const mongoose = require("mongoose");
const { Schema } = mongoose;
const attemptSchema = new Schema({
  contactId: { type: Schema.Types.ObjectId, ref: "contact", required: true },
  kind: { type: String, enum: ["initial", "followup"], required: true },
  status: { type: String, default: "pending" },
  sid: String,
  error: String,
  createdAt: { type: Date, default: Date.now },
});
const actionSchema = new Schema({
  contactId: { type: Schema.Types.ObjectId, ref: "contact", required: true },
  reason: { type: String, maxlength: 500 },
  state: {
    type: String,
    enum: [
      "proposed",
      "approved",
      "rejected",
      "sending",
      "accepted",
      "failed",
      "unknown",
      "blocked",
    ],
    default: "proposed",
  },
  createdAt: { type: Date, default: Date.now },
});
const sessionSchema = new Schema(
  {
    ...require('../coordination/schema').fields,
    profileId: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
      index: true,
    },
    historyId: { type: Schema.Types.ObjectId, ref: "history" },
    reference: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: [
        "active",
        "acknowledged",
        "resolved",
        "expired",
        "review_required",
      ],
      default: "active",
    },
  ready: { type: Boolean, default: false },
  initialDeadline: { type: Date, required: true },
    summary: String,
    severity: String,
    location: { mapsLink: String, observedAt: Date },
    recipients: [
      {
        contactId: Schema.Types.ObjectId, label: String, number: String,
        responseTokenHashes: { type: [String], default: undefined },
        responseStatus: { type: String, enum: ['pending', 'coming', 'cannot_help', 'arrived'], default: 'pending' },
        respondedAt: Date,
        lastLocation: {
          latitude: Number, longitude: Number, accuracy: Number,
          observedAt: Date, receivedAt: Date,
        },
      },
    ],
    attempts: [attemptSchema],
    actions: [actionSchema],
    events: [
      {
        key: String,
        type: { type: String },
        contactId: Schema.Types.ObjectId,
        text: String,
        at: { type: Date, default: Date.now },
      },
    ],
    acknowledgments: [
      {
        contactId: Schema.Types.ObjectId,
        at: { type: Date, default: Date.now },
      },
    ],
    processedMessageSids: [String],
    nextRunAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    leaseUntil: { type: Date, default: () => new Date(0) },
    leaseToken: String,
    runCount: { type: Number, default: 0 },
    followupCount: { type: Number, default: 0 },
    lastError: String,
    aiFailureCount: { type: Number, default: 0 },
    aiRetryAfter: Date,
    resolvedAt: Date,
  },
  { timestamps: true },
);
sessionSchema.index({ ready: 1, status: 1, nextRunAt: 1, leaseUntil: 1 });
sessionSchema.index({ "attempts.sid": 1 });
sessionSchema.index({ 'recipients.responseTokenHashes': 1 });
sessionSchema.index({ status: 1, coordinationNextRunAt: 1 });
sessionSchema.index({ 'nearbyResponderRequests.responderUserId': 1, status: 1 });
// One responder cannot be primary on two incidents, even across API processes.
sessionSchema.index({ 'activeResponder.userId': 1 }, { unique: true, partialFilterExpression: { 'activeResponder.userId': { $type: 'objectId' } } });
module.exports = mongoose.model("EmergencySession", sessionSchema);
