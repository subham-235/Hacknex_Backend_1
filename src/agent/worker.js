require("dotenv").config({ path: require("node:path").resolve(__dirname, "../../.env") });
const mongoose = require("mongoose");
const { Worker } = require("bullmq");
const { createGeminiFailover, geminiKeys } = require("../services/geminiFailover");
const Session = require("../models/emergencySession");
const { getConfig } = require("./config");
const { createDispatcher } = require("./dispatcher");
const { QUEUE_NAME, GEO_QUEUE_NAME, transportOptions, createQueue } = require("./queue");
const { createProcessor } = require("./processor");
const { createTools } = require("./tools");
const { createClient } = require("redis");
const { redisOptions } = require("../config/redisOptions");

async function start() {
  const config = getConfig();
  // Deterministic coordination remains enabled when AI follow-up is off.
  if (config.mode !== "off" && (!config.model || !geminiKeys().length)) throw new Error("Set AGENT_MODEL and GEMINI_API_KEYS or GEMINI_API_KEY before starting the agent worker");
  if (config.mode === "live" && (!config.baseUrl || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_PHONE_NUMBER)) throw new Error("Live mode requires PUBLIC_BASE_URL and Twilio credentials");
  // Atlas SRV lookup and replica-set discovery can exceed five seconds on a
  // cold connection even when every node is reachable.
  await mongoose.connect(process.env.DB_CONNECT_STRING, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 15000,
  });
  await Session.init();
  const publisher = createClient({ ...redisOptions(), disableOfflineQueue: true });
  publisher.on("error", error => console.error("Agent publisher error:", error.message));
  await publisher.connect();
  const queue = createQueue();
  queue.on("error", error => console.error("Agent queue error:", error.message));
  const geoQueue = createQueue(GEO_QUEUE_NAME);
  geoQueue.on('error', () => console.error('Coordination queue connection unavailable; persisted schedules will recover after reconnection.'));
  const ai = config.mode === "off" ? null : createGeminiFailover({
    cooldownMs: config.keyCooldownMs,
    httpOptions: { timeout: config.modelTimeoutMs, retryOptions: { attempts: 1 } },
  });
  const Journey = require('../models/safetyJourney');
  const ActiveUser = require('../models/activeUser');
  await Journey.init();
  await ActiveUser.init();
  const notifyGeo = event => publisher.publish('suraksha-geo-updates', JSON.stringify(event));
  const responders = require('../coordination/responders').createResponderService({ Session, ActiveUser, notify: notifyGeo });
  const escalateJourney = require('../coordination/journeySos').createJourneySos({
    Journey, Contact: require('../models/contact'), sessions: require('./sessions'),
    sendSOSAlert: require('../services/smsAlart').sendSOSAlert, notify: notifyGeo,
  });
  const journeys = require('../coordination/journeys').createJourneyService({ Journey, notify: notifyGeo, escalate: escalateJourney });
  const processAgent = createProcessor({ Session, createTools, config, generate: request => ai.generateContent(request), notify: event => publisher.publish("suraksha-agent-updates", JSON.stringify(event)) });
  const processJob = async job => {
    try {
      if (job.name === 'coordinate-session') return await responders.check(job.data.sessionId);
      if (job.name === 'check-journey') return await journeys.check(job.data.journeyId, job.data.profileId);
      return await processAgent(job);
    } catch (e) { if (e.status === 404 || (e.status === 409 && /closed/.test(e.message))) return; throw e; }
  };
  const worker = new Worker(QUEUE_NAME, processJob, {
    connection: { ...transportOptions(), maxRetriesPerRequest: null }, concurrency: 1,
  });
  const geoWorker = new Worker(GEO_QUEUE_NAME, processJob, {
    connection: { ...transportOptions(), maxRetriesPerRequest: null }, concurrency: 2,
  });
  for (const [label, current] of [['AI', worker], ['Coordination', geoWorker]]) {
    current.on('error', error => console.error(`${label} worker Redis connection error (${error.code || error.name}). Reconnecting with backoff; check Redis reachability if this persists.`));
    current.on('failed', (job, error) => console.error(`${label} job ${job?.name || 'unknown'} failed (${error.code || error.name}); inspect persisted session state.`));
  }
  await Promise.all([worker.waitUntilReady(), geoWorker.waitUntilReady()]);
  const dispatchAgent = createDispatcher({ Session, queue, enabled: config.mode !== 'off' });
  const dispatchGeo = require('../coordination/dispatcher').createGeoDispatcher({ Session, Journey, queue: geoQueue });
  const dispatch = async () => { await dispatchAgent(); await dispatchGeo(); };
  const timer = setInterval(dispatch, 15000);
  await dispatch();
  console.log(`SOS agent worker running in ${config.mode} mode`);
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await worker.close();
    await geoWorker.close();
    await queue.close();
    await geoQueue.close();
    await publisher.quit();
    await mongoose.disconnect();
  }
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
if (require.main === module) start().catch(error => { console.error("Agent startup failed:", error.message); process.exit(1); });
module.exports = { start };
