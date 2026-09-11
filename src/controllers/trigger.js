const User = require("../models/user");
const Contact = require("../models/contact");
const { analyzeAudioDirectly } = require("../services/llmsupport");
const { sendSOSAlert } = require("../services/smsAlart");
const History = require("../models/history");
const ActiveUser = require("../models/activeUser");
const Incident = require("../models/incident");
const { getIO } = require("../socket");
const { parseLatLon } = require("../utils/locationParser");
const { createSession, callbackUrl, recordAttempt, finishInitial } = require("../agent/sessions");

// Sobchey main Api
const trigger = async (req, res) => {
  const audioPath = req.file?.path;
  try {
    const { location, confidence } = req.body;

    if (!req.file) {
      return res.status(400).json({
        error: "No audio file received",
      });
    }

    if (!location) {
      return res.status(400).json({
        error: "No location found...",
      });
    }

    // Google Maps link or string from frontend
    const mapsLink = typeof location === "string" ? location : String(location);

    const analysis = await analyzeAudioDirectly(
      audioPath,
      mapsLink
    );

    if (!analysis.isDistress || analysis.confidence < 70) {
      return res.status(200).json({
        sent: false,
        isDistress: false,
        transcript: analysis.transcript,
        emotion: analysis.emotion,
        reason: analysis.reason,
      });
    }

    const profileId = req.user._id;
    const contacts = await Contact.find({
      profileId,
      isActive: true,
    });

    if (contacts.length === 0) {
      return res.status(400).json({
        error: "No active emergency contact available",
      });
    }

    // Save a durable schedule before sending. AI follow-up never runs in this request.
    let agentSession = null;
    let agentTrackingError = false;
    try { agentSession = await createSession(profileId, analysis, mapsLink, contacts); }
    catch (error) { agentTrackingError = true; console.error("Agent session unavailable:", error.name); }
    const attemptFor = contact => agentSession?.attempts.find(a => String(a.contactId) === String(contact._id));

    // Send SMS alert via Twilio
    const smsSend = await sendSOSAlert(
      analysis.summary,
      mapsLink,
      contacts,
      agentSession ? {
        reference: agentSession.reference,
        statusCallback: contact => callbackUrl(agentSession._id, attemptFor(contact)._id),
        onResult: (contact, result) => recordAttempt(agentSession._id, attemptFor(contact)._id, {
          ...result, status: result.deliveryStatus || (result.status === "sent" ? "accepted" : "failed"),
        }),
      } : {}
    );
    // Ready even if a later history write fails: follow-up can still proceed.
    if (agentSession) {
      try { await finishInitial(agentSession._id); }
      catch (error) { agentTrackingError = true; console.error("Agent scheduling update failed:", error.name); }
    }
    // sendSOSAlert returns one result per contact, in the same order.
    // "sent" means accepted by the SMS service, not confirmed delivery.
    const sentContacts = contacts.filter((contact, index) => smsSend[index]?.status === "sent");
    const failedContacts = contacts.filter((contact, index) => smsSend[index]?.status !== "sent");
    const sent = sentContacts.length > 0;

    let severity = analysis.severity?.toLowerCase();
    let numSeverity = 3;

    if (severity === "critical" || severity === "high") {
      severity = "High";
      numSeverity = 5;
    } else if (severity === "moderate" || severity === "medium") {
      severity = "Medium";
      numSeverity = 3;
    } else {
      severity = "Low";
      numSeverity = 1;
    }

    // Save alert to History schema
    const savedAlert = await History.create({
      confidencePercentage: analysis.confidence ?? confidence,
      transcript: analysis.transcript,
      severity: severity,
      sent: sentContacts.map((contact) => contact._id),
      location: {
        mapsLink: mapsLink,
      },
      summary: analysis.summary,
      profileId: profileId,
    });
    if (agentSession) {
      try { await finishInitial(agentSession._id, savedAlert._id); }
      catch (error) { agentTrackingError = true; console.error("Agent history link failed:", error.name); }
    }

    // Parse coordinates embedded in the Google Maps link
    const parsedCoords = parseLatLon(mapsLink, req.body.lon || req.body.lng);

    // Notify nearby users & save incident if lat and lon are present
    if (parsedCoords) {
      const { lat: parsedLat, lon: parsedLon } = parsedCoords;

      try {
        // Save incident to Heatmap
        await Incident.create({
          location: {
            type: "Point",
            coordinates: [parsedLon, parsedLat],
          },
          incidentType: "sos_triggered",
          reportedVia: "sos_auto",
          severity: numSeverity,
          timeOfDay: getTimeOfDay(),
        });

        // Find active community users within 500m
        const nearbyUsers = await ActiveUser.find({
          isActive: true,
          profileId: { $ne: profileId },   // exclude victim
          location: {
            $near: {
              $geometry: {
                type: "Point",
                coordinates: [parsedLon, parsedLat],
              },
              $maxDistance: 500,   // 500 meters
            },
          },
        });

        // Broadcast notification via Socket.io
        if (nearbyUsers.length > 0) {
          const io = getIO();

          nearbyUsers.forEach((user) => {
            if (user.socketId) {
              io.to(user.socketId).emit("nearby-sos", {
                message: "Someone nearby needs help!",
                distance: "Within 500m of your location",
                mapsLink: mapsLink.startsWith("http") ? mapsLink : `https://maps.google.com/?q=${parsedLat},${parsedLon}`,
                severity: severity,
                timeOfDay: getTimeOfDay(),
              });
            }
          });

          console.log(`Notified ${nearbyUsers.length} nearby users via Socket.io`);
        }
      } catch (geoErr) {
        console.error("Error processing nearby notification / incident recording:", geoErr.message);
      }
    }

    return res.status(sent ? 200 : 502).json({
      success: sent,
      sent,
      partialSuccess: sent && failedContacts.length > 0,
      ...(!sent ? { error: "All SMS alert attempts failed" } : {}),
      isDistress: true,
      transcript: analysis.transcript,
      emotion: analysis.emotion,
      confidence: analysis.confidence,
      summary: analysis.summary,
      severity: analysis.severity,
      sentTo: sentContacts.map((contact) => contact.contactNumber),
      failedTo: failedContacts.map((contact) => contact.contactNumber),
      historyId: savedAlert._id,
      agentSessionId: agentSession?._id || null,
      agentReference: agentSession?.reference || null,
      agentTrackingError,
      createdAt: savedAlert.createdAt,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err.message,
    });
  }
};

const getTimeOfDay = () => {
  const hour = new Date().getHours();
  if (hour >= 5  && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
};

module.exports = trigger;
