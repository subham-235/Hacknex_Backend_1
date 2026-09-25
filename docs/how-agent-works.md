# How the Suraksha agent works

The agent follows up after the backend detects an SOS. It runs in a separate worker, so the initial alert does not wait for the agent's decisions.

1. The app sends audio and location to `POST /sos/trigger`. The backend analyzes the audio and checks its distress threshold.
2. When an SOS qualifies, the backend sends the initial SMS alerts and saves an emergency session in MongoDB. The session records the authorized contacts, message attempts, incident reference, location, and next review time.
3. A dispatcher checks for due sessions and places jobs in BullMQ. The worker claims a session so two workers do not process the same incident at once.
4. The worker asks Gemini to review the incident. Gemini can use restricted tools to read the emergency context, contact replies, and latest location. It can record an update or request a follow-up to a contact already authorized for that incident.
5. Backend policy validates every requested action, including the recipient, session state, acknowledgments, and send limits. Gemini cannot send an arbitrary message or choose a new recipient.
6. In the default `review` mode, a follow-up becomes a proposal. The incident owner must approve it before an SMS is sent. In `live` mode, permitted follow-ups can be sent automatically. With `AGENT_MODE=off`, AI follow-ups are disabled.
7. Twilio delivery callbacks and contact replies update the session. A contact can acknowledge with `ACK <reference>`. An acknowledgment records a response; the owner must still resolve the incident.

MongoDB keeps the session and its schedule, Redis and BullMQ handle background jobs, and Socket.IO tells the signed-in owner when the session changes. The worker has limits on model runs, tool calls, follow-ups, and session duration. If it restarts, it can pick up eligible sessions from the saved schedule.

Run the API with `npm start` and the worker with `npm run agent:worker` from `backend`. See [agent-workflow.md](agent-workflow.md) for configuration, API routes, failure handling, and implementation details.