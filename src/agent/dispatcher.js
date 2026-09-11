const { ACTIVE } = require("./policy");
function createDispatcher({ Session, queue }) {
  let dispatching = false;
  return async function dispatch() {
    if (dispatching) return;
    dispatching = true;
    try {
      await Session.updateMany({ status: { $in: [...ACTIVE, "review_required"] }, expiresAt: { $lte: new Date() } }, { $set: { status: "expired" } });
      // Recover incomplete initial processing without replaying uncertain submissions.
      await Session.updateMany({ ready: false, initialDeadline: { $lte: new Date() }, status: { $in: ACTIVE } }, {
        $set: { ready: true, "attempts.$[pending].status": "unknown", lastError: "Initial alert processing was interrupted; inspect SMS provider records" },
      }, { arrayFilters: [{ "pending.status": "pending" }] });
      // Persisted schedules recover from queue loss or downtime.
      const due = await Session.find({ ready: true, status: { $in: ACTIVE }, nextRunAt: { $lte: new Date() }, leaseUntil: { $lte: new Date() } }).select("_id").sort({ nextRunAt: 1 }).limit(100).lean();
      for (const session of due) await queue.add("review-session", { sessionId: String(session._id) }, { jobId: `session-${session._id}` });
    } catch (error) { console.error("Agent dispatcher failed:", error.name); }
    finally { dispatching = false; }
  };
}
module.exports = { createDispatcher };
