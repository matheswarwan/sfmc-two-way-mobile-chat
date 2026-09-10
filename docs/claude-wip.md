# Work In Progress

## Done

MVP skeleton, a setup screen, and agent-initiated conversations. Verified in mock mode.

### Adding a contact to the chat

- **Add to chat** panel on the Chat tab: type a number, or search All Subscribers by email or
  number and pick a result. Search returns only records that have a phone number.
- Adding opts the number in first, using `POST /sms/v1/queueMO` with the keyword as the message
  text. There is no opt-in API; an inbound message whose first token is a registered keyword is
  what creates the subscription. It also arms the conversation window as a side effect.
- The server waits up to 12 seconds for `POST /sms/v1/contacts/subscriptions` to confirm, and says
  plainly when it could not, rather than opening a thread that will fail on first send.
- The opt-in echo is dropped from the conversation view by a one-shot, time-boxed filter in
  `InboundIngest`. The row stays in the Data Extension.
- Subscriber search composes two documented reads: SOAP `Retrieve` on `Subscriber`, which is the
  only partial-match read available, then `POST /sms/v1/contacts/subscriptions` keyed by the
  subscriber keys it returned, which supplies the mobile numbers in one call.

### Several codes

- `SFMC_SHORT_CODES` takes a comma-separated list of `code:countryCode`. `SFMC_SHORT_CODE` plus
  `SFMC_COUNTRY_CODE` still works unchanged for a single code.
- A conversation belongs to one code. Sends pick the send definition bound to that code, because
  the documented message-send body has no way to name a code.
- One send definition per code: the first keeps `SFMC_DEFINITION_KEY`, the rest get `<key>-<code>`.
  The setup screen shows one step per code, and the provision route reads the code from the step id.

### Two request shapes corrected against the reference

- `POST /sms/v1/contacts/subscriptions` takes `mobileNumber` holding an array, not `mobileNumbers`,
  and answers with a `contacts` array of one entry per number-and-code pair carrying `optInDate`.
  The previous code sent and parsed neither correctly.
- The transactional message send documents only `definitionKey`, `recipient` and `content.message`.
  There is no `subscriptions.shortCode` on the send, which is why the code lives on the definition.

### Earlier

- Workspaces, TypeScript strict, ESLint, Vitest. 34 tests passing.
- Conversation store, idempotent inbound ingest, DE poller, WebSocket hub, React chat UI.
- **Outbound switched from MobileConnect to Transactional Messaging.** The send definition is created
  by API, so the hand-built Outbound message and `SFMC_OUTBOUND_MESSAGE_ID` are gone.
- **Setup screen** at `/#setup`: live per-artefact status checked against the tenant, one-click
  provisioning for the Data Extension, keyword and send definition, generated AMPscript with the
  tenant's values substituted, and an inbound verification that replays a message with `queueMO`.
- `.env` is now actually loaded, which it was not before.
- Poller distinguishes setup failures (404/403 suspend with an actionable message) from transient
  ones (retry, then go quiet).
- `npm run check:sfmc` preflight: authenticates, reports scopes, reads the Data Extension.

## Next

1. **Validate the Transactional Messaging switch against a real tenant.** One Salesforce overview
   page claims transactional content must pre-exist as a channel message, contradicting the SMS
   reference and quick start. This is the first thing to confirm.
2. Run the `HttpPost2()` experiment to settle push versus poll for inbound.
3. Authorization code flow behind the `TokenProvider` interface, required for AppExchange.
4. Durable store behind `ConversationStore`.
5. Delivery status from ENS `SmsSent`/`SmsDelivered`/`SmsBounced`, now available because outbound is
   transactional.

## Blocked

Nothing has been exercised against real SFMC. Mock mode proves the app's logic, not the integration.

## Notes

Conversation window: range 10 minutes to 7 days, default 60 minutes. The default is likely too short
for support conversations and should be raised during setup.

The poller advances its high-water mark to the newest `ReceivedAt` it saw and reads with a strict
`>`, so two rows written in the same millisecond can lose the second one. Pre-existing, and not hit
in practice at SMS volumes, but the fix is to keep the mark one interval behind and lean on the
dedupe key. Worth doing when the store becomes durable.

Subscriber search has not been run against a real tenant. Two things to confirm there: that SOAP
`Retrieve` on `Subscriber` accepts the `like` operator on `EmailAddress` and `SubscriberKey` in this
account, and that `POST /sms/v1/contacts/subscriptions` echoes `subscriberKey` back when queried by
key. The client reads that field defensively, so a tenant that omits it degrades to matching by
number rather than failing.
