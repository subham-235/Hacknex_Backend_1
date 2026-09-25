const ActiveUser = require("../models/activeUser");
const { updatePresence } = require("../coordination/presence");
const { wakeForLocation } = require("../agent/sessions");
function locationHandler(activate) {
  return async (req, res) => {
    try {
      await updatePresence(req.user._id, req.body, activate);
      try { await wakeForLocation(req.user._id); } catch (e) { console.error("Agent location wake failed:", e.name); }
      return res.status(200).json({ success: true, ...(activate ? { message: "Suraksha Mode activated. You are now protecting your community." } : {}) });
    } catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : "Location update failed" }); }
  };
}
async function deactivateLocation(req, res) {
  try {
    await ActiveUser.findOneAndUpdate({ profileId: req.user._id }, { isActive: false });
    return res.status(200).json({ success: true, message: "Suraksha Mode deactivated" });
  } catch { return res.status(500).json({ error: "Location update failed" }); }
}
module.exports = { activateLocation: locationHandler(true), updateLocation: locationHandler(false), deactivateLocation };
