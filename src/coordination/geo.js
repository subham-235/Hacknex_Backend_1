const { getGeoConfig } = require("./config");
const radians = (d) => (d * Math.PI) / 180;
function validPoint(p) {
  return (
    p &&
    typeof p.latitude === "number" &&
    Number.isFinite(p.latitude) &&
    Math.abs(p.latitude) <= 90 &&
    typeof p.longitude === "number" &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.longitude) <= 180
  );
}
function distance(a, b) {
  const h =
    Math.sin(radians(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(radians(b.longitude - a.longitude) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function locationInput(body, now = Date.now(), config = getGeoConfig()) {
  body = body || {};
  if (!validPoint(body))
    throw Object.assign(
      new Error("Valid numeric latitude and longitude required"),
      {
        status: 400,
      },
    );
  const at = new Date(body.timestamp ?? now);
  if (!Number.isFinite(+at) || +at > now + 10000 || +at < now - config.staleMs)
    throw Object.assign(new Error("Location timestamp is stale or invalid"), {
      status: 400,
    });
  if (
    body.accuracy !== undefined &&
    (typeof body.accuracy !== "number" ||
      !Number.isFinite(body.accuracy) ||
      body.accuracy < 0 ||
      body.accuracy > config.maxAccuracy)
  )
    throw Object.assign(new Error("Location accuracy is insufficient"), {
      status: 400,
    });
  return {
    latitude: body.latitude,
    longitude: body.longitude,
    accuracy: body.accuracy,
    observedAt: at,
    receivedAt: new Date(now),
  };
}
function acceptLocation(previous, next, config = getGeoConfig()) {
  if (!previous?.observedAt) return;
  const elapsed = +new Date(next.observedAt) - +new Date(previous.observedAt);
  if (elapsed <= 0)
    throw Object.assign(new Error("Out-of-order location"), { status: 409 });
  if (
    +next.receivedAt - +new Date(previous.receivedAt || previous.observedAt) <
    config.locationIntervalMs
  )
    throw Object.assign(new Error("Location updates are too frequent"), {
      status: 429,
    });
  if (
    distance(previous, next) >
    (config.maxSpeed * elapsed) / 1000 +
      (previous.accuracy || 0) +
      (next.accuracy || 0)
  )
    throw Object.assign(new Error("Implausible GPS jump"), { status: 400 });
}
function getCurrentEmergencyCenter(
  session,
  now = Date.now(),
  config = getGeoConfig(),
) {
  let point = validPoint(session.latestVictimLocation)
    ? session.latestVictimLocation
    : session.initialVictimLocation;
  if (!validPoint(point) && session.location?.mapsLink) {
    const parsed = require("../utils/locationParser").parseLatLon(
      session.location.mapsLink,
    );
    if (parsed)
      point = {
        latitude: parsed.lat,
        longitude: parsed.lon,
        observedAt: session.location.observedAt,
      };
  }
  if (!validPoint(point)) return null;
  const ageSeconds = Math.max(
    0,
    (now - +new Date(point.observedAt || 0)) / 1000,
  );
  return { ...point, ageSeconds, fresh: ageSeconds * 1000 <= config.staleMs };
}
function tracking(
  victim,
  responder,
  now = Date.now(),
  config = getGeoConfig(),
) {
  if (!validPoint(victim) || !validPoint(responder)) return null;
  const meters = distance(victim, responder);
  const fresh =
    now - +new Date(victim.observedAt) <= config.staleMs &&
    now - +new Date(responder.observedAt) <= config.staleMs;
  // Unknown GPS accuracy cannot support an automatic arrival candidate.
  const precise =
    Number.isFinite(victim.accuracy) &&
    Number.isFinite(responder.accuracy) &&
    victim.accuracy + responder.accuracy <= config.arrived;
  const zone = !fresh
    ? "unknown"
    : meters <= config.arrived && precise
      ? "arrival_candidate"
      : meters <= config.near
        ? "nearby"
        : meters <= config.approaching
          ? "approaching"
          : "en_route";
  return {
    distanceMeters: Math.round(meters),
    estimatedEtaSeconds: fresh ? Math.ceil((meters * 1.4) / 1.1 + 60) : null,
    estimated: true,
    zone,
    fresh,
    lastUpdatedAt: new Date(now),
  };
}
// Spherical cross-track distance to a bounded great-circle route segment.
function corridorDistance(point, route) {
  if (!Array.isArray(route) || route.length < 2) return null;
  const bearing = (a, b) =>
    Math.atan2(
      Math.sin(radians(b.longitude - a.longitude)) *
        Math.cos(radians(b.latitude)),
      Math.cos(radians(a.latitude)) * Math.sin(radians(b.latitude)) -
        Math.sin(radians(a.latitude)) *
          Math.cos(radians(b.latitude)) *
          Math.cos(radians(b.longitude - a.longitude)),
    );
  return Math.min(
    ...route.slice(1).map((b, i) => {
      const a = route[i],
        d = distance(a, point) / 6371000,
        angle = bearing(a, point) - bearing(a, b);
      const along =
        Math.atan2(Math.sin(d) * Math.cos(angle), Math.cos(d)) * 6371000;
      if (along < 0 || along > distance(a, b))
        return Math.min(distance(a, point), distance(b, point));
      return (
        Math.abs(
          Math.asin(Math.max(-1, Math.min(1, Math.sin(d) * Math.sin(angle)))),
        ) * 6371000
      );
    }),
  );
}
function evaluateJourney(journey, point, now, config = getGeoConfig()) {
  const reached =
    distance(point, journey.destination) +
      (point.accuracy ?? config.maxAccuracy) <=
    config.destinationRadius;
  if (reached)
    return {
      status: "arrived",
      destinationReached: true,
      checkInState: "safe",
      outsideSamples: 0,
      outsideSince: null,
      routeDeviationDetected: false,
      riskSignals: [],
    };
  const outside = corridorDistance(point, journey.route);
  const gap =
    journey.currentLocation?.observedAt &&
    now - +new Date(journey.currentLocation.observedAt) > config.staleMs;
  const samples =
    outside !== null && outside > config.tolerance + (point.accuracy || 0)
      ? (gap ? 0 : journey.outsideSamples || 0) + 1
      : 0;
  const since = samples
    ? (!gap && journey.outsideSince) || new Date(now)
    : null;
  const deviation =
    samples >= config.outsideSamples &&
    now - +new Date(since) >= config.deviationMs;
  const risks = (journey.riskSignals || []).filter(
    (s) => s !== "ROUTE_DEVIATION" && s !== "LOCATION_STALE",
  );
  if (deviation) risks.push("ROUTE_DEVIATION");
  return {
    outsideSamples: samples,
    outsideSince: since,
    routeDeviationDetected: deviation,
    riskSignals: risks,
    ...(deviation
      ? {
          status: "attention_required",
          checkInState:
            journey.checkInState === "unanswered" ? "unanswered" : "pending",
          checkInDueAt:
            journey.checkInDueAt || new Date(now + config.checkinMs),
        }
      : {}),
  };
}
module.exports = {
  validPoint,
  distance,
  locationInput,
  acceptLocation,
  getCurrentEmergencyCenter,
  tracking,
  corridorDistance,
  evaluateJourney,
};
