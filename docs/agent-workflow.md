# Suraksha SOS Agent
Workflow and operations guide

Implementation guide | 11 September 2026 | Backend edition

## What has been built
Suraksha now has one bounded AI agent that follows up on an existing SOS. The original audio analysis, initial SMS alerts, incident recording and nearby-user notifications remain the first response. A separate Node.js worker evaluates subsequent events and proposes or sends a follow-up to an authorized emergency contact.

The agent is different from a fixed notification script because it can read current incident context, interpret a contact's reply, retrieve location information and choose its next tool call. Backend code controls the recipients, message template, execution limits and session lifecycle.

The default is review mode. Gemini can propose a follow-up, but the proposal sends no SMS until the incident owner approves it through the authenticated API. Live mode permits automatic follow-ups within the same backend limits. Off mode disables new agent sessions and worker processing; the original SOS endpoint can still send initial messages.

## Technology and responsibilities
| Component | Responsibility |
| Node.js and Express | Existing HTTP API, ownership checks and webhook routes |
| Gemini / @google/genai | Interpret context and select allowed function calls |
| BullMQ and Redis | Execute background jobs and dispatch persisted schedules |
| MongoDB and Mongoose | Store sessions, message attempts, decisions and events |
| Twilio | Submit SMS and provide signed delivery/reply callbacks |
| Socket.IO and Redis pub/sub | Notify the authenticated owner that a session changed |

## What is deliberately bounded
The agent works with the active contacts captured for this incident. It does not add recipients, contact arbitrary numbers, dispatch emergency services, give medical instructions or declare the person safe. Only the authenticated incident owner can resolve the session. Acknowledgment means a contact has responded; it does not mean the emergency has ended.

---
# The workflow

## From audio to background processing
1. The authenticated client posts audio and location to POST /sos/trigger. The existing Gemini audio analyzer decides whether the distress/confidence threshold is met.
2. For a qualifying alert with active contacts, the controller creates an EmergencySession containing the recipient snapshot, initial message attempts, reference code, expiry and next review time.
3. The SMS service sends the initial alerts. Each tracked SMS includes the incident reference and reply instructions. Twilio submission results are recorded separately from confirmed delivery. The session becomes ready for background processing.
4. The controller saves alert history, records the geographic incident and attempts nearby-user notifications. The response includes agentSessionId, agentReference and agentTrackingError.
5. Every 15 seconds, the worker's dispatcher finds due sessions in MongoDB and adds them to BullMQ. The default first review is due 60 seconds after session creation, once initial processing is complete.
6. A worker acquires an atomic MongoDB lease. It processes owner-approved actions, then runs the bounded Gemini tool loop if the model-run budget remains.
7. The agent reads context and replies before requesting a follow-up. Each result is returned to Gemini so it can decide whether another tool is useful or finish the run.
8. The backend saves proposals, attempts and notes. An owner-only Socket.IO event prompts the client to fetch the updated session. The next scheduled review remains persisted in MongoDB.

## Example: a contact cannot help
An initial alert goes to a parent and a sister. The parent replies, "ABCDEF123456 I am away; her sister is nearby." The signed inbound webhook matches the reference and sender to the incident, then records the reply. The agent can inspect whether the sister is an authorized recipient and whether she has acknowledged.

If a follow-up is useful, review mode records a proposal for the sister with the agent's reason. After owner approval, the worker sends the fixed follow-up template. Live mode can execute the same action automatically. The model's reason is kept in the action log; it is not inserted into the outgoing message.

If the sister replies "ACK ABCDEF123456", the backend records an explicit acknowledgment and blocks further follow-ups to her. The incident remains open until the owner resolves it or its processing window ends.

---
# Agent tools and stored state

## Allowed tools
| Tool | Result or effect |
| getEmergencyContext | Status, summary, authorized contact IDs, attempts, prior actions and remaining budget |
| getContactResponses | Recent contact replies and explicit acknowledgments |
| getLatestLocation | Fresh location when available; otherwise the last known location and timestamp |
| sendFollowUp | Record a review proposal or execute an allowed template message |
| recordUpdate | Store a short agent observation for the incident owner |

Tool arguments are validated in code. Arbitrary tool names, extra fields, invalid contact IDs and oversized text are rejected. The loop requires successful context and reply reads before a follow-up request. Full Gemini response parts are retained between calls, including any thought signatures.

## Emergency session lifecycle
| State | Meaning |
| active | Open incident eligible for background processing |
| acknowledged | At least one authorized contact explicitly acknowledged; other allowed follow-ups remain possible |
| review_required | Model-run budget is exhausted; the owner can inspect or approve existing proposals |
| resolved | Owner explicitly ended the incident; no new follow-up is authorized |
| expired | Processing window elapsed; no new follow-up is authorized |

Every session stores its owner, history link, recipient snapshot, SMS attempts, actions, acknowledgments, recent events, next-run time, expiry and worker lease. Delivery states such as accepted, queued, sent and delivered are distinct. An action's accepted state describes submission; its associated attempt contains later delivery updates.

## Default execution limits
There are at most 12 model runs per session, six tool calls per run, a 30-second agent deadline and three follow-up attempts per session. Only one follow-up action can exist for each contact in a session, including rejected or failed actions. The session window is 30 minutes. A worker lease lasts 120 seconds, and one worker process runs up to two jobs concurrently.

Proposals also count toward the three-action cap. A reserved send consumes the follow-up attempt budget even if it subsequently fails or is blocked. These choices favor bounded behavior over repeated messaging.

---
# Configuration and startup

## Configure the backend
Use .env.example as a reference and merge values into the existing backend/.env. Do not overwrite working credentials. The API and worker must use the same MongoDB, Redis and agent settings. Use Redis with persistence and a noeviction policy for BullMQ.

| Setting | Purpose / default |
| AGENT_MODE | review (default), live or off |
| AGENT_MODEL | gemini-3.6-flash by default; choose a function-calling model available to the account |
| GEMINI_API_KEY | Required for the worker's Gemini requests |
| DB_CONNECT_STRING | MongoDB connection string |
| REDIS_URL | Redis connection URL; rediss:// enables TLS |
| PUBLIC_BASE_URL | Public HTTPS backend origin, without a path; used to sign and validate callback URLs |
| TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN | Twilio account and webhook verification credentials |
| TWILIO_PHONE_NUMBER | Outgoing SMS number in international format |
| AGENT_CHECK_SECONDS | Review interval; default 60, range 30-600 |
| AGENT_SESSION_MINUTES | Processing window; default 30, range 5-120 |
| AGENT_MAX_RUNS / AGENT_MAX_FOLLOWUPS | Defaults 12 / 3; maximum configurable values 60 / 10 |

When REDIS_URL is omitted, REDIS_HOST, REDIS_PORT, REDIS_USERNAME, REDIS_PASSWORD and REDIS_TLS are supported. The original project's Redis host and port remain fallbacks. JWT_KEY and FRONTEND_URL continue to configure existing authentication and browser access.

## Run the two processes
From the backend directory, install dependencies and start the HTTP API:
```
npm install
npm start
```
In a second terminal, also from backend, start the worker:
```
npm run agent:worker
```
The worker logs its operating mode. Review mode still calls Gemini and may incur AI usage; it suppresses automatic follow-up SMS. Initial SOS alerts remain live. Approving a proposal authorizes a real SMS submission when the worker and Twilio credentials are configured.

---
# Webhooks and client integration

## Configure Twilio
Set the Twilio number's incoming-message webhook to POST https://your-backend.example/agent/webhooks/incoming. Configure PUBLIC_BASE_URL to exactly match that public backend origin. The backend attaches a per-attempt statusCallback URL to each tracked outgoing SMS; its path is /agent/webhooks/status with sessionId and attemptId query parameters.

Both routes validate X-Twilio-Signature against the configured public URL, submitted form fields and Twilio auth token. The AccountSid must match the configured account. If the origin or proxy path is incorrect, signature verification fails. Use an SMS sender that can receive replies for the intended recipients; capability and availability depend on the provider setup.

Contacts reply with "ACK <reference>" to acknowledge. Free-text replies must include the 12-character reference, for example "ABCDEF123456 I am on my way". A reply without a matching reference, from an unrelated number, or for a closed/expired session is ignored. Webhooks return empty TwiML and do not automatically text a reply.

## Owner API
All routes below require the existing login token cookie. Prefix each path with /agent. IDs come from the SOS response or the session detail response.

| Method and path | Use |
| GET /sessions | List the owner's 20 most recent sessions |
| GET /sessions/:id | Read state, attempts, proposals and event history |
| POST /sessions/:id/resolve | Mark the incident resolved |
| POST /sessions/:id/actions/:actionId/approve | Approve a proposed follow-up and schedule processing |
| POST /sessions/:id/actions/:actionId/reject | Reject a proposed follow-up |

Approval and rejection require the action to still be proposed and the session to be open and unexpired. Approval does not bypass current contact authorization, acknowledgment checks or send limits. It can execute after the model-run budget has been spent.

## Socket.IO
Connect with the existing token cookie and credentials enabled. Sockets authenticate on connection and join the server-selected owner room. The register event accepts only that authenticated user's ID. Listen for agent-session-updated, whose payload is { sessionId }, then fetch GET /agent/sessions/:id. Periodic API polling is a fallback if a live notification is missed. No frontend screens are included in this backend workspace.

---
# Reliability, verification and code map

## Failure and recovery behavior
MongoDB stores the schedule independently of BullMQ. After worker or Redis downtime, the dispatcher re-enqueues due sessions. Atomic leases prevent two workers from processing one incident at the same time. Expired leases can be reclaimed.

Before a follow-up SMS is submitted, the worker records a send reservation and attempt. A crash or network timeout can leave the outcome uncertain. The action is not automatically replayed: inspect Twilio records and subsequent callbacks. This prevents blind retries but does not promise exactly-once delivery. An SMS already submitted cannot be recalled if the owner resolves the incident immediately afterward.

If initial processing is interrupted, recovery waits until the initial deadline (30 seconds per initial contact plus two minutes). Remaining pending attempts become unknown; those contacts are blocked from follow-up until delivery evidence clarifies the outcome. The original messages are not replayed.

Model failures consume the bounded run budget and leave an error event; they do not undo initial alerts. Delivery callbacks use compare-and-set updates so older queued/sent events cannot downgrade delivered messages. Inbound message SIDs are deduplicated; at most 100 incoming messages are accepted per session and the latest 100 events are retained. Session records themselves have no automatic deletion policy.

## Verification and practical limits
Run npm test from backend. Automated tests use mocked AI, SMS, database and queue boundaries; they cover review and live decisions, authorization, acknowledgments, signature validation, delivery ordering, execution budgets and existing controller regressions. No live Gemini request, Twilio SMS or production-database integration was exercised during implementation. Verify those configured integrations with designated test contacts before relying on live mode.

The initial audio endpoint still requires audio and its existing distress threshold. This implementation does not add a manual SOS button or change the audio model's decision policy. Follow-ups currently support the project's existing Indian, 10-digit SMS contact format. WhatsApp follow-ups and emergency-service dispatch are not implemented.

## Main source files
| Location under backend/src | Responsibility |
| agent/loop.js and agent/tools.js | Gemini loop and restricted tool execution |
| agent/policy.js and agent/config.js | Eligibility, delivery ordering and configurable limits |
| agent/worker.js, processor.js, dispatcher.js | Background execution, leases and durable scheduling |
| agent/sessions.js and models/emergencySession.js | Initial integration and persistent state |
| agent/http.js and routes/agent.js | Owner endpoints and signed webhooks |
| services/smsGateway.js and smsAlart.js | Shared Twilio submission and initial SMS tracking |

## Official technical references
Gemini function calling: https://ai.google.dev/gemini-api/docs/function-calling

BullMQ connections and Redis configuration: https://docs.bullmq.io/guide/connections

Twilio webhook security: https://www.twilio.com/docs/usage/webhooks/webhooks-security

Twilio delivery tracking: https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
