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
  const timeoutMs = integer(env, 'AGENT_RUN_TIMEOUT_SECONDS', 180, 30, 300) * 1000;
  const modelTimeoutMs = integer(env, 'AGENT_MODEL_TIMEOUT_SECONDS', 90, 10, 180) * 1000;
  if (modelTimeoutMs > timeoutMs) throw new Error('Model timeout must not exceed agent run timeout');
  return {
    mode, baseUrl, model: env.AGENT_MODEL || env.GEMINI_MODEL || "gemini-3.6-flash",
    checkMs: integer(env, "AGENT_CHECK_SECONDS", 60, 30, 600) * 1000,
    durationMs: integer(env, "AGENT_SESSION_MINUTES", 30, 5, 120) * 60000,
    maxRuns: integer(env, "AGENT_MAX_RUNS", 12, 1, 60),
    maxMessages: integer(env, "AGENT_MAX_FOLLOWUPS", 3, 1, 10),
    maxToolCalls: 6,
    timeoutMs, modelTimeoutMs,
    keyCooldownMs: integer(env, "GEMINI_KEY_COOLDOWN_SECONDS", 60, 5, 3600) * 1000,
    leaseMs: timeoutMs + 60000,
    retryBaseMs: 60000,
    retryMaxMs: 600000,
  };
}

module.exports = { getConfig };
