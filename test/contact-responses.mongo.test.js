const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Session = require('../src/models/emergencySession');
const Contact = require('../src/models/contact');
const { createContactResponses, hashToken } = require('../src/agent/contactResponses');
const { createHandlers } = require('../src/agent/http');
const { canFollowUp } = require('../src/agent/policy');

test('secure contact response lifecycle in isolated MongoDB', { timeout: 180000 }, async t => {
  const mongo = await MongoMemoryServer.create();
  let server;
  try {
    await mongoose.connect(mongo.getUri());
    await Session.init();
    let now = Date.now();
    const owner = new mongoose.Types.ObjectId();
    // Use the collection to avoid unrelated contact validation; values mirror stored contacts.
    const a = { _id: new mongoose.Types.ObjectId(), profileId: owner, isActive: true, contactNumber: '9999999999', via: 'SMS' };
    const b = { ...a, _id: new mongoose.Types.ObjectId(), contactNumber: '8888888888' };
    await Contact.collection.insertMany([a, b]);
    const point = { latitude: 0, longitude: 0, accuracy: 5, observedAt: new Date(now), receivedAt: new Date(now) };
    const session = await Session.create({ profileId: owner, reference: 'SECURE123456', ready: true, initialDeadline: new Date(now), expiresAt: new Date(now + 1800000),
      initialVictimLocation: point, latestVictimLocation: point,
      status: 'review_required', lastError: 'Gemini quota reached',
      recipients: [{ contactId: a._id, number: a.contactNumber, label: 'Mother' }, { contactId: b._id, number: b.contactNumber, label: 'Brother' }],
    });
    const events = [];
    const service = createContactResponses({ Session, Contact, now: () => now, notify: async e => events.push(e) });
    const config = { baseUrl: 'https://example.test' };
    const link = await service.issueLink(session._id, a._id, config);
    const token = new URL(link).hash.slice(1);
    const secondToken = new URL(await service.issueLink(session._id, b._id, config)).hash.slice(1);
    const saved = () => Session.findById(session._id).lean();

    await t.test('links contain unpredictable tokens; storage has only hashes; no public origin means no broken link', async () => {
      assert.equal(token.length, 43);
      assert.notEqual(token, secondToken);
      assert.ok((await saved()).recipients[0].responseTokenHashes.includes(hashToken(token)));
      assert.ok(!JSON.stringify(await saved()).includes(token));
      assert.equal(await service.issueLink(session._id, a._id, { baseUrl: '' }), null);
    });
    await t.test('opening is read-only and exposes no victim location before acceptance or other contact data', async () => {
      const context = await service.context(token);
      assert.equal(context.responseStatus, 'pending');
      assert.equal(context.victimLocation, null);
      assert.equal(context.recipients, undefined);
      assert.equal((await saved()).events.length, 0);
      await assert.rejects(service.context('A'.repeat(43)), { status: 410 });
      await assert.rejects(service.context(undefined), { status: 410 });
    });
    await t.test('coming and decline are independently stored despite Gemini failure; repeated tap is idempotent', async () => {
      await service.respond(token, 'coming');
      await service.respond(token, 'coming');
      await service.respond(secondToken, 'cannot_help');
      const value = await saved();
      assert.equal(value.recipients[0].responseStatus, 'coming');
      assert.equal(value.recipients[1].responseStatus, 'cannot_help');
      assert.equal(value.status, 'review_required');
      assert.equal(value.events.length, 2);
      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'agent-session-updated');
      assert.equal((await service.context(token)).victimLocation.latitude, 0);
      assert.equal((await service.context(secondToken)).victimLocation, null);
      assert.match(canFollowUp({ ...value, status: 'active' }, a, { mode: 'live' }), /already responded/);
      assert.match(canFollowUp({ ...value, status: 'active' }, b, { mode: 'live' }), /already responded/);
      await assert.rejects(service.respond(secondToken, 'arrived'), { status: 409 });
    });
    await t.test('location is opt-in, validated, throttled, timestamped and never treated as arrival', async () => {
      await assert.rejects(service.location(secondToken, { latitude: 0, longitude: 0, accuracy: 5, timestamp: now }), { status: 409 });
      await assert.rejects(service.location(token, { latitude: 0, longitude: 0 }), { status: 400 });
      await assert.rejects(service.location(token, { latitude: 91, longitude: 0, accuracy: 5 }), { status: 400 });
      await service.location(token, { latitude: 0, longitude: .001, accuracy: 5, timestamp: now });
      const context = await service.context(token);
      assert.equal(context.responseStatus, 'coming');
      assert.equal(context.tracking.distanceMeters, 111);
      assert.equal(context.tracking.fresh, true);
      await assert.rejects(service.location(token, { latitude: 0, longitude: .001, accuracy: 5, timestamp: now }), { status: 409 });
      now += 1000;
      await assert.rejects(service.location(token, { latitude: 0, longitude: .001, accuracy: 5, timestamp: now }), { status: 429 });
      await service.stopLocation(token);
      assert.equal((await service.context(token)).tracking, null);
    });
    await t.test('owner presentation includes contact distance and never exposes token hashes', async () => {
      now += 20000;
      await service.location(token, { latitude: 0, longitude: .001, accuracy: 5, timestamp: now });
      let data;
      await createHandlers({ Session, Contact }).detail({ params: { id: String(session._id) }, user: { _id: owner } }, { json: value => { data = value; } });
      assert.equal(data.session.recipients[0].tracking.distanceMeters, 111);
      assert.equal(data.session.recipients[0].responseTokenHashes, undefined);
      await service.respond(token, 'cannot_help');
      assert.equal((await service.context(token)).tracking, null);
      assert.equal((await saved()).recipients[0].lastLocation, undefined);
      await service.respond(token, 'coming');
      await service.respond(token, 'arrived');
      assert.equal((await saved()).status, 'review_required');
    });
    await t.test('page GET cannot accept help; public HTTP routes require bearer token and ignore injected contact IDs', async () => {
      const app = express();
      app.use(express.json());
      app.use('/agent/respond', require('../src/routes/contactResponse'));
      server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      const base = `http://127.0.0.1:${server.address().port}/agent/respond`;
      const page = await fetch(base);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
      assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.match(await page.text(), /I’m coming/);
      assert.equal((await fetch(`${base}/api/context`, { method: 'POST' })).status, 410);
      const result = await fetch(`${base}/api/respond`, { method: 'POST', headers: { Authorization: `Bearer ${secondToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'coming', contactId: String(a._id) }) });
      assert.equal(result.status, 200);
      assert.equal((await saved()).recipients[0].responseStatus, 'arrived');
      assert.equal((await saved()).recipients[1].responseStatus, 'coming');
    });
    await t.test('deactivated or changed contacts lose link access', async () => {
      await Contact.updateOne({ _id: a._id }, { $set: { isActive: false } });
      await assert.rejects(service.context(token), { status: 410 });
      await Contact.updateOne({ _id: a._id }, { $set: { isActive: true, contactNumber: '7777777777' } });
      await assert.rejects(service.respond(token, 'coming'), { status: 410 });
    });
    await t.test('resolved and expired sessions reject all link access and location writes', async () => {
      await Session.updateOne({ _id: session._id }, { $set: { status: 'resolved' } });
      await assert.rejects(service.context(secondToken), { status: 410 });
      await assert.rejects(service.respond(secondToken, 'coming'), { status: 410 });
      await assert.rejects(service.location(secondToken, { latitude: 0, longitude: 0, accuracy: 5 }), { status: 410 });
      await Session.updateOne({ _id: session._id }, { $set: { status: 'active', expiresAt: new Date(now - 1) } });
      await assert.rejects(service.context(secondToken), { status: 410 });
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    await mongo.stop();
  }
});
