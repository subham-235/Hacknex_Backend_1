const express = require("express");
const router = express.Router();
const userMiddleware = require("../middleware/userMiddleware");
const { 
  activateLocation, 
  updateLocation, 
  deactivateLocation 
} = require("../controllers/locationController");

router.post("/activate", userMiddleware, activateLocation);
router.patch("/update", userMiddleware, updateLocation);
router.post("/deactivate", userMiddleware, deactivateLocation);

module.exports = router;

