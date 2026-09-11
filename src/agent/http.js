const twilio = require("twilio");
const { getConfig } = require("./config");
const { ACTIVE, parseReply } = require("./policy");

function verifyTwilio(req, res, next) {
  const { baseUrl } = getConfig();
  const signature = req.get("X-Twilio-Signature");
  if (!baseUrl || !process.env.TWILIO_AUTH_TOKEN || !signature) return res.status(403).json({ error: "Webhook signature required" });
  // Use the configured public origin, never a client-supplied Host header.
  if (!twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, baseUrl + req.originalUrl, req.body)) return res.status(403).json({ error: "Invalid webhook signature" });
  if (req.body.AccountSid !== process.env.TWILIO_ACCOUNT_SID) return res.status(403).json({ error: "Wrong Twilio account" });
  next();
}

function createHandlers({ Session, Contact, recordAttempt }) {
  const idValid = id => typeof id === "string" && /^[a-f0-9]{24}$/i.test(id);
  const owned = req => ({ _id: req.params.id, profileId: req.user._id });
  async function list(req, res) {
    const sessions = await Session.find({ profileId: req.user._id }).sort({ createdAt: -1 }).limit(20).lean();
    return res.json({ sessions });
  }
  async function detail(req, res) {
    if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid session ID" });
    const session = await Session.findOne(owned(req)).lean();
    return session ? res.json({ session }) : res.status(404).json({ error: "Session not found" });
  }
  async function resolve(req, res) {
    if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid session ID" });
    const session = await Session.findOneAndUpdate(owned(req), { $set: { status: "resolved", resolvedAt: new Date() } }, { new: true }).lean();
    return session ? res.json({ session }) : res.status(404).json({ error: "Session not found" });
  }
  function decideAction(state) {
    return async (req, res) => {
      if (!idValid(req.params.id) || !idValid(req.params.actionId)) return res.status(400).json({ error: "Invalid ID" });
      if (state === "approved" && getConfig().mode === "off") return res.status(409).json({ error: "Agent is disabled" });
      const result = await Session.updateOne({ ...owned(req), status: { $in: [...ACTIVE, "review_required"] }, expiresAt: { $gt: new Date() }, actions: { $elemMatch: { _id: req.params.actionId, state: "proposed" } } }, {
        $set: { "actions.$.state": state, ...(state === "approved" ? { status: "active", nextRunAt: new Date() } : {}) },
      });
      return result.modifiedCount ? res.json({ success: true, state }) : res.status(409).json({ error: "Action unavailable, already decided, or session closed" });
    };
  }
  async function delivery(req, res) {
    const { sessionId, attemptId } = req.query;
    const { MessageSid, MessageStatus, To } = req.body;
    if (!idValid(sessionId) || !idValid(attemptId) || !/^SM[a-f0-9]{32}$/i.test(MessageSid || "")) return res.status(400).json({ error: "Invalid callback identifiers" });
    const session = await Session.findById(sessionId).lean();
    const attempt = session?.attempts.find(a => String(a._id) === attemptId);
    const recipient = session?.recipients.find(r => String(r.contactId) === String(attempt?.contactId));
    if (!attempt || !recipient || To !== `+91${recipient.number}` || (attempt.sid && attempt.sid !== MessageSid)) return res.status(404).json({ error: "Message not found" });
    await recordAttempt(sessionId, attemptId, { status: MessageStatus, sid: MessageSid });
    return res.sendStatus(204);
  }
  async function incoming(req, res) {
    const parsed = parseReply(req.body.Body);
    const empty = () => res.type("text/xml").send("<Response></Response>");
    if (!parsed || !/^SM[a-f0-9]{32}$/i.test(req.body.MessageSid || "")) return empty();
    const session = await Session.findOne({ reference: parsed.reference, status: { $in: [...ACTIVE, "review_required"] }, expiresAt: { $gt: new Date() } }).lean();
    const recipient = session?.recipients.find(r => `+91${r.number}` === req.body.From);
    if (!recipient) return empty();
    const contact = await Contact.findOne({ _id: recipient.contactId, profileId: session.profileId, isActive: true, contactNumber: recipient.number }).lean();
    if (!contact) return empty();
    await Session.updateOne({ _id: session._id, status: { $in: [...ACTIVE, "review_required"] }, expiresAt: { $gt: new Date() }, processedMessageSids: { $ne: req.body.MessageSid }, $expr: { $lt: [{ $size: "$processedMessageSids" }, 100] } }, {
      $addToSet: { processedMessageSids: req.body.MessageSid },
      $push: { events: { $each: [{ key: req.body.MessageSid, type: "contact_reply", contactId: recipient.contactId, text: parsed.text, at: new Date() }], $slice: -100 } },
      $min: { nextRunAt: new Date() },
    });
    if (parsed.acknowledged) await Session.updateOne({ _id: session._id, processedMessageSids: req.body.MessageSid, status: { $in: [...ACTIVE, "review_required"] }, acknowledgments: { $not: { $elemMatch: { contactId: recipient.contactId } } } }, {
      $push: { acknowledgments: { contactId: recipient.contactId, at: new Date() } },
      // Preserve review_required after the run budget is exhausted.
    });
    if (parsed.acknowledged) await Session.updateOne({ _id: session._id, status: "active", "acknowledgments.contactId": recipient.contactId }, { $set: { status: "acknowledged" } });
    return empty();
  }
  return { list, detail, resolve, approve: decideAction("approved"), reject: decideAction("rejected"), delivery, incoming };
}
module.exports = { createHandlers, verifyTwilio };
