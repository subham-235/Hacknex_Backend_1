const mongoose = require("mongoose");
const { locationSchema } = require("../coordination/schema");
const schema = new mongoose.Schema(
  {
    profileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    open: { type: Boolean, default: true },
    status: {
      type: String,
      enum: [
        "active",
        "arrived",
        "cancelled",
        "attention_required",
        "escalated",
      ],
      default: "active",
    },
    startedAt: { type: Date, default: Date.now },
    expectedArrivalAt: Date,
    destination: { type: locationSchema, required: true },
    destinationLabel: { type: String, maxlength: 300 },
    travelMode: { type: String, enum: ["driving"] },
    routingPreference: {
      type: String,
      enum: ["normal", "safer"],
      default: "normal",
    },
    destinationRadiusMeters: Number,
    corridorToleranceMeters: Number,
    currentLocation: locationSchema,
    route: [locationSchema],
    destinationReached: { type: Boolean, default: false },
    outsideSamples: { type: Number, default: 0 },
    outsideSince: Date,
    routeDeviationDetected: { type: Boolean, default: false },
    checkInState: {
      type: String,
      enum: ["none", "pending", "safe", "unanswered"],
      default: "none",
    },
    checkInDueAt: Date,
    // Existing journeys keep their original check-in-only behavior.
    autoSosEnabled: { type: Boolean, default: false },
    sosState: { type: String, enum: ['none', 'sending', 'accepted', 'partial', 'failed', 'unknown', 'no_contacts'], default: 'none' },
    sosSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmergencySession' },
    sosStartedAt: Date,
    sosDeadline: Date,
    sosError: String,
    riskSignals: [String],
    nextCheckAt: { type: Date, default: Date.now },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);
schema.index(
  { profileId: 1 },
  { unique: true, partialFilterExpression: { open: true } },
);
schema.index({ open: 1, nextCheckAt: 1 });
module.exports = mongoose.model("SafetyJourney", schema);
