# Missing SMS replies in Safety agent

Gemini quota errors affect AI follow-up review, not the incoming SMS handler. A valid incoming reply is persisted and triggers a dashboard refresh without calling Gemini. Polling recovers missed socket events.

## India SMS limitation

This backend sends to Indian (+91) contacts. Twilio documents that its SMS route to Indian mobile devices is one-way because the sender ID is replaced. Replying to that displayed sender does not reach the Twilio number or this backend. Setting a webhook cannot remove this carrier limitation. Initial and follow-up alerts therefore no longer promise that replying ACK works on this route.

New SOS and follow-up messages now include a private contact response link when `PUBLIC_BASE_URL` is configured. The page is served by the backend at `/agent/respond`; no separate frontend deployment or contact account is required. The contact can choose “I'm coming”, “Cannot help”, or confirm arrival after choosing to come. Optional GPS sharing starts only after a separate button press. The owner sees sounded status and fresh-distance updates, and the agent reads the structured responses without relying on Gemini to record them. Contacts who responded are excluded from further follow-up SMS proposals.

Links use random 256-bit bearer tokens in the URL fragment; only SHA-256 hashes are stored. Possession of the link authorizes acting as that one contact for that SOS, so recipients must not forward it. Opening or previewing a link does not confirm help. Links stop working when the session closes/expires or the contact is disabled, removed, or its number changes. Up to four issued links per contact remain valid to support follow-up messages. No token is included in owner-facing session responses.

The backend serves the page, scripts and API from one origin, with no analytics or external assets. GPS updates stop on leaving the page; the last shared point becomes stale. “Stop sharing” also clears the stored point while connected. Arrival never resolves the SOS.

For a local demo, expose the backend port through an HTTPS tunnel, set that tunnel origin as `PUBLIC_BASE_URL`, and restart the backend and worker. Keep the tunnel running. Use a new SOS: an already-delivered SMS cannot acquire a new link. Changing a tunnel URL makes previously sent links unreachable. Do not use the frontend's localhost URL as the public backend origin. SMS delivery still depends on the existing provider/account setup.

Source: https://help.twilio.com/hc/en-us/articles/223134167-Limitations-sending-SMS-messages-to-Indian-mobile-devices

## Callback setup for supported incoming messages and delivery receipts

1. Expose the backend through a public HTTPS origin (deployment or development tunnel). Twilio cannot reach localhost on your computer.
2. Set `PUBLIC_BASE_URL` in `backend/.env` to that origin only, without a path. Restart the backend and agent worker after changing configuration.
3. For a supported inbound SMS number, configure its Twilio incoming message webhook as HTTP POST to `<PUBLIC_BASE_URL>/agent/webhooks/incoming`. Check Messaging Service routing if the number belongs to one.
4. Keep signature validation enabled. Twilio account credentials and the exact public URL must match the signed request. Do not paste auth tokens into logs or chats.
5. Incoming messages must contain the session's 12-character reference, come from its currently active trusted contact, and arrive before the session closes/expires. `ACK <reference>` records acknowledgment. Other referenced replies are displayed as text; acknowledgment never resolves the SOS or proves arrival.
6. Newly sent messages include a delivery status callback when the public origin is configured. Configuring it now does not attach callbacks to old outbound messages.

The authenticated `/agent/diagnostics` endpoint reports local callback and response-link configuration, not verified reachability or carrier support. The dashboard shows this distinction and a dedicated Contact replies section. Secure response links do not require an inbound Twilio SMS webhook: the contact's browser posts directly to the backend. A webhook remains necessary for provider delivery receipts and any supported inbound SMS channel.

Source: https://www.twilio.com/docs/messaging/guides/webhook-request

Gemini 429 errors still require available provider quota. The existing worker retains exponential cooldown and keeps rescue coordination independent; it does not bypass provider limits.
