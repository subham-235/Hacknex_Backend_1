const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const parser = require("../src/utils/locationParser");

// Isolate controllers from live databases, AI, and SMS services.
function loadController(name, dependencies) {
  const filename = path.join(__dirname, "../src/controllers", name);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module,
    console: { log() {}, error() {} },
    require(id) {
      if (id === "../utils/locationParser") return parser;
      if (id === '../coordination/config') return require('../src/coordination/config');
      if (id === "../coordination/presence") return { updatePresence: async (profileId, body) => {
        const p = parser.parseLatLon(body.location || body, body.lon);
        if (!p) throw Object.assign(new Error('Invalid location'), { status: 400 });
        await dependencies['../models/activeUser'].findOneAndUpdate({ profileId }, { location: { type: 'Point', coordinates: [p.lon, p.lat] } });
      } };
      if (id === "../agent/sessions" && !Object.hasOwn(dependencies, id)) return { createSession: async () => null, wakeForLocation: async () => {} };
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
  }, { filename });
  return module.exports;
}

for (const unavailable of [false, true]) {
  test(`SOS integration with ${unavailable ? "unavailable" : "available"} agent tracking`, async () => {
    const events = [];
    const contacts = [{ _id: "c1", contactNumber: "1111111111" }];
    const trigger = loadController("trigger.js", {
      "../models/user": {},
      "../models/contact": { find: async () => contacts },
      "../services/llmsupport": { analyzeAudioDirectly: async paths => {
        if (unavailable) assert.deepEqual(Array.from(paths), ["first.webm", "second.webm"]);
        else assert.equal(paths, "mock.webm");
        return { isDistress: true, confidence: 95, severity: "high", transcript: "Help", summary: "Help needed" };
      } },
      "../agent/sessions": {
        createSession: async (profileId, analysis, location) => {
          assert.equal(location, "https://maps.google.com/?q=22,88");
          events.push("session");
          if (unavailable) throw new Error("Tracking unavailable");
          return { _id: "s1", reference: "ABCDEF123456", attempts: [{ _id: "a1", contactId: "c1" }] };
        },
        callbackUrl: (session, attempt) => `${session}/${attempt}`,
        recordAttempt: async (session, attempt, result) => { events.push(`tracked-${result.status}`); },
        finishInitial: async (session, history) => { events.push(history ? "linked" : "ready"); },
      },
      "../services/smsAlart": { sendSOSAlert: async (summary, location, recipients, options) => {
        assert.equal(location, "https://maps.google.com/?q=22,88");
        events.push("sms");
        if (!unavailable) {
          assert.equal(options.reference, "ABCDEF123456");
          assert.equal(options.statusCallback(contacts[0]), "s1/a1");
          await options.onResult(contacts[0], { status: "sent", sid: "mock-sid" });
        }
        return [{ status: "sent" }];
      } },
      "../models/history": { create: async () => { events.push("history"); return { _id: "h1" }; } },
      "../models/incident": { create: async () => {} },
      "../models/activeUser": { find: async () => [] },
      "../socket": { getIO: () => ({}) },
    });
    const res = response();
    await trigger({ ...(unavailable ? { files: [{ path: "first.webm" }, { path: "second.webm" }] } : { file: { path: "mock.webm" } }), body: { location: "22,88" }, user: { _id: "u1" } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.sent, true);
    assert.equal(res.body.agentTrackingError, unavailable);
    assert.equal(res.body.agentSessionId, unavailable ? null : "s1");
    assert.deepEqual(events, unavailable ? ["session", "sms", "history"] : ["session", "sms", "tracked-accepted", "ready", "history", "linked"]);
  });
}

function response() {
  return {
    code: 200,
    status(code) { this.code = code; return this; },
    json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; },
  };
}

for (const action of ["activateLocation", "updateLocation", "reportIncident"]) {
  for (const [label, body, expected] of [
    ["coordinates including zero", { lat: 0, lon: 0 }, [0, 0]],
    ["Maps URL", { location: "https://maps.google.com/?q=22.5,88.3" }, [88.3, 22.5]],
    ["lng alias", { lat: 22.5, lng: 88.3 }, [88.3, 22.5]],
    ["invalid coordinates", { lat: 100, lon: 200 }, null],
    ["missing location", {}, null],
  ]) {
    test(`${action}: ${label}`, async () => {
      const writes = [];
      const controller = loadController(
        action === "reportIncident" ? "incidentController.js" : "locationController.js",
        {
          "../models/activeUser": { async findOneAndUpdate(filter, data) { writes.push(data); } },
          "../models/incident": { async create(data) { writes.push(data); } },
        },
      );
      const res = response();
      await controller[action]({ body, user: { _id: "user1" } }, res);
      assert.equal(res.code, expected ? (action === "reportIncident" ? 201 : 200) : 400);
      assert.equal(writes.length, expected ? 1 : 0);
      if (expected) assert.deepEqual(Array.from(writes[0].location.coordinates), expected);
    });
  }
}

for (const statuses of [["sent", "sent"], ["sent", "failed"], ["failed", "failed"]]) {
  test(`SOS SMS results: ${statuses.join(", ")}`, async () => {
    const histories = [];
    const incidents = [];
    const notifications = [];
    const contacts = [{ _id: "c1", contactNumber: "1111111111" }, { _id: "c2", contactNumber: "2222222222" }];
    const trigger = loadController("trigger.js", {
      "../models/user": {},
      "../models/contact": { async find() { return contacts; } },
      "../services/llmsupport": { async analyzeAudioDirectly() {
        return { isDistress: true, confidence: 95, severity: "high", transcript: "Help", summary: "Help needed" };
      } },
      "../services/smsAlart": { async sendSOSAlert() { return statuses.map(status => ({ status })); } },
      "../models/history": { async create(data) { histories.push(data); return { _id: "h1" }; } },
      "../models/incident": { async create(data) { incidents.push(data); } },
      "../models/activeUser": { async find(filter) {
        assert.equal(filter.profileId.$ne, "user1");
        assert.ok(filter.expireAt.$gt);
        return [{ profileId: "helper1", socketId: null }, { profileId: "helper2", socketId: "stale-socket" }];
      } },
      "../socket": { publishNearbyAlert(profileId, payload) {
        assert.equal(payload.mapsLink, undefined, "Unassigned users must not receive precise victim location");
        notifications.push({ room: `user:${profileId}`, event: "nearby-sos" });
      } },
    });
    const res = response();
    await trigger({ file: { path: "mock.webm" }, body: { location: "22.5,88.3" }, user: { _id: "user1" } }, res);
    const successful = contacts.filter((contact, index) => statuses[index] === "sent");
    const failed = contacts.filter((contact, index) => statuses[index] === "failed");
    assert.equal(res.code, successful.length ? 200 : 502);
    assert.equal(res.body.sent, successful.length > 0);
    assert.equal(res.body.success, successful.length > 0);
    assert.equal(res.body.partialSuccess, successful.length > 0 && failed.length > 0);
    assert.deepEqual(res.body.sentTo, successful.map(contact => contact.contactNumber));
    assert.deepEqual(res.body.failedTo, failed.map(contact => contact.contactNumber));
    assert.deepEqual(Array.from(histories[0].sent), successful.map(contact => contact._id));
    assert.equal(incidents.length, 1);
    assert.deepEqual(notifications, [
      { room: "user:helper1", event: "nearby-sos" },
      { room: "user:helper2", event: "nearby-sos" },
    ]);
    if (!successful.length) assert.equal(res.body.error, "All SMS alert attempts failed");
  });
}

test('public heatmap coarsens precise incident locations', async () => {
  const controller = loadController('incidentController.js', {
    '../models/incident': { find: () => ({ select() { return this; }, limit: async () => [{ location: { coordinates: [88.363913, 22.572612] }, severity: 5 }] }) },
  });
  const res = response();
  await controller.getHeatmap({}, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.approximate, true);
  assert.ok(res.body.areaRadiusMeters >= 700);
  assert.deepEqual(res.body.heatmapPoints, [[22.57, 88.36, 1]]);
});
