function redisOptions(env = process.env) {
  if (env.REDIS_URL) return { url: env.REDIS_URL };
  return {
    username: env.REDIS_USERNAME || "default", password: env.REDIS_PASSWORD,
    socket: { host: env.REDIS_HOST || "eye-cosmic-zinc-41239.db.redis.io", port: Number(env.REDIS_PORT || 19010), ...(env.REDIS_TLS === "true" ? { tls: true } : {}) },
  };
}
module.exports = { redisOptions };
