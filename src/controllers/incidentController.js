const Incident = require("../models/incident");
const { parseLatLon } = require("../utils/locationParser");

const getTimeOfDay = () => {
  const hour = new Date().getHours();
  if (hour >= 5  && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
};

const getHeatmap = async (req, res) => {
  try {
    const incidents = await Incident.find()
      .select("location severity incidentType")
      .limit(500);

    const heatmapPoints = incidents.map((inc) => [
      inc.location.coordinates[1],   // lat
      inc.location.coordinates[0],   // lon
      inc.severity / 5,              // intensity 0-1
    ]);

    return res.status(200).json({
      success: true,
      count: incidents.length,
      heatmapPoints,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// POST manual report
const reportIncident = async (req, res) => {
  try {
    const { location, lon, incidentType, severity } = req.body;

    const parsedCoords = parseLatLon(location || req.body, lon);

    if (!parsedCoords) {
      return res.status(400).json({ 
        error: "Valid location (Google Maps link or lat/lon coordinates) is required" 
      });
    }

    await Incident.create({
      location: {
        type: "Point",
        coordinates: [parsedCoords.lon, parsedCoords.lat],
      },
      incidentType: incidentType || "unsafe_area",
      reportedVia: "manual_report",
      severity: severity || 3,
      timeOfDay: getTimeOfDay(),
    });

    return res.status(201).json({ 
      success: true,
      message: "Incident reported. Thank you for keeping others safe." 
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports = { getHeatmap, reportIncident, getTimeOfDay };
