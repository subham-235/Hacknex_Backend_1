const { Schema } = require("mongoose");
const locationSchema = new Schema(
  { latitude: Number, longitude: Number, accuracy: Number, observedAt: Date, receivedAt: Date },
  { _id: false },
);
const assignmentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "user" },
    acceptedAt: Date,
    assignedAt: Date,
    currentStatus: {
      type: String,
      enum: ["assigned", "en_route", "nearby", "arrived", "completed", "cancelled"],
    },
    lastLocation: locationSchema,
    arrivalCandidateAt: Date,
  },
  { _id: false },
);
const fields = {
  distressConfidence: Number,
  initialVictimLocation: locationSchema,
  latestVictimLocation: locationSchema,
  nearbyResponderRequests: [
    {
      responderUserId: { type: Schema.Types.ObjectId, ref: "user" },
      status: { type: String, enum: ["pending", "accepted", "declined", "expired", "cancelled"] },
      distanceAtNotification: Number,
      notifiedAt: Date,
      respondedAt: Date,
      expiresAt: Date,
    },
  ],
  activeResponder: { type: assignmentSchema, default: null },
  responderHistory: [{ userId: Schema.Types.ObjectId, status: String, at: Date }],
  responderTracking: {
    distanceMeters: Number,
    estimatedEtaSeconds: Number,
    estimated: Boolean,
    zone: String,
    fresh: Boolean,
    lastUpdatedAt: Date,
  },
  escalationStage: { type: Number, default: 0 },
  escalationHistory: [{ stage: Number, radiusMeters: Number, at: Date }],
  escalationState: { type: String, default: "searching" },
  emergencyGeofence: { center: locationSchema, searchCenter: locationSchema, lastQueriedAt: Date, radiusMeters: Number },
  geoRiskSignals: [String],
  geoEvents: [{ type: { type: String }, at: Date }],
  coordinationVersion: { type: Number, default: 0 },
  coordinationNextRunAt: { type: Date, default: Date.now },
};
module.exports = { fields, locationSchema };
