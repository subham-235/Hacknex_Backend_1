const test = require("node:test");
const assert = require("node:assert/strict");
const geo = require("../src/coordination/geo");
const { getGeoConfig } = require("../src/coordination/config");
const { createResponderService } = require("../src/coordination/responders");
const { createJourneyService } = require("../src/coordination/journeys");
const { createGeoDispatcher } = require("../src/coordination/dispatcher");
const { createGeoHandlers } = require("../src/coordination/http");
const SessionModel = require("../src/models/emergencySession");
const JourneyModel = require("../src/models/safetyJourney");
const config = getGeoConfig({});
const OWNER = "111111111111111111111111",
  A = "222222222222222222222222",
  B = "333333333333333333333333",
  ID = "444444444444444444444444";
const clone = (x) => structuredClone(x);
const point = (longitude = 0, at = 1000000) => ({
  latitude: 0,
  longitude,
  accuracy: 5,
  observedAt: new Date(at),
  receivedAt: new Date(at),
});
const query = (fn) => ({
  lean: async () => clone(fn()),
  select() {
    return this;
  },
  sort() {
    return this;
  },
  limit() {
    return this;
  },
});
function harness(options = {}) {
  let time = 1000000;
  let session = {
    _id: ID,
    profileId: OWNER,
    status: "active",
    ready: true,
    expiresAt: new Date(time + 1800000),
    coordinationVersion: 0,
    nearbyResponderRequests: [],
    latestVictimLocation: point(),
    initialVictimLocation: point(),
    escalationStage: 0,
    escalationHistory: [],
    geoRiskSignals: [],
    ...options,
  };
  const users = [A, B].map((id, i) => ({
    profileId: id,
    isActive: true,
    lastSeen: new Date(time),
    expireAt: new Date(time + 600000),
    location: { coordinates: [0.001 * (i + 1), 0] },
    accuracy: 5,
  }));
  const events = [],
    writes = [],
    searches = [];
  const Session = {
    findById: () => query(() => session),
    exists: async () => false,
    findOneAndUpdate: (filter, update) =>
      query(() => {
        if (
          filter.coordinationVersion !== session.coordinationVersion ||
          !filter.status.$in.includes(session.status) ||
          session.expiresAt <= filter.expiresAt.$gt
        )
          return null;
        writes.push(clone({ filter, update }));
        Object.assign(session, clone(update.$set));
        session.coordinationVersion++;
        return session;
      }),
  };
  const ActiveUser = {
    findOne: (f) =>
      query(
        () =>
          users.find(
            (u) =>
              u.profileId === String(f.profileId) &&
              u.isActive &&
              +u.lastSeen >= +f.lastSeen.$gte &&
              +u.expireAt > +f.expireAt.$gt,
          ) || null,
      ),
    exists: async (f) => users.some((u) => u.profileId === String(f.profileId) && u.isActive),
    find: (f) => {
      searches.push(f);
      return query(() =>
        users.filter(
          (u) =>
            u.isActive &&
            !f.profileId.$nin.map(String).includes(u.profileId) &&
            +u.lastSeen >= +f.lastSeen.$gte &&
            geo.distance(
              {
                longitude: f.location.$near.$geometry.coordinates[0],
                latitude: f.location.$near.$geometry.coordinates[1],
              },
              { longitude: u.location.coordinates[0], latitude: u.location.coordinates[1] },
            ) <= f.location.$near.$maxDistance,
        ),
      );
    },
  };
  const service = createResponderService({
    Session,
    ActiveUser,
    now: () => time,
    config,
    notify: async (e) => events.push(e),
  });
  return {
    service,
    Session,
    ActiveUser,
    users,
    events,
    writes,
    searches,
    get session() {
      return session;
    },
    advance: (ms) => {
      time += ms;
    },
    now: () => time,
  };
}
test("configuration validates ordered radii and bounded thresholds", () => {
  assert.deepEqual(config.radii, [1000, 2000, 3000]);
  assert.throws(() => getGeoConfig({ RESPONDER_RADIUS_MAX_METERS: 500 }));
  assert.throws(() => getGeoConfig({ GEO_MAX_ACCURACY_METERS: "NaN" }));
});
test("haversine measures known distances including antimeridian", () => {
  assert.equal(geo.distance(point(), point()), 0);
  assert.ok(Math.abs(geo.distance(point(), point(1)) - 111195) < 1);
  assert.ok(geo.distance(point(179.999), point(-179.999)) < 225);
});
test("location input rejects impossible, malformed, future, stale and inaccurate readings", () => {
  for (const input of [
    null,
    {},
    { latitude: "0", longitude: 0 },
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: Infinity },
    { latitude: 0, longitude: 0, accuracy: 500 },
    { latitude: 0, longitude: 0, timestamp: 1 },
    { latitude: 0, longitude: 0, timestamp: 2000000 },
  ])
    assert.throws(() => geo.locationInput(input, 1000000, config));
  assert.equal(geo.locationInput({ latitude: 0, longitude: 0 }, 1000000, config).longitude, 0);
});
test("location ordering, rate limits, and GPS jump protection", () => {
  assert.throws(() => geo.acceptLocation(point(), point(0, 999999), config), { status: 409 });
  assert.throws(() => geo.acceptLocation(point(), point(0, 1001000), config), { status: 429 });
  assert.throws(() => geo.acceptLocation(point(), point(1, 1010000), config), /GPS jump/);
  geo.acceptLocation(point(), point(0.001, 1010000), config);
});
test("arrival is a candidate only with fresh, accurate locations and never resolution", () => {
  assert.equal(geo.tracking(point(), point(0.00005), 1000000, config).zone, "arrival_candidate");
  assert.equal(
    geo.tracking(point(), { ...point(), accuracy: undefined }, 1000000, config).zone,
    "nearby",
  );
  assert.equal(geo.tracking(point(), point(), 1200001, config).estimatedEtaSeconds, null);
  assert.equal(geo.tracking(point(), point(0.003), 1000000, config).zone, "approaching");
});
test("initial requests are persistent, rounded, deduplicated, and exclude owner", async () => {
  const h = harness();
  await h.service.check(ID);
  await h.service.check(ID);
  assert.equal(h.session.nearbyResponderRequests.length, 2);
  assert.equal(h.events.filter((e) => e.type === "responder-request-created").length, 2);
  assert.equal(h.session.nearbyResponderRequests[0].distanceAtNotification, 200);
  assert.equal(h.session.escalationStage, 1);
  assert.ok(h.searches[0].profileId.$nin.includes(OWNER));
  assert.equal(h.service.view(h.session, A).victimLocation, undefined);
});
test("authenticated acceptance assigns and duplicate response is blocked", async () => {
  const h = harness();
  await h.service.check(ID);
  await h.service.respond(ID, A, "accepted");
  assert.equal(h.session.activeResponder.userId, A);
  assert.equal(h.session.activeResponder.currentStatus, "assigned");
  assert.ok(h.service.view(h.session, A).victimLocation);
  assert.equal(h.service.view(h.session, B).victimLocation, undefined);
  await assert.rejects(h.service.respond(ID, A, "accepted"), { status: 409 });
});
test("simultaneous accepts atomically retain exactly one primary and both decisions", async () => {
  const h = harness();
  await h.service.check(ID);
  await Promise.all([h.service.respond(ID, A, "accepted"), h.service.respond(ID, B, "accepted")]);
  assert.ok([A, B].includes(h.session.activeResponder.userId));
  assert.equal(h.session.nearbyResponderRequests.filter((r) => r.status === "accepted").length, 2);
  assert.equal(
    h.events.filter((e) => e.type === "responder-assigned" && e.profileId === OWNER).length,
    1,
  );
});
test("assignment selects nearest of currently accepted eligible responders", async () => {
  const h = harness();
  await h.service.check(ID);
  h.session.nearbyResponderRequests.forEach((r) => {
    r.status = "accepted";
    r.respondedAt = new Date(h.now());
  });
  await h.service.check(ID);
  assert.equal(h.session.activeResponder.userId, A);
});
test("decline, foreign request, inactive user and expired request are enforced", async () => {
  const h = harness();
  await h.service.check(ID);
  await assert.rejects(h.service.respond(ID, OWNER, "accepted"), { status: 404 });
  await h.service.respond(ID, A, "declined");
  assert.equal(h.session.activeResponder, null);
  h.users[1].isActive = false;
  await assert.rejects(h.service.respond(ID, B, "accepted"), { status: 403 });
  h.users[1].isActive = true;
  h.advance(config.acceptMs + 1);
  await assert.rejects(h.service.respond(ID, B, "accepted"), { status: 409 });
});
test("radius escalation discovers new users and stops at configured maximum", async () => {
  const h = harness();
  h.users[1].location.coordinates[0] = 0.015;
  await h.service.check(ID);
  assert.equal(h.session.nearbyResponderRequests.length, 1);
  h.advance(30001);
  await h.service.check(ID);
  assert.equal(h.session.escalationStage, 2);
  assert.equal(h.session.nearbyResponderRequests.length, 2);
  h.advance(30001);
  await h.service.check(ID);
  assert.equal(h.session.escalationState, "searching");
  h.advance(30001);
  await h.service.check(ID);
  assert.equal(h.session.escalationStage, 3);
  assert.equal(h.session.escalationState, "help_unavailable");
  assert.equal(h.session.escalationHistory.length, 3);
});
test("empty nearby search remains active and persists escalation schedule", async () => {
  const h = harness();
  h.users.length = 0;
  await h.service.check(ID);
  assert.equal(h.session.status, "active");
  assert.equal(h.session.escalationState, "searching");
  assert.ok(h.session.coordinationNextRunAt > h.now());
});
test("victim movement recentres search, updates distance and throttles requery", async () => {
  const h = harness();
  await h.service.check(ID);
  await h.service.respond(ID, A, "accepted");
  h.advance(15000);
  await h.service.location(
    ID,
    OWNER,
    { latitude: 0, longitude: 0.005, accuracy: 5, timestamp: h.now() },
    true,
  );
  assert.ok(h.session.responderTracking.distanceMeters > 400);
  await h.service.check(ID);
  assert.equal(h.session.emergencyGeofence.center.longitude, 0.005);
  assert.equal(h.session.emergencyGeofence.searchCenter.longitude, 0);
  h.advance(16000);
  await h.service.check(ID);
  assert.equal(h.session.emergencyGeofence.center.longitude, 0.005);
  assert.ok(h.session.geoRiskSignals.includes("VICTIM_MOVING_DURING_EMERGENCY"));
  assert.equal(h.session.emergencyGeofence.searchCenter.longitude, 0.005);
});
test("tracking requires assignment, remains active at arrival, and stops on resolution/expiry", async () => {
  const h = harness();
  await h.service.check(ID);
  await h.service.respond(ID, A, "accepted");
  h.advance(10000);
  const body = { latitude: 0, longitude: 0, accuracy: 5, timestamp: h.now() };
  await assert.rejects(h.service.location(ID, B, body), { status: 403 });
  await h.service.location(ID, A, body);
  assert.equal(h.session.responderTracking.zone, "arrival_candidate");
  assert.equal(h.session.status, "active");
  await h.service.state(ID, A, "arrived");
  await h.service.state(ID, A, "completed");
  assert.equal(h.session.status, "active");
  await assert.rejects(h.service.location(ID, A, body), /ended/);
  h.session.status = "resolved";
  await assert.rejects(h.service.location(ID, A, body), /closed/);
  assert.equal(h.service.view(h.session, A).victimLocation, undefined);
  h.session.status = "active";
  h.session.expiresAt = new Date(0);
  await assert.rejects(h.service.state(ID, A, "en_route"), /closed/);
});
test("responder cancellation reassigns accepted backup, stale location revokes access", async () => {
  const h = harness();
  await h.service.check(ID);
  await h.service.respond(ID, A, "accepted");
  await h.service.respond(ID, B, "accepted");
  await h.service.state(ID, A, "cancelled");
  await h.service.check(ID);
  assert.equal(h.session.activeResponder.userId, B);
  h.advance(config.staleMs + 1);
  assert.equal(h.service.view(h.session, B).victimLocation, undefined);
  await h.service.check(ID);
  assert.equal(h.session.activeResponder, null);
  assert.ok(h.session.geoRiskSignals.includes("RESPONDER_LOCATION_STALE"));
  assert.ok(h.session.geoRiskSignals.includes("LOCATION_STALE"));
});
test("resolution during a pending write wins over responder mutation", async () => {
  const h = harness();
  await h.service.check(ID);
  const original = h.Session.findOneAndUpdate;
  h.Session.findOneAndUpdate = (...args) => {
    h.session.status = "resolved";
    return original(...args);
  };
  await assert.rejects(h.service.respond(ID, A, "accepted"), /closed/);
  assert.equal(h.session.activeResponder, null);
});
test("closed-loop retry after lost notifications never duplicates requests", async () => {
  const h = harness();
  const broken = createResponderService({
    Session: h.Session,
    ActiveUser: h.ActiveUser,
    now: h.now,
    config,
    notify: async () => {
      throw new Error("Redis disconnected");
    },
  });
  await broken.check(ID);
  await h.service.check(ID);
  assert.equal(h.session.nearbyResponderRequests.length, 2);
  assert.equal(h.service.view(h.session, A).request.status, "pending");
});
test("journey destination tolerates GPS but does not assert arrival with broad uncertainty", () => {
  const journey = { destination: point(), route: [] };
  assert.equal(geo.evaluateJourney(journey, point(0.0005), 1000000, config).status, "arrived");
  assert.notEqual(
    geo.evaluateJourney(journey, { ...point(0.001), accuracy: 100 }, 1000000, config).status,
    "arrived",
  );
});
test("route deviation requires multiple samples AND minimum duration, noise resets", () => {
  let j = { destination: point(0.1), route: [point(), point(0.1)] };
  const outside = { ...point(0.02), latitude: 0.01 };
  j = { ...j, ...geo.evaluateJourney(j, outside, 1000000, config) };
  assert.equal(j.routeDeviationDetected, false);
  j = { ...j, ...geo.evaluateJourney(j, outside, 1030000, config) };
  assert.equal(j.routeDeviationDetected, false);
  j = { ...j, ...geo.evaluateJourney(j, outside, 1060000, config) };
  assert.equal(j.routeDeviationDetected, true);
  assert.equal(j.checkInState, "pending");
  j = { ...j, ...geo.evaluateJourney(j, point(0.02), 1070000, config) };
  assert.equal(j.outsideSamples, 0);
  assert.equal(j.routeDeviationDetected, false);
  assert.ok(geo.corridorDistance(point(0.05), [point(), point(0.1)]) < 0.01);
});
function journeyHarness() {
  let time = 1000000,
    j;
  const Journey = {
    create: async (input) => {
      j = {
        _id: ID,
        open: true,
        version: 0,
        status: "active",
        checkInState: "none",
        riskSignals: [],
        ...input,
      };
      return clone(j);
    },
    findOne: (f) => query(() => (j && String(j.profileId) === String(f.profileId) ? j : null)),
    findOneAndUpdate: (f, u) =>
      query(() => {
        if (j.version !== f.version || !j.open) return null;
        Object.assign(j, clone(u.$set));
        j.version++;
        return j;
      }),
  };
  const service = createJourneyService({ Journey, config, now: () => time });
  return {
    service,
    get journey() {
      return j;
    },
    advance: (ms) => (time += ms),
    now: () => time,
  };
}
test("journey ETA starts a timed safety check before unanswered escalation", async () => {
  const h = journeyHarness();
  await h.service.start(OWNER, {
    startLocation: { latitude: 0, longitude: 0 },
    destination: point(0.1),
    expectedArrivalAt: new Date(h.now() + 60000),
  });
  h.advance(60001);
  await h.service.check(ID, OWNER);
  assert.equal(h.journey.checkInState, "pending");
  h.advance(config.checkinMs);
  await h.service.check(ID, OWNER);
  assert.equal(h.journey.status, "escalated");
  assert.ok(h.journey.riskSignals.includes("DESTINATION_OVERDUE"));
  await assert.rejects(h.service.action(ID, A, "safe"), { status: 404 });
  await h.service.action(ID, OWNER, "safe");
  assert.equal(h.journey.open, false);
  assert.equal(h.journey.checkInState, "safe");
  await assert.rejects(
    h.service.location(ID, OWNER, { latitude: 0, longitude: 0, timestamp: h.now() }),
    /closed/,
  );
});
test("a safety check can continue the same monitored journey", async () => {
  const h = journeyHarness();
  await h.service.start(OWNER, {
    startLocation: { latitude: 0, longitude: 0 },
    destination: point(0.1),
    route: [point(), point(0.1)],
    expectedArrivalAt: new Date(h.now() + 60000),
  });
  h.advance(60001);
  await h.service.check(ID, OWNER);
  assert.equal(h.journey.checkInState, "pending");
  await h.service.action(ID, OWNER, "continue");
  assert.equal(h.journey.open, true);
  assert.equal(h.journey.status, "active");
  assert.equal(h.journey.checkInState, "none");
  assert.equal(h.journey.route.length, 2);
  assert.ok(+new Date(h.journey.expectedArrivalAt) > h.now());
  await h.service.check(ID, OWNER);
  assert.equal(h.journey.checkInState, "none");
});
test("journey arrival and cancellation stop background monitoring", async () => {
  for (const action of ["arrive", "cancel"]) {
    const h = journeyHarness();
    await h.service.start(OWNER, {
      startLocation: { latitude: 0, longitude: 0, accuracy: 5 },
      destination: point(0.001),
    });
    h.advance(10000);
    if (action === "arrive")
      await h.service.location(ID, OWNER, {
        latitude: 0,
        longitude: 0.001,
        accuracy: 5,
        timestamp: h.now(),
      });
    else await h.service.action(ID, OWNER, "cancel");
    assert.equal(h.journey.open, false);
    assert.equal(h.journey.status, action === "arrive" ? "arrived" : "cancelled");
  }
});
test("journey tracking starts coarse and refines without weakening rescue GPS rules", async () => {
  const h = journeyHarness();
  await h.service.start(OWNER, {
    startLocation: { latitude: 0, longitude: 0, accuracy: 1500 },
    destination: point(0.01),
    route: [point(0), point(0.01)],
  });
  assert.equal(h.service.view(h.journey).locationPrecise, false);
  h.advance(10000);
  await h.service.location(ID, OWNER, {
    latitude: 0,
    longitude: 0,
    accuracy: 300,
    timestamp: h.now(),
  });
  assert.equal(h.service.view(h.journey).locationPrecise, false);
  h.advance(10000);
  await h.service.location(ID, OWNER, {
    latitude: 0,
    longitude: 0,
    accuracy: 50,
    timestamp: h.now(),
  });
  assert.equal(h.service.view(h.journey).locationPrecise, true);
  assert.throws(
    () => geo.locationInput({ latitude: 0, longitude: 0, accuracy: 300 }, h.now(), config),
    /accuracy is insufficient/,
  );
});
test("dispatcher requeues persisted due work after Redis failure with stable IDs", async () => {
  const jobs = [];
  let fail = true;
  const Session = { updateMany: async () => {}, find: () => query(() => [{ _id: ID }]) };
  const Journey = { updateMany: async () => {}, find: () => query(() => [{ _id: A, profileId: OWNER }]) };
  const queue = {
    add: async (...args) => {
      if (fail) throw new Error("Redis down");
      jobs.push(args);
    },
  };
  const dispatch = createGeoDispatcher({ Session, Journey, queue });
  await dispatch();
  fail = false;
  await dispatch();
  await createGeoDispatcher({ Session, Journey, queue })();
  assert.equal(jobs.length, 4);
  assert.equal(jobs[0][2].jobId, jobs[2][2].jobId);
  assert.equal(jobs[0][2].attempts, 3);
  assert.equal(jobs[1][0], "check-journey");
});
test("HTTP rejects malformed IDs and uses authenticated identity, never body responder ID", async () => {
  let called;
  const h = createGeoHandlers({
    responders: {
      respond: async (...args) => {
        called = args;
        return {};
      },
      view: () => ({}),
    },
  });
  const res = {
    code: 200,
    status(c) {
      this.code = c;
      return this;
    },
    json(v) {
      this.body = v;
      return this;
    },
  };
  await h.respond("accepted")({ params: { id: "invalid" }, user: { _id: A } }, res, (e) => {
    throw e;
  });
  assert.equal(res.code, 400);
  assert.equal(called, undefined);
  await h.respond("accepted")(
    { params: { id: ID }, user: { _id: A }, body: { responderUserId: B } },
    res,
    (e) => {
      throw e;
    },
  );
  assert.deepEqual(called, [ID, A, "accepted"]);
});
test("schemas persist assignment, request states, and partial unique indexes", async () => {
  const s = new SessionModel({
    profileId: OWNER,
    reference: "TEST",
    initialDeadline: new Date(),
    expiresAt: new Date(),
    activeResponder: { userId: A, currentStatus: "assigned" },
    nearbyResponderRequests: [{ responderUserId: A, status: "pending" }],
  });
  await s.validate();
  assert.ok(
    SessionModel.schema
      .indexes()
      .some(([keys, options]) => keys["activeResponder.userId"] && options.unique),
  );
  assert.ok(
    JourneyModel.schema
      .indexes()
      .some(([, options]) => options.unique && options.partialFilterExpression.open),
  );
});
