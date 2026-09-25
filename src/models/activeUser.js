const mongoose = require("mongoose");

const ActiveUserSchema = new mongoose.Schema({
  profileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    required: true,
    unique: true,
  },
  location: {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
    },
    coordinates: {
      type: [Number],   
      required: true,
    },
  },
  socketId: { type: String, default: null },
  isActive: { type: Boolean, default: true },
  lastSeen: { type: Date, default: Date.now },
  locationObservedAt: Date,
  accuracy: Number,
  expireAt: {
    type: Date,
    default: () => new Date(Date.now() + 10 * 60 * 1000),
    expires: 0, 
  },
});


ActiveUserSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("ActiveUser", ActiveUserSchema);
