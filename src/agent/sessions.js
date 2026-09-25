const { randomBytes } = require("node:crypto");
const Session = require("../models/emergencySession");
const { getConfig } = require("./config");
const { ACTIVE, nextDeliveryStatus } = require("./policy");

async function createSession(profileId, analysis, mapsLink, contacts, options = {}) {
  const config = getConfig();
  const at = (options.now || Date.now)();
  const coordinates = require("../utils/locationParser").parseLatLon(mapsLink);
  const point = options.point || (coordinates ? { latitude: coordinates.lat, longitude: coordinates.lon, observedAt: new Date(at), receivedAt: new Date(at) } : undefined);
  return (options.Session || Session).create({
    ...(options.sessionId ? { _id: options.sessionId } : {}),
    profileId, reference: randomBytes(6).toString("hex").toUpperCase(),
    summary: String(analysis.summary || "Emergency assistance requested").slice(0, 1000),
    severity: analysis.severity,
    distressConfidence: analysis.confidence,
    initialVictimLocation: point, latestVictimLocation: point,
    location: { mapsLink, observedAt: point?.observedAt || new Date(at) },
    recipients: contacts.map(c => ({ contactId: c._id, label: c.contacts, number: c.contactNumber })),
    attempts: contacts.map(c => ({ contactId: c._id, kind: "initial", status: "pending" })),
    expiresAt: new Date(at + (options.durationMs || config.durationMs)),
    initialDeadline: new Date(at + contacts.length * 30000 + 120000),
    nextRunAt: new Date(at + config.checkMs),
  });
}

function callbackUrl(sessionId, attemptId, config = getConfig()) {
  return config.baseUrl ? `${config.baseUrl}/agent/webhooks/status?sessionId=${sessionId}&attemptId=${attemptId}` : undefined;
}

async function recordAttempt(sessionId, attemptId, result) {
  // Compare-and-set prevents out-of-order callbacks from downgrading delivery.
  for (let retry = 0; retry < 5; retry++) {
    const session = await Session.findById(sessionId).lean();
    const attempt = session?.attempts.find(a => String(a._id) === String(attemptId));
    if (!attempt || (attempt.sid && result.sid && attempt.sid !== result.sid)) return false;
    const status = nextDeliveryStatus(attempt.status, result.status);
    const set = { "attempts.$.status": status };
    if (result.sid) set["attempts.$.sid"] = result.sid;
    if (result.error) set["attempts.$.error"] = String(result.error).slice(0, 200);
    const updated = await Session.updateOne({
      _id: sessionId,
      attempts: { $elemMatch: { _id: attemptId, status: attempt.status, ...(attempt.sid ? { sid: attempt.sid } : { sid: { $exists: false } }) } },
    }, { $set: set });
    if (updated.matchedCount) {
      if (["failed", "undelivered", "canceled"].includes(status)) await wakeSession(sessionId);
      return true;
    }
  }
  throw new Error("Concurrent delivery updates; callback should retry");
}

async function finishInitial(sessionId, historyId) {
  await Session.updateOne({ _id: sessionId }, { $set: { ready: true, ...(historyId ? { historyId } : {}) } });
  try { await require("../coordination/runtime").responders.check(sessionId); }
  catch (error) { console.error("Responder initialization deferred to worker:", error.name); }
}

async function wakeSession(sessionId) {
  await Session.updateOne({ _id: sessionId, status: { $in: ACTIVE } }, { $min: { nextRunAt: new Date() } });
}

async function wakeForLocation(profileId) {
  // Coalesce frequent GPS updates; worker reads the freshest location when due.
  await Session.updateMany({ profileId, status: { $in: ACTIVE } }, { $min: { nextRunAt: new Date(Date.now() + getConfig().checkMs) } });
}

const issueContactLink = (...args) => require('./contactResponseRuntime').issueLink(...args);
module.exports = { createSession, callbackUrl, recordAttempt, finishInitial, wakeSession, wakeForLocation, issueContactLink };
