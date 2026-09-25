const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Journey = require('../src/models/safetyJourney');
const Session = require('../src/models/emergencySession');
const { createSession } = require('../src/agent/sessions');
const { createJourneySos } = require('../src/coordination/journeySos');
const { createJourneyService } = require('../src/coordination/journeys');

test('automatic journey SOS uses durable claims and respects check-ins', { timeout: 180000 }, async t => {
  const mongo = await MongoMemoryServer.create();
  try {
    await mongoose.connect(mongo.getUri());
    await Promise.all([Journey.init(), Session.init()]);
    let now = Date.now(), sends = [], mode = 'accepted', beforeContacts;
    const contact = { _id: new mongoose.Types.ObjectId(), contacts: 'Test contact', contactNumber: '9999999999' };
    let contacts = [contact];
    const escalate = createJourneySos({ Journey, Contact: { find: async () => { await beforeContacts?.(); return contacts; } }, now: () => now,
      sessions: {
        createSession: (...args) => createSession(...args.slice(0, 4), { ...args[4], now: () => now }),
        issueContactLink: async () => 'https://example.test/agent/respond#test-token',
        callbackUrl: () => 'https://example.test/status',
        recordAttempt: async () => {},
        finishInitial: id => Session.updateOne({ _id: id }, { $set: { ready: true } }),
      },
      sendSOSAlert: async (summary, location, recipients, options) => {
        sends.push({ summary, location, recipients, link: recipients.length ? await options.responseLink(contact) : null });
        if (mode === 'throw') throw new Error('Provider disconnected');
        return recipients.map(() => mode === 'accepted' ? { status: 'sent' } : { status: 'failed', deliveryStatus: mode });
      },
    });
    const service = createJourneyService({ Journey, escalate, now: () => now });
    const make = async (overrides = {}) => Journey.create({ profileId: new mongoose.Types.ObjectId(),
      destination: { latitude: 1, longitude: 1 }, currentLocation: { latitude: 0, longitude: 0, accuracy: 5, observedAt: new Date(now - 600000) },
      autoSosEnabled: true, checkInState: 'pending', checkInDueAt: new Date(now + 1000), ...overrides });

    await t.test('no SMS before deadline; worker checks create exactly one linked SOS with original GPS timestamp', async () => {
      const j = await make();
      await service.check(j._id, j.profileId);
      assert.equal(sends.length, 0);
      now += 1001;
      await Promise.all([service.check(j._id, j.profileId), service.check(j._id, j.profileId)]);
      await service.check(j._id, j.profileId);
      const saved = await Journey.findById(j._id);
      assert.equal(saved.sosState, 'accepted');
      assert.equal(sends.length, 1);
      const session = await Session.findById(saved.sosSessionId);
      assert.equal(session.ready, true);
      assert.equal(+session.latestVictimLocation.observedAt, +j.currentLocation.observedAt);
      assert.match(sends[0].summary, /Safety is unconfirmed/);
      assert.match(sends[0].summary, /may be outdated/);
      assert.match(sends[0].link, /respond#/);
    });
    await t.test('safe, cancelled, arrived, legacy and wrong-owner journeys do not send', async () => {
      const count = sends.length;
      for (const action of ['safe', 'cancel']) {
        const j = await make();
        await service.action(j._id, j.profileId, action);
        now += 1001;
        await escalate(j._id, j.profileId);
      }
      for (const overrides of [{ open: false, status: 'arrived' }, { autoSosEnabled: false }]) {
        const j = await make({ ...overrides, checkInState: 'unanswered', checkInDueAt: new Date(now - 1) });
        await escalate(j._id, j.profileId);
      }
      const j = await make({ checkInState: 'unanswered', checkInDueAt: new Date(now - 1) });
      await escalate(j._id, new mongoose.Types.ObjectId());
      assert.equal(sends.length, count);
    });
    await t.test('provider failure and uncertain submission are persisted without automatic replay', async () => {
      for (mode of ['failed', 'unknown', 'throw']) {
        const j = await make({ checkInState: 'unanswered', checkInDueAt: new Date(now - 1) });
        const count = sends.length;
        await escalate(j._id, j.profileId);
        await escalate(j._id, j.profileId);
        assert.equal(sends.length, count + 1);
        assert.equal((await Journey.findById(j._id)).sosState, mode === 'failed' ? 'failed' : 'unknown');
      }
    });
    await t.test('a safety confirmation during contact lookup wins before the SMS claim', async () => {
      const j = await make({ checkInState: 'unanswered', checkInDueAt: new Date(now - 1) });
      const count = sends.length;
      beforeContacts = () => service.action(j._id, j.profileId, 'safe');
      try { await escalate(j._id, j.profileId); } finally { beforeContacts = undefined; }
      assert.equal(sends.length, count);
      assert.equal((await Journey.findById(j._id)).sosState, 'none');
    });
    await t.test('no contacts is explicit; an SOS session still exists for coordination', async () => {
      contacts = []; mode = 'accepted';
      const j = await make({ checkInState: 'unanswered', checkInDueAt: new Date(now - 1) });
      await escalate(j._id, j.profileId);
      const saved = await Journey.findById(j._id);
      assert.equal(saved.sosState, 'no_contacts');
      assert.ok(await Session.findById(saved.sosSessionId));
    });
    await t.test('interrupted claims become unknown instead of resending', async () => {
      const j = await make({ checkInState: 'unanswered', checkInDueAt: new Date(now - 1), sosState: 'sending', sosDeadline: new Date(now - 1) });
      const count = sends.length;
      await escalate(j._id, j.profileId);
      assert.equal((await Journey.findById(j._id)).sosState, 'unknown');
      assert.equal(sends.length, count);
    });
  } finally { await mongoose.disconnect(); await mongo.stop(); }
});
