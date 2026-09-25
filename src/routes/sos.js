const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { randomUUID } = require("node:crypto");

const userMiddleware = require("../middleware/userMiddleware");
const trigger = require("../controllers/trigger");

const authSos = express.Router();

const storage = multer.diskStorage({

  destination: (req, file, cb) => {

    const dir = "./uploads/audio";

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, {
        recursive: true,
      });
    }

    cb(null, dir);
  },

  filename: (req, file, cb) => {

    cb(
      null,
      `audio_${randomUUID()}.webm`
    );
  },

});



const upload = multer({
  storage,

  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },
});

authSos.post(
  "/trigger",
  userMiddleware,
  upload.array("audio", 5),
  trigger
);


module.exports = authSos;
