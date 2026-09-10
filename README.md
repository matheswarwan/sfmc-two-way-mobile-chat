# SFMC Two-Way Mobile Chat

A two-way conversation console for Salesforce Marketing Cloud messaging channels.
An agent picks a contact, types free-form text, sends it as SMS, and sees the customer's reply arrive in a thread.

SMS via MobileConnect is the MVP channel. WhatsApp and LINE attach later as channel adapters.

## Start here

- `docs/claude-context.md` - the verified SFMC findings everything rests on. Read this before changing the messaging layer.
- `plan.md` - implementation plan and sequence.
- `sfmc-assets/SETUP.md` - the SFMC configuration runbook, most of which is manual.

## Running it

The app boots in mock mode and needs no SFMC tenant.

```bash
npm install
npm run dev          # server on :3000, UI on :5173
```

Open http://localhost:5173, type a mobile number in the sidebar, and send a message.
To see an inbound reply arrive over the WebSocket:

```bash
curl -X POST localhost:3000/dev/simulate-inbound \
  -H 'Content-Type: application/json' \
  -d '{"mobileNumber":"13175551212","body":"my order never arrived"}'
```

Tests:

```bash
npm test
```

## Connecting a real tenant

Copy `.env.example` to `.env` and fill it in. The file is gitignored; real values never enter the repo.
`.env` is read automatically at boot from the repository root.

Credentials normally arrive before the Outbound message and Data Extension exist, so live mode boots
in a partial state rather than failing obscurely: it says at startup what is missing, disables sending
until a short or long code is set, and disables polling until `SFMC_INBOUND_DE_KEY` is set.

Check credentials without sending anything:

```bash
npm run check:sfmc
```

That authenticates, prints the granted scopes, flags any required scope the Installed Package is
missing, and lists what still needs configuring. It never sends a message.

Then set `SFMC_MODE=live`, start the app, and open the **Setup** tab (`/#setup`).

The setup screen checks each artefact against your tenant and creates what it can:

| Artefact | Created by the app? |
| --- | --- |
| Installed Package + API Integration | No. Credential bootstrap, must be manual. |
| Short or long code | No. Procured through your Account Executive, takes weeks. |
| Inbound Data Extension | **Yes**, via SOAP. |
| Keyword | **Yes**, via `POST /sms/v1/keyword`. |
| Transactional send definition | **Yes**, via `POST /messaging/v1/sms/definitions`. |
| MobileConnect Text Response message | No. SFMC exposes no create API; the screen generates the AMPscript to paste. |
| Conversation window | No. Setup UI only. Default 60 minutes, range 10 minutes to 7 days. |

The screen also has a **Verify inbound** action that replays a message with `queueMO` and waits for
it to reach the app, which tests the manual Text Response step without needing a handset.

**Live mode sends real SMS and costs real money.** Note that sends use `Subscribe: true` and
`Resubscribe: true`, which re-subscribes a number that previously replied STOP. That suits a support
conversation but is a compliance decision worth making deliberately.

## Adding someone to the chat

An agent starts a conversation from the **Add to chat** panel on the Chat tab.
Two ways in: type a mobile number, or search All Subscribers by email or number and pick a result.
Search only returns records that have a phone number, because those are the only ones that can be texted.

Adding is not just opening a thread.
MobileConnect delivers only to numbers holding a `Subscribed` status on the code, so the app opts the number in first, then waits for SFMC to confirm before reporting success.

The opt-in has no dedicated API. What MobileConnect offers is `POST /sms/v1/queueMO`, which injects an inbound message as though the handset had sent it, and an inbound message whose first token is a registered keyword is exactly what creates a subscription.
So the app queues an MO whose text is the keyword itself (`CHAT` by default).
That has a useful side effect: the Text Response bound to the keyword runs, which arms the conversation window and lets the customer's next message be free-form prose rather than a keyword.

The Text Response also writes that opt-in message to the inbound Data Extension like any other reply.
The app drops it from the conversation view with a one-shot, time-boxed filter, so the agent does not see the customer apparently texting `CHAT` before the conversation began.
The row itself stays in the Data Extension, which remains the complete audit log.

### Several codes

An account can own more than one short or long code.
A subscription, a keyword and a send definition are each scoped to one code, so a conversation belongs to one code and cannot be answered from another.

Set them with `SFMC_SHORT_CODES`, a comma-separated list of `code:countryCode` entries:

```
SFMC_SHORT_CODES=86288:US,447700900123
```

Omit the country code for a long code, which carries its country in the number.
`SFMC_SHORT_CODE` plus `SFMC_COUNTRY_CODE` still works for a single code and needs no change.

The first entry is the default and keeps `SFMC_DEFINITION_KEY` as its send definition key; each further code gets `<key>-<code>`.
The setup screen then shows one send definition step per code.
When more than one code is configured the Add panel shows a picker; with one code it just shows which code is in use.

## How inbound works, and why it looks odd

Salesforce publishes **no webhook for inbound SMS**.
Event Notification Service covers outbound SMS lifecycle only, and its mobile-originated events exist solely for WhatsApp.
Journey Builder has no SMS-reply entry source.

So inbound runs on two paths that converge:

1. **Data Extension poller** - a MobileConnect Text Response message captures the reply with `Msg(0)` and writes it via `InsertData()`. The app polls that Data Extension. Fully documented, always works, latency equals the poll interval.
2. **AMPscript webhook** - the same Text Response optionally `HttpPost2()`s straight to the app. Sub-second, but Salesforce documents neither support nor prohibition for HTTP functions inside a MobileConnect message. It is off by default until the experiment in `sfmc-assets/SETUP.md` confirms it.

Both normalise to the same `InboundMessage` and pass through the same idempotent ingest, so whichever fires, the message appears exactly once.

## Layout

```
server/          Fastify API, SFMC client, inbound ingest, WebSocket hub
web/             React chat UI
sfmc-assets/     AMPscript, Data Extension spec, setup runbook
docs/            Project context and work in progress
```

## Known gaps

- Auth is server-to-server, which suits the prototype but cannot ship on AppExchange. The `TokenProvider` interface is the seam for the authorization code flow.
- Outbound uses Transactional Messaging rather than MobileConnect, so the send definition is provisioned by API instead of hand-built. One Salesforce overview page claims transactional content must pre-exist as a channel message, which contradicts the SMS reference and quick start; validate against your tenant.
- Conversation state is in memory. `ConversationStore` is the seam for a real database.
- The first inbound turn depends on the code's default keyword, because a conversation cannot be armed from an overridden outbound send.
