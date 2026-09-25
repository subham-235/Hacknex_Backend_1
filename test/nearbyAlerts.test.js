const test = require('node:test');
const assert = require('node:assert/strict');
const { createNearbyAlerts } = require('../src/nearbyAlerts');

test('reconnecting helpers receive only their own unexpired alerts', () => {
  let now = 1000;
  const buffer = createNearbyAlerts({ now: () => now, ttlMs: 100 });
  const alert = buffer.add('helper', { mapsLink: 'https://maps.google.com/?q=0,0' });
  assert.deepEqual(buffer.list('other-helper'), []);
  assert.deepEqual(buffer.list('helper'), [alert]);
  // Receipt/reconnect does not remove the card; a page reload can recover it.
  assert.deepEqual(buffer.list('helper'), [alert]);
  now = 1100;
  assert.deepEqual(buffer.list('helper'), []);
});

test('replay storage is bounded per helper and across recipients', () => {
  const buffer = createNearbyAlerts({ maxUsers: 2 });
  for (let i = 0; i < 12; i++) buffer.add('helper', { message: String(i) });
  const alerts = buffer.list('helper');
  assert.equal(alerts.length, 10);
  assert.equal(alerts[0].message, '2');
  assert.equal(new Set(alerts.map(alert => alert.id)).size, 10);
  buffer.add('second', {});
  buffer.add('third', {});
  assert.deepEqual(buffer.list('helper'), []);
});
