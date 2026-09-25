# Suraksha backend

Express API for audio-triggered SOS alerts, emergency contacts, location sharing,
incident heatmaps and a bounded Gemini follow-up agent.

## Run

### Worker connection errors and model limits

`node scripts/check-worker.js` checks the worker's Redis transport and eviction policy without creating SOS jobs. Add `--gemini` for one tiny model connectivity request (uses API quota). Add `--fix-redis-policy` to attempt changing the configured Redis database to `noeviction`; hosted providers may require this setting in their database console instead.

- Redis `ETIMEDOUT`: verify the configured endpoint, port, TLS setting, credentials and network access. Workers reconnect with bounded exponential backoff. Reconnection cannot fix an unreachable provider.
- Redis `volatile-lru`: select **noeviction** in your Redis provider's database eviction-policy settings. BullMQ locks and job state must not be evicted. The application does not suppress this warning when the policy is still wrong.
- Gemini `429`: check the model's quota/rate limits and billing in Google AI Studio. A successful Redis check does not mean the model is available. The worker schedules progressively longer retries (60s to 10min), subject to the existing run budget and incident expiry.
- Gemini timeouts/`499`/`504`: transient failures receive the same bounded retries. `AGENT_MODEL_TIMEOUT_SECONDS=45` limits each call; `AGENT_RUN_TIMEOUT_SECONDS=90` limits the whole multi-step review. SDK-internal retries are disabled so application retry scheduling owns the retry budget.
- Gemini authentication/model/request errors pause AI review with a persisted explanation rather than continuously retrying. Incident status becomes `review_required`; the incident is not marked resolved and geofence checks continue. Correct configuration before resuming AI review.

For runtime key failover, set `GEMINI_API_KEYS=first_key,second_key` (the existing
`GEMINI_API_KEY` and optional `GEMINI_API_KEY_2` variables are also supported).
Audio analysis, agent follow-ups and the Gemini diagnostic all use the pool. A
`429`, retryable `5xx`, timeout or network failure puts that key into cooldown
and immediately tries the same request once on the next available key. Successful
requests keep using the working key. `GEMINI_KEY_COOLDOWN_SECONDS` defaults to 60,
and a provider `Retry-After` header takes precedence. Request/authentication errors
do not rotate keys. No key values are written to logs. Keys in the same provider
project can share quota, so a second key is useful only when it has independent
capacity.

AI follow-ups use `suraksha-followup` with concurrency 1; geofencing and responder tracking use a separate `suraksha-coordination` queue with concurrency 2. The original worker still accepts old coordination jobs during migration. Model cooldown is stored in MongoDB and cannot be bypassed by location updates; explicitly approved actions retain their existing guarded execution. Failures do not replay initial SOS messages or uncertain SMS sends.

Restart `npm run agent:worker` after changing worker code/configuration. If the provider limits remain unresolved, deterministic geofencing can run with `AGENT_MODE=off`; this disables AI follow-up only and does not repair provider quota.

For **Geofencing Demo Mode**, see the [simulator setup, controls and judge walkthrough](docs/geofencing-demo.md). It is disabled by default and uses the real coordination services with isolated demo records.

Merge the settings in `.env.example` into your existing `.env`. Keep the API and
worker on the same MongoDB and Redis. The worker uses `AGENT_MODEL` (default:
the existing project's `gemini-3.6-flash`) and `GEMINI_API_KEYS` or the legacy
`GEMINI_API_KEY`.

```sh
npm install
npm start
```

In another terminal:

```sh
npm run agent:worker
```

The agent defaults to **review** mode: proposals do not send automatically.
Approving a proposal through the API authorizes a real SMS. `AGENT_MODE=live`
enables automatic bounded follow-ups; `off` disables the agent. Initial SOS
messages are unaffected by review/off mode and still use Twilio.

Set `PUBLIC_BASE_URL` to your public HTTPS backend origin. Configure Twilio's
incoming SMS webhook to `POST /agent/webhooks/incoming`. Status callback URLs
are attached to outgoing tracked messages. Both webhook routes verify Twilio
signatures. Use Redis persistence and `maxmemory-policy=noeviction` for BullMQ.

## Agent API

### Voice latency

The frontend records independent two-second WebM clips. While an analysis is
running, it retains at most five recent clips (ten seconds) and submits them in
chronological order in the next request, using repeated `audio` multipart fields.
Clips older than ten seconds are discarded to avoid delayed alerts from a growing
backlog. Restart this backend before using the updated frontend; older backends
accept only one file per request.

Audio is sent inline to Gemini in one model request, without a separate Files API
upload. The combined raw audio limit is 12 MiB, allowing room for base64 encoding.
The model and distress threshold are unchanged. Shorter clips can contain less
context, so verify detection with representative recordings before relying on it.

Backend `SOS timing` logs report Gemini duration and cumulative time from controller
entry to analysis completion and SMS submissions completion. They exclude browser
recording/upload time and carrier delivery time; no live latency guarantee is made.

## Agent endpoints

Existing authenticated cookie required:

- `GET /agent/sessions`
- `GET /agent/sessions/:id`
- `POST /agent/sessions/:id/resolve`
- `POST /agent/sessions/:id/actions/:actionId/approve`
- `POST /agent/sessions/:id/actions/:actionId/reject`

`POST /sos/trigger` now also returns `agentSessionId`, `agentReference` and
`agentTrackingError`. Contacts acknowledge via `ACK <reference>` or send a
free-text reply containing the reference. Acknowledgment does not resolve an SOS.

Socket.IO connections now require the login token cookie. Listen for
`agent-session-updated` with `{ sessionId }` and fetch the owner-scoped details.
The legacy `register` event only accepts the authenticated user's own ID.

## Verification and guide

```sh
npm test
```

Tests mock external services; they do not send SMS or call Gemini. The full
workflow, operating limits, recovery behavior and integration instructions are
in [the guide](docs/agent-workflow.md) and
[the Word document](docs/Suraksha-Agent-Workflow.docx).

There is no frontend in this checkout. Configure and test actual Gemini, Redis,
MongoDB and Twilio integrations with designated test contacts before live use.

## Responder coordination and geo safety

See [Responder coordination and geofencing](docs/responder-geofencing.md) for the implementation map, authenticated APIs, socket events, settings, privacy rules, local setup, tests and full demonstration. Run the existing agent worker for deterministic coordination even with `AGENT_MODE=off`; off now disables AI follow-ups, while emergency sessions and geo monitoring remain available.
