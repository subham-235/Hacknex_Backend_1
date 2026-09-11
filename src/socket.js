const { Server } = require("socket.io");
const ActiveUser = require("./models/activeUser");
const jwt = require("jsonwebtoken");
const User = require("./models/user");
const redisClient = require("./config/redis");

let io = null;

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:5173",
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const tokenCookie = (socket.handshake.headers.cookie || "")
        .split(";")
        .map((value) => value.trim())
        .find((value) => value.startsWith("token="));
      const token = tokenCookie
        ? decodeURIComponent(tokenCookie.slice(6))
        : null;
      if (!token) throw new Error("Authentication required");
      const payload = jwt.verify(token, process.env.JWT_KEY);
      if (
        (await redisClient.exists(`token:${token}`)) ||
        !(await User.exists({ _id: payload._id }))
      )
        throw new Error("Authentication required");
      socket.data.profileId = String(payload._id);
      socket.data.tokenExpiresAt = payload.exp * 1000;
      next();
    } catch {
      next(new Error("Authentication required"));
    }
  });

  io.on("connection", (socket) => {
    socket.join(`user:${socket.data.profileId}`);
    const expiryTimer = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, socket.data.tokenExpiresAt - Date.now()),
    );
    console.log("Socket connected:", socket.id);

    // User registers their socket ID when app opens
    socket.on("register", async (profileId) => {
      if (profileId && String(profileId) !== socket.data.profileId) return;
      profileId = socket.data.profileId;
      try {
        await ActiveUser.findOneAndUpdate(
          { profileId },
          { socketId: socket.id },
        );
        console.log(`User ${profileId} registered socket`);
      } catch (err) {
        console.error("Socket register error:", err.message);
      }
    });

    // User disconnects — clean up
    socket.on("disconnect", async () => {
      clearTimeout(expiryTimer);
      try {
        await ActiveUser.findOneAndUpdate(
          { socketId: socket.id },
          { socketId: null, isActive: false },
        );
        console.log("Socket disconnected:", socket.id);
      } catch (err) {
        console.error("Socket disconnect error:", err.message);
      }
    });
  });

  return io;
};

const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};

module.exports = { initSocket, getIO };
