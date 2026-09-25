// Read-only diagnostics: DNS lookups and database PINGs; never sends SOS messages.
require("dotenv").config({
  path: require("node:path").resolve(__dirname, "../.env"),
  quiet: true,
});
const dns = require("node:dns").promises;
const mongoose = require("mongoose");
const { createClient } = require("redis");
const { redisOptions } = require("../src/config/redisOptions");

async function check(label, action) {
  try {
    await action();
    console.log(`${label}: OK`);
  } catch (error) {
    // Do not print connection strings, credentials, or raw provider errors.
    console.log(`${label}: FAILED (${error.code || error.name})`);
    process.exitCode = 1;
  }
}

async function main() {
  const mongoUrl = process.env.DB_CONNECT_STRING;
  if (!mongoUrl) throw new Error("DB_CONNECT_STRING is missing");
  const mongo = new URL(mongoUrl);
  const options = redisOptions();
  const redisHost = options.url
    ? new URL(options.url).hostname
    : options.socket.host;
  console.log(
    `Redis settings source: ${options.url ? "REDIS_URL" : process.env.REDIS_HOST ? "REDIS_HOST" : "project default host"}`,
  );
  const resolver = new dns.Resolver({ timeout: 3000, tries: 1 });
  await Promise.all([
    check("MongoDB DNS", () =>
      mongo.protocol === "mongodb+srv:"
        ? resolver.resolveSrv(`_mongodb._tcp.${mongo.hostname}`)
        : resolver.resolve4(mongo.hostname),
    ),
    check("Redis DNS", () => resolver.resolve4(redisHost)),
    check("MongoDB connect and ping", async () => {
      const connection = mongoose.createConnection(mongoUrl, {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 5000,
        socketTimeoutMS: 5000,
        maxPoolSize: 1,
      });
      try {
        await connection.asPromise();
        await connection.db.command({ ping: 1 }, { maxTimeMS: 3000 });
      } finally {
        await connection.close();
      }
    }),
    check("Redis connect and ping", async () => {
      const client = createClient({
        ...options,
        disableOfflineQueue: true,
        socket: {
          ...options.socket,
          connectTimeout: 8000,
          reconnectStrategy: false,
        },
      });
      client.on("error", () => {});
      const timer = setTimeout(() => {
        if (client.isOpen) client.destroy();
      }, 10000);
      try {
        await client.connect();
        await client.ping();
      } finally {
        clearTimeout(timer);
        if (client.isOpen) client.destroy();
      }
    }),
  ]);
}
main().catch((error) => {
  console.error("Connection check failed:", error.name);
  process.exitCode = 1;
});
