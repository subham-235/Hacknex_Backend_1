const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createDemoService } = require('../src/demo/service');
const models = require('../src/demo/models');
const geo = require('../src/coordination/geo');

test('every guided judge story executes its displayed steps against the real demo backend', { timeout: 180000 }, async t => {
  const { scenarios } = await import('../../frontend/lib/demo-scenarios.mjs');
  const mongo = await MongoMemoryServer.create();
  try {
    await mongoose.connect(mongo.getUri());
    await Promise.all(Object.values(models).map(model => model.init()));
    const service = createDemoService(models);
    const owner = new mongoose.Types.ObjectId();
    const run = await service.create(owner);
    for (const scenario of scenarios) await t.test(scenario.title, async () => {
      let snapshot;
      assert.equal(scenario.steps[0].action, 'reset');
      for (const step of scenario.steps) {
        snapshot = await service.act(run._id, owner, step.action, {});
        if (step.action === 'confirm-arrival') assert.equal(snapshot.session.activeResponder.currentStatus, 'arrived');
        if (step.action === 'responder-15') {
          assert.ok(snapshot.session.responderTracking.distanceMeters <= 16);
          assert.notEqual(snapshot.session.activeResponder.currentStatus, 'arrived');
        }
        if (step.action === 'victim-300' && scenario.id === 'rescue') {
          assert.ok(snapshot.run.previousCenter);
          assert.ok(geo.distance(snapshot.run.previousCenter, snapshot.session.latestVictimLocation) >= 299);
          assert.ok(geo.distance(snapshot.session.emergencyGeofence.center, snapshot.session.latestVictimLocation) < 1);
        }
        if (step.action === 'deviation' || step.action === 'checkin-wait') {
          assert.equal(snapshot.journey.checkInState, 'pending');
          assert.equal(snapshot.session, null);
          assert.ok(+new Date(snapshot.journey.checkInDueAt) > snapshot.run.clock);
        }
        if (step.action === 'checkin-timeout') {
          assert.equal(snapshot.journey.checkInState, 'unanswered');
          assert.equal(snapshot.journey.sosState, 'accepted');
          assert.equal(String(snapshot.journey.sosSessionId), String(snapshot.session._id));
          assert.equal(snapshot.session.attempts.length, 1);
          assert.equal(snapshot.session.attempts[0].status, 'accepted');
          assert.equal(snapshot.session.ready, true);
          const repeated = await service.act(run._id, owner, 'checkin-timeout');
          assert.equal(String(repeated.session._id), String(snapshot.session._id));
        }
      }
      if (scenario.id === 'journey') assert.equal(snapshot.journey.routeDeviationDetected, true);
      else assert.equal(snapshot.session.status, 'resolved');
    });
    await t.test('ten-second wall-clock countdown cannot fire early and expires only once', async () => {
      for (const action of ['reset', 'start', 'deviation']) await service.act(run._id, owner, action);
      let snapshot = await service.snapshot(run._id, owner);
      assert.equal(snapshot.config.checkinMs, 10000);
      assert.ok(+new Date(snapshot.run.checkInWallDeadline) - Date.now() > 9000);
      snapshot = await service.act(run._id, owner, 'checkin-tick');
      assert.equal(snapshot.session, null);
      await models.Run.updateOne({ _id: run._id }, { $set: { checkInWallDeadline: new Date(Date.now() - 1) } });
      snapshot = await service.act(run._id, owner, 'checkin-tick');
      assert.equal(snapshot.journey.sosState, 'accepted');
      const again = await service.act(run._id, owner, 'checkin-tick');
      assert.equal(String(again.session._id), String(snapshot.session._id));
    });
    await t.test('checking in safely prevents demo escalation and never creates a live SOS', async () => {
      for (const action of ['reset', 'start', 'safe', 'deviation', 'checkin-safe']) await service.act(run._id, owner, action);
      const safe = await service.snapshot(run._id, owner);
      assert.equal(safe.journey.checkInState, 'safe');
      assert.equal(safe.journey.open, false);
      assert.equal(safe.session, null);
      await assert.rejects(service.act(run._id, owner, 'checkin-timeout'), /Trigger a safety check first/);
      assert.equal(await require('../src/models/emergencySession').countDocuments(), 0);
      assert.equal(await require('../src/models/safetyJourney').countDocuments(), 0);
    });
    await t.test('live demo SMS requires explicit confirmation and is claimed before submission', async () => {
      const deliveries = [];
      const liveService = createDemoService(models, async () => {}, async (profileId, message) => {
        deliveries.push({ profileId, message });
        return { attempted: 2, accepted: 2, failed: 0 };
      });
      const liveOwner = new mongoose.Types.ObjectId();
      const liveRun = await liveService.create(liveOwner);
      await assert.rejects(
        liveService.act(liveRun._id, liveOwner, 'emergency', { sendRealSms: true }),
        /Confirm live demo SMS/,
      );
      let live = await liveService.act(liveRun._id, liveOwner, 'reset');
      live = await liveService.act(liveRun._id, liveOwner, 'emergency', {
        sendRealSms: true,
        demoSmsConfirmation: 'SEND DEMO SMS',
      });
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].message.kind, 'rescue');
      assert.deepEqual(live.run.liveSmsClaims, ['rescue']);
      assert.equal(live.run.liveSmsResult.accepted, 2);
    });
  } finally { await mongoose.disconnect(); await mongo.stop(); }
});
