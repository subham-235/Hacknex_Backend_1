const { Queue } = require("bullmq");
const QUEUE_NAME = "suraksha-followup";
const GEO_QUEUE_NAME = 'suraksha-coordination';
function connectionOptions(env = process.env) {
  if (env.REDIS_URL) {
    const url = new URL(env.REDIS_URL);
    if (!["redis:", "rediss:"].includes(url.protocol)) throw new Error("Invalid REDIS_URL protocol");
    return { host: url.hostname, port: Number(url.port || 6379), username: decodeURIComponent(url.username) || undefined, password: decodeURIComponent(url.password) || undefined, db: Number(url.pathname.slice(1) || 0), ...(url.protocol === "rediss:" ? { tls: {} } : {}) };
  }
  return { host: env.REDIS_HOST || "eye-cosmic-zinc-41239.db.redis.io", port: Number(env.REDIS_PORT || 19010), username: env.REDIS_USERNAME || "default", password: env.REDIS_PASSWORD, ...(env.REDIS_TLS === "true" ? { tls: {} } : {}) };
}
function transportOptions() {
  return { ...connectionOptions(), connectTimeout: 15000, keepAlive: 10000, retryStrategy: attempt => Math.min(1000 * 2 ** Math.min(attempt - 1, 5), 30000) };
}
function createQueue(name = QUEUE_NAME) {
  return new Queue(name, { connection: { ...transportOptions(), maxRetriesPerRequest: 1 }, defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
}
module.exports = { QUEUE_NAME, GEO_QUEUE_NAME, connectionOptions, transportOptions, createQueue };
