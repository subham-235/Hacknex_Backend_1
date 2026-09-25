# Geofencing Demo Mode

"Demo Mode simulates only device GPS coordinates. The coordinates are processed through the same backend geofencing, responder, escalation, distance, persistence and real-time update logic used by real devices."

## Enable and run

Set these in `backend/.env` (demo mode is disabled when omitted):

```env
ENABLE_DEMO_MODE=true
DEMO_RESPONDER_TIMEOUT_SECONDS=5
DEMO_DEVIATION_CONFIRM_SECONDS=3
```

Start MongoDB and Redis with your existing configuration. Run `npm install` and `npm start` inside `backend`; run `npm install` and `npm run dev` inside `frontend`. On PowerShell installations blocking npm.ps1, use `npm.cmd`. The frontend runs on 5173 and proxies to backend port 5000: set backend `PORT=5000` or match `BACKEND_URL` to your backend port.

Sign in normally, open **GPS simulator**, then **Create / Resume My Demo**. One demo workspace is retained per account; reopening resumes it. The existing **Explore demo** is an in-memory product tour and does not run this backend simulator. Normal workers may continue running; they never schedule demo collections.

## Controls

| Button | Real backend behavior |
| --- | --- |
| Set Start Position | Starts a predefined Kolkata journey; closes this demo's previous open journey. |
| Move Along Safe Route | Sends three route samples through the shared location/journey services. |
| Simulate Route Deviation | Sends the configured outside samples spanning the confirmation duration; requires a safety check, never invents an SOS. |
| Simulate GPS Noise | Sends one coordinate just outside the corridor. Start/follow the safe route first: one outside sample cannot confirm deviation. |
| Move Victim 300m / 700m | Moves east from the emergency victim (or route start); recalculates tracking and emergency center. |
| Move Near Destination | Sends a coordinate outside the configured destination radius. |
| Enter Destination | Sends a coordinate inside the destination and uses real arrival rules to close the journey. |
| Start Emergency | Creates a labelled demo incident and a responder fixture at 900m; real geospatial discovery generates the request. |
| Simulate No Responder | Places the fixture between the initial and secondary radii so it is initially undiscoverable. Reset before starting another incident. |
| Trigger Radius Expansion | Advances the simulation clock by the acceptance timeout and calls the production escalation check. Assigned help prevents expansion; the configured maximum still applies. |
| Simulate Responder Accept | Accepts the actual pending request using the normal assignment service; rejects absent/expired requests. |
| Start 900m Away / Move To 500m / 250m / 80m / 15m | Sends coordinates through responder tracking. Accept first. Distance, ETA and proximity come from the backend. |
| Confirm Arrival | Invokes the normal explicit responder-arrival transition. |
| Resolve Incident | Invokes the existing resolution handler on the selected demo incident. |
| Normal Timing / Demo Timing | Selects production durations or demo-only shortened durations. |
| RESET DEMO | Deletes only the selected demo's incident, journeys and fixture presence; resets its clock. |

The three **Demo:** buttons reset the selected workspace and run these API actions in sequence. Rescue stops at the real arrival-candidate state; confirmation and resolution remain explicit actions.

## Two-minute judge walkthrough

1. Set Start Position, Move Along Safe Route, then Simulate GPS Noise. Show no confirmed deviation.
2. Move Along Safe Route, then Simulate Route Deviation. Show outside distance, elapsed simulation time, sample count and the safety-check requirement.
3. Simulate No Responder. Show initial radius (default 1km), then Trigger Radius Expansion. Stage 2 (default 2km) discovers the responder.
4. Simulate Responder Accept. Move to 900m, 500m, 250m, 80m and 15m. Observe backend distance, ETA and proximity updates.
5. Confirm Arrival. The incident remains active. Move Victim 700m and show previous/current emergency centers and changed tracking distance.
6. Resolve Incident; Reset to replay.

Production distinguishes **arrival candidate** from **confirmed arrived**: precise fresh GPS inside the threshold generates a candidate; explicit arrival confirmation is required. The demo preserves this rule. Victim movement updates proximity but does not reverse a previously confirmed responder status.

## Architecture, timing and safety

The simulator injects the same `createResponderService` and `createJourneyService` used by real GPS, using cloned production Mongoose schemas and indexes in isolated `demoemergencysessions`, `demosafetyjourneys` and `demoactiveusers` collections. `demoruns` stores ownership, selected records and simulation time. Real location validation, spherical distance, corridor evaluation, MongoDB geospatial discovery, assignment, proximity, optimistic concurrency, escalation and persistence execute. Socket.IO notifies the authenticated owner's room; the frontend fetches persisted snapshots, with three-second polling recovery.

Victim/responder identities are explicit demo fixtures. Discovery is additionally scoped to each run's fixture presence. Demo fixtures never enter real community searches, inboxes, SMS delivery or worker queues. The simulator does not send distress SMS or run audio classification. Production GPS cannot overwrite demo coordinates. The only interface reading these records permanently displays **DEMO MODE — SIMULATED GPS**.

Presentation timing is an explicit exception to wall-clock pacing: actions advance a persisted, displayed **simulation clock**. Movement advances enough elapsed time to satisfy normal GPS speed/rate/order validation instead of disabling it. Radius Expansion advances the acceptance timeout. Normal Timing uses production durations on this clock; Demo Timing uses the two shortened durations above. Time does not advance while idle, keeping manual presentation steps repeatable. Services receive the clock through their existing dependency injection and determine every outcome. React never sets fake distance or status.

The map's emergency circle uses the backend center and radius. Its purple corridor uses the configured tolerance around the predefined straight route. Device accuracy still participates in backend boundary evaluation. OpenStreetMap supplies base tiles; calculations continue without tiles.

## API and access control

Every `/demo` route returns 404 unless `ENABLE_DEMO_MODE` is exactly `true`. Enabled routes use normal cookie/JWT authentication. Redis limits each account to 120 requests/minute across API processes; limiter failure rejects requests. A MongoDB lease rejects concurrent mutations of the same demo.

```text
GET  /demo/config
POST /demo/sessions
GET  /demo/sessions/:id
POST /demo/sessions/:id/victim-location
POST /demo/sessions/:id/responder-location
POST /demo/sessions/:id/scenario
POST /demo/sessions/:id/reset
```

`:id` is the owned demo workspace ID returned by creation, not a production incident ID. Location endpoints accept numeric `latitude` and `longitude`. Scenario bodies contain an `action` matching the implementation's control name. Client-supplied identities are never used. Foreign IDs return 404. Shared validation rejects invalid coordinates. Reset is scoped by workspace ownership and fixture identity.

To disable, set `ENABLE_DEMO_MODE=false` and restart the backend. All demo APIs become unavailable without changing normal APIs or workers. Records remain isolated; Reset before disabling if cleanup is wanted.

## Verification

The guided “A journey goes off route” story starts a live 10-second safety-check countdown. Keep the simulator page open. Choose “I'm safe” to end the demo journey without an SOS; otherwise the page automatically requests `checkin-tick` when time expires. The backend checks the persisted wall-clock deadline before advancing simulation time and escalating. An early tick cannot send. Production journey timing stays unchanged at five minutes by default. Manual `checkin-wait` and `checkin-timeout` controls remain available for inspecting simulation time. The timeout runs the production journey escalation service with demo-only models, a fictional contact, and an in-memory SMS adapter. The resulting demo SOS records simulated submission acceptance, not real delivery. Repeating the timeout does not create another SOS. The frontend checks the demo API version and asks for a backend restart when an older running process lacks these actions.

Run `npm test` in backend and frontend, and `npm run typecheck` / `npm run build` in frontend. The demo integration test uses temporary MongoDB, never your application database. It covers ownership, disabled/authenticated routes, geospatial discovery, noise, deviation, destination, expansion, assignment, proximity, resolution and reset isolation.
