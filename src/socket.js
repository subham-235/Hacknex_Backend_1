const { Server } = require("socket.io");
const ActiveUser = require("./models/activeUser");
const jwt = require("jsonwebtoken");
const User = require("./models/user");
const redisClient = require("./config/redis");
const { createNearbyAlerts } = require("./nearbyAlerts");
const nearbyAlerts = createNearbyAlerts();

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
    const connectedAt = Date.now();
    socket.join(`user:${socket.data.profileId}`);
    const expiryTimer = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, socket.data.tokenExpiresAt - Date.now()),
    );
    console.log("Socket connected:", socket.id);
    socket.on("nearby-sos-sync", () => {
      for (const alert of nearbyAlerts.list(socket.data.profileId)) {
        socket.emit("nearby-sos", alert);
      }
    });
    socket.on("nearby-sos-received", (id) => {
      if (nearbyAlerts.list(socket.data.profileId).some(alert => alert.id === id)) {
        console.log("Nearby SOS received by helper browser:", id);
      }
    });

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
    socket.on("disconnect", async (reason) => {
      clearTimeout(expiryTimer);
      // Log before database cleanup, which may be slow or fail.
      console.log("Socket disconnected:", socket.id, {
        reason,
        connectedForMs: Date.now() - connectedAt,
        transport: socket.conn?.transport?.name,
      });
      try {
        await ActiveUser.findOneAndUpdate(
          { socketId: socket.id },
          // Sharing ends explicitly or when its location expires. A transport
          // disconnect must not disable a helper after reconnect or in another tab.
          { socketId: null },
        );
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

const publishNearbyAlert = (profileId, payload) => {
  const alert = nearbyAlerts.add(profileId, payload);
  getIO().to(`user:${profileId}`).emit("nearby-sos", alert);
};

module.exports = { initSocket, getIO, publishNearbyAlert };
