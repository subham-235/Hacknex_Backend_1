const { createHash } = require("node:crypto");
const geo = require("./geo");
const { getGeoConfig } = require("./config");
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
function providerUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Map provider URLs must be HTTPS without credentials or query parameters");
  return url.href.replace(/\/$/, "");
}
function mapConfig(env = process.env) {
  return {
    searchUrl: providerUrl(env.JOURNEY_PLACE_SEARCH_URL || "https://photon.komoot.io/api"),
    routeUrl: providerUrl(
      env.JOURNEY_ROUTE_URL || "https://router.project-osrm.org/route/v1/driving",
    ),
  };
}
// Retain bends to within 15 m instead of sampling every nth vertex, which could
// incorrectly cut across streets and cause false corridor deviation warnings.
function simplifyRoute(points, tolerance = 15) {
  const keep = new Set([0, points.length - 1]),
    stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maximum = tolerance,
      chosen = -1;
    for (let i = first + 1; i < last; i++) {
      const d = geo.corridorDistance(points[i], [points[first], points[last]]);
      if (d > maximum) {
        maximum = d;
        chosen = i;
      }
    }
    if (chosen >= 0) {
      keep.add(chosen);
      stack.push([first, chosen], [chosen, last]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}
function routeHazards(route, incidents, gridDegrees) {
  const radiusMeters = Math.round(gridDegrees * 111195 * Math.SQRT2 / 2);
  const coarse = (value) =>
    Number((Math.round(value / gridDegrees) * gridDegrees).toFixed(3));
  const unique = new Map();
  for (const incident of incidents) {
    const [longitude, latitude] = incident.location?.coordinates || [];
    const point = { latitude: coarse(latitude), longitude: coarse(longitude) };
    if (!geo.validPoint(point)) continue;
    const key = `${point.latitude}:${point.longitude}`;
    const previous = unique.get(key);
    unique.set(key, {
      ...point,
      severity: Math.max(previous?.severity || 0, Number(incident.severity) || 1),
    });
  }
  const hazards = [...unique.values()].filter(
    (point) => geo.corridorDistance(point, route) <= radiusMeters,
  );
  return {
    count: hazards.length,
    weight: hazards.reduce((total, hazard) => total + hazard.severity, 0),
    hazards,
    radiusMeters,
  };
}
function detourWaypoints(start, destination, hazards, radiusMeters) {
  if (!hazards.length) return [];
  const latitude = hazards.reduce((sum, point) => sum + point.latitude, 0) / hazards.length;
  const longitude = hazards.reduce((sum, point) => sum + point.longitude, 0) / hazards.length;
  const cosine = Math.max(0.2, Math.cos((latitude * Math.PI) / 180));
  const dx = (destination.longitude - start.longitude) * 111195 * cosine;
  const dy = (destination.latitude - start.latitude) * 111195;
  const length = Math.hypot(dx, dy);
  if (!length) return [];
  const spread = Math.max(
    0,
    ...hazards.map((point) => geo.distance({ latitude, longitude }, point)),
  );
  const offset = spread + radiusMeters + 500;
  const perpendicular = { x: -dy / length, y: dx / length };
  return [-1, 1].map((side) => ({
    latitude: latitude + (perpendicular.y * offset * side) / 111195,
    longitude: longitude + (perpendicular.x * offset * side) / (111195 * cosine),
  }));
}
function createMapService({
  redis,
  Incident,
  fetcher = fetch,
  config = mapConfig(),
  geoConfig = getGeoConfig(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  async function request(url, attempts = 1) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetcher(url, {
          signal: AbortSignal.timeout(8000),
          redirect: "error",
          headers: { Accept: "application/json", "User-Agent": "Suraksha-AI-Journey/1.0" },
        });
        if (!response.ok) {
          const transient = response.status === 429 || response.status >= 500;
          throw Object.assign(
            new Error("Map service is unavailable. Please try again shortly."),
            { status: 503, transient },
          );
        }
        const raw = await response.text();
        if (raw.length > 2_000_000) fail("Map response is too large.", 502);
        return JSON.parse(raw);
      } catch (error) {
        if (error.status && !error.transient) throw error;
        lastError = error;
        if (attempt + 1 < attempts) await wait(250 * 2 ** attempt);
      }
    }
    if (lastError?.status) throw lastError;
    fail("Map service could not be reached after retrying. Please try again.", 503);
  }
  async function gate(kind) {
    // Shared across all API processes, not a per-process timer. Fail closed if
    // Redis is unavailable rather than flooding public provider endpoints.
    if (!(await redis.set(`suraksha:maps:limit:${kind}`, "1", { NX: true, PX: 1000 })))
      fail("Map service is busy. Please try again in a moment.", 429);
  }
  async function search(query) {
    if (typeof query !== "string" || query.trim().length < 3 || query.length > 160)
      fail("Enter a place name between 3 and 160 characters.");
    const q = query.trim();
    const cacheKey = `suraksha:maps:search:${createHash("sha256").update(q.toLowerCase()).digest("hex")}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    await gate("search");
    const url = new URL(config.searchUrl);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", "6");
    const result = await request(url);
    if (!Array.isArray(result.features)) fail("Place search returned an invalid response.", 502);
    const places = result.features.slice(0, 6).flatMap((feature, index) => {
      const [longitude, latitude] = feature.geometry?.coordinates || [];
      if (!geo.validPoint({ latitude, longitude })) return [];
      const p = feature.properties || {};
      const parts = [
        p.name,
        [p.housenumber, p.street].filter((x) => typeof x === "string").join(" "),
        p.city || p.town || p.village,
        p.state,
        p.country,
      ].filter((x) => typeof x === "string" && x.trim());
      const label = [...new Set(parts)].join(", ").slice(0, 300);
      return label
        ? [{ id: `${p.osm_type || "place"}-${p.osm_id || index}`, label, latitude, longitude }]
        : [];
    });
    const data = { places, attribution: "© OpenStreetMap contributors · Photon" };
    await redis.set(cacheKey, JSON.stringify(data), { EX: 600 });
    return data;
  }
  async function route(body) {
    const { start, destination } = body || {};
    const routeMode = body?.routeMode === "safer" ? "safer" : "normal";
    if (!geo.validPoint(start) || !geo.validPoint(destination))
      fail("Valid start and destination coordinates are required.");
    if (geo.distance(start, destination) > 100000)
      fail("Choose a destination within 100 km for monitored journeys.");
    if (geo.distance(start, destination) < 20)
      fail("You are already at this destination. Choose another place.");
    const routeKey = `suraksha:maps:route:${createHash("sha256")
      .update([
        routeMode === "safer" ? "safer-v2" : routeMode,
        ...[start.latitude, start.longitude, destination.latitude, destination.longitude]
          .map((value) => Number(value).toFixed(5)),
      ].join(","))
      .digest("hex")}`;
    const cached = await redis.get(routeKey);
    if (cached) return JSON.parse(cached);
    await gate("route");
    const routeUrl = (points, alternatives = false) => {
      const url = new URL(
        `${config.routeUrl}/${points.map((point) => `${point.longitude},${point.latitude}`).join(";")}`,
      );
      url.searchParams.set("overview", "full");
      url.searchParams.set("geometries", "geojson");
      url.searchParams.set("steps", "false");
      if (alternatives) url.searchParams.set("alternatives", "3");
      return url;
    };
    const url = routeUrl([start, destination], routeMode === "safer");
    const response = await request(url, 3);
    let chosen = response.routes?.[0], safety;
    if (response.code !== "Ok" || !chosen)
      fail("No driving route was found. Try another destination.", 422);
    if (routeMode === "safer") {
      if (!Incident) fail("Safer routing is temporarily unavailable.", 503);
      const incidents = await Incident.find()
        .select("location severity")
        .limit(500)
        .lean();
      const scoreCandidates = (routes, source) => routes.flatMap((candidate, index) => {
        const candidateCoordinates = candidate.geometry?.coordinates;
        if (
          !Array.isArray(candidateCoordinates) ||
          candidateCoordinates.length < 2 ||
          candidateCoordinates.length > 20000 ||
          !Number.isFinite(candidate.distance) ||
          !Number.isFinite(candidate.duration)
        )
          return [];
        const candidatePoints = candidateCoordinates.map((coordinate) => ({
          longitude: coordinate?.[0],
          latitude: coordinate?.[1],
        }));
        if (!candidatePoints.every(geo.validPoint)) return [];
        return [{
          candidate,
          index: source === "ordinary" ? index : index + 100,
          source,
          ...routeHazards(
            simplifyRoute(candidatePoints),
            incidents,
            geoConfig.heatmapGridDegrees,
          ),
        }];
      });
      const candidates = scoreCandidates(response.routes || [], "ordinary");
      if (!candidates.length) fail("Route provider returned an invalid route.", 502);
      const ordinary = candidates.find((candidate) => candidate.index === 0) || candidates[0];
      const initialSafest = [...candidates].sort(
        (a, b) =>
          a.count - b.count ||
          a.weight - b.weight ||
          a.candidate.duration - b.candidate.duration,
      )[0];
      if (initialSafest.count > 0) {
        const waypoints = detourWaypoints(
          start,
          destination,
          initialSafest.hazards,
          initialSafest.radiusMeters,
        );
        for (const waypoint of waypoints) {
          try {
            const detourResponse = await request(
              routeUrl([start, waypoint, destination]),
              2,
            );
            if (detourResponse.code === "Ok")
              candidates.push(...scoreCandidates(detourResponse.routes || [], "detour"));
          } catch {
            // Provider alternatives remain usable if a generated detour fails.
          }
        }
      }
      candidates.sort(
        (a, b) =>
          a.count - b.count ||
          a.weight - b.weight ||
          a.candidate.duration - b.candidate.duration,
      );
      const safest = candidates[0];
      chosen = safest.candidate;
      safety = {
        routeMode,
        alternativeRoutesConsidered: candidates.length,
        reportedAreasOnRoute: safest.count,
        reportedAreasAvoided: Math.max(0, ordinary.count - safest.count),
        detourRouteSelected: safest.source === "detour",
      };
    }
    const coordinates = chosen.geometry?.coordinates;
    if (
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      coordinates.length > 20000 ||
      !Number.isFinite(chosen.distance) ||
      chosen.distance < 0 ||
      !Number.isFinite(chosen.duration) ||
      chosen.duration < 0
    )
      fail("Route provider returned an invalid route.", 502);
    const points = coordinates.map((c) => ({ longitude: c?.[0], latitude: c?.[1] }));
    if (!points.every(geo.validPoint)) fail("Route provider returned invalid coordinates.", 502);
    if (
      geo.distance(start, points[0]) > geoConfig.tolerance ||
      geo.distance(destination, points.at(-1)) > geoConfig.destinationRadius
    )
      fail("This place is too far from a routable road. Choose a nearby entrance.", 422);
    const route = simplifyRoute(points);
    if (route.length > geoConfig.maxRoutePoints)
      fail("This route is too complex to monitor. Choose a closer destination.", 422);
    const data = {
      route,
      distanceMeters: Math.round(chosen.distance),
      estimatedDurationSeconds: Math.ceil(chosen.duration),
      travelMode: "driving",
      estimated: true,
      destinationRadiusMeters: geoConfig.destinationRadius,
      corridorToleranceMeters: geoConfig.tolerance,
      ...(routeMode === "safer" ? safety : { routeMode: "normal" }),
      attribution: "© OpenStreetMap contributors · Routing by OSRM",
    };
    await redis.set(routeKey, JSON.stringify(data), { EX: 300 });
    return data;
  }
  return { search, route };
}
module.exports = {
  createMapService,
  mapConfig,
  simplifyRoute,
  routeHazards,
  detourWaypoints,
};
