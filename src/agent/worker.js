require("dotenv").config({ path: require("node:path").resolve(__dirname, "../../.env") });
const mongoose = require("mongoose");
const { Worker } = require("bullmq");
const { GoogleGenAI } = require("@google/genai");
const Session = require("../models/emergencySession");
const { getConfig } = require("./config");
const { createDispatcher } = require("./dispatcher");
const { QUEUE_NAME, connectionOptions, createQueue } = require("./queue");
const { createProcessor } = require("./processor");
const { createTools } = require("./tools");
const { createClient } = require("redis");
const { redisOptions } = require("../config/redisOptions");

async function start() {
  const config = getConfig();
  if (config.mode === "off") { console.log("SOS agent is disabled"); return; }
  if (!config.model || !process.env.GEMINI_API_KEY) throw new Error("Set AGENT_MODEL and GEMINI_API_KEY before starting the agent worker");
  if (config.mode === "live" && (!config.baseUrl || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_PHONE_NUMBER)) throw new Error("Live mode requires PUBLIC_BASE_URL and Twilio credentials");
  await mongoose.connect(process.env.DB_CONNECT_STRING, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 15000 });
  await Session.init();
  const publisher = createClient({ ...redisOptions(), disableOfflineQueue: true });
  publisher.on("error", error => console.error("Agent publisher error:", error.name));
  await publisher.connect();
  const queue = createQueue();
  queue.on("error", error => console.error("Agent queue error:", error.name));
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: config.timeoutMs } });
  const worker = new Worker(QUEUE_NAME, createProcessor({ Session, createTools, config, generate: request => ai.models.generateContent(request), notify: event => publisher.publish("suraksha-agent-updates", JSON.stringify(event)) }), {
    connection: { ...connectionOptions(), maxRetriesPerRequest: null }, concurrency: 2,
  });
  worker.on("error", error => console.error("Agent worker error:", error.name));
  const dispatch = createDispatcher({ Session, queue });
  const timer = setInterval(dispatch, 15000);
  await dispatch();
  console.log(`SOS agent worker running in ${config.mode} mode`);
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await worker.close();
    await queue.close();
    await publisher.quit();
    await mongoose.disconnect();
  }
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
if (require.main === module) start().catch(error => { console.error("Agent startup failed:", error.message); process.exit(1); });
module.exports = { start };
