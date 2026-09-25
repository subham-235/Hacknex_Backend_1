const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const tick = () => new Promise(resolve => setImmediate(resolve));

function page() {
  const elements = new Map(), calls = [], intervals = [], watchers = [], cleared = [];
  let status = 'pending', expired = false;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } });
    return elements.get(id);
  };
  const context = vm.createContext({
    location: { hash: '#' + 'A'.repeat(43), pathname: '/agent/respond' },
    document: { getElementById: element }, window: { addEventListener() {} },
    AbortController, setTimeout, clearTimeout,
    setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    navigator: { geolocation: { watchPosition(success) { watchers.push(success); return watchers.length; }, clearWatch(id) { cleared.push(id); } } },
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (expired) return { ok: false, status: 410, json: async () => ({ error: 'Link expired' }) };
      if (url.endsWith('/respond')) status = JSON.parse(options.body).status;
      return { ok: true, json: async () => ({ reference: 'REFERENCE', responseStatus: status, expiresAt: Date.now() + 60000, victimLocation: null }) };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/contact-response/app.js'), 'utf8'), context);
  return { element, calls, watchers, cleared, intervals, expire() { expired = true; } };
}

test('opening response page makes no decision and never opens GPS without explicit consent', async () => {
  const p = page();
  await tick();
  assert.equal(p.calls.length, 1);
  assert.match(p.calls[0].url, /api\/context$/);
  assert.equal(p.calls[0].options.credentials, 'omit');
  assert.equal(p.watchers.length, 0);
  p.element('coming').handlers.click();
  await tick();
  assert.equal(p.calls.find(c => c.url.endsWith('/respond')).body.status, 'coming');
  assert.equal(p.watchers.length, 0);
  assert.match(p.element('status').textContent, /coming to help/);
  await p.element('share').handlers.click();
  assert.equal(p.watchers.length, 1);
  p.watchers[0]({ coords: { latitude: 0, longitude: .001, accuracy: 5 }, timestamp: Date.now() });
  await tick();
  assert.ok(p.calls.some(c => c.url.endsWith('/location')));
  await p.element('share').handlers.click();
  assert.deepEqual(p.cleared, [1]);
  assert.ok(p.calls.some(c => c.url.endsWith('/stop-location')));
});

test('expiry stops GPS and disables response controls', async () => {
  const p = page();
  await tick();
  p.element('coming').handlers.click();
  await tick();
  await p.element('share').handlers.click();
  p.expire();
  await p.intervals[0]();
  await tick();
  assert.deepEqual(p.cleared, [1]);
  assert.equal(p.element('coming').disabled, true);
  assert.equal(p.element('location-section').hidden, true);
  assert.match(p.element('status').textContent, /no longer available/);
});
