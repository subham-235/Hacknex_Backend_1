function getGeoConfig(env = process.env) {
  const n = (key, fallback, min = 1, max = 86400) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const config = {
    maxRoutePoints: n("JOURNEY_MAX_ROUTE_POINTS", 2000, 200, 2000),
    heatmapGridDegrees: n("PUBLIC_HEATMAP_GRID_DEGREES", 0.01, 0.005, 0.1),
    radii: [
      n("RESPONDER_RADIUS_INITIAL_METERS", 1000, 100, 10000),
      n("RESPONDER_RADIUS_SECONDARY_METERS", 2000, 100, 10000),
      n("RESPONDER_RADIUS_MAX_METERS", 3000, 100, 10000),
    ],
    acceptMs: n("RESPONDER_ACCEPT_TIMEOUT_SECONDS", 30, 10, 600) * 1000,
    staleMs: n("RESPONDER_LOCATION_STALE_SECONDS", 120, 30, 600) * 1000,
    near: n("RESPONDER_GEOFENCE_NEAR_METERS", 100, 20, 500),
    arrived: n("RESPONDER_GEOFENCE_ARRIVED_METERS", 20, 5, 100),
    approaching: n("RESPONDER_GEOFENCE_APPROACHING_METERS", 500, 100, 2000),
    movement: n("EMERGENCY_GEOFENCE_RECALC_DISTANCE_METERS", 250, 50, 2000),
    recalcMs: n("EMERGENCY_GEOFENCE_RECALC_SECONDS", 30, 10, 600) * 1000,
    destinationRadius: n("JOURNEY_DESTINATION_RADIUS_METERS", 150, 50, 500),
    tolerance: n("JOURNEY_DEVIATION_TOLERANCE_METERS", 200, 50, 1000),
    deviationMs: n("JOURNEY_DEVIATION_CONFIRM_SECONDS", 60, 20, 600) * 1000,
    outsideSamples: n("GEOFENCE_REQUIRED_OUTSIDE_SAMPLES", 3, 2, 20),
    graceMs: n("JOURNEY_ARRIVAL_GRACE_MINUTES", 5, 1, 60) * 60000,
    checkinMs: n("JOURNEY_CHECKIN_TIMEOUT_SECONDS", 300, 30, 3600) * 1000,
    locationIntervalMs: n("GEO_LOCATION_MIN_INTERVAL_SECONDS", 5, 1, 60) * 1000,
    maxAccuracy: n("GEO_MAX_ACCURACY_METERS", 250, 10, 500),
    journeyMaxAccuracy: n("JOURNEY_MAX_ACCURACY_METERS", 2000, 100, 5000),
    maxSpeed: n("GEO_MAX_SPEED_METERS_PER_SECOND", 70, 10, 150),
    maxRequests: n("RESPONDER_MAX_REQUESTS_PER_SESSION", 200, 10, 1000),
  };
  if (
    config.radii.some((r, i) => i && r <= config.radii[i - 1]) ||
    config.arrived >= config.near ||
    config.near >= config.approaching
  )
    throw new Error("Geo thresholds must be increasing");
  if (config.journeyMaxAccuracy < config.maxAccuracy)
    throw new Error(
      "Journey GPS accuracy limit cannot be stricter than the rescue GPS limit",
    );
  return config;
}
module.exports = { getGeoConfig };
