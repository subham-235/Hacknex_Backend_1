const idValid = (value) => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
function createGeoHandlers({ Session, Journey, responders, journeys }) {
  const handler = (fn) => async (req, res, next) => {
    try {
      if (req.params.id !== undefined && !idValid(req.params.id))
        return res.status(400).json({ error: "Invalid ID" });
      return res.json(await fn(req));
    } catch (e) {
      if (e.status || e.code === 11000)
        return res
          .status(e.status || 409)
          .json({ error: e.code === 11000 ? "Responder already assigned; retry" : e.message });
      next(e);
    }
  };
  return {
    inbox: handler(async (req) => {
      const sessions = await Session.find({
        "nearbyResponderRequests.responderUserId": req.user._id,
        status: { $in: ["active", "acknowledged", "review_required"] },
        expiresAt: { $gt: new Date() },
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
      return { requests: sessions.map((s) => responders.view(s, req.user._id)) };
    }),
    detail: handler(async (req) => {
      const s = await Session.findById(req.params.id).lean();
      if (!s) throw Object.assign(new Error("Request not found"), { status: 404 });
      return responders.view(s, req.user._id);
    }),
    respond: (decision) =>
      handler(async (req) => ({
        result: responders.view(
          await responders.respond(req.params.id, req.user._id, decision),
          req.user._id,
        ),
      })),
    location: (victim) =>
      handler(async (req) => {
        await responders.location(req.params.id, req.user._id, req.body, victim);
        return { success: true };
      }),
    state: handler(async (req) => {
      await responders.state(req.params.id, req.user._id, req.body?.status);
      return { success: true };
    }),
    journeys: handler(async (req) => ({
      journeys: (await Journey.find({ profileId: req.user._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean()).map(j => journeys.view ? journeys.view(j) : j),
    })),
    start: handler(async (req) => ({ journey: await journeys.start(req.user._id, req.body) })),
    journeyLocation: handler(async (req) => ({
      journey: await journeys.location(req.params.id, req.user._id, req.body),
    })),
    journeyAction: handler(async (req) => ({
      journey: await journeys.action(req.params.id, req.user._id, req.body?.action),
    })),
  };
}
module.exports = { createGeoHandlers, idValid };
