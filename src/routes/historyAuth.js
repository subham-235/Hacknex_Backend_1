const express = require("express");
const router = express.Router();
const userMiddleware = require("../middleware/userMiddleware");
const { 
  getHistory, 
  getAlertById, 
  deleteAlert 
} = require("../controllers/historyController");

router.get("/list", userMiddleware, getHistory);
router.get("/detail/:id", userMiddleware, getAlertById);
router.delete("/delete/:id", userMiddleware, deleteAlert);

module.exports = router;

