const mongoose = require("mongoose");
const geo = require("../coordination/geo");
const { getGeoConfig } = require("../coordination/config");
const { createResponderService } = require("../coordination/responders");
const { createJourneyService } = require("../coordination/journeys");
const START = { latitude: 22.5726, longitude: 88.3639 };
function offset(p, north = 0, east = 0) {
  return {
    latitude: p.latitude + north / 111195,
    longitude: p.longitude + east / (111195 * Math.cos((p.latitude * Math.PI) / 180)),
  };
}
const ROUTE = [0, 400, 800, 1200, 1800].map((m) => offset(START, m));
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
function demoConfig(fast, env = process.env) {
  const config = getGeoConfig(env);
  config.checkinMs = 10000;
  if (fast)
    for (const [key, name, fallback] of [
      ["acceptMs", "DEMO_RESPONDER_TIMEOUT_SECONDS", 5],
      ["deviationMs", "DEMO_DEVIATION_CONFIRM_SECONDS", 3],
    ]) {
      const n = Number(env[name] ?? fallback);
      if (!Number.isFinite(n) || n < 1 || n > 600) fail(`Invalid ${name}`, 500);
      config[key] = n * 1000;
    }
  return config;
}
function createDemoService(models, notify = async () => {}, sendLiveDemoSms = async () => null) {
  const { Run, Session, Journey, ActiveUser } = models;
  async function create(owner) {
    const existing = await Run.findOne({ owner }).lean();
    if (existing) return existing;
    return Run.create({
      owner,
      victim: new mongoose.Types.ObjectId(),
      responder: new mongoose.Types.ObjectId(),
      clock: Date.now(),
    });
  }
  async function owned(id, owner) {
    if (!/^[a-f0-9]{24}$/i.test(String(id))) fail("Invalid demo ID", 400);
    const run = await Run.findOne({ _id: id, owner }).lean();
    if (!run) fail("Demo not found", 404);
    return run;
  }
  async function snapshot(id, owner) {
    const run = await owned(id, owner);
    const [session, journey] = await Promise.all([
      run.sessionId ? Session.findById(run.sessionId).lean() : null,
      run.journeyId ? Journey.findById(run.journeyId).lean() : null,
    ]);
    const config = demoConfig(run.fast);
    return {
      run,
      session,
      journey,
      route: ROUTE,
      config,
      simulated: true,
      label: "DEMO MODE — SIMULATED GPS",
      locationAgeSeconds: session
        ? geo.getCurrentEmergencyCenter(session, run.clock, config)?.ageSeconds
        : null,
      routeDistanceMeters: journey ? geo.corridorDistance(journey.currentLocation, ROUTE) : null,
      outsideSeconds: journey?.outsideSince
        ? Math.max(0, (run.clock - +new Date(journey.outsideSince)) / 1000)
        : 0,
    };
  }
  async function act(id, owner, action, body = {}) {
    const existing = await owned(id, owner);
    const config = demoConfig(existing.fast);
    const token = new Date(Date.now() + 60000);
    const run = await Run.findOneAndUpdate(
      { _id: id, owner, lockedUntil: { $lt: new Date() } },
      { $set: { lockedUntil: token } },
      { returnDocument: 'after' },
    ).lean();
    if (!run) fail("Another demo action is running");
    const now = () => run.clock;
    const emit = (event) =>
      notify({ ...event, profileId: String(owner), demoRunId: String(id), simulated: true });
    // Each demo can discover only its own explicitly created responder fixture.
    const scopedPresence = Object.fromEntries(
      ["find", "findOne", "exists", "updateOne"].map((method) => [
        method,
        (query, ...args) => ActiveUser[method]({ ...query, demoRunId: run._id }, ...args),
      ]),
    );
    const responders = createResponderService({
      Session,
      ActiveUser: scopedPresence,
      now,
      config,
      notify: emit,
    });
    // Run the production escalation rules using isolated models and a fake
    // contact/provider. No live contact lookup or SMS gateway is used here.
    const escalation = require('../coordination/journeySos').createJourneySos({
      Journey, now, notify: emit,
      Contact: { find: async () => [{ _id: run.responder, contacts: 'Simulated trusted contact', contactNumber: '0000000000' }] },
      sessions: {
        createSession: (profileId, analysis, mapsLink, contacts, options) =>
          require('../agent/sessions').createSession(profileId, analysis, mapsLink, contacts, { ...options, Session, now, durationMs: 86400000 }),
        issueContactLink: async () => null,
        callbackUrl: () => undefined,
        recordAttempt: (sessionId, attemptId, result) => Session.updateOne({ _id: sessionId, 'attempts._id': attemptId }, { $set: { 'attempts.$.status': result.status } }),
        finishInitial: async sessionId => {
          run.sessionId = sessionId;
          await Session.updateOne({ _id: sessionId }, { $set: { ready: true } });
        },
      },
      sendSOSAlert: async (summary, location, contacts, options) => {
        const results = contacts.map(() => ({ status: 'sent' }));
        for (let i = 0; i < contacts.length; i++) await options.onResult(contacts[i], results[i]);
        return results;
      },
    });
    const journeys = createJourneyService({ Journey, now, config, notify: emit, escalate: escalation });
    const advance = (ms) => {
      run.clock += Math.ceil(ms);
    };
    const input = (p) => ({ ...p, accuracy: 3, timestamp: run.clock });
    async function seedResponder(p) {
      const point = geo.locationInput(input(p), now(), config);
      await ActiveUser.findOneAndUpdate(
        { profileId: run.responder, demoRunId: run._id },
        {
          $set: {
            location: { type: "Point", coordinates: [point.longitude, point.latitude] },
            accuracy: 3,
            isActive: true,
            lastSeen: new Date(now()),
            locationObservedAt: new Date(now()),
            expireAt: new Date(now() + 3600000),
          },
        },
        { upsert: true },
      );
    }
    async function startJourney() {
      if (run.journeyId) {
        const old = await Journey.findById(run.journeyId).lean();
        if (old?.open) await journeys.action(old._id, run.victim, "cancel");
      }
      const j = await journeys.start(run.victim, {
        startLocation: input(START),
        destination: ROUTE.at(-1),
        route: ROUTE,
      });
      run.journeyId = j._id;
    }
    async function move(p, victim = true) {
      geo.locationInput(p, now(), config);
      const s = run.sessionId && (await Session.findById(run.sessionId).lean());
      const j = run.journeyId && (await Journey.findById(run.journeyId).lean());
      const previous = victim
        ? [s?.latestVictimLocation, j?.open && j.currentLocation].filter(Boolean)
        : [s?.activeResponder?.lastLocation].filter(Boolean);
      if (victim && !j?.open && (!s || s.status === "resolved"))
        fail("Start an open journey or emergency first");
      // Advance an explicitly displayed simulation clock instead of bypassing
      // the real rate, ordering, accuracy or plausible-speed validators.
      advance(
        Math.max(
          config.locationIntervalMs + 1,
          ...previous.map((q) => (geo.distance(q, p) / config.maxSpeed) * 1000 + 1000),
        ),
      );
      if (victim) {
        if (j?.open) await journeys.location(j._id, run.victim, input(p));
        if (s && s.status !== "resolved") {
          run.previousCenter = s.emergencyGeofence?.center;
          await responders.location(s._id, run.victim, input(p), true);
          await responders.check(s._id);
        }
      } else {
        if (!s?.activeResponder) fail("Accept a responder request first");
        await responders.location(s._id, run.responder, input(p));
      }
    }
    async function emergency(distance = 900) {
      if (run.sessionId) fail("Reset the demo before starting another emergency");
      const j = run.journeyId && (await Journey.findById(run.journeyId).lean());
      const p = j?.currentLocation || START;
      const point = geo.locationInput(input(p), now(), config);
      const s = await require("../agent/sessions").createSession(
        run.victim,
        { summary: "DEMO MODE — SIMULATED GPS" },
        `https://www.google.com/maps?q=${point.latitude},${point.longitude}`,
        [],
        { Session, now, point, durationMs: 86400000 },
      );
      run.sessionId = s._id;
      await seedResponder(offset(p, 0, distance));
      await responders.check(s._id);
    }
    async function accept() {
      if (!run.sessionId) fail("Start an emergency first");
      const s = await Session.findById(run.sessionId).lean();
      const request = s.nearbyResponderRequests.find(
        (r) => String(r.responderUserId) === String(run.responder),
      );
      if (!request || request.status !== "pending")
        fail("No pending responder request; reset to replay");
      await responders.respond(s._id, run.responder, "accepted");
      await responders.state(s._id, run.responder, "en_route");
      await responders.check(s._id);
    }
    async function liveSms(kind, location, body) {
      if (!body.sendRealSms) return;
      if (body.demoSmsConfirmation !== "SEND DEMO SMS")
        fail("Confirm live demo SMS before running this step", 400);
      if (run.liveSmsClaims?.includes(kind)) return;
      // Claim before the external request. An uncertain Twilio submission must
      // never be replayed automatically by a double-click or story replay.
      run.liveSmsClaims ||= [];
      run.liveSmsClaims.push(kind);
      const result = await sendLiveDemoSms(owner, {
        kind,
        location,
        demoRunId: run._id,
      });
      run.liveSmsResult = { kind, ...result, at: new Date() };
    }
    try {
      switch (action) {
        case "start":
          await startJourney();
          break;
        case "safe":
          if (!run.journeyId) await startJourney();
          for (const p of ROUTE.slice(1, 4)) await move(p);
          break;
        case "deviation":
          if (!run.journeyId) await startJourney();
          for (let i = 0; i < config.outsideSamples; i++) {
            advance(config.deviationMs / (config.outsideSamples - 1));
            await move(offset(ROUTE[2], 0, config.tolerance + 350));
          }
          // Give the viewer a full ten seconds after the deviation step finishes.
          {
            const j = await Journey.findById(run.journeyId).lean();
            if (j?.checkInState === 'pending' && !run.checkInWallDeadline) {
              run.checkInWallDeadline = new Date(Date.now() + config.checkinMs);
              await Journey.updateOne({ _id: j._id }, { $set: { checkInDueAt: new Date(now() + config.checkinMs) }, $inc: { version: 1 } });
            }
          }
          break;
        case "noise":
          await move(offset(ROUTE[2], 0, config.tolerance + 20));
          break;
        case 'checkin-wait':
        case 'checkin-tick':
        case 'checkin-timeout': {
          const j = run.journeyId && await Journey.findById(run.journeyId).lean();
          if (!j?.open || !['pending', 'unanswered'].includes(j.checkInState)) fail('Trigger a safety check first');
          if (run.sessionId && String(run.sessionId) !== String(j.sosSessionId)) fail('Reset the demo before escalating a journey alongside another emergency');
          if (action === 'checkin-tick' && (!run.checkInWallDeadline || Date.now() < +new Date(run.checkInWallDeadline))) break;
          if (action === 'checkin-wait') advance(Math.max(0, (+new Date(j.checkInDueAt) - now()) / 2));
          else advance(Math.max(0, +new Date(j.checkInDueAt) - now()) + 1);
          await journeys.check(j._id, run.victim);
          const updatedJourney = await Journey.findById(j._id).lean();
          if (updatedJourney?.sosState === 'accepted')
            await liveSms('journey', updatedJourney.currentLocation, body);
          break;
        }
        case 'checkin-safe':
          if (!run.journeyId) fail('Start a journey first');
          await journeys.action(run.journeyId, run.victim, 'safe');
          run.checkInWallDeadline = null;
          break;
        case "near-destination":
          await move(offset(ROUTE.at(-1), -config.destinationRadius - 100));
          break;
        case "destination":
          await move(ROUTE.at(-1));
          break;
        case "victim-location":
          await move(body);
          break;
        case "responder-location":
          await move(body, false);
          break;
        case "victim-300":
        case "victim-700": {
          const s = run.sessionId && (await Session.findById(run.sessionId).lean());
          // Movement-driven rescue searches require both enough distance and
          // enough elapsed time. Advance the visible simulation clock so this
          // action demonstrates the same recentering rule used in production.
          if (s && s.status !== "resolved") advance(config.recalcMs + 1);
          await move(
            offset(s?.latestVictimLocation || START, 0, action === "victim-300" ? 300 : 700),
          );
          break;
        }
        case "emergency":
        case "no-responder":
          await emergency(
            action === "no-responder" ? (config.radii[0] + config.radii[1]) / 2 : 900,
          );
          await liveSms("rescue", START, body);
          break;
        case "expand":
          if (!run.sessionId) fail("Start an emergency first");
          advance(config.acceptMs + 1);
          await responders.check(run.sessionId);
          break;
        case "accept":
          await accept();
          break;
        case "responder-900":
        case "responder-500":
        case "responder-250":
        case "responder-80":
        case "responder-15": {
          const s = run.sessionId && (await Session.findById(run.sessionId).lean());
          if (!s) fail("Start an emergency first");
          await move(offset(s.latestVictimLocation, 0, Number(action.split("-")[1])), false);
          break;
        }
        case "confirm-arrival":
          if (!run.sessionId) fail("Start an emergency first");
          await responders.state(run.sessionId, run.responder, "arrived");
          break;
        case "timing":
          if (typeof body.fast !== "boolean") fail("fast must be boolean", 400);
          run.fast = body.fast;
          break;
        case "resolve": {
          if (!run.sessionId) fail("Start an emergency first");
          // Reuse the authenticated production resolution handler with the
          // already-authorized demo fixture identity and isolated model.
          const h = require("../agent/http").createHandlers({ Session, notify: emit });
          await h.resolve(
            { params: { id: String(run.sessionId) }, user: { _id: run.victim } },
            { json: (x) => x, status: () => ({ json: (x) => x }) },
          );
          break;
        }
        case "reset":
          if (run.sessionId) await Session.deleteOne({ _id: run.sessionId, profileId: run.victim });
          await Journey.deleteMany({ profileId: run.victim });
          await ActiveUser.deleteMany({ demoRunId: run._id });
          run.sessionId = null;
          run.journeyId = null;
          run.previousCenter = null;
          run.checkInWallDeadline = null;
          run.liveSmsClaims = [];
          run.liveSmsResult = null;
          run.clock = Date.now();
          break;
        default:
          fail("Unknown demo action", 400);
      }
    } finally {
      // Persist partial progress too: a retry/reset can recover a failed action.
      await Run.updateOne(
        { _id: id, owner, lockedUntil: token },
        {
          $set: {
            sessionId: run.sessionId,
            journeyId: run.journeyId,
            clock: run.clock,
            fast: run.fast,
            previousCenter: run.previousCenter,
            checkInWallDeadline: run.checkInWallDeadline,
            liveSmsClaims: run.liveSmsClaims,
            liveSmsResult: run.liveSmsResult,
            lockedUntil: new Date(0),
          },
        },
      );
      await emit({ type: "demo-updated" }).catch(() => {});
    }
    return snapshot(id, owner);
  }
  return { create, owned, snapshot, act };
}
module.exports = { createDemoService, demoConfig, START, ROUTE, offset };
