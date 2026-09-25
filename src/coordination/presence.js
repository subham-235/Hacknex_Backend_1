const { locationInput, acceptLocation } = require("./geo");
const { parseLatLon } = require("../utils/locationParser");
async function updatePresence(profileId, body, activate = false) {
  body = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const ActiveUser = require("../models/activeUser");
  const Session = require("../models/emergencySession");
  const Journey = require("../models/safetyJourney");
  const { responders, journeys } = require("./runtime");
  const input = typeof body.location === "object" ? body.location : body;
  for (const key of ["lat", "lon", "lng"]) {
    if (
      input?.[key] !== undefined &&
      typeof input[key] !== "number" &&
      (typeof input[key] !== "string" || !/^-?\d+(\.\d+)?$/.test(input[key]))
    )
      throw Object.assign(new Error("Malformed coordinates"), { status: 400 });
  }
  const coords = parseLatLon(body.location || body, body.lon);
  const point = locationInput({
    latitude: body.latitude ?? coords?.lat,
    longitude: body.longitude ?? coords?.lon,
    accuracy: body.accuracy,
    timestamp: body.timestamp,
  });
  const previous = await ActiveUser.findOne({ profileId }).lean();
  if (previous)
    acceptLocation(
      {
        latitude: previous.location.coordinates[1],
        longitude: previous.location.coordinates[0],
        observedAt: previous.locationObservedAt || previous.lastSeen,
        receivedAt: previous.lastSeen,
        accuracy: previous.accuracy,
      },
      point,
    );
  if (!previous && !activate)
    throw Object.assign(new Error("Activate location sharing first"), { status: 409 });
  let updated;
  try {
    updated = await ActiveUser.findOneAndUpdate(
      {
        profileId,
        ...(previous ? { lastSeen: previous.lastSeen } : { lastSeen: { $exists: false } }),
      },
      {
        $set: {
          ...(activate ? { isActive: true } : {}),
          lastSeen: point.receivedAt,
          locationObservedAt: point.observedAt,
          accuracy: point.accuracy,
          expireAt: new Date(Date.now() + 600000),
          location: { type: "Point", coordinates: [point.longitude, point.latitude] },
        },
      },
      { upsert: !previous, returnDocument: 'after' },
    ).lean();
  } catch (e) {
    if (e.code === 11000)
      throw Object.assign(new Error("Concurrent location update"), { status: 409 });
    throw e;
  }
  if (!updated) throw Object.assign(new Error("Concurrent location update"), { status: 409 });
  const payload = {
    latitude: point.latitude,
    longitude: point.longitude,
    accuracy: point.accuracy,
    timestamp: +point.observedAt,
  };
  const sessions = await Session.find({
    profileId,
    status: { $in: ["active", "acknowledged", "review_required"] },
    expiresAt: { $gt: new Date() },
  })
    .select("_id")
    .lean();
  for (const s of sessions) {
    try {
      await responders.location(s._id, profileId, payload, true);
    } catch (e) {
      if (![400, 409, 429].includes(e.status)) throw e;
    }
  }
  const journey = await Journey.findOne({ profileId, open: true }).lean();
  if (journey) {
    try {
      await journeys.location(journey._id, profileId, payload);
    } catch (e) {
      if (![400, 409, 429].includes(e.status)) throw e;
    }
  }
  return point;
}
module.exports = { updatePresence };
