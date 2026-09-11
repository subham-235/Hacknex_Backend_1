const ActiveUser = require("../models/activeUser");
const { parseLatLon } = require("../utils/locationParser");
const { wakeForLocation } = require("../agent/sessions");

// POST — user activates Suraksha Mode

const activateLocation = async (req, res) => {
  try {
    const { socketId, location, lon } = req.body;
    const profileId = req.user._id;

    const parsedCoords = parseLatLon(location || req.body, lon);

    if (!parsedCoords) {
      return res.status(400).json({ 
        error: "Valid location (Google Maps link or lat/lon coordinates) is required" 
      });
    }

    await ActiveUser.findOneAndUpdate(
      { profileId },
      {
        profileId,
        socketId: socketId || null,
        isActive: true,
        lastSeen: new Date(),
        expireAt: new Date(Date.now() + 10 * 60 * 1000),
        location: {
          type: "Point",
          coordinates: [parsedCoords.lon, parsedCoords.lat], 
        },
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Suraksha Mode activated. You are now protecting your community.",
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// PATCH — update location every 30 seconds
const updateLocation = async (req, res) => {
  try {
    const { location, lon } = req.body;
    const profileId = req.user._id;

    const parsedCoords = parseLatLon(location || req.body, lon);

    if (!parsedCoords) {
      return res.status(400).json({ 
        error: "Valid location (Google Maps link or lat/lon coordinates) is required" 
      });
    }

    await ActiveUser.findOneAndUpdate(
      { profileId },
      {
        lastSeen: new Date(),
        expireAt: new Date(Date.now() + 10 * 60 * 1000),
        location: {
          type: "Point",
          coordinates: [parsedCoords.lon, parsedCoords.lat],
        },
      }
    );

    try { await wakeForLocation(profileId); }
    catch (error) { console.error("Agent location wake failed:", error.name); }
    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// POST — user deactivates Suraksha Mode
const deactivateLocation = async (req, res) => {
  try {
    const profileId = req.user._id;

    await ActiveUser.findOneAndUpdate(
      { profileId },
      { isActive: false }
    );

    return res.status(200).json({
      success: true,
      message: "Suraksha Mode deactivated",
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports = { 
  activateLocation, 
  updateLocation, 
  deactivateLocation 
};
