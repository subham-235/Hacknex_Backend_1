const mongoose = require("mongoose");

const IncidentSchema = new mongoose.Schema({
  location: {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
    },
    coordinates: { 
      type: [Number],   
      required: true 
    },
  },
  incidentType: {
    type: String,
    enum: ["sos_triggered", "harassment", "unsafe_area", "other"],
    default: "sos_triggered",
  },
  reportedVia: {
    type: String,
    enum: ["sos_auto", "manual_report"],
    default: "sos_auto",
  },
  severity: { 
    type: Number, 
    min: 1, 
    max: 5, 
    default: 3 
  },
  timeOfDay: {
    type: String,
    enum: ["morning", "afternoon", "evening", "night"],
  },
  createdAt: { type: Date, default: Date.now },
});

IncidentSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("Incident", IncidentSchema);

