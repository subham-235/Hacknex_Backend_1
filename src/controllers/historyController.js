const History = require("../models/history");

// GET all alerts for logged in user
const getHistory = async (req, res) => {
  try {
    const profileId = req.user._id;

    const history = await History.find({ profileId })
      .sort({ createdAt: -1 })   
      .limit(20)
      .populate("sent", "contacts contactNumber");

    return res.status(200).json({
      success: true,
      count: history.length,
      history,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// GET single alert detail
const getAlertById = async (req, res) => {
  try {
    const { id } = req.params;
    const profileId = req.user._id;

    const alert = await History.findOne({ 
      _id: id, 
      profileId 
    }).populate("sent", "contacts contactNumber");

    if (!alert) {
      return res.status(404).json({ 
        error: "Alert not found" 
      });
    }

    return res.status(200).json({ 
      success: true, 
      alert 
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// DELETE single alert from history
const deleteAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const profileId = req.user._id;

    const deletedAlert = await History.findOneAndDelete({ _id: id, profileId });

    if (!deletedAlert) {
      return res.status(404).json({
        error: "Alert not found",
      });
    }

    return res.status(200).json({ 
      success: true, 
      message: "Alert removed from history" 
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports = { getHistory, getAlertById, deleteAlert };

