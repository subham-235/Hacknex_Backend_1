const ACTIVE = ["active", "acknowledged"];
function canFollowUp(session, contact, config, now = Date.now()) {
  if (config.mode === "off") return "Agent is disabled";
  if (!ACTIVE.includes(session.status) || new Date(session.expiresAt).getTime() <= now) return "Session is closed";
  if (!contact || !contact.isActive || String(contact.profileId) !== String(session.profileId)) return "Contact is not authorized";
  if (contact.via !== "SMS") return "Only SMS contacts are supported";
  if (!session.recipients.some(r => String(r.contactId) === String(contact._id) && r.number === contact.contactNumber)) return "Contact was not authorized for this incident";
  if (session.acknowledgments.some(a => String(a.contactId) === String(contact._id))) return "Contact already acknowledged";
  if (session.attempts?.some(a => a.kind === "initial" && String(a.contactId) === String(contact._id) && ["pending", "sending", "unknown"].includes(a.status))) return "Initial SMS submission is pending or uncertain";
  if (session.followupCount >= config.maxMessages) return "Session follow-up limit reached";
  return null;
}

function nextDeliveryStatus(current, incoming) {
  if (incoming === "unknown" && ["pending", "sending"].includes(current)) return "unknown";
  if (incoming === "blocked" && ["pending", "sending"].includes(current)) return "blocked";
  const order = { pending: 0, sending: 1, accepted: 2, scheduled: 2, queued: 3, sent: 4, failed: 5, undelivered: 5, canceled: 5, delivered: 6, read: 7, unknown: 0 };
  if (!Object.hasOwn(order, incoming)) return current;
  return order[incoming] > (order[current] ?? -1) ? incoming : current;
}

function parseReply(body) {
  if (typeof body !== "string" || body.length > 1600) return null;
  const match = body.match(/\b([A-F0-9]{12})\b/i);
  if (!match) return null;
  return { reference: match[1].toUpperCase(), text: body.trim(), acknowledged: new RegExp(`^ACK\\s+${match[1]}[.!]?\\s*$`, "i").test(body.trim()) };
}
module.exports = { ACTIVE, canFollowUp, nextDeliveryStatus, parseReply };
