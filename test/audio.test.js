const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(size = 100) {
  const calls = [];
  const module = { exports: {} };
  const deps = {
    path,
    'node:fs/promises': {
      stat: async () => ({ size }),
      readFile: async file => Buffer.from(file),
    },
    './geminiFailover': { createGeminiFailover: () => ({
      generateContent: async args => {
        calls.push(args);
        return { text: JSON.stringify({ isDistress: true, confidence: 95, summary: 'Help' }) };
      },
    }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/llmsupport.js'), 'utf8'), {
    module, process: { env: {} }, console: { log() {}, error() {} }, require: id => {
      assert.ok(Object.hasOwn(deps, id));
      return deps[id];
    },
  });
  return { analyze: module.exports.analyzeAudioDirectly, calls };
}

test('single audio and ordered batches are sent inline in one model request', async () => {
  for (const input of ['one.webm', ['one.webm', 'two.webm']]) {
    const h = harness();
    assert.equal((await h.analyze(input, '0,0')).isDistress, true);
    assert.equal(h.calls.length, 1);
    const parts = h.calls[0].contents.slice(1);
    assert.deepEqual(Array.from(parts, part => Buffer.from(part.inlineData.data, 'base64').toString()),
      Array.isArray(input) ? input : [input]);
    assert.ok(parts.every(part => part.inlineData.mimeType === 'audio/webm'));
  }
});

test('oversized audio and excess clips fail before calling Gemini', async () => {
  const h = harness(13 * 1024 * 1024);
  await assert.rejects(h.analyze('one.webm', '0,0'), /limit/);
  await assert.rejects(h.analyze(Array(6).fill('one.webm'), '0,0'), /five/);
  await assert.rejects(h.analyze([], '0,0'), /five/);
  assert.equal(h.calls.length, 0);
});
