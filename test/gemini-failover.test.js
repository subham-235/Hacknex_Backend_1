const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createGeminiFailover,
  geminiKeys,
  retryAfterMs,
} = require("../src/services/geminiFailover");

test("Gemini keys support a comma-separated pool, legacy second key, and deduplication", () => {
  assert.deepEqual(
    geminiKeys({
      GEMINI_API_KEYS: " first, second,first ",
      GEMINI_API_KEY: "legacy",
      GEMINI_API_KEY_2: "second",
    }),
    ["first", "second", "legacy"],
  );
});

test("a retryable Gemini failure immediately switches keys and keeps the working key preferred", async () => {
  const calls = [];
  const pool = createGeminiFailover({
    keys: ["first", "second"],
    createClient: (key) => ({
      models: {
        async generateContent(request) {
          calls.push({ key, request });
          if (key === "first") throw { status: 429 };
          return { text: "available" };
        },
      },
    }),
  });

  const request = { contents: [{ text: "test" }] };
  assert.equal((await pool.generateContent(request)).text, "available");
  assert.equal((await pool.generateContent(request)).text, "available");
  assert.deepEqual(calls.map((call) => call.key), ["first", "second", "second"]);
  assert.equal(calls[0].request, request);
});

test("provider 503, timeout and network failures are failover eligible", async () => {
  for (const failure of [
    { status: 503 },
    Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
    new TypeError("fetch failed"),
  ]) {
    let calls = 0;
    const pool = createGeminiFailover({
      keys: ["first", "second"],
      createClient: () => ({ models: { generateContent: async () => {
        if (++calls === 1) throw failure;
        return { text: "fallback" };
      } } }),
    });
    assert.equal((await pool.generateContent({})).text, "fallback");
    assert.equal(calls, 2);
  }
});

test("non-retryable requests and an explicitly aborted request never switch keys", async () => {
  for (const { failure, signal } of [
    { failure: { status: 401 } },
    { failure: Object.assign(new Error("aborted"), { name: "AbortError" }), signal: AbortSignal.abort() },
  ]) {
    let calls = 0;
    const pool = createGeminiFailover({
      keys: ["first", "second"],
      createClient: () => ({ models: { generateContent: async () => {
        calls += 1;
        throw failure;
      } } }),
    });
    await assert.rejects(pool.generateContent({ config: { abortSignal: signal } }));
    assert.equal(calls, 1);
  }
});

test("Retry-After controls the failed key cooldown", () => {
  assert.equal(
    retryAfterMs({ headers: { get: () => "12" } }, 60000),
    12000,
  );
});
