# How the Suraksha agent actually works — a beginner's guide

This guide explains the implementation in this project. You do not need previous experience with AI agents to follow it.

## 1. What is an agent?

An AI agent combines a language model with functions it is allowed to request. The model reads information, chooses a function, sees the result and can choose another function.

In Suraksha, Gemini is the model. The functions let it inspect an emergency and request a follow-up. Your Node.js code actually runs those functions.

For example, the agent might go through this sequence:

1. Read the open emergency.
2. Check whether any contacts replied.
3. Notice that one contact cannot help.
4. Check another authorized contact's status.
5. Propose a follow-up to that contact.

That sequence is an example, not a guaranteed model response. The model may decide that no further action is useful.

## 2. You already had AI before adding the agent

Your original audio feature calls Gemini to analyze a recording. Gemini returns information such as the transcript, whether it sounds like distress, a confidence value and an emergency summary.

The controller then follows a fixed path:

```text
Receive audio and location
          |
          v
Ask Gemini to analyze audio
          |
          v
Check distress and confidence threshold
          |
          v
Send initial SMS alerts
          |
          v
Save history and attempt nearby-user notifications
```

The new agent adds a follow-up process after those initial messages. It can take new replies and delivery information into account when deciding its next action.

The audio analyzer and the follow-up agent are two different uses of Gemini. They do not share an ongoing chat conversation automatically.

## 3. The parts of your project, in plain language

| Part | What it does in this project |
| --- | --- |
| Express API | Receives requests from the app and callbacks from Twilio. |
| Gemini | Reads supplied information and requests an allowed tool. |
| Tools | Ordinary JavaScript functions that read data or request a follow-up. |
| MongoDB | Stores the emergency, recipients, attempts, replies and decisions. |
| Redis | Supports the job queue and communication between the API and worker. |
| BullMQ | Manages background jobs waiting to be processed. |
| Worker | A separate Node.js process that picks up and processes those jobs. |
| Twilio | Submits SMS messages and tells the backend about delivery or replies. |
| Socket.IO | Tells the logged-in user's app that a session has changed. |

The agent is not an extra person or a program that runs by itself forever. It is a bounded loop inside your worker.

## 4. Why there are two running processes

Your API runs with:

```sh
npm start
```

Your agent worker runs in another terminal with:

```sh
npm run agent:worker
```

Run both commands from the `backend` folder.

The API handles incoming requests. The worker handles follow-up processing in the background. Keeping them separate means the original SOS request does not wait for the agent's reasoning loop to finish.

If only the API is running, it can still process initial alerts and store emergency sessions. Agent follow-ups need the worker. When the worker starts again, it checks persisted schedules for sessions that are still eligible.

## 5. What happens when a user triggers an SOS?

### Step A: The existing controller checks the audio

The app posts audio and location to:

```http
POST /sos/trigger
```

The existing controller requires `isDistress` to be true and confidence to be at least 70 before sending alerts. The agent implementation does not replace that check or add a separate manual SOS endpoint.

### Step B: The backend creates an emergency session

A session is the saved record of one incident and its follow-up activity. It includes:

- The user who owns the incident.
- A snapshot of the emergency contacts selected for this incident.
- The summary and location.
- Initial SMS attempts and later delivery information.
- Contact replies and acknowledgments.
- Proposed follow-up actions.
- The next review time and expiry time.

It also gets a reference such as `ABCDEF123456`. That reference connects a contact's SMS reply to the correct incident.

### Step C: Initial alerts are sent

The SMS service sends the original alerts. When agent tracking is available, the messages include instructions such as:

```text
Reply ACK ABCDEF123456 to acknowledge,
or include ABCDEF123456 in your reply.
```

The backend records the submission results. It then marks the session ready for background processing, saves history and attempts the existing geographic notifications.

The response includes `agentSessionId`. The app can use this ID to retrieve the session later.

### Step D: The worker finds the session

The worker contains a dispatcher: a small piece of code that checks MongoDB every 15 seconds for sessions whose review time has arrived.

The default first review is due 60 seconds after session creation, once initial processing is complete. Actual processing may start later because of the dispatch interval, queue load or service availability.

The dispatcher places the session ID into BullMQ. MongoDB keeps the full incident record; the queue job only needs to identify the session.

### Step E: One worker claims the job

Before processing, the worker claims a temporary lease on the session. A lease is a saved marker saying, "This worker is handling this incident for now."

Other workers cannot claim the same session while that lease is valid. If a worker crashes, its lease eventually expires so another worker can continue.

## 6. What Gemini actually receives and returns

The worker gives Gemini instructions and a list of available tools. Gemini does not receive unrestricted database access or Twilio credentials.

The following is a simplified example of a tool request:

```json
{
  "name": "getContactResponses",
  "args": {}
}
```

Your code sees the requested name, checks that it is allowed and runs the corresponding JavaScript function. It returns the result to Gemini.

The model can then request another tool. A later request might look like:

```json
{
  "name": "sendFollowUp",
  "args": {
    "contactId": "222222222222222222222222",
    "reason": "The other contact cannot help and this contact has not acknowledged."
  }
}
```

That ID is illustrative. In actual use, it must identify a permitted contact returned by the backend.

The important sequence is:

```text
Gemini requests a tool
        |
        v
Backend validates the request
        |
        v
Backend executes the allowed function
        |
        v
Backend returns the result to Gemini
        |
        v
Gemini chooses another tool or finishes
```

This repeated exchange is the agent loop. Your implementation checks that the agent has read emergency context and contact responses before requesting a follow-up.

## 7. The five tools it can use

| Tool | Beginner explanation |
| --- | --- |
| `getEmergencyContext` | "Show me this incident, permitted contact IDs and previous actions." |
| `getContactResponses` | "Show me what the contacts replied and who explicitly acknowledged." |
| `getLatestLocation` | "Show me a recent location, or label the available location as last known." |
| `sendFollowUp` | "Propose or attempt a permitted follow-up for this contact." |
| `recordUpdate` | "Save a short observation for the owner to read." |

Despite its name, `sendFollowUp` does not automatically send in review mode. It creates a proposal.

The follow-up message text comes from a backend template. Gemini supplies a contact ID and a reason; the reason stays in the action record and is not inserted into the outgoing SMS.

## 8. Review mode, live mode and off mode

### Review: the default

```env
AGENT_MODE=review
```

The model can propose a follow-up. You inspect it through the owner API and decide whether to approve it.

Approval schedules the action for the worker. Before sending, the worker checks the contact and incident again. It can block an approved action if the incident has closed, the contact has acknowledged or another limit now applies.

Review mode still calls Gemini. It is not a fully simulated environment: initial SOS messages are real, and approving a proposal authorizes a real follow-up SMS when configured.

### Live: automatic follow-ups

```env
AGENT_MODE=live
```

The agent can execute a follow-up without the separate owner-approval step. The same backend authorization checks and limits still apply.

### Off: disable agent processing

```env
AGENT_MODE=off
```

New agent sessions and worker processing are disabled. This setting does not disable the original SOS alerts.

Restart the API and worker after changing environment settings so both processes use the same configuration.

## 9. How a contact's reply reaches the agent

A webhook is an HTTP request that another service sends to your application when something happens.

Here is the reply path:

```text
Contact replies by SMS
        |
        v
Twilio receives the reply
        |
        v
Twilio calls POST /agent/webhooks/incoming
        |
        v
Backend verifies the signature, sender and incident reference
        |
        v
Backend saves the reply and makes the session due for review
        |
        v
Worker lets the agent inspect the updated information
```

For example:

```text
ABCDEF123456 I am out of town. Please check with her sister.
```

This is stored as a reply. It is not an explicit acknowledgment.

```text
ACK ABCDEF123456
```

This records an explicit acknowledgment. The backend blocks further follow-ups to that contact. It does not conclude that the person is safe, and other eligible contacts can still receive a follow-up.

The Twilio incoming webhook must be configured against a publicly reachable HTTPS backend. `localhost` on your laptop is not a public callback address. `PUBLIC_BASE_URL` must match the public origin used by Twilio.

## 10. Sent, delivered and acknowledged mean different things

| Label | Meaning |
| --- | --- |
| Accepted / queued | Twilio accepted the submission or queued it. |
| Sent | A provider transport status; it does not mean the contact read the SMS. |
| Delivered | Twilio reported delivery through a status callback. |
| Acknowledged | The contact explicitly replied with the expected ACK message. |
| Resolved | The incident owner explicitly closed the session. |
| Unknown | A submission result is uncertain, for example after a network timeout. |

Do not treat these as interchangeable. The original SOS response's `sent` flag describes successful submission attempts; later delivery information appears in the emergency session.

## 11. How to inspect and approve a proposal

Log in through your existing authentication API first. The following endpoints require its token cookie. You can use Postman with the login cookie retained for the same backend.

List your sessions:

```http
GET /agent/sessions
```

Open one session, replacing `SESSION_ID` with its actual ID:

```http
GET /agent/sessions/SESSION_ID
```

Look at the `actions` array for an action whose `state` is `proposed`. Its `_id` is the action ID.

Approve it:

```http
POST /agent/sessions/SESSION_ID/actions/ACTION_ID/approve
```

Or reject it:

```http
POST /agent/sessions/SESSION_ID/actions/ACTION_ID/reject
```

These action endpoints do not need a request body. Successful approval means the action was approved for processing, not that the SMS has already been delivered. Fetch the session again to inspect the result.

To close the incident:

```http
POST /agent/sessions/SESSION_ID/resolve
```

There is no agent dashboard in this backend-only checkout. The endpoints are ready for a frontend to use. Socket.IO can notify the owner with `agent-session-updated`; the app then fetches the updated session through the API.

## 12. Why the agent cannot keep messaging forever

The default limits are:

- 12 model runs per session.
- Six tool calls per run.
- A 30-second deadline for an agent run.
- Three follow-up actions per session, including review proposals.
- At most one follow-up action per contact per session.
- A 30-minute session processing window.

One model run can contain several Gemini requests and tool calls. It is not necessarily one SMS or one Gemini API request.

When the model-run budget is exhausted, the session moves to `review_required` on a subsequent processing pass. The owner can still approve an existing proposal while the session is unexpired. Approval does not grant unlimited additional AI runs.

An expiry ends the processing window. It does not mean the emergency was resolved successfully.

## 13. What happens if something fails?

### The worker stops

MongoDB retains the session and schedule. When the worker resumes, it can find due sessions that are still eligible.

### Gemini fails

The backend records an agent error. The failed run counts toward the run budget. Initial alerts that were already sent remain unaffected.

### A message submission times out

The provider might have received the request even though the backend did not receive a response. The code records an uncertain outcome rather than blindly replaying the same follow-up. Check provider records or later callbacks to establish what happened.

### The same webhook arrives twice

Incoming message IDs are deduplicated. Delivery updates are ordered so an older status cannot overwrite a later delivery confirmation.

### The user resolves the session during processing

The worker checks the session before authorizing a send. A message that has already been submitted to Twilio cannot be recalled.

## 14. Which files should you read first?

Read these in order, relative to `backend`:

| File | What to look for |
| --- | --- |
| `src/controllers/trigger.js` | Where the original SOS flow creates and prepares a session. |
| `src/models/emergencySession.js` | What the backend remembers about one incident. |
| `src/agent/worker.js` | How the separate background process starts. |
| `src/agent/dispatcher.js` | How due sessions become queue jobs. |
| `src/agent/processor.js` | How a job claims a session and starts processing. |
| `src/agent/loop.js` | The actual Gemini/tool/result loop. |
| `src/agent/tools.js` | The functions the agent can request. |
| `src/agent/policy.js` | Rules that decide whether follow-up is allowed. |
| `src/agent/http.js` | Replies, delivery callbacks, approvals and resolution. |
| `src/agent/config.js` | Modes and default execution limits. |

Start with `loop.js` if you specifically want to see the agentic part. Follow its call into `tools.js`, then look at `policy.js` to understand how backend rules limit what the model can do.

## 15. Your first steps with this implementation

1. Read `.env.example` and merge the needed values into your existing `.env` without replacing working credentials.
2. Keep `AGENT_MODE=review` while learning the flow.
3. Run `npm test` to exercise the automated tests. These use mocked external services and do not send SMS or call Gemini.
4. Start the API and worker in separate terminals once MongoDB, Redis and Gemini are configured.
5. Configure Twilio's public callback address if you want to exercise replies and delivery updates.
6. Use designated test contacts for an actual SOS exercise. Initial SMS messages are real even in review mode.
7. Inspect the saved session and proposed actions. Approve a proposal only when you intend the configured worker to submit that follow-up SMS.

The implementation was tested with mocked integrations. Actual provider access, SMS reply support and end-to-end delivery still need verification in your configured environment.
