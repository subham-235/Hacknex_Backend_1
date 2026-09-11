const mongoose = require("mongoose");
const { Schema } = mongoose;

const historyScheme = new Schema(
  {
    confidencePercentage: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    transcript: {
      type: String,
      required: true,
    },
    severity: {
      type: String,
      required: true,
      enum: ["High", "Medium", "Low"],
      default: "Low",
    },
    sent: [
      {
        type: Schema.Types.ObjectId,
        ref: "contact",
      },
    ],
    location: {
      mapsLink: {
        type: String,
        required: true,
      },
    },
    summary: {
      type: String,
      required: true,
    },
    profileId: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

const History = mongoose.model("history", historyScheme);
module.exports = History;
