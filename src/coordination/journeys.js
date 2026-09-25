const { getGeoConfig } = require("./config");
const geo = require("./geo");
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
function createJourneyService({
  Journey,
  notify = async () => {},
  now = Date.now,
  config = getGeoConfig(),
  escalate,
}) {
  async function start(profileId, body) {
    body = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    if (!geo.validPoint(body.destination)) fail("Valid destination required", 400);
    // Delivery-style journey tracking can begin with a coarse desktop/network
    // fix, then refine as better GPS readings arrive. Accuracy is still folded
    // into every arrival and deviation calculation.
    const journeyLocationConfig = { ...config, maxAccuracy: config.journeyMaxAccuracy };
    const point = geo.locationInput(body.startLocation, now(), journeyLocationConfig);
    if (
      body.route !== undefined &&
      (!Array.isArray(body.route) ||
        body.route.length < 2 ||
        body.route.length > config.maxRoutePoints ||
        !body.route.every(geo.validPoint))
    )
      fail(`Route requires 2–${config.maxRoutePoints} valid points`, 400);
    const expected = body.expectedArrivalAt ? new Date(body.expectedArrivalAt) : null;
    if (
      expected &&
      (!Number.isFinite(+expected) || +expected <= now() || +expected > now() + 86400000)
    )
      fail("Arrival must be within the next 24 hours", 400);
    // Explicitly pick coordinates; never copy client supplied schema fields.
    const clean = (p) => ({ latitude: p.latitude, longitude: p.longitude });
    try {
      return await Journey.create({
        profileId,
        autoSosEnabled: true,
        destination: clean(body.destination),
        destinationLabel: typeof body.destinationLabel === 'string' ? body.destinationLabel.trim().slice(0, 300) : undefined,
        travelMode: body.travelMode === 'driving' ? 'driving' : undefined,
        routingPreference: body.routingPreference === 'safer' ? 'safer' : 'normal',
        destinationRadiusMeters: config.destinationRadius,
        corridorToleranceMeters: config.tolerance,
        currentLocation: point,
        route: (body.route || []).map(clean),
        expectedArrivalAt: expected,
        nextCheckAt: new Date(now() + 15000),
      });
    } catch (e) {
      if (e.code === 11000) fail("An open journey already exists");
      throw e;
    }
  }
  async function mutate(id, profileId, change) {
    for (let retry = 0; retry < 8; retry++) {
      const j = await Journey.findOne({ _id: id, profileId }).lean();
      if (!j) fail("Journey not found", 404);
      if (!j.open) fail("Journey is closed");
      const patch = change(j);
      const updated = await Journey.findOneAndUpdate(
        { _id: id, profileId, open: true, version: j.version },
        { $set: patch, $inc: { version: 1 } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) continue;
      try {
        await notify({
          profileId: String(profileId),
          journeyId: String(id),
          type:
            updated.routeDeviationDetected && !j.routeDeviationDetected
              ? "journey-deviation-detected"
              : updated.checkInState === "pending"
                ? "journey-checkin-required"
                : "journey-updated",
        });
      } catch {
        /* persisted state remains available */
      }
      return updated;
    }
    fail("Concurrent journey update; retry");
  }
  async function location(id, profileId, body) {
    const point = geo.locationInput(body, now(), {
      ...config,
      maxAccuracy: config.journeyMaxAccuracy,
    });
    return mutate(id, profileId, (j) => {
      geo.acceptLocation(j.currentLocation, point, config);
      const result = geo.evaluateJourney(j, point, now(), config);
      return {
        ...result,
        currentLocation: point,
        ...(result.destinationReached ? { open: false, route: [] } : {}),
        nextCheckAt: new Date(now() + 15000),
      };
    });
  }
  async function action(id, profileId, action) {
    if (!["safe", "continue", "cancel"].includes(action)) fail("Invalid journey action", 400);
    if (action === "continue") {
      return mutate(id, profileId, (j) => {
        if (!["pending", "unanswered"].includes(j.checkInState))
          fail("There is no active safety check to confirm", 409);
        if (j.sosState && j.sosState !== "none")
          fail("The automatic SOS has already started", 409);
        const at = now();
        return {
          open: true,
          status: "active",
          checkInState: "none",
          checkInDueAt: null,
          expectedArrivalAt: new Date(at + config.checkinMs),
          routeDeviationDetected: false,
          outsideSamples: 0,
          outsideSince: null,
          riskSignals: (j.riskSignals || []).filter(
            (signal) =>
              !["DESTINATION_OVERDUE", "ROUTE_DEVIATION"].includes(signal),
          ),
          nextCheckAt: new Date(at + 15000),
        };
      });
    }
    // A safety confirmation closes monitoring; starting another journey is explicit.
    return mutate(id, profileId, () => ({
      open: false,
      status: "cancelled",
      checkInState: action === "safe" ? "safe" : "none",
      riskSignals: [],
      route: [],
    }));
  }
  async function check(id, profileId) {
    const updated = await mutate(id, profileId, (j) => {
      const at = now(),
        risks = new Set(j.riskSignals || []);
      if (at - +new Date(j.currentLocation?.observedAt) > config.staleMs)
        risks.add("LOCATION_STALE");
      const overdue =
        j.expectedArrivalAt &&
        at > +new Date(j.expectedArrivalAt) &&
        !j.destinationReached;
      if (overdue) risks.add("DESTINATION_OVERDUE");
      let state = j.checkInState,
        due = j.checkInDueAt,
        status = j.status;
      if ((overdue || j.routeDeviationDetected) && state === "none") {
        state = "pending";
        due = new Date(at + config.checkinMs);
        status = "attention_required";
      }
      if (state === "pending" && +new Date(due) <= at) {
        state = "unanswered";
        status = "escalated";
      }
      return {
        checkInState: state,
        checkInDueAt: due,
        status,
        riskSignals: [...risks],
        nextCheckAt: new Date(at + 15000),
      };
    });
    if (escalate && updated.autoSosEnabled && updated.checkInState === 'unanswered') {
      await escalate(id, profileId);
      return Journey.findOne({ _id: id, profileId }).lean();
    }
    return updated;
  }
  function view(journey) {
    const j = journey.toObject ? journey.toObject() : journey;
    const age = Math.max(0, (now() - +new Date(j.currentLocation?.observedAt || 0)) / 1000);
    return { ...j,
      checkInTimeoutSeconds: config.checkinMs / 1000,
      locationAgeSeconds: Math.round(age),
      locationFresh: age * 1000 <= config.staleMs,
      locationPrecise: (j.currentLocation?.accuracy ?? config.journeyMaxAccuracy) <= config.maxAccuracy,
      destinationDistanceMeters: geo.validPoint(j.currentLocation) ? Math.round(geo.distance(j.currentLocation, j.destination)) : null,
      distanceFromRouteMeters: geo.validPoint(j.currentLocation) && j.route?.length >= 2 ? Math.round(geo.corridorDistance(j.currentLocation, j.route)) : null,
      outsideSeconds: j.outsideSince ? Math.max(0, Math.round((now() - +new Date(j.outsideSince)) / 1000)) : 0,
    };
  }
  return { start, location, action, check, view };
}
module.exports = { createJourneyService };
