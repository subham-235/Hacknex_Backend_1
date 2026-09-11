const express = require("express");
const router = express.Router();
const userMiddleware = require("../middleware/userMiddleware");
const { getHeatmap, reportIncident } = require("../controllers/incidentController");

router.get("/heatmap", getHeatmap);           // public
router.post("/report", userMiddleware, reportIncident);

module.exports = router;

