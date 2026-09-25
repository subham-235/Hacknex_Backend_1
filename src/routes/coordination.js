const router = require("express").Router();
const { createGeoHandlers } = require("../coordination/http");
const Session = require("../models/emergencySession");
const Journey = require("../models/safetyJourney");
const { responders, journeys } = require("../coordination/runtime");
const h = createGeoHandlers({ Session, Journey, responders, journeys });
router.get('/location-config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const config = require('../coordination/config').getGeoConfig();
  res.json({
    maxAccuracyMeters: config.maxAccuracy,
    journeyMaxAccuracyMeters: config.journeyMaxAccuracy,
  });
});
const maps = require("../coordination/maps").createMapService({
  redis: require("../config/redis"),
  Incident: require("../models/incident"),
});
const mapHandler = (fn) => async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    res.json(await fn(req));
  } catch (e) {
    res
      .status(e.status || 503)
      .json({ error: e.status ? e.message : "Map service is temporarily unavailable." });
  }
};
router.get(
  "/journeys/places",
  mapHandler((req) => maps.search(req.query.q)),
);
router.post(
  "/journeys/route",
  mapHandler((req) => maps.route(req.body)),
);
router.get("/responder-requests", h.inbox);
router.get("/sessions/:id/responder", h.detail);
router.post("/sessions/:id/responders/accept", h.respond("accepted"));
router.post("/sessions/:id/responders/decline", h.respond("declined"));
router.post("/sessions/:id/responder/location", h.location(false));
router.post("/sessions/:id/victim/location", h.location(true));
router.post("/sessions/:id/responder/status", h.state);
router.get("/journeys", h.journeys);
router.post("/journeys", h.start);
router.post("/journeys/:id/location", h.journeyLocation);
router.post("/journeys/:id/checkin", h.journeyAction);
module.exports = router;
