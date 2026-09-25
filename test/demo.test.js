const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { createDemoService, demoConfig, START } = require("../src/demo/service");
const models = require("../src/demo/models");

test("demo limiter rejects excess traffic and fails closed without Redis", async () => {
  const { createDemoRateLimit } = require("../src/demo/rateLimit");
  let count = 0,
    accepted = 0,
    status = 200,
    expiry;
  const res = {
    set() {},
    status(code) {
      status = code;
      return this;
    },
    json(value) {
      return value;
    },
  };
  const req = { user: { _id: "owner" } };
  const limit = createDemoRateLimit({
    incr: async () => ++count,
    expire: async (key, seconds) => {
      expiry = seconds;
    },
  });
  for (let i = 0; i < 121; i++) await limit(req, res, () => accepted++);
  assert.equal(accepted, 120);
  assert.equal(status, 429);
  assert.equal(expiry, 120);
  await createDemoRateLimit({
    incr: async () => {
      throw new Error("offline");
    },
  })(req, res, () => accepted++);
  assert.equal(status, 503);
  assert.equal(accepted, 120);
});

test("demo configuration leaves production thresholds unchanged", () => {
  assert.equal(demoConfig(true, {}).checkinMs, 10000);
  assert.equal(require('../src/coordination/config').getGeoConfig({}).checkinMs, 300000);
  assert.equal(demoConfig(false, {}).acceptMs, 30000);
  assert.equal(demoConfig(false, {}).deviationMs, 60000);
  assert.equal(demoConfig(true, {}).acceptMs, 5000);
  assert.equal(demoConfig(true, {}).deviationMs, 3000);
  assert.throws(() => demoConfig(true, { DEMO_RESPONDER_TIMEOUT_SECONDS: "0" }));
});

test("demo routes are unavailable by default and still require authentication", async () => {
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use(require("cookie-parser")());
  app.use("/demo", require("../src/demo/routes"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/demo`;
  const before = process.env.ENABLE_DEMO_MODE;
  try {
    delete process.env.ENABLE_DEMO_MODE;
    for (const path of [
      "/sessions",
      "/sessions/000000000000000000000000/scenario",
      "/sessions/000000000000000000000000/reset",
      "/sessions/000000000000000000000000/victim-location",
      "/sessions/000000000000000000000000/responder-location",
    ]) {
      assert.equal((await fetch(url + path, { method: "POST" })).status, 404);
    }
    process.env.ENABLE_DEMO_MODE = "true";
    const unauthenticated = await fetch(url + "/sessions", { method: "POST" });
    assert.equal(unauthenticated.status, 404); // Existing authentication middleware convention.
    assert.match(await unauthenticated.text(), /Token not found/);
  } finally {
    if (before === undefined) delete process.env.ENABLE_DEMO_MODE;
    else process.env.ENABLE_DEMO_MODE = before;
    await new Promise((resolve) => server.close(resolve));
  }
});

test(
  "real MongoDB demo: ownership, discovery, escalation, GPS, journey and reset",
  { timeout: 180000 },
  async () => {
    const mongo = await MongoMemoryServer.create();
    try {
      await mongoose.connect(mongo.getUri());
      await Promise.all(Object.values(models).map((m) => m.init()));
      const events = [];
      const service = createDemoService(models, async (e) => events.push(e));
      const owner = new mongoose.Types.ObjectId(),
        outsider = new mongoose.Types.ObjectId();
      const run = await service.create(owner);
      const act = (action, body) => service.act(run._id, owner, action, body);
      await models.Run.updateOne(
        { _id: run._id },
        { $set: { lockedUntil: new Date(Date.now() + 60000) } },
      );
      await assert.rejects(act("reset"), /Another demo action/);
      await models.Run.updateOne({ _id: run._id }, { $set: { lockedUntil: new Date(0) } });
      await assert.rejects(service.snapshot(run._id, outsider), { status: 404 });
      await assert.rejects(service.act(run._id, outsider, "reset"), { status: 404 });
      await assert.rejects(act("victim-location", { latitude: "22", longitude: 88 }), {
        status: 400,
      });
      await assert.rejects(act("responder-location", { latitude: 91, longitude: 88 }), {
        status: 400,
      });
      await act("start");
      let state = await act("safe");
      assert.equal(state.journey.outsideSamples, 0);
      state = await act("noise");
      assert.equal(state.journey.outsideSamples, 1);
      assert.equal(state.journey.routeDeviationDetected, false);
      await act("safe");
      state = await act("deviation");
      assert.equal(state.journey.routeDeviationDetected, true);
      assert.equal(state.journey.checkInState, "pending");
      assert.equal(state.session, null);
      assert(events.some((e) => e.type === "journey-deviation-detected"));
      await act("reset");
      await act("start");
      state = await act("near-destination");
      assert.equal(state.journey.destinationReached, false);
      state = await act("destination");
      assert.equal(state.journey.destinationReached, true);
      await act("reset");
      state = await act("no-responder");
      assert.equal(state.session.escalationStage, 1);
      assert.equal(state.session.nearbyResponderRequests.length, 0);
      state = await act("expand");
      assert.equal(state.session.escalationStage, 2);
      assert.equal(state.session.emergencyGeofence.radiusMeters, 2000);
      assert.equal(state.session.nearbyResponderRequests.length, 1);
      state = await act("accept");
      assert.equal(state.session.activeResponder.currentStatus, "en_route");
      for (const [meters, zone] of [
        [900, "en_route"],
        [500, "approaching"],
        [250, "approaching"],
        [80, "nearby"],
        [15, "arrival_candidate"],
      ]) {
        state = await act(`responder-${meters}`);
        assert(Math.abs(state.session.responderTracking.distanceMeters - meters) <= 1);
        assert.equal(state.session.responderTracking.zone, zone);
        assert.equal(state.session.status, "active");
      }
      state = await act("confirm-arrival");
      assert.equal(state.session.activeResponder.currentStatus, "arrived");
      state = await act("victim-700");
      assert.equal(
        state.session.emergencyGeofence.center.longitude,
        state.session.latestVictimLocation.longitude,
      );
      assert.notEqual(
        state.run.previousCenter.longitude,
        state.session.emergencyGeofence.center.longitude,
      );
      state = await act("resolve");
      assert.equal(state.session.status, "resolved");
      assert.equal(state.session.activeResponder, null);
      const other = await service.create(outsider);
      await service.act(other._id, outsider, "emergency");
      const production = require("../src/models/emergencySession");
      assert.equal(await production.countDocuments(), 0);
      await act("reset");
      assert.equal(await models.Session.countDocuments(), 1);
      assert.equal(
        (await service.snapshot(other._id, outsider)).session.nearbyResponderRequests.length,
        1,
      );
      assert.equal(await models.ActiveUser.countDocuments({ demoRunId: run._id }), 0);
      assert(events.some((e) => e.type === "responder-arrival-candidate"));
      assert(
        events.every(
          (e) =>
            (e.simulated && String(e.profileId) === String(owner)) ||
            String(e.profileId) === String(outsider),
        ),
      );
    } finally {
      await mongoose.disconnect();
      await mongo.stop();
    }
  },
);
