# Implementation Plan - SFMC Two-Way Mobile Chat

Read `docs/claude-context.md` first for the verified SFMC findings this plan rests on.

## Context

SFMC sends campaigns, not conversations.
This project builds an externally hosted app, iframed into SFMC, where an agent picks a contact, types free-form text, sends it as SMS, and sees the customer's reply land in a thread.

The MVP is SMS only, single short code, single tenant, aimed at a working prototype against a dev or sandbox account.
WhatsApp and LINE are deferred but the messaging layer is shaped so they attach as adapters rather than a rewrite.

`Project Intent.md` proposed a design that the documentation does not support.
The corrections are recorded in `docs/claude-context.md` and are load-bearing for everything below:
the dynamic body is not `%%=v(@typedMessage)=%%`, inbound SMS has no ENS event, and JWT SSO is legacy-only.

## Stack

TypeScript across the whole app.

- **Backend** - Node with Fastify. One language shared with the UI, first-class WebSocket support for pushing inbound messages to the agent's browser, and a straightforward story for the raw-body handling that HMAC signature verification needs.
- **Frontend** - React with Vite.
- **Store** - in-memory for the prototype, behind a `ConversationStore` interface so SQLite or Postgres is a new implementation rather than a rewrite of the callers.

Rationale over the alternatives: the inbound path is a webhook-plus-realtime-fanout problem, which is Node's strongest suit, and sharing message types between the receiver and the chat UI removes a whole class of drift.

## Architecture

```
SFMC iframe ──> /auth/login ──> OAuth authorization_code ──> /auth/callback
                                                                  │
Agent browser <──── WebSocket ──── Fastify ────> SFMC REST (send SMS)
                                      ▲
                    ┌─────────────────┴─────────────────┐
                    │                                   │
          /inbound/ampscript                    DE poller (fallback)
          (HttpPost2, if it works)              GET /data/v1/customobjectdata
```

Inbound is deliberately **two paths into one funnel**.
Both normalise into the same `InboundMessage` and both pass through the same idempotent ingest, so whichever path fires the message appears once.
The poller is the floor that always works; the webhook is the upgrade we test for.

### Modules

| Path | Responsibility |
| --- | --- |
| `server/src/auth/` | OAuth authorization_code flow, token store, refresh-ahead-of-expiry |
| `server/src/sfmc/` | REST client: send SMS, subscription check, DE read |
| `server/src/inbound/` | Webhook receiver, DE poller, normalisation, dedupe |
| `server/src/conversations/` | Thread store, message persistence, contact list |
| `server/src/realtime/` | WebSocket hub, per-agent fanout |
| `web/src/` | React chat UI |
| `sfmc-assets/` | AMPscript for the Text Response message, plus setup runbook |

## Sequence

### 1. Repo scaffolding
npm workspaces (`server`, `web`), TypeScript strict, ESLint, Vitest, `.env.example`, `.gitignore` that excludes `user-requirement.md` per the project's documentation rules.

### 2. Token and auth layer
`GET /auth/login` starts `/v2/authorize` with `state`; `/auth/callback` exchanges the code, captures `tssd`, stores tokens per user and business unit.
Request `offline` scope so the backend can act when no user is present, which the inbound path requires.
Refresh two minutes before `expires_in`.
Scopes: `sms_read sms_send sms_write data_extensions_read data_extensions_write list_and_subscribers_read offline`.

Set `x-frame-options` / CSP to permit framing by `exacttarget.com`, and set the login cookie SFMC requires.

### 3. SFMC client
- `sendSms(mobileNumber, text)` -> `POST /sms/v1/messageContact/{id}/send` with `Override: true` and request-level `messageText`. One call per message, because `messageText` is not per-subscriber.
- `getSubscriptionStatus(numbers)` -> `POST /sms/v1/contacts/subscriptions`, since MobileConnect only delivers to `Subscribed` numbers.
- `readDataExtension(key, since)` -> `GET /data/v1/customobjectdata/key/{key}/rowset`.
- 429 handling: honour `Retry-After`, exponential backoff.

### 4. Conversation store
Contacts, threads keyed by mobile number, messages with direction, status, provider id, timestamps.
Map the documented SMS status codes to a UI state, inferring final status from the highest numeric code.

### 5. Inbound ingest
One `ingest(message)` entry point, idempotent on a natural key, used by both the webhook and the poller.
Webhook route validates a shared secret, responds immediately, enqueues.
Poller runs on an interval against the inbound DE, tracking a high-water mark.

### 6. Realtime + UI
WebSocket hub broadcasts new messages to the agent's session.
React UI: contact list, thread view, composer, delivery status, opt-in state.

### 7. SFMC-side assets
AMPscript for the Text Response message that captures `Msg(0)`, writes via `InsertData()`, re-arms with `SetSmsConversationNextKeyword()`, and optionally posts to our webhook.
Written so the `HttpPost2()` call can be commented in or out for the experiment.
Plus a runbook for the manual SFMC setup that has no API: short code, keyword, conversation window, Installed Package.

### 8. The experiment
Before trusting the webhook path, run the sandbox test described in Verification.

## Risks

| Risk | Handling |
| --- | --- |
| `HttpPost2()` may not fire from a Text Response | The poller is the floor. The webhook is additive, never assumed. |
| Conversation window duration and default-keyword limits unverified | Read them in Setup during SFMC configuration and record actuals in the runbook. |
| The free-form routing chain is not published end to end | Test it in a sandbox before building UI on top of it. |
| A slow webhook could delay the customer's SMS reply, since Text Response renders synchronously | Aggressive timeout, never raise on error. |
| No SFMC sandbox is currently authorized in this environment | Build against a mock SFMC layer, keep the seam clean, swap in real credentials when available. |

## Verification

**Local, no SFMC needed.** Mock mode boots server and UI, injects a synthetic inbound message, and asserts it reaches the browser over WebSocket. Unit tests cover token refresh, dedupe, status-code mapping and signature verification.

**The `HttpPost2()` experiment.** Create a Text Response message whose body is an `HttpPost2()` to a request bin plus a static reply. Text the keyword. Record whether the bin receives the POST, whether the SMS still goes out, and the latency. This decides the transport and is worth more than further doc reading.

**End to end in a sandbox.** Configure short code, keyword and conversation window. From the UI, send to a real handset. Reply with free-form text that starts with no keyword. Confirm it routes to the Text Response, lands in the DE, and appears in the thread. Then reply again to confirm the conversation re-arms for a second turn.

## Out of scope for the MVP

WhatsApp and LINE channels, multi-tenant credential handling, AppExchange packaging and security review, agent presence and assignment, message search and history export.
