const { GoogleGenAI } = require("@google/genai");

function geminiKeys(env = process.env) {
  const configured = [
    ...(env.GEMINI_API_KEYS || "").split(","),
    env.GEMINI_API_KEY,
    env.GEMINI_API_KEY_2,
  ];
  return [...new Set(configured.map((key) => String(key || "").trim()).filter(Boolean))];
}

function retryable(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = error?.code || error?.cause?.code;
  const message = String(error?.message || error?.cause?.message || "");
  return (
    [408, 429, 499, 500, 502, 503, 504].includes(status) ||
    ["AbortError", "TimeoutError"].includes(error?.name) ||
    /timed?\s*out|timeout|deadline/i.test(message) ||
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code) ||
    (error?.name === "TypeError" && /fetch|network/i.test(message))
  );
}

function retryAfterMs(error, fallback) {
  const headers = error?.response?.headers || error?.headers;
  const raw = typeof headers?.get === "function"
    ? headers.get("retry-after")
    : headers?.["retry-after"];
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : fallback;
}

function createGeminiFailover({
  keys = geminiKeys(),
  httpOptions,
  cooldownMs = 60000,
  now = () => Date.now(),
  createClient = (apiKey) => new GoogleGenAI({ apiKey, ...(httpOptions ? { httpOptions } : {}) }),
} = {}) {
  if (!keys.length) throw new Error("Set GEMINI_API_KEYS or GEMINI_API_KEY before using Gemini");
  const entries = keys.map((key) => ({ client: createClient(key), unavailableUntil: 0 }));
  let preferred = 0;
  let lastFailure;

  async function generateContent(request) {
    const startedAt = now();
    const order = entries
      .map((_, offset) => (preferred + offset) % entries.length)
      .filter((index) => entries[index].unavailableUntil <= startedAt);
    if (!order.length) throw lastFailure || Object.assign(new Error("All Gemini API keys are cooling down"), { status: 429 });

    for (const index of order) {
      try {
        const response = await entries[index].client.models.generateContent(request);
        entries[index].unavailableUntil = 0;
        preferred = index;
        lastFailure = undefined;
        return response;
      } catch (error) {
        if (!retryable(error) || request?.config?.abortSignal?.aborted) throw error;
        entries[index].unavailableUntil = now() + retryAfterMs(error, cooldownMs);
        lastFailure = error;
      }
    }
    throw lastFailure;
  }

  return { generateContent };
}

module.exports = { createGeminiFailover, geminiKeys, retryable, retryAfterMs };
