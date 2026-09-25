const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Session = require("../src/models/emergencySession");
const ActiveUser = require("../src/models/activeUser");
const Journey = require("../src/models/safetyJourney");
const { createResponderService } = require("../src/coordination/responders");
const { createJourneyService } = require("../src/coordination/journeys");
const { createHandlers } = require("../src/agent/http");

// An isolated, temporary mongod: never reads .env or an application DB URI.
test("real MongoDB coordination integration", { timeout: 180000 }, async (t) => {
  const mongo = await MongoMemoryServer.create();
  try {
    await mongoose.connect(mongo.getUri());
    await Promise.all([Session.init(), ActiveUser.init(), Journey.init()]);
    const owner = new mongoose.Types.ObjectId(),
      a = new mongoose.Types.ObjectId(),
      b = new mongoose.Types.ObjectId();
    let now = Date.now();
    const events = [];
    const responders = createResponderService({
      Session,
      ActiveUser,
      now: () => now,
      notify: async (e) => events.push(e),
    });
    const point = {
      latitude: 0,
      longitude: 0,
      accuracy: 5,
      observedAt: new Date(now),
      receivedAt: new Date(now),
    };
    await ActiveUser.create(
      [a, b].map((profileId, i) => ({
        profileId,
        location: { type: "Point", coordinates: [0.001 * (i + 1), 0] },
        lastSeen: new Date(now),
        locationObservedAt: new Date(now),
        expireAt: new Date(now + 600000),
        accuracy: 5,
      })),
    );
    const makeSession = (reference, profileId = owner) =>
      Session.create({
        profileId,
        reference,
        ready: true,
        initialDeadline: new Date(now),
        expiresAt: new Date(now + 1800000),
        initialVictimLocation: point,
        latestVictimLocation: point,
      });
    const session = await makeSession("MONGO-ONE");
    await t.test(
      "geospatial query creates deduplicated requests under concurrent checks",
      async () => {
        await Promise.all([responders.check(session._id), responders.check(session._id)]);
        const saved = await Session.findById(session._id).lean();
        assert.equal(saved.nearbyResponderRequests.length, 2);
        assert.equal(saved.escalationStage, 1);
        assert.equal(events.filter((e) => e.type === "responder-request-created").length, 2);
      },
    );
    await t.test(
      "concurrent accepts persist both decisions and exactly one assignment",
      async () => {
        await Promise.all([
          responders.respond(session._id, a, "accepted"),
          responders.respond(session._id, b, "accepted"),
        ]);
        const saved = await Session.findById(session._id).lean();
        assert.equal(
          saved.nearbyResponderRequests.filter((r) => r.status === "accepted").length,
          2,
        );
        assert.ok([String(a), String(b)].includes(String(saved.activeResponder.userId)));
        assert.equal(
          events.filter((e) => e.type === "responder-assigned" && e.profileId === String(owner))
            .length,
          1,
        );
      },
    );
    await t.test("partial unique index blocks cross-incident duplicate assignments", async () => {
      const saved = await Session.findById(session._id).lean();
      const other = await makeSession("MONGO-TWO", new mongoose.Types.ObjectId());
      await assert.rejects(
        Session.updateOne({ _id: other._id }, { $set: { activeResponder: saved.activeResponder } }),
        { code: 11000 },
      );
    });
    await t.test(
      "real conditional writes reject impersonation and out-of-order tracking",
      async () => {
        const saved = await Session.findById(session._id).lean(),
          assigned = saved.activeResponder.userId;
        now += 10000;
        const body = { latitude: 0, longitude: 0, accuracy: 5, timestamp: now };
        await assert.rejects(responders.location(session._id, owner, body), { status: 403 });
        await responders.location(session._id, assigned, body);
        await assert.rejects(responders.location(session._id, assigned, body), { status: 409 });
        const tracked = await Session.findById(session._id).lean();
        assert.equal(tracked.responderTracking.zone, "arrival_candidate");
        assert.equal(tracked.status, "active");
      },
    );
    await t.test(
      "owner resolution atomically clears assignment and cancels outstanding requests",
      async () => {
        const saved = await Session.findById(session._id).lean();
        const handlers = createHandlers({ Session });
        const res = {
          status(c) {
            this.code = c;
            return this;
          },
          json(body) {
            this.body = body;
            return this;
          },
        };
        await handlers.resolve({ params: { id: String(session._id) }, user: { _id: owner } }, res);
        assert.equal(res.body.session.status, "resolved");
        assert.equal(res.body.session.activeResponder, null);
        assert.ok(res.body.session.nearbyResponderRequests.every((r) => r.status === "cancelled"));
        await assert.rejects(
          responders.location(session._id, saved.activeResponder.userId, {
            latitude: 0,
            longitude: 0,
            timestamp: now,
          }),
          /closed/,
        );
        assert.equal(
          responders.view(await Session.findById(session._id).lean(), saved.activeResponder.userId)
            .victimLocation,
          undefined,
        );
      },
    );
    await t.test('legacy sessions without responder arrays do not block dispatch or resolution', async () => {
      const legacyId = new mongoose.Types.ObjectId();
      await Session.collection.insertMany([
        { _id: new mongoose.Types.ObjectId(), profileId: owner, reference: 'LEGACY-CLOSED', status: 'resolved', expiresAt: new Date(0) },
        { _id: legacyId, profileId: owner, reference: 'LEGACY-ACTIVE', status: 'active', ready: true, expiresAt: new Date(Date.now() + 600000), location: { mapsLink: '0,0', observedAt: new Date() } },
      ]);
      const jobs = [];
      await require('../src/coordination/dispatcher').createGeoDispatcher({ Session, Journey, queue: { add: async (...args) => jobs.push(args) } })();
      assert.ok(jobs.some(([, data]) => data.sessionId === String(legacyId)));
      const res = { status(c) { this.code = c; return this; }, json(body) { this.body = body; return this; } };
      await createHandlers({ Session }).resolve({ params: { id: String(legacyId) }, user: { _id: owner } }, res);
      assert.equal(res.body.session.status, 'resolved');
      assert.deepEqual(res.body.session.nearbyResponderRequests, []);
    });
    await t.test("open journey uniqueness and persistence survive service recreation", async () => {
      const service = createJourneyService({ Journey, now: () => now });
      const input = {
        startLocation: { latitude: 0, longitude: 0, accuracy: 5 },
        destination: { latitude: 0, longitude: 0.01 },
        expectedArrivalAt: new Date(now + 10000),
      };
      const results = await Promise.allSettled([
        service.start(owner, input),
        service.start(owner, input),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
      const journey = await Journey.findOne({ profileId: owner, open: true }).lean();
      now += 310001;
      const restarted = createJourneyService({ Journey, now: () => now });
      await restarted.check(journey._id, owner);
      assert.equal((await Journey.findById(journey._id)).checkInState, "pending");
      await restarted.action(journey._id, owner, "cancel");
      assert.equal((await Journey.findById(journey._id)).open, false);
      await restarted.start(owner, { ...input, expectedArrivalAt: undefined });
    });
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
});
