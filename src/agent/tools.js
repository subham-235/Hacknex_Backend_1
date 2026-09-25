const mongoose = require("mongoose");
const Session = require("../models/emergencySession");
const Contact = require("../models/contact");
const ActiveUser = require("../models/activeUser");
const { canFollowUp, ACTIVE } = require("./policy");
const { callbackUrl, recordAttempt, issueContactLink } = require("./sessions");
const { sendMessage } = require("../services/smsGateway");

async function latestLocation(session) {
  const active = await ActiveUser.findOne({ profileId: session.profileId, isActive: true, lastSeen: { $gte: new Date(Date.now() - 120000) }, expireAt: { $gt: new Date() } }).lean();
  const coordinates = active?.location?.coordinates;
  if (coordinates?.length === 2) return { mapsLink: `https://maps.google.com/?q=${coordinates[1]},${coordinates[0]}`, observedAt: active.lastSeen, fresh: true };
  return { ...session.location, fresh: false };
}

function createTools({ sessionId, leaseToken, config, signal }) {
  const leaseFilter = () => ({ _id: sessionId, status: { $in: ACTIVE }, expiresAt: { $gt: new Date() }, leaseToken, leaseUntil: { $gt: new Date() } });
  async function load() {
    signal?.throwIfAborted();
    const session = await Session.findOne(leaseFilter()).lean();
    if (!session) throw new Error("Session closed or worker lease lost");
    return session;
  }
  async function recordUpdate({ text }) {
    signal?.throwIfAborted();
    const updated = await Session.updateOne(leaseFilter(), { $push: { events: { $each: [{ type: "agent_note", text: text.slice(0, 500), at: new Date() }], $slice: -100 } } });
    return { recorded: updated.matchedCount === 1 };
  }
  async function executeAction(actionId) {
    const session = await load();
    const action = session.actions.find(a => String(a._id) === String(actionId));
    if (!action || action.state !== "approved") return { blocked: "Action is not approved" };
    const contact = await Contact.findById(action.contactId).lean();
    const blocked = canFollowUp(session, contact, config);
    if (blocked) {
      await Session.updateOne({ ...leaseFilter(), "actions._id": actionId }, { $set: { "actions.$.state": "blocked" } });
      return { blocked };
    }
    const location = await latestLocation(session);
    signal?.throwIfAborted();
    const attemptId = new mongoose.Types.ObjectId();
    // Persist the reservation BEFORE the external request. Never replay an uncertain send.
    const reserved = await Session.updateOne({
      ...leaseFilter(), followupCount: { $lt: config.maxMessages },
      actions: { $elemMatch: { _id: actionId, state: "approved" } },
      acknowledgments: { $not: { $elemMatch: { contactId: contact._id } } },
    }, {
      $set: { "actions.$.state": "sending" }, $inc: { followupCount: 1 },
      $push: { attempts: { _id: attemptId, contactId: contact._id, kind: "followup", status: "sending" } },
    });
    if (!reserved.modifiedCount) return { blocked: "Action was already claimed or session changed" };
    let result;
    let submitted = false;
    try {
      // Recheck resolution/lease after reserving. An already submitted SMS cannot be recalled.
      const currentSession = await load();
      const currentContact = await Contact.findById(contact._id).lean();
      if (canFollowUp({ ...currentSession, followupCount: session.followupCount }, currentContact, config)) throw new Error("Contact changed or responded before sending");
      let link;
      try { if (config.baseUrl) link = await issueContactLink(sessionId, contact._id, config); }
      catch { /* Link failure must not suppress the approved alert. */ }
      signal?.throwIfAborted();
      submitted = true;
      const sent = await sendMessage({
        to: `+91${contact.contactNumber}`,
        body: `Suraksha follow-up ${session.reference}: An SOS remains open. Please check on the person. ${location.fresh ? "Latest" : "Last known"} location: ${location.mapsLink}\nReplies to this SMS are not supported.${link ? ` Respond securely: ${link}\nKeep this link private.` : ' Contact the person directly.'}`,
        statusCallback: callbackUrl(sessionId, attemptId, config),
      });
      result = { status: ["failed", "undelivered", "canceled"].includes(sent.status) ? "failed" : "accepted", sid: sent.sid };
    } catch (error) {
      result = { status: !submitted ? "blocked" : error.status >= 400 && error.status < 500 ? "failed" : "unknown", error: "Send blocked, failed or outcome uncertain; inspect provider status before retrying" };
    }
    await recordAttempt(sessionId, attemptId, result);
    await Session.updateOne({ _id: sessionId, "actions._id": actionId }, { $set: { "actions.$.state": result.status } });
    return result;
  }
  const tools = {
    async getResponderStatus() {
      const s = await load();
      return { assigned: Boolean(s.activeResponder), status: s.activeResponder?.currentStatus, tracking: s.responderTracking, escalationStage: s.escalationStage, escalationState: s.escalationState };
    },
    async getNearbyResponderSummary() {
      const s = await load();
      return { counts: (s.nearbyResponderRequests || []).reduce((counts, r) => { counts[r.status] = (counts[r.status] || 0) + 1; return counts; }, {}), radiusMeters: s.emergencyGeofence?.radiusMeters };
    },
    async getGeoSafetyStatus() {
      const s = await load();
      return { signals: s.geoRiskSignals || [], locationObservedAt: s.latestVictimLocation?.observedAt, events: (s.geoEvents || []).slice(-10) };
    },
    async getEmergencyContext() {
      const session = await load();
      const contacts = await Contact.find({ profileId: session.profileId, isActive: true, via: "SMS", _id: { $in: session.recipients.map(r => r.contactId) } }).lean();
      return {
        status: session.status, summary: session.summary, severity: session.severity, mode: config.mode,
        contacts: contacts.map(c => ({ contactId: String(c._id), relationship: c.contacts, priority: c.priority })),
        attempts: session.attempts.map(a => ({ contactId: String(a.contactId), status: a.status, kind: a.kind })),
        actions: session.actions.map(a => ({ contactId: String(a.contactId), state: a.state, reason: a.reason })),
        remainingFollowups: Math.max(0, config.maxMessages - session.followupCount),
      };
    },
    async getContactResponses() { const session = await load(); return {
      acknowledgments: session.acknowledgments,
      responses: session.recipients.map(r => ({ contactId: String(r.contactId), status: r.responseStatus || 'pending', respondedAt: r.respondedAt })),
      replies: session.events.filter(e => e.type === "contact_reply").slice(-20),
    }; },
    async getLatestLocation() { return latestLocation(await load()); },
    recordUpdate,
    async sendFollowUp({ contactId, reason }) {
      const session = await load();
      const contact = await Contact.findById(contactId).lean();
      const blocked = canFollowUp(session, contact, config);
      if (blocked) return { blocked };
      if (session.actions.some(a => String(a.contactId) === contactId)) return { blocked: "A follow-up already exists for this contact" };
      const actionId = new mongoose.Types.ObjectId();
      const state = config.mode === "live" ? "approved" : "proposed";
      const result = await Session.updateOne({ ...leaseFilter(),
        actions: { $not: { $elemMatch: { contactId: contact._id } } },
        $expr: { $lt: [{ $size: "$actions" }, config.maxMessages] },
      }, { $push: { actions: { _id: actionId, contactId, reason, state } } });
      if (!result.modifiedCount) return { blocked: "Duplicate action or proposal limit reached" };
      return state === "proposed" ? { proposed: true, actionId: String(actionId) } : executeAction(actionId);
    },
  };
  return { tools, executeAction };
}
module.exports = { createTools, latestLocation };
