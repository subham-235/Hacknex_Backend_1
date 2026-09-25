const mongoose = require("mongoose");
// Identical production schemas and indexes, isolated collections. Production
// workers, community discovery and device GPS never read these collections.
const clone = (name, source) => mongoose.model(name, require(source).schema.clone());
const Session = clone("DemoEmergencySession", "../models/emergencySession");
const Journey = clone("DemoSafetyJourney", "../models/safetyJourney");
const presence = require("../models/activeUser").schema.clone();
presence.add({ demoRunId: mongoose.Schema.Types.ObjectId });
const ActiveUser = mongoose.model("DemoActiveUser", presence);
const Run = mongoose.model(
  "DemoRun",
  new mongoose.Schema(
    {
      owner: { type: mongoose.Schema.Types.ObjectId, unique: true, required: true },
      victim: mongoose.Schema.Types.ObjectId,
      responder: mongoose.Schema.Types.ObjectId,
      sessionId: mongoose.Schema.Types.ObjectId,
      journeyId: mongoose.Schema.Types.ObjectId,
      clock: Number,
      checkInWallDeadline: Date,
      fast: { type: Boolean, default: true },
      lockedUntil: { type: Date, default: () => new Date(0) },
      previousCenter: { latitude: Number, longitude: Number },
      liveSmsClaims: { type: [String], default: [] },
      liveSmsResult: {
        kind: String,
        attempted: Number,
        accepted: Number,
        failed: Number,
        at: Date,
      },
    },
    { timestamps: true },
  ),
);
module.exports = { Session, Journey, ActiveUser, Run };
