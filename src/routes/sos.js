const express = require("express");
const multer = require("multer");
const fs = require("fs");

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
      `audio_${Date.now()}.webm`
    );
  },

});



const upload = multer({
  storage,

  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

console.log(upload.single("audio"));
authSos.post(
  "/trigger",
  userMiddleware,
  upload.single("audio"),
  trigger
);


module.exports = authSos;