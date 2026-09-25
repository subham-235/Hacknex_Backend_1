# Responder coordination and geo safety

## Existing architecture and integration points

Suraksha remains an Express/Mongoose backend and React/Vinext frontend. Cookie JWT authentication and Redis token revocation still protect HTTP and Socket.IO. `socket.js` joins server-controlled `user:<authenticated profile>` rooms. Clients cannot select another user's room.

`controllers/trigger.js` sends audio through the existing Gemini analyzer in `services/llmsupport.js`. The existing `isDistress && confidence >= 70` rule and active emergency contact requirement remain. `services/smsAlart.js` submits the original contact SMS alerts through Twilio. Accepted submission is distinct from confirmed delivery. History and heatmap incidents are retained. Signed Twilio callbacks, exact ACK parsing, contact authorization, send reservations, and bounded Gemini tool calls are unchanged.

`agent/sessions.js` persists `EmergencySession` before SMS submission. Its initial-completion hook now creates nearby requests. If this step fails, the worker retries from persistent state; SMS delivery is not contingent on responder availability. If session creation itself fails, the existing 500 m nearby notification fallback remains, with precise coordinates removed. Normal coordination starts at the configurable 1 km radius.

Implementation map:

| File | Responsibility |
| --- | --- |
| `src/coordination/config.js` | Validated, bounded settings |
| `src/coordination/geo.js` | Coordinate validation, Haversine, corridor distance, geofences, location age |
| `src/coordination/responders.js` | Requests, eligibility, assignment, tracking, escalation, privacy projection |
| `src/coordination/journeys.js` | Journey lifecycle and safety checks |
| `src/coordination/presence.js` | Existing community location integration and propagation |
| `src/coordination/schema.js` | Embedded emergency coordination data |
| `src/coordination/http.js`, `src/routes/coordination.js` | Authenticated APIs under `/agent` |
| `src/coordination/dispatcher.js` | Persisted due checks to the existing BullMQ queue |
| `src/coordination/runtime.js` | API service wiring and notifications |
| `src/models/safetyJourney.js` | Optional journey persistence |
| `src/agent/worker.js` | Existing worker, queue and dispatcher cadence reused |
| `frontend/components/rescue-panel.tsx` | Responder, journey and emergency-owner controls |

No LangChain, LangGraph, RAG, vector database, external routing dependency, or alternative model framework is introduced.

## Requests, eligibility and deterministic assignment

Requests are embedded in the emergency document. Each responder appears at most once per emergency. Request statuses are `pending`, `accepted`, `declined`, `expired`, `cancelled`. They contain a responder ID, rounded-up distance in 100 m increments, and notification/response/expiry timestamps. They do not retain a precise responder location snapshot.

Eligibility uses the existing explicit community opt-in: `ActiveUser.isActive`, unexpired presence, fresh `lastSeen`, valid location, and a different ID from the victim. Accept/decline uses the authenticated profile, requires its own pending, unexpired request and current eligibility, and checks distance against the configured maximum radius. A client-provided responder ID is ignored.

On acceptance, the backend selects the nearest currently eligible **accepted** responder with a fresh location and no other primary assignment. Distance ties break by user ID. The first accepted response can be assigned immediately. Concurrent later accepts remain backups; an existing primary is not displaced merely because another user is closer. When the primary cancels or goes stale, a still-eligible accepted backup can be assigned.

Every responder/geo update compares `coordinationVersion` and increments it in the same MongoDB update. Requests, assignment and status are written together. The predicate rechecks open status and expiry. Conflicting writes reload and retry up to eight times. A partial unique index on `activeResponder.userId` prevents the same responder being primary on two incidents, including races between API processes. A conflict returns HTTP 409; no duplicate assignment is committed. Transactions/replica sets are not required.

Primary states: `assigned → en_route/nearby → arrived → completed`, with cancellation before completion. `arrival_candidate` is a proximity observation, not an explicit arrival confirmation. Arrival and completed assistance never resolve the incident. The authenticated owner retains the existing resolve endpoint.

## Dynamic emergency geofence and escalation

The center is the latest validated victim location, falling back to the initial emergency coordinates or the legacy maps link. Every center includes `observedAt`, `ageSeconds`, and `fresh`; stale points remain visibly last-known. The worker also reads newer valid community presence, recovering a missed propagation step. GeoJSON queries use `[longitude, latitude]` and the existing `ActiveUser.location` 2dsphere index.

Default stages are 1 km, 2 km, and 3 km, separated by at least 30 seconds without an assigned responder. The dispatcher runs every 15 seconds, so actual transitions can be later than the exact deadline. Stage history and request deduplication are persistent. Radius expansion stops at the configured maximum. At the final stage, an unanswered search becomes `help_unavailable`; it does not contact police, ambulance, or an arbitrary organization.

Movement of at least 250 m, together with at least 30 seconds since the last search, recentres the fence and permits a new search if no primary exists. Assigned incidents still update their center and tracking; they do not broadcast fresh requests unnecessarily. Stage changes also trigger a search. Only newly eligible, previously unrequested users are notified, up to 200 total requests per incident. Earlier declined/expired/cancelled requests are never reissued. A dense area hitting the cap remains bounded rather than repeatedly contacting people.

Stale responder locations revoke precise-location access immediately when read. A subsequent worker check cancels stale assignment, records a risk signal and tries a backup/continued bounded search. Explicit community deactivation also makes the primary unavailable. The tracking endpoint refreshes an existing opted-in community record but never silently reactivates it.

## Tracking, distance, ETA and proximity

Locations require finite numeric latitude/longitude, a recent timestamp, and acceptable accuracy when supplied. Coordinates outside ±90/±180 are rejected. Old or more-than-10-seconds-future timestamps, out-of-order readings, updates faster than the configured interval, and implausible jumps are rejected. Maximum jump distance is `maxSpeed × elapsedSeconds + previousAccuracy + nextAccuracy`.

Distance uses Haversine on a 6,371 km sphere. ETA is explicitly approximate: `ceil(distanceMeters × 1.4 / 1.1 + 60)` seconds, a walking assumption with a 40% path allowance and one-minute overhead. It does not account for roads, barriers, traffic, travel mode or dispatch. ETA is null when either position is stale.

| Default distance | Observation |
| --- | --- |
| >500 m | `en_route` |
| 100–500 m | `approaching` |
| 20–100 m | `nearby` |
| ≤20 m | `arrival_candidate` only if both positions are fresh and combined reported accuracy ≤20 m |

If accuracy is unknown/too broad, close distance cannot automatically create an arrival candidate. The responder can explicitly confirm arrival. Location history is not accumulated: only initial/current victim position, current fence center and latest primary position are kept. Bounded event/history arrays contain statuses and timestamps, not trails of GPS points.

## Optional journeys

One open journey per user is enforced by a partial unique index. Start requires a current location and destination, with an optional arrival time within 24 hours and optional 2–200 route points. No route is invented from the endpoints. With no supplied route, corridor monitoring is unavailable; destination/time monitoring still works.

Route preview defaults to the original normal mode. The optional safer mode requests available OSRM alternatives and selects the route intersecting the fewest distinct rounded community incident areas, using severity and duration as tie-breakers. When those alternatives remain exposed, it also asks the routing provider for bounded left-side and right-side waypoint detours around the reported-area cluster and compares those results. It reports how many candidates were compared and when the selected route still crosses a reported area. Community reports are approximate caution signals, so safer mode reduces known exposure but cannot guarantee that a route is safe. Both modes keep the existing on-route warnings and journey monitoring.

Journey preview, start, and tracking accept a delivery-style approximate fix up to `JOURNEY_MAX_ACCURACY_METERS` (default 2000 m), then refine it as the browser supplies better readings. The reported accuracy remains attached to every point: arrival requires the accuracy circle to fit inside the destination zone, and route-deviation distance includes GPS uncertainty. Emergency responder and SOS location flows use the stricter `GEO_MAX_ACCURACY_METERS` default of 250 m. The browser still must remain on the journey screen because this web app has no native background-location service.

Destination arrival requires `distance + accuracy <= destinationRadius` (150 m by default); unknown accuracy uses the maximum accuracy allowance. Arrival closes monitoring and clears the planned route. It does not close any emergency.

Route deviation uses the minimum spherical distance to planned route segments. A reading is outside only beyond corridor tolerance plus GPS accuracy. Both at least three consecutive outside readings **and** at least 60 seconds outside are required. An inside reading resets the counter. Poor GPS readings never count toward confirmation.

Passing the expected arrival time, or confirming a route deviation, creates a pending safety check. After `JOURNEY_CHECKIN_TIMEOUT_SECONDS` (default 300) without a response, new journeys become `escalated`/`unanswered` and the worker starts an automatic SOS. Existing journeys without `autoSosEnabled` retain check-in-only behavior. Missing GPS alone does not start a safety check.

The automatic SOS creates an owner-visible EmergencySession and submits alerts to active trusted contacts through the existing SMS service, including secure reply links when configured. It does not require audio or Gemini approval. The alert explicitly says safety is unconfirmed and labels the location as last known, preserving its original GPS timestamp. Accepted SMS submission does not prove delivery. An empty contact list is shown explicitly; the SOS session remains available for coordination. Demo services have no SOS sender attached.

“I'm safe”, cancellation, or destination arrival before the worker claims the SOS prevents submission. After submission begins, checking in cannot recall messages or resolve the separate emergency session. The claim is atomic and permanent: repeated jobs do not replay SMS. A crash or ambiguous provider error is shown as `unknown`, with no automatic resend of uncertain initial alerts; inspect Safety agent/provider delivery records. The dispatcher recovers interrupted session initialization and marks timed-out journey sends unknown. Keep the backend, Redis, MongoDB and worker running; closing the page does not cancel an already-pending deadline. Restart the backend and worker after upgrading, and start a new journey to enable this behavior.

## Explicit geo-risk signals

There is no numeric or AI-generated risk score. Signals are deterministic:

| Signal | Trigger |
| --- | --- |
| `ROUTE_DEVIATION` | Confirmed outside samples and duration |
| `DESTINATION_OVERDUE` | Arrival time + grace passed, no destination arrival |
| `LOCATION_STALE` | Victim/journey position exceeds freshness threshold |
| `VICTIM_MOVING_DURING_EMERGENCY` | Center moved by the configured minimum |
| `RESPONDER_APPROACHING` | Fresh responder distance is in approaching zone |
| `RESPONDER_LOCATION_STALE` | Primary stopped providing current location / became unavailable |
| `NO_RESPONDER_ACCEPTED` | No currently assigned eligible accepted responder |

Emergency `geoRiskSignals` represent the latest check; bounded `geoEvents` retain changes. Journeys hold their own signals. Gemini can read responder/nearby/geo status via three new read tools, or record observations through the existing `recordUpdate`. It cannot change radii, assign users, alter positions, override auth, resolve incidents or declare the victim safe.

## API reference

All routes below require the existing authenticated cookie; Twilio webhook routes remain separately signature-protected. Mongo IDs must be 24 hex characters. Extra identity or state fields in a location body are never trusted.

| Method/path | Authorization and result |
| --- | --- |
| `GET /agent/responder-requests` | Own active request inbox; approximate request data only until assignment |
| `GET /agent/sessions/:id/responder` | Own request; assigned responder gets current victim location and tracking |
| `POST /agent/sessions/:id/responders/accept` | Own pending request; atomically accepts and attempts assignment |
| `POST /agent/sessions/:id/responders/decline` | Own pending request; persists decline |
| `POST /agent/sessions/:id/responder/location` | Assigned responder only, active incident, assistance not completed |
| `POST /agent/sessions/:id/responder/status` | Assigned responder; body `{ "status": "en_route\|arrived\|completed\|cancelled" }` |
| `POST /agent/sessions/:id/victim/location` | Emergency owner only |
| `GET /agent/journeys` | Own latest 20 journeys |
| `POST /agent/journeys` | Start optional journey; rejects a second open journey |
| `POST /agent/journeys/:id/location` | Owner of open journey |
| `POST /agent/journeys/:id/checkin` | Owner; body action `safe`, `continue`, or `cancel` |
| Existing `/location/activate`, `/location/update` | Update opted-in presence and propagate to active owned emergencies/journey |
| Existing `/agent/sessions`, `/agent/sessions/:id` | Owner-only full state, including rescue progress |
| Existing `/agent/sessions/:id/resolve` | Owner resolution; immediately clears tracking and cancels requests |

Location payload:

```json
{"latitude":22.5726,"longitude":88.3639,"accuracy":8,"timestamp":1789990000000}
```

Use a **current** timestamp, not the illustrative value. An omitted timestamp uses server receipt time; browser clients send the observation timestamp.

Journey creation:

```json
{
  "startLocation":{"latitude":22.5726,"longitude":88.3639,"accuracy":8},
  "destination":{"latitude":22.5826,"longitude":88.3739},
  "expectedArrivalAt":"2026-09-22T16:30:00Z",
  "route":[{"latitude":22.5726,"longitude":88.3639},{"latitude":22.5826,"longitude":88.3739}]
}
```

Typical errors: 400 malformed/poor GPS or invalid input; 403 unauthorized/ineligible; 404 inaccessible/missing request; 409 expired/closed/answered/concurrent operation; 429 location updates too frequent. Refresh authoritative state after 409. Duplicate decisions do not repeat notifications or assignment.

## Socket.IO events and offline recovery

Events: `responder-request-created`, `responder-accepted`, `responder-declined`, `responder-assigned`, `responder-location-updated`, `responder-nearby`, `responder-arrival-candidate`, `responder-arrived`, `emergency-radius-expanded`, `journey-deviation-detected`, `journey-checkin-required`, `journey-updated`, and existing `agent-session-updated`.

The existing public heatmap now rounds all points (including legacy SOS records) to `PUBLIC_HEATMAP_GRID_DEGREES`, default 0.01 degrees, about 1.1 km in latitude. It remains an approximate area map and does not reveal current victim positions.

New event payloads contain `{sessionId}` or `{journeyId}` only. The API emits into authenticated user rooms; worker events pass through the existing Redis pub/sub architecture on `suraksha-geo-updates`, with a type/ID allowlist at the API relay. Existing `nearby-sos` remains for familiar notifications/reconnect buffering, without a precise map link.

Persisted request inbox and session/journey APIs are authoritative. Socket delivery is best effort and not proof a person saw an alert. The frontend polls every ten seconds and refreshes on relevant events/reconnect. No background mobile push service exists in this repository; check-ins are delivered to connected clients and visible on the next poll/open. Closing a browser cannot guarantee notification receipt.

## Persistence, jobs, modes and rollout

New `EmergencySession` fields: `distressConfidence`, initial/latest victim locations, `nearbyResponderRequests`, `activeResponder`, bounded `responderHistory`, `responderTracking`, `escalationStage/History/State`, `emergencyGeofence`, `geoRiskSignals`, bounded `geoEvents`, `coordinationVersion`, `coordinationNextRunAt`. `ActiveUser` adds observation time and accuracy. `SafetyJourney` is separate because prevention has a lifecycle independent of emergencies.

The original queue `suraksha-followup` now also accepts `coordinate-session` and `check-journey`. Both use stable IDs and three exponential-backoff attempts. Due timestamps remain in MongoDB; queue loss and worker restarts do not erase work. The existing worker dispatcher is the only scheduling timer. Closed jobs no-op. Expiry cleanup releases primary assignment and cancels requests; APIs enforce expiry even before the worker runs.

Existing sessions missing coordination fields are picked up by the dispatcher and use their legacy location. No destructive migration is necessary. API and worker initialize indexes before serving work. Deploy backend and worker together before using the new frontend. Do not run old and new coordination workers concurrently during rollout.

`AGENT_MODE=review/live` retains the existing SMS follow-up approval policy. `off` now disables **AI follow-ups only**: emergency sessions and deterministic responder/journey coordination continue, and the worker must still run. This intentional extension enables rescue tracking without enabling model actions. Initial SOS still uses the existing Gemini audio analysis. The off-mode worker does not require Gemini/Twilio credentials to process geo jobs.

Configuration is centralized in `src/coordination/config.js`; every new variable, unit, and default appears in `.env.example`. Radius/zone ordering and bounds are validated at startup. GPS updates default to a five-second minimum interval, 250 m maximum accuracy, and a 70 m/s jump threshold. The UI samples at 15-second intervals while the relevant screen stays open. Monitoring is explicit and stops on leaving that screen; community sharing retains its existing opt-in controls.

## Local run and safe testing

1. Install backend dependencies with `npm ci`, and frontend dependencies with `npm ci` in its own directory.
2. Copy `.env.example` values into your ignored backend `.env`, using local MongoDB and Redis. Use `PORT=5000` to match the existing frontend proxy, or set `BACKEND_URL` for Vite to your chosen backend port. Keep provider secrets out of source control.
3. Start backend with `npm start`; start its separate worker with `npm run agent:worker`.
4. Start frontend with `npm run dev`. Register/sign in separate victim and responder accounts. Use the existing community sharing controls to opt responders in and keep location current.
5. Backend tests: `npm test`. Frontend: `npm test`, `npm run typecheck`, `npm run build`. On PowerShell with scripts disabled, use `npm.cmd`.

Automated tests mock Gemini, Twilio and outbound notifications. Database integration tests launch an isolated temporary MongoDB using the dev dependency `mongodb-memory-server`; they never load `.env` or use an application connection URI. The first run may need network access to download the MongoDB binary; subsequent runs use its cache. No real SMS or socket notification is sent. Tests cover atomic races using actual MongoDB, cross-session unique assignment, cleanup, journey uniqueness, and restart recovery, alongside service-level timing/noise/auth scenarios.

The frontend demo remains simulated and sends no alerts. New responder/journey operations require sign-in and live backend state; no fake responder acceptance is presented as real. ETA and provider routes are estimates, and geofencing relies on client GPS rather than native background location. Gemini/Twilio are real providers only when their existing live flows are exercised. Do not test a distress-trigger route with real contact/provider credentials unless you intend to send its original SMS alerts.

## End-to-end demonstration

Use an isolated test fixture/provider mock for the distress step, or intentionally configured test contacts:

1. Gemini detects distress with confidence ≥70; existing SOS policy passes.
2. An emergency session is persisted and initial authorized contact alerts are submitted.
3. Eligible opted-in users within 1 km get persistent requests and approximate nearby alerts.
4. Nobody accepts before the request/stage deadline.
5. The next worker check expands to 2 km and notifies only new users.
6. A fresh eligible responder accepts through their authenticated request.
7. The backend atomically assigns that responder; the owner's progress shows confirmed help.
8. The owner sends fresh GPS readings while moving 700 m.
9. Once movement and interval criteria hold, the emergency fence follows that location.
10. Responder readings recalculate distance and labelled estimated walking ETA.
11. Within 100 m, fresh readings show `nearby` and emit a proximity update.
12. Within 20 m with sufficient GPS accuracy, the backend records an arrival candidate. The responder explicitly confirms arrival and can mark assistance completed.
13. The owner resolves the incident. Outstanding requests are cancelled, assignment/tracking is removed, and further responder location updates are rejected.
