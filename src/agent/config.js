function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

function getConfig(env = process.env) {
  const mode = env.AGENT_MODE || "review";
  if (!["off", "review", "live"].includes(mode)) throw new Error("AGENT_MODE must be off, review, or live");
  const baseUrl = (env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("PUBLIC_BASE_URL must be an HTTPS origin without a path or credentials");
    }
  }
  return {
    mode, baseUrl, model: env.AGENT_MODEL || env.GEMINI_MODEL || "gemini-3.6-flash",
    checkMs: integer(env, "AGENT_CHECK_SECONDS", 60, 30, 600) * 1000,
    durationMs: integer(env, "AGENT_SESSION_MINUTES", 30, 5, 120) * 60000,
    maxRuns: integer(env, "AGENT_MAX_RUNS", 12, 1, 60),
    maxMessages: integer(env, "AGENT_MAX_FOLLOWUPS", 3, 1, 10),
    maxToolCalls: 6,
    timeoutMs: 30000,
    leaseMs: 120000,
  };
}

module.exports = { getConfig };
