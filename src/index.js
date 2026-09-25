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

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Route Registrations
app.use("/user", require("./routes/userAuth"));
app.use("/contact", require("./routes/contactAuth"));
app.use("/sos", require("./routes/sos"));
app.use("/history", require("./routes/historyAuth"));
app.use("/location", require("./routes/locationAuth"));
app.use("/incident", require("./routes/incidentAuth"));
app.use("/agent", require("./routes/agent"));
app.use("/demo", require("./demo/routes"));

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
    await Promise.all([require('./models/emergencySession').init(), require('./models/safetyJourney').init(), require('./models/activeUser').init()]);
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
      await agentSubscriber.subscribe('suraksha-geo-updates', message => {
        try {
          const event = JSON.parse(message);
          if (event.simulated) {
            const validDemoId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
            if (process.env.ENABLE_DEMO_MODE === 'true' && validDemoId(event.profileId) && validDemoId(event.demoRunId)) {
              require('./socket').getIO().to(`user:${event.profileId}`).emit('demo-updated', { demoRunId: event.demoRunId, simulated: true });
            }
            return;
          }
          const allowed = ['responder-request-created', 'responder-accepted', 'responder-declined', 'responder-assigned', 'responder-location-updated', 'responder-nearby', 'responder-arrived', 'responder-arrival-candidate', 'emergency-radius-expanded', 'journey-deviation-detected', 'journey-checkin-required', 'journey-updated', 'agent-session-updated'];
          const valid = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
          if (!valid(event.profileId) || !allowed.includes(event.type) || (!valid(event.sessionId) && !valid(event.journeyId))) return;
          require('./socket').getIO().to(`user:${event.profileId}`).emit(event.type, { sessionId: event.sessionId, journeyId: event.journeyId });
          if (event.type === 'responder-request-created') require('./socket').publishNearbyAlert(event.profileId, { sessionId: event.sessionId, message: 'Someone nearby needs help!', distance: 'Open responder requests for approximate distance' });
        } catch { /* Ignore malformed internal events. */ }
      });
    };
    // Optional live updates must not prevent the initial SOS API from starting.
    subscribeToAgentUpdates().catch(error => console.error("Agent live updates unavailable:", error.name));
    console.log("DB & Redis Connected..");
    console.log(`GPS accuracy acceptance limit: ${require('./coordination/config').getGeoConfig().maxAccuracy}m`);
    if (process.env.ENABLE_DEMO_MODE === 'true') console.log('Demo GPS simulator enabled (authenticated, isolated demo records).');

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Initialization Error:", err);
  }
};

InitializeConnection();
