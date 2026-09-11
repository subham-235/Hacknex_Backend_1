const { randomUUID } = require("node:crypto");
const { ACTIVE } = require("./policy");
const { runAgentLoop } = require("./loop");

function createProcessor({ Session, createTools, generate, config, notify = async () => {} }) {
  return async ({ data }) => {
    if (config.mode === "off") return;
    const leaseToken = randomUUID();
    const now = new Date();
    const session = await Session.findOneAndUpdate({ _id: data.sessionId, ready: true, status: { $in: ACTIVE }, nextRunAt: { $lte: now }, leaseUntil: { $lte: now } }, {
      $set: { leaseToken, leaseUntil: new Date(Date.now() + config.leaseMs), nextRunAt: new Date(Date.now() + config.checkMs) },
    }, { new: true }).lean();
    if (!session) return;
    const filter = { _id: session._id, leaseToken };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Agent run timed out")), config.timeoutMs);
    try {
      if (session.expiresAt <= now) {
        await Session.updateOne({ ...filter, status: { $in: ACTIVE } }, { $set: { status: "expired" } });
        return;
      }
      const { tools, executeAction } = createTools({ sessionId: session._id, leaseToken, config, signal: controller.signal });
      // Owner-approved actions can execute even after the model-run budget is spent.
      for (const action of session.actions.filter(a => a.state === "approved")) await executeAction(action._id);
      if (session.runCount >= config.maxRuns) {
        await Session.updateOne({ ...filter, status: { $in: ACTIVE } }, { $set: { status: "review_required" } });
        return;
      }
      await Session.updateOne(filter, { $inc: { runCount: 1 } });
      const outcome = await runAgentLoop({ generate, tools, config, signal: controller.signal });
      await Session.updateOne(filter, { $set: { lastError: "" }, $push: { events: { $each: [{ type: "agent_run", text: outcome.summary, at: new Date() }], $slice: -100 } } });
    } catch (error) {
      await Session.updateOne(filter, { $set: { lastError: "Agent run failed; inspect worker logs" }, $push: { events: { $each: [{ type: "agent_error", text: "Agent unavailable or run interrupted; initial alerts are unaffected", at: new Date() }], $slice: -100 } } });
      console.error("Agent run failed:", error.name, error.status || "");
    } finally {
      clearTimeout(timer);
      await Session.updateOne(filter, { $set: { leaseUntil: new Date(0) }, $unset: { leaseToken: "" } });
      try { await notify({ profileId: String(session.profileId), sessionId: String(session._id) }); }
      catch { console.error("Agent live update unavailable; session remains available through the API"); }
    }
  };
}
module.exports = { createProcessor };
