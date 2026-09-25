const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFailure, retryDelay } = require('../src/agent/failures');
const { createProcessor } = require('../src/agent/processor');
const { getConfig } = require('../src/agent/config');
const config = getConfig({});
const session = { _id: '111111111111111111111111', profileId: '222222222222222222222222', actions: [], runCount: 0, expiresAt: new Date(Date.now() + 1800000) };
function harness(extra, generate) {
  const writes = [];
  let executed = 0;
  const processor = createProcessor({ config,
    Session: { findOneAndUpdate: () => ({ lean: async () => ({ ...session, ...extra }) }), updateOne: async (filter, update) => writes.push({ filter, update }) },
    createTools: () => ({ tools: {}, executeAction: async () => executed++ }), generate,
  });
  return { writes, processor, executed: () => executed };
}
test('provider failure classification distinguishes quota, network, timeout and code errors', () => {
  assert.equal(classifyFailure({ status: 429 }).code, 'RATE_LIMITED');
  assert.equal(classifyFailure({ status: 504 }).code, 'TIMEOUT');
  assert.equal(classifyFailure({ name: 'AbortError' }).retry, true);
  assert.equal(classifyFailure(new Error('The operation timed out')).code, 'TIMEOUT');
  assert.equal(classifyFailure(new Error('request deadline exceeded')).retry, true);
  assert.equal(classifyFailure(new TypeError('fetch failed')).code, 'NETWORK');
  assert.equal(classifyFailure(new TypeError('Cannot read properties')).retry, false);
  assert.equal(classifyFailure({ status: 403 }).retry, false);
  assert.equal(classifyFailure({ cause: { code: 'ETIMEDOUT' } }).retry, true);
  assert.deepEqual([1, 2, 3, 4, 5, 20].map(n => retryDelay(n, config)), [60000, 120000, 240000, 480000, 600000, 600000]);
});
test('Gemini rate limit persists cooldown without resolving the SOS', async () => {
  const h = harness({ aiFailureCount: 1 }, async () => { throw { status: 429 }; });
  await h.processor({ data: { sessionId: session._id } });
  const set = h.writes.find(w => w.update.$set?.aiRetryAfter).update.$set;
  assert.equal(set.aiFailureCount, 2);
  assert(set.aiRetryAfter > Date.now() + 110000);
  assert.match(set.lastError, /Gemini rate limit/);
  assert.equal(set.status, undefined);
  assert(h.writes.at(-1).update.$unset.leaseToken === '');
});
test('location wake cannot bypass cooldown; approved actions are still processed', async () => {
  const h = harness({ aiRetryAfter: new Date(Date.now() + 300000), actions: [{ _id: 'action', state: 'approved' }] }, () => assert.fail('Model should not run'));
  await h.processor({ data: { sessionId: session._id } });
  assert.equal(h.executed(), 1);
  assert(!h.writes.some(w => w.update.$inc?.runCount));
});
test('configuration errors pause AI review instead of endlessly retrying', async () => {
  const h = harness({}, async () => { throw { status: 401 }; });
  await h.processor({ data: { sessionId: session._id } });
  assert(h.writes.some(w => w.update.$set?.status === 'review_required'));
});
test('successful model run clears old cooldown and failure count', async () => {
  const h = harness({ aiFailureCount: 3 }, async () => ({ text: 'No further action needed.' }));
  await h.processor({ data: { sessionId: session._id } });
  assert(h.writes.some(w => w.update.$set?.aiFailureCount === 0 && w.update.$unset?.aiRetryAfter === ''));
});
