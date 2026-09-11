# Suraksha backend

Express API for audio-triggered SOS alerts, emergency contacts, location sharing,
incident heatmaps and a bounded Gemini follow-up agent.

## Run

Merge the settings in `.env.example` into your existing `.env`. Keep the API and
worker on the same MongoDB and Redis. The worker uses `AGENT_MODEL` (default:
the existing project's `gemini-3.6-flash`) and `GEMINI_API_KEY`.

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
