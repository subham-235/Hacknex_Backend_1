const test = require("node:test");
const assert = require("node:assert/strict");
const { createMapService } = require("../src/coordination/maps");

function redisFixture() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) || null; },
    async del(key) { return values.delete(key); },
    async set(key, value, options) {
      if (options?.NX && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
  };
}

const start = { latitude: 22.57, longitude: 88.36 };
const destination = { latitude: 22.58, longitude: 88.37 };
const providerResult = {
  code: "Ok",
  routes: [{
    distance: 1600,
    duration: 300,
    geometry: { coordinates: [[88.36, 22.57], [88.365, 22.575], [88.37, 22.58]] },
  }],
};

test("route retries a transient provider failure and caches the result", async () => {
  const redis = redisFixture();
  let calls = 0;
  const service = createMapService({
    redis,
    wait: async () => {},
    fetcher: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return { ok: true, text: async () => JSON.stringify(providerResult) };
    },
    config: { routeUrl: "https://router.example/route/v1/driving", searchUrl: "https://search.example" },
  });

  const first = await service.route({ start, destination });
  const second = await service.route({ start, destination });
  assert.equal(calls, 2);
  assert.equal(first.distanceMeters, 1600);
  assert.deepEqual(second, first);
});

test("route reports an unavailable provider after bounded retries", async () => {
  let calls = 0;
  const service = createMapService({
    redis: redisFixture(),
    wait: async () => {},
    fetcher: async () => { calls += 1; throw new TypeError("fetch failed"); },
    config: { routeUrl: "https://router.example/route/v1/driving", searchUrl: "https://search.example" },
  });

  await assert.rejects(
    service.route({ start, destination }),
    (error) => error.status === 503 && /after retrying/.test(error.message),
  );
  assert.equal(calls, 3);
});

test("safer mode selects the alternative with the fewest reported areas", async () => {
  let requestedUrl;
  const fartherDestination = { latitude: 22.59, longitude: 88.38 };
  const service = createMapService({
    redis: redisFixture(),
    Incident: {
      find: () => ({
        select() { return this; },
        limit() { return this; },
        async lean() {
          return [{ location: { coordinates: [88.37, 22.58] }, severity: 5 }];
        },
      }),
    },
    fetcher: async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        text: async () => JSON.stringify({
          code: "Ok",
          routes: [
            {
              distance: 3200,
              duration: 520,
              geometry: {
                coordinates: [[88.36, 22.57], [88.37, 22.58], [88.38, 22.59]],
              },
            },
            {
              distance: 4100,
              duration: 690,
              geometry: {
                coordinates: [[88.36, 22.57], [88.36, 22.59], [88.38, 22.59]],
              },
            },
          ],
        }),
      };
    },
    config: {
      routeUrl: "https://router.example/route/v1/driving",
      searchUrl: "https://search.example",
    },
  });

  const result = await service.route({
    start,
    destination: fartherDestination,
    routeMode: "safer",
  });
  assert.match(requestedUrl, /alternatives=3/);
  assert.equal(result.routeMode, "safer");
  assert.equal(result.distanceMeters, 4100);
  assert.equal(result.reportedAreasOnRoute, 0);
  assert.equal(result.reportedAreasAvoided, 1);
  assert.equal(result.alternativeRoutesConsidered, 2);
});

test("normal and safer modes use separate cached route results", async () => {
  const redis = redisFixture();
  let calls = 0;
  const service = createMapService({
    redis,
    Incident: {
      find: () => ({
        select() { return this; },
        limit() { return this; },
        async lean() { return []; },
      }),
    },
    fetcher: async () => {
      calls += 1;
      return { ok: true, text: async () => JSON.stringify(providerResult) };
    },
    config: {
      routeUrl: "https://router.example/route/v1/driving",
      searchUrl: "https://search.example",
    },
  });

  assert.equal((await service.route({ start, destination })).routeMode, "normal");
  await redis.del("suraksha:maps:limit:route");
  assert.equal(
    (await service.route({ start, destination, routeMode: "safer" })).routeMode,
    "safer",
  );
  assert.equal(calls, 2);
});

test("safer mode creates detour candidates when ordinary alternatives remain unsafe", async () => {
  const fartherDestination = { latitude: 22.59, longitude: 88.38 };
  let calls = 0;
  const service = createMapService({
    redis: redisFixture(),
    Incident: {
      find: () => ({
        select() { return this; },
        limit() { return this; },
        async lean() {
          // Duplicate reports in one rounded zone must count as one unsafe area.
          return [
            { location: { coordinates: [88.37, 22.58] }, severity: 2 },
            { location: { coordinates: [88.3701, 22.5801] }, severity: 5 },
          ];
        },
      }),
    },
    fetcher: async (url) => {
      calls += 1;
      const coordinates = decodeURIComponent(new URL(url).pathname.split("/").at(-1))
        .split(";")
        .map((pair) => pair.split(",").map(Number));
      const detour = coordinates.length === 3;
      return {
        ok: true,
        text: async () => JSON.stringify({
          code: "Ok",
          routes: [{
            distance: detour ? 4200 : 3200,
            duration: detour ? 700 : 520,
            geometry: {
              coordinates: detour
                ? coordinates
                : [[88.36, 22.57], [88.37, 22.58], [88.38, 22.59]],
            },
          }],
        }),
      };
    },
    config: {
      routeUrl: "https://router.example/route/v1/driving",
      searchUrl: "https://search.example",
    },
  });

  const result = await service.route({
    start,
    destination: fartherDestination,
    routeMode: "safer",
  });

  assert.equal(calls, 3);
  assert.equal(result.detourRouteSelected, true);
  assert.equal(result.reportedAreasOnRoute, 0);
  assert.equal(result.reportedAreasAvoided, 1);
  assert.equal(result.alternativeRoutesConsidered, 3);
});
