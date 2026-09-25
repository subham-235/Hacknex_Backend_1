function createDemoRateLimit(redis) {
  return async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      const key = `demo-rate:${req.user._id}:${Math.floor(Date.now() / 60000)}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 120);
      if (count > 120) return res.status(429).json({ error: "Demo rate limit exceeded" });
      next();
    } catch {
      res.status(503).json({ error: "Demo rate limiter unavailable" });
    }
  };
}
module.exports = { createDemoRateLimit };
