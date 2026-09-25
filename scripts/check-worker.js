// No SOS, contact messages, incident updates or queue jobs are created.
require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env'), quiet: true });
const Redis = require('ioredis');
const { transportOptions } = require('../src/agent/queue');
const { getConfig } = require('../src/agent/config');
const { classifyFailure } = require('../src/agent/failures');
async function redisCheck() {
  const client = new Redis({ ...transportOptions(), lazyConnect: true, connectTimeout: 15000, retryStrategy: null, maxRetriesPerRequest: 1, commandTimeout: 10000 });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.ping();
    console.log('Worker Redis transport: PONG');
    const info = await client.info('memory');
    const policy = info.match(/^maxmemory_policy:(.+)$/m)?.[1]?.trim();
    console.log(`Redis eviction policy: ${policy || 'not reported'}`);
    if (policy && policy !== 'noeviction') {
      if (process.argv.includes('--fix-redis-policy')) {
        try {
          await client.config('SET', 'maxmemory-policy', 'noeviction');
          const updated = await client.info('memory');
          if (!/^maxmemory_policy:noeviction\r?$/m.test(updated)) throw new Error('Not applied');
          console.log('Redis eviction policy changed and verified: noeviction');
        } catch {
          console.log('Redis policy cannot be changed through this connection. Set eviction policy to noeviction in your Redis provider database settings.');
          process.exitCode = 1;
        }
      } else console.log('BullMQ requires noeviction. Set it in the provider console, or run with --fix-redis-policy if CONFIG SET is supported.');
    }
  } catch (error) {
    const auth = /WRONGPASS|NOAUTH|AUTH/i.test(error.message || '');
    console.log(auth ? 'Worker Redis check failed: authentication rejected. Check Redis credentials.' : `Worker Redis check failed: ${classifyFailure(error, 'Redis').message}`);
    process.exitCode = 1;
  } finally { client.disconnect(); }
}
async function modelCheck() {
  if (!process.argv.includes('--gemini')) return;
  const { createGeminiFailover } = require('../src/services/geminiFailover');
  const config = getConfig();
  const ai = createGeminiFailover({ cooldownMs: config.keyCooldownMs, httpOptions: { timeout: config.modelTimeoutMs, retryOptions: { attempts: 1 } } });
  try {
    const response = await ai.generateContent({
      model: config.model,
      contents: 'Reply with exactly the word OK.',
      config: {
        maxOutputTokens: 128,
        temperature: 0,
        thinkingConfig: { thinkingLevel: 'low' },
        abortSignal: AbortSignal.timeout(config.modelTimeoutMs),
      },
    });
    const text = String(response.text || '').trim();
    if (!/^OK[.!]?$/i.test(text)) throw new Error('Gemini returned an unexpected diagnostic response');
    console.log(`Gemini connectivity (${config.model}): OK`);
  } catch (error) {
    console.log(`Gemini check: ${classifyFailure(error, 'Gemini').message}`);
    process.exitCode = 1;
  }
}
Promise.all([redisCheck(), modelCheck()]).catch(() => { process.exitCode = 1; });
