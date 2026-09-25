const { OPEN } = require("./responders");
function createGeoDispatcher({ Session, Journey, queue }) {
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      await Journey.updateMany({ sosState: 'sending', sosDeadline: { $lte: new Date() } }, {
        $set: { sosState: 'unknown', sosError: 'SOS processing was interrupted. Check Safety agent for message status.' },
        $inc: { version: 1 },
      });
      await Session.updateMany(
        { status: { $in: OPEN }, expiresAt: { $lte: new Date() } },
        { $set: { status: "expired" } },
      );
      await Session.updateMany(
        { status: { $in: ["expired", "resolved"] } },
        { $set: { activeResponder: null, responderTracking: null } },
      );
      await Session.updateMany(
        { status: { $in: ["expired", "resolved"] }, nearbyResponderRequests: { $type: 'array' } },
        {
          $set: {
            "nearbyResponderRequests.$[open].status": "cancelled",
          },
        },
        { arrayFilters: [{ "open.status": { $in: ["pending", "accepted"] } }] },
      );
      const sessions = await Session.find({
        ready: true,
        status: { $in: OPEN },
        $or: [
          { coordinationNextRunAt: { $lte: new Date() } },
          { coordinationNextRunAt: { $exists: false } },
        ],
      })
        .select("_id")
        .sort({ coordinationNextRunAt: 1 })
        .limit(100)
        .lean();
      for (const s of sessions)
        await queue.add(
          "coordinate-session",
          { sessionId: String(s._id) },
          { jobId: `geo-${s._id}`, attempts: 3, backoff: { type: "exponential", delay: 1000 } },
        );
      const journeys = await Journey.find({ open: true, nextCheckAt: { $lte: new Date() } })
        .select("_id profileId")
        .sort({ nextCheckAt: 1 })
        .limit(100)
        .lean();
      for (const j of journeys)
        await queue.add(
          "check-journey",
          { journeyId: String(j._id), profileId: String(j.profileId) },
          { jobId: `journey-${j._id}`, attempts: 3, backoff: { type: "exponential", delay: 1000 } },
        );
    } catch (e) {
      console.error("Geo dispatcher unavailable:", e.name);
    } finally {
      busy = false;
    }
  };
}
module.exports = { createGeoDispatcher };
