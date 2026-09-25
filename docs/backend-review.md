# Backend review: code issues and connection failures

Reviewed on 11 September 2026. This is a review of the current implementation, not a claim that the issues below have been fixed.

## What was checked

- All 42 JavaScript application source files under `src`: controllers, routes, models, middleware, agent, services, configuration and Socket.IO.
- Both automated test files, package configuration and the documented operating modes.
- Environment variable presence without printing credential values.
- Syntax checks and the existing 57 automated tests.
- Additional offline reproductions of authentication, AI-response validation, coordinate parsing, location updates and post-SMS failure handling.
- Read-only DNS lookups and MongoDB/Redis connection and PING checks. No application records were read or changed, and no SMS or Gemini inference was requested.

Third-party dependency source, uploaded recordings and Git history are not covered by the application-code review. Passing these checks does not establish that the entire application is production-ready.

## Connection findings

| Check | Observed result | What it establishes |
| --- | --- | --- |
| Redis DNS lookup | Passed outside the restricted tool sandbox | The configured hostname resolved at that moment. |
| Redis connection, authentication and PING | Passed | The current Redis credentials and endpoint worked for this check; this does not establish long-term connection stability. |
| MongoDB DNS lookup | Passed outside the restricted tool sandbox | The Atlas SRV records could be resolved at that moment. |
| MongoDB connection and PING | Failed with `MongooseServerSelectionError` | A usable database connection could not be established. The precise cause remains unconfirmed. |
| Gemini and Twilio credentials | Present; not tested against the providers | Presence alone does not prove validity, model access, quota or SMS permissions. |
| `PUBLIC_BASE_URL` | Blank or absent | Twilio callback verification cannot operate until a matching public HTTPS origin is configured. |
| `REDIS_URL` and `REDIS_HOST` | Blank or absent | The application currently uses the original Redis hostname fallback in code. |
| Agent configuration | Valid; review mode | Follow-up proposals require owner approval before an SMS submission. |

The first connection check inside the restricted tool sandbox was blocked and is not evidence that the user's credentials are wrong. The table above reports the subsequent check outside that sandbox.

The original logs show intermittent DNS failures, connection timeouts and resets. `querySrv ECONNREFUSED` concerns the DNS lookup; it is not proof that an Atlas IP access-list rule rejected the connection. Redis `ENOTFOUND` also indicates hostname resolution failure. The later successful API startup in the user's logs demonstrates that the dependencies were reachable at least once.

For Atlas, verify that the cluster is running, the connection string still matches the cluster, the current client IP is allowed and the network permits the Atlas connection. If DNS failures recur, compare the same lookups on another permitted network. Do not replace keys simply because a DNS lookup or TCP connection failed.

## Highest-priority code issues

### 1. The authenticated-user endpoint fails even with a valid user

**File:** `src/controllers/userAuthenticate.js`, `authenticat`, around lines 100-114.

The middleware sets `req.user`, but the handler reads an undeclared `user` variable. Its `catch` clause then references an undeclared `err` variable, causing a second error.

**Offline reproduction:** calling the handler with a valid mocked `req.user` rejects with `ReferenceError: err is not defined`.

**Impact:** `POST /user/auth` cannot return the authenticated profile correctly even after the database connection is fixed. This can look like a login or API-key failure in the frontend.

**Correction:** use `req.user` and a properly bound `catch (err)`; add a regression test covering the real handler.

### 2. Redis outages can stall authenticated requests and leave a misleading health response

**Files:** `src/config/redis.js`, `src/middleware/userMiddleware.js`, `src/middleware/adminMiddleware.js`, `src/socket.js`, `src/index.js`.

Authenticated requests wait for a Redis token-blocklist lookup. The client has no explicit fail-fast policy for queued commands during a disconnect. The installed Redis client queues commands while disconnected unless offline queuing is disabled. The reconnect strategy eventually gives up, but a running HTTP server is not automatically restarted or marked unready.

The `/health` endpoint always returns `status: "ok"`, even after database or Redis connections fail. Before initial startup, the server waits for both dependencies, so no HTTP health endpoint is available until both connect.

**Impact:** a listening port or a successful `/health` response does not mean login-protected routes are usable. This directly matters for the reported network problem.

**Correction:** use explicit connection/command deadlines, return a service-unavailable response for dependency failure, distinguish liveness from readiness, and define reconnect exhaustion and shutdown behavior. Keep authentication checks enforced; do not silently skip Redis revocation checks.

### 3. Gemini audio output is coerced instead of strictly validated

**File:** `src/services/llmsupport.js`, around lines 170-190.

`Boolean(result.isDistress)` converts the string `"false"` into `true`. Confidence is converted to a number without rejecting values outside 0-100. Severity and required text fields are also not strictly checked against the expected result shape.

**Offline reproduction:** a mocked model response with `isDistress: "false"` and `confidence: 150` becomes `isDistress: true, confidence: 150`.

**Impact:** malformed model output can pass the distress decision incorrectly. Invalid confidence or empty required text can also cause a later history write to fail after messages have already been submitted.

**Correction:** require the actual boolean type, finite confidence in range, allowed severity values and appropriate required strings before any external side effect. Structured output should be backed by application-side validation.

### 4. A history failure after SMS submission returns a generic failure and skips subsequent work

**File:** `src/controllers/trigger.js`, SMS submission around line 68 and history creation around line 106.

SMS messages are submitted before `History.create`. If that database write fails, control jumps to the outer catch and returns HTTP 500. Geographic incident recording and nearby notifications are then skipped. The response does not preserve the already-completed SMS result.

**Offline reproduction:** one mocked SMS submission succeeded, the history write threw, and the endpoint returned HTTP 500 with zero incident creations.

**Impact:** a client may retry the whole SOS request and submit duplicate initial alerts. The per-session follow-up duplicate checks do not deduplicate separate initial SOS requests.

**Correction:** introduce a request idempotency key and persist the initial operation before submission, report partial outcomes accurately, and isolate later bookkeeping failures from completed notifications.

### 5. Location parsing can silently change invalid coordinates

**File:** `src/utils/locationParser.js`, especially lines 34 and 48-49.

The fallback coordinate regex can match a substring inside a larger invalid latitude. Numeric parsing also accepts strings with trailing nonnumeric characters. `decodeURIComponent` is not guarded against malformed percent escapes.

**Offline reproductions:**

```text
Input: "100,88"
Actual output: { lat: 0, lon: 88 }

Input: "%"
Actual result: URIError
```

**Impact:** the app can record or broadcast the wrong location, or return HTTP 500 for malformed input. In the SOS flow, parsing occurs after SMS and history processing, so malformed location input can also produce a failure after side effects.

**Correction:** validate complete numeric tokens, anchor raw coordinate input, parse supported URL formats explicitly, handle decoding errors and validate before submitting messages.

## Other concrete issues

### 6. Location updates report success even when no active-user row exists

**File:** `src/controllers/locationController.js`, `updateLocation`, around lines 60-74.

The result of `findOneAndUpdate` is ignored. If the user never activated location sharing, or the TTL record expired, the update matches nothing but returns HTTP 200 and `success: true`.

**Offline reproduction:** a mocked database update returning `null` still produced a successful response.

**Correction:** check the returned document and require activation or deliberately recreate the record. Also decide how updates to explicitly deactivated users should behave.

### 7. Socket ownership is not enforced in location activation

**Files:** `src/controllers/locationController.js:24`, `src/socket.js`.

The socket `register` event is owner-checked, but location activation still accepts a `socketId` supplied in the HTTP body and stores it without verifying socket ownership.

**Impact:** the association between a user's location and a notification socket can be overwritten with an unrelated ID. This weakens the authenticated socket-registration guarantees and can misroute community notifications.

**Correction:** derive socket association from an authenticated connection or verify that the supplied socket belongs to `req.user`.

### 8. Audio uploads are always labelled WebM and have no cleanup policy

**Files:** `src/routes/sos.js`, `src/services/llmsupport.js`, `src/controllers/trigger.js`.

Every upload is renamed to `.webm`, while the analyzer chooses the MIME type from the filename extension. An MP3 upload is therefore described to Gemini as WebM. There is a size limit but no audio-type verification. Upload paths depend on the shell's current working directory. Local recordings are not removed on success, rejection or error, and uploaded Gemini files are not explicitly cleaned up by this code.

**Impact:** legitimate uploads may fail analysis, nonaudio files can be submitted, and local storage grows. Starting from `backend` versus `backend/src` writes uploads to different directories.

**Correction:** enforce supported audio formats, use a stable absolute upload directory and implement intentional retention and cleanup.

### 9. Cookie configuration is incomplete and login expiry is inconsistent

**File:** `src/controllers/userAuthenticate.js`.

The login JWT expires in seven days, while its cookie expires after one hour. Cookies do not explicitly set `httpOnly`, `secure` or `sameSite`.

**Impact:** browser login persistence is inconsistent. A separately deployed frontend may require different cookie settings, and the current session token is accessible to page JavaScript.

**Correction:** align session and cookie duration and configure cookie protections for the actual local/deployed origin arrangement. Apply compatible settings when clearing the cookie.

### 10. Contacts can select WhatsApp, but initial alerts always use SMS

**Files:** `src/models/contact.js`, `src/utils/contactValidator.js`, `src/controllers/trigger.js`, `src/services/smsAlart.js`.

The contact model and validator allow `via: "WhatsApp"`, but the initial SOS retrieves all active contacts and sends normal SMS to each. Follow-ups correctly restrict their eligibility to SMS contacts.

**Impact:** stored communication preferences do not match actual initial messaging behavior.

**Correction:** support channel-specific sending or only expose and accept the channel that is implemented.

### 11. Changing the agent model does not change the audio-analysis model

**Files:** `src/services/llmsupport.js:112`, `src/agent/config.js:18`.

The audio analyzer hardcodes `gemini-3.6-flash`. The agent uses `AGENT_MODEL` or its fallback. Updating the agent setting will not fix model-access errors from the audio endpoint.

**Correction:** make the audio model independently configurable and document both settings. Model availability for the user's key remains unverified; a model-access error is separate from DNS failure or an invalid key.

### 12. Agent logs hide the error detail needed for troubleshooting

**Files:** `src/index.js:54`, `src/agent/worker.js`, `src/agent/dispatcher.js`, `src/agent/processor.js`.

Several handlers log only `error.name`. A value such as `Error` does not tell the user whether the failure was a timeout, reset, DNS issue, authentication error or queue problem. This explains why the subscriber logs in the supplied output are uninformative, though it does not establish the underlying cause.

**Correction:** log a sanitized error code, component and safe message, and suppress repeated identical messages without hiding recovery events. This is a gap in the agent integration added earlier.

## Additional coverage and product concerns

- The current 57 tests pass, but most database, queue and provider boundaries are mocks. They do not validate real MongoDB updates, actual BullMQ processing, complete authentication routes or network-recovery behavior. The extra offline reproductions found bugs outside that existing coverage.
- Agent leases, action reservations and acknowledgment updates need integration tests against a real test database, including concurrent events and interrupted workers. Existing mocks cannot prove database-level atomicity or exactly-once delivery.
- The public heatmap returns exact incident coordinate points. Review whether unauthenticated users should receive that precision for automatically recorded SOS incidents; aggregation or reduced precision may be more appropriate for the intended UI.
- Nearby-user lookup checks `isActive` but not `lastSeen` or `expireAt`. Old records can be selected until TTL cleanup occurs. The agent's latest-location lookup already checks freshness, so the two paths behave differently.
- Several handlers return raw error messages and map validation or infrastructure errors to broad 400/401/500 responses. A consistent error contract would make client debugging easier.
- No application-level rate limits or initial-request deduplication were found on login, audio analysis or SOS submissions. These endpoints can repeatedly consume provider resources.

## What can be tested without internet?

Run the existing tests from `backend`:

```sh
npm test
```

These work offline once dependencies are installed. They do not validate real provider credentials or prove that the whole HTTP API works without databases.

For a read-only connection check when network access is available:

```sh
node scripts/check-connections.js
```

This checks MongoDB/Redis DNS and PING only. It does not send SMS, call Gemini or print credentials. A result such as `OK` establishes only that particular check at that time.

Full local HTTP testing without cloud access requires local/test MongoDB and Redis plus mocked Gemini/Twilio services. `AGENT_MODE=review` is not an offline or SMS-simulation mode: initial SOS messages remain real, and approved proposals can send real follow-ups.

## Recommended correction order

1. Fix `/user/auth` and add direct authentication-handler coverage.
2. Add dependency readiness, bounded request waiting and useful connection diagnostics.
3. Strictly validate AI output and location input before sending alerts.
4. Make the initial SOS operation idempotent and preserve partial results after downstream failures.
5. Fix location update/ownership behavior and upload handling.
6. Align channel preferences and cookies, then run real isolated database/queue integration tests.

The application source was not modified during this review. A read-only connection diagnostic script and this report were added locally; neither was pushed to GitHub.

## Official troubleshooting references

- [MongoDB Atlas connection troubleshooting](https://www.mongodb.com/docs/atlas/troubleshoot-connection/)
- [Redis Cloud database connections](https://redis.io/docs/latest/operate/rc/databases/connect/)
- [Node Redis connection error handling](https://redis.io/docs/latest/develop/clients/nodejs/error-handling/)
