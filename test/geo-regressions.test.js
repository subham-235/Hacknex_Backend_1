const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLatLon } = require("../src/utils/locationParser");
const { createDispatcher } = require("../src/agent/dispatcher");
test("legacy location parser rejects malformed coordinates without losing Maps compatibility", () => {
  for (const input of [
    "100,88",
    "91,88",
    "22,188",
    "junk 22,88",
    "22,88oops",
    "%ZZ",
    { lat: "22oops", lon: 88 },
    { lat: 0, lon: true },
  ])
    assert.equal(parseLatLon(input), null);
  assert.deepEqual(parseLatLon("https://maps.google.com/?q=0,0"), { lat: 0, lon: 0 });
  assert.deepEqual(parseLatLon("22.5, 88.3"), { lat: 22.5, lon: 88.3 });
});
test("agent off mode still recovers interrupted initial schedules without queueing Gemini jobs", async () => {
  const writes = [];
  await createDispatcher({
    enabled: false,
    Session: {
      updateMany: async (filter, update) => writes.push({ filter, update }),
      find: () => assert.fail("AI work queued in off mode"),
    },
    queue: { add: () => assert.fail("AI work queued in off mode") },
  })();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].update.$set.ready, true);
  assert.equal(writes[1].update.$set["attempts.$[pending].status"], "unknown");
});
