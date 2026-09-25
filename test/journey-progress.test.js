const test = require('node:test');
const assert = require('node:assert/strict');
const { createJourneyService } = require('../src/coordination/journeys');
test('journey progress reports destination distance and stale GPS honestly', () => {
  let time = 1000000;
  const service = createJourneyService({ Journey: {}, now: () => time });
  const point = { latitude: 0, longitude: 0, observedAt: new Date(time) };
  const journey = { currentLocation: point, destination: { latitude: 0, longitude: 0.01 }, route: [point, { latitude: 0, longitude: 0.01 }] };
  const live = service.view(journey);
  assert.equal(live.locationFresh, true);
  assert.equal(live.locationAgeSeconds, 0);
  assert.ok(live.destinationDistanceMeters > 1100 && live.destinationDistanceMeters < 1120);
  assert.equal(live.distanceFromRouteMeters, 0);
  time += 3600000;
  assert.equal(service.view(journey).locationFresh, false);
  assert.equal(service.view(journey).locationAgeSeconds, 3600);
  assert.equal(journey.locationFresh, undefined);
});
