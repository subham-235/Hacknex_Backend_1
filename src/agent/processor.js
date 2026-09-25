const { randomUUID } = require("node:crypto");
const { ACTIVE } = require("./policy");
const { runAgentLoop } = require("./loop");
const { classifyFailure, retryDelay } = require('./failures');

function createProcessor({ Session, createTools, generate, config, notify = async () => {} }) {
  return async ({ data }) => {
    if (config.mode === "off") return;
    const leaseToken = randomUUID();
    const now = new Date();
    const session = await Session.findOneAndUpdate({ _id: data.sessionId, ready: true, status: { $in: ACTIVE }, nextRunAt: { $lte: now }, leaseUntil: { $lte: now } }, {
      $set: { leaseToken, leaseUntil: new Date(Date.now() + config.leaseMs), nextRunAt: new Date(Date.now() + config.checkMs) },
    }, { returnDocument: 'after' }).lean();
    if (!session) return;
    const filter = { _id: session._id, leaseToken };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Agent run timed out")), config.timeoutMs);
    let failureSource = 'Agent';
    try {
      if (session.expiresAt <= now) {
        await Session.updateOne({ ...filter, status: { $in: ACTIVE } }, { $set: { status: "expired" } });
        return;
      }
      const { tools, executeAction } = createTools({ sessionId: session._id, leaseToken, config, signal: controller.signal });
      // Owner-approved actions can execute even after the model-run budget is spent.
      for (const action of session.actions.filter(a => a.state === "approved")) await executeAction(action._id);
      // Location updates and approved actions can wake a session early. They
      // must not bypass the persisted model cooldown.
      if (session.aiRetryAfter && +new Date(session.aiRetryAfter) > Date.now()) {
        await Session.updateOne(filter, { $set: { nextRunAt: session.aiRetryAfter } });
        return;
      }
      if (session.runCount >= config.maxRuns) {
        await Session.updateOne({ ...filter, status: { $in: ACTIVE } }, { $set: { status: "review_required" } });
        return;
      }
      await Session.updateOne(filter, { $inc: { runCount: 1 } });
      const outcome = await runAgentLoop({ generate: async request => {
        try { return await generate(request); }
        catch (error) { failureSource = 'Gemini'; throw error; }
      }, tools, config, signal: controller.signal });
      await Session.updateOne(filter, { $set: { lastError: "", aiFailureCount: 0, nextRunAt: new Date(Date.now() + config.checkMs) }, $unset: { aiRetryAfter: '' }, $push: { events: { $each: [{ type: "agent_run", text: outcome.summary, at: new Date() }], $slice: -100 } } });
    } catch (error) {
      const failure = classifyFailure(controller.signal.aborted ? { name: 'AbortError' } : error, failureSource);
      const failures = (session.aiFailureCount || 0) + 1;
      const delay = retryDelay(failures, config);
      const retryAt = new Date(Date.now() + delay);
      const retry = failure.retry && session.runCount + 1 < config.maxRuns && +retryAt < +new Date(session.expiresAt);
      const message = `${failure.message} ${retry ? `Retry scheduled in ${Math.ceil(delay / 1000)} seconds.` : 'Automatic AI review paused; manual review required.'} Initial alerts and responder tracking are not cancelled.`;
      await Session.updateOne({ ...filter, status: { $in: ACTIVE } }, { $set: {
        lastError: message, aiFailureCount: failures,
        ...(retry ? { nextRunAt: retryAt, aiRetryAfter: retryAt } : { status: 'review_required' }),
      }, $push: { events: { $each: [{ type: 'agent_error', text: message, at: new Date() }], $slice: -100 } } });
      console.error(`Agent ${failure.code} [session ${session._id}]: ${message}`);
    } finally {
      clearTimeout(timer);
      await Session.updateOne(filter, { $set: { leaseUntil: new Date(0) }, $unset: { leaseToken: "" } });
      try { await notify({ profileId: String(session.profileId), sessionId: String(session._id) }); }
      catch { console.error("Agent live update unavailable; session remains available through the API"); }
    }
  };
}
module.exports = { createProcessor };
