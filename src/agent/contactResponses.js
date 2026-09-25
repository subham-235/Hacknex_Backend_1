const { randomBytes, createHash } = require("node:crypto");
const { getConfig } = require("./config");
const geo = require("../coordination/geo");
const OPEN = ["active", "acknowledged", "review_required"];
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

function createContactResponses({
  Session,
  Contact,
  notify = async () => {},
  now = Date.now,
}) {
  const open = () => ({
    status: { $in: OPEN },
    expiresAt: { $gt: new Date(now()) },
  });
  async function issueLink(sessionId, contactId, config = getConfig()) {
    if (!config.baseUrl) return null;
    const token = randomBytes(32).toString("base64url");
    const result = await Session.updateOne(
      { _id: sessionId, ...open(), "recipients.contactId": contactId },
      {
        $push: {
          "recipients.$.responseTokenHashes": {
            $each: [hashToken(token)],
            $slice: -4,
          },
        },
      },
    );
    if (!result.modifiedCount) return null;
    // Fragment stays out of HTTP access logs and Referer headers.
    return `${config.baseUrl}/agent/respond#${token}`;
  }
  async function authorize(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      fail(
        410,
        "This response link is invalid, expired, or no longer available.",
      );
    const hash = hashToken(token);
    const session = await Session.findOne({
      ...open(),
      "recipients.responseTokenHashes": hash,
    }).lean();
    const recipient = session?.recipients.find((r) =>
      r.responseTokenHashes?.includes(hash),
    );
    if (!recipient)
      fail(
        410,
        "This response link is invalid, expired, or no longer available.",
      );
    const contact = await Contact.findOne({
      _id: recipient.contactId,
      profileId: session.profileId,
      isActive: true,
      contactNumber: recipient.number,
    }).lean();
    if (!contact)
      fail(
        410,
        "This response link is invalid, expired, or no longer available.",
      );
    return { session, recipient, hash };
  }
  const filter = ({ session, recipient, hash }, extra = {}) => ({
    _id: session._id,
    ...open(),
    recipients: {
      $elemMatch: {
        contactId: recipient.contactId,
        responseTokenHashes: hash,
        ...extra,
      },
    },
  });
  async function changed(session) {
    try {
      await notify({
        profileId: String(session.profileId),
        sessionId: String(session._id),
        type: "agent-session-updated",
      });
    } catch {
      /* Polling reads persisted updates independently of the worker. */
    }
  }
  async function context(token) {
    const { session, recipient } = await authorize(token);
    const helping = ["coming", "arrived"].includes(recipient.responseStatus);
    const center = helping
      ? geo.getCurrentEmergencyCenter(session, now())
      : null;
    return {
      reference: session.reference,
      expiresAt: session.expiresAt,
      responseStatus: recipient.responseStatus || "pending",
      victimLocation: center
        ? {
            latitude: center.latitude,
            longitude: center.longitude,
            fresh: center.fresh,
            observedAt: center.observedAt,
          }
        : null,
      tracking: helping
        ? geo.tracking(center, recipient.lastLocation, now())
        : null,
    };
  }
  async function respond(token, status) {
    if (!["coming", "cannot_help", "arrived"].includes(status))
      fail(400, "Choose a valid response.");
    const auth = await authorize(token);
    const { session, recipient } = auth;
    if (recipient.responseStatus === status) return { responseStatus: status };
    if (status === "arrived" && recipient.responseStatus !== "coming")
      fail(409, "Confirm you are coming before marking arrival.");
    const previous = recipient.responseStatus || null;
    const text = {
      coming: "I'm coming to help.",
      cannot_help: "I cannot help.",
      arrived: "I have arrived.",
    }[status];
    const result = await Session.updateOne(
      filter(auth, { responseStatus: previous }),
      {
        $set: {
          "recipients.$.responseStatus": status,
          "recipients.$.respondedAt": new Date(now()),
        },
        ...(status === "cannot_help"
          ? { $unset: { "recipients.$.lastLocation": "" } }
          : {}),
        $push: {
          events: {
            $each: [
              {
                type: "contact_reply",
                contactId: recipient.contactId,
                text,
                at: new Date(now()),
              },
            ],
            $slice: -100,
          },
        },
        $min: { nextRunAt: new Date(now()) },
      },
    );
    if (!result.modifiedCount)
      fail(409, "The SOS or your response changed. Refresh and try again.");
    await changed(session);
    return { responseStatus: status };
  }
  async function location(token, body) {
    const auth = await authorize(token);
    if (!["coming", "arrived"].includes(auth.recipient.responseStatus))
      fail(409, "Choose “I’m coming” before sharing location.");
    if (!Number.isFinite(body?.accuracy))
      fail(400, "GPS accuracy is required.");
    const point = geo.locationInput(body, now());
    geo.acceptLocation(auth.recipient.lastLocation, point);
    const result = await Session.updateOne(
      filter(auth, {
        responseStatus: auth.recipient.responseStatus,
        "lastLocation.observedAt":
          auth.recipient.lastLocation?.observedAt || null,
      }),
      { $set: { "recipients.$.lastLocation": point } },
    );
    if (!result.modifiedCount)
      fail(409, "Your response or location changed. Refresh and try again.");
    await changed(auth.session);
    return { shared: true };
  }
  async function stopLocation(token) {
    const auth = await authorize(token);
    await Session.updateOne(filter(auth), {
      $unset: { "recipients.$.lastLocation": "" },
    });
    await changed(auth.session);
    return { shared: false };
  }
  return { issueLink, context, respond, location, stopLocation };
}
module.exports = { createContactResponses, hashToken };
