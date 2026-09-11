const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const cookieParser = require("cookie-parser");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const main = require("./config/db");
const redisClient = require("./config/redis");
const { initSocket } = require("./socket");

const app = express();
const httpServer = http.createServer(app);

// Initialize Socket.io
initSocket(httpServer);

// Configure CORS
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  })
);

app.use(express.json());
app.use(cookieParser());

// Route Registrations
app.use("/user", require("./routes/userAuth"));
app.use("/contact", require("./routes/contactAuth"));
app.use("/sos", require("./routes/sos"));
app.use("/history", require("./routes/historyAuth"));
app.use("/location", require("./routes/locationAuth"));
app.use("/incident", require("./routes/incidentAuth"));
app.use("/agent", require("./routes/agent"));

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

const InitializeConnection = async () => {
  try {
    await Promise.all([main(), redisClient.connect()]);
    // Worker notifications contain IDs only; clients fetch details through the owner-scoped API.
    const agentSubscriber = redisClient.duplicate();
    agentSubscriber.on("error", error => console.error("Agent update subscriber:", error.name));
    const subscribeToAgentUpdates = async () => {
      await agentSubscriber.connect();
      await agentSubscriber.subscribe("suraksha-agent-updates", message => {
      try {
        const event = JSON.parse(message);
        if (/^[a-f0-9]{24}$/i.test(event.profileId) && /^[a-f0-9]{24}$/i.test(event.sessionId)) {
          require("./socket").getIO().to(`user:${event.profileId}`).emit("agent-session-updated", { sessionId: event.sessionId });
        }
      } catch { /* Ignore malformed internal notifications. */ }
      });
    };
    // Optional live updates must not prevent the initial SOS API from starting.
    subscribeToAgentUpdates().catch(error => console.error("Agent live updates unavailable:", error.name));
    console.log("DB & Redis Connected..");

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Initialization Error:", err);
  }
};

InitializeConnection();
