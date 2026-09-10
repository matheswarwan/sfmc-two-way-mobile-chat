# Claude Context - SFMC Two-Way Mobile Chat

This is the entry point for understanding the project.
Read this first.

## What we are building

An externally hosted application for Salesforce Marketing Cloud Engagement, intended for eventual AppExchange distribution, that turns SFMC's outbound messaging channels into a two-way conversation surface for a human agent.

An agent picks a contact, types a free-form message, sends it, and sees the customer's reply arrive in a threaded conversation view.

SFMC is built for one-way, campaign-shaped sending.
MobileConnect, WhatsApp and LINE can each deliver a message and each capture an inbound reply, but there is no native console that stitches those two halves into a conversation.
That gap is the product.

## Current status

A working prototype, exercised end to end in mock mode only.
Nothing has been run against a real SFMC tenant yet, so the integration is unproven even though the app's own logic is covered by tests.

Built so far: outbound send, both inbound paths, the conversation store and realtime hub, a setup screen that provisions what SFMC allows, agent-initiated conversations with opt-in, and subscriber search.
See `docs/claude-wip.md` for the detail and the current work item.

Documentation research against official Salesforce sources is complete for outbound, inbound, opt-in, subscriber lookup, auth and packaging.
The main remaining unknown is empirical, not documentary: whether AMPscript HTTP callouts fire from a MobileConnect Text Response. That is settled by a sandbox test, not more reading.

## Decisions taken

| Decision | Choice |
| --- | --- |
| UI surface | Inside SFMC, as a Marketing Cloud App component in an Installed Package |
| MVP scope | SMS only, via MobileConnect, single tenant. Several short codes are supported; a conversation belongs to one of them. |
| Goal of this phase | Working prototype against a dev/sandbox SFMC account |
| Multi-tenancy, packaging, security review | Deferred, but architecture should not preclude them |

## Verified findings that contradict the original Project Intent

`Project Intent.md` was written before this research.
Four of its premises do not survive contact with the official documentation.
These are the most important facts in this repository, so they are recorded with citations.

### 1. `%%=v(@typedMessage)=%%` is not a supported mechanism

The intent document proposed creating one MobileConnect Outbound message whose body is only `%%=v(@typedMessage)=%%`, with the real text supplied per send.

Salesforce documents `Subscribers[].Attributes` as populating **standard replacement strings**, not AMPscript variables.
The reference states the attribute "must match the attribute string in the message" and that "the dictionary key is available as a standard replacement string in AMPScript".
Every official example uses the `%%FirstName%%` form.

`@typedMessage` would have to be `SET` inside the message's own AMPscript, which the API never does.

**Use instead:** `Override: true` with a request-level `messageText`, or the Transactional Messaging API's `content.message` override.
Note that `messageText` is request-level, not per-subscriber, so one API call carries one message body.

Source: https://developer.salesforce.com/docs/marketing/marketing-cloud/references/mc_rest_sms/postMessageContactSend.html

### 2. Event Notification Service does not deliver inbound SMS

The intent document proposed using ENS to surface customer replies.
ENS has exactly seven documented event categories.
Its Transactional SMS category contains five types, all outbound lifecycle: `SmsSent`, `SmsNotSent`, `SmsTransient`, `SmsDelivered`, `SmsBounced`.

There is no `SmsMobileOriginated` analogue to the WhatsApp inbound event, and Journey Builder has no SMS-inbound entry source.

Sources:
https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/ens-supported-events.html
https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/transactional_sms_events.html

### 3. WhatsApp and LINE are different products, not one "OTT" channel

WhatsApp uses the Transactional Messaging OTT API at `/messaging/v1/ott/`.
Inbound arrives as the ENS event `EngagementEvents.OttMobileOriginated`.
Every OTT event page states `senderType` has one supported value, `WhatsApp`.

LINE and Facebook Messenger use the **GroupConnect Chat Messaging API** at `/ott/v1/` (`POST /ott/v1/registration`, `POST /ott/v1/send`).
No documented ENS inbound event covers LINE.

A single inbound webhook covering both WhatsApp and LINE does not exist.

Sources:
https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/engagement_ott_events_mobile_originated.html
https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/gc-chat-messaging-api.html

### 4. JWT SSO is legacy-only, and server-to-server auth cannot ship on AppExchange

The ability to create legacy packages was deprecated in August 2019, and all new packages are enhanced packages.
An enhanced package's Marketing Cloud App component receives **no posted JWT**; SFMC simply iframes the Login URL.
The app must immediately run the OAuth 2.0 authorization code flow and call `v2/userinfo` to establish identity.

Separately: "AppExchange partners can't upload a package with a server-to-server integration to AppExchange."

Consequence for a chat product: when an inbound event arrives there is no user present, so the backend must operate on stored per-user, per-business-unit refresh tokens obtained with the `offline` scope. Default refresh token lifetime is 30 days.

Sources:
https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/create-a-mc-app.html
https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/integration-s2s-client-credentials.html
https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/integration-considerations.html

## Key reference material

### Outbound SMS

MobileConnect send, one call per distinct body:

```
POST /sms/v1/messageContact/{encodedMessageId}/send
{
  "mobileNumbers": ["13175551212"],
  "Subscribe": true,
  "Resubscribe": true,
  "keyword": "JOINSMS",
  "Override": true,
  "messageText": "your arbitrary text"
}
```
Returns `202 Accepted` with a `tokenId`.

Constraints: `mobileNumbers` and `Subscribers` are mutually exclusive; a `Subscribers` entry requires both `MobileNumber` and `SubscriberKey`; max 250 subscriber records; `keyword` is required when `Subscribe` or `Resubscribe` is true; numbers must be numeric strings with country code and no separators.

Transactional Messaging SMS is the documented higher-capacity alternative and emits ENS delivery events:

```
POST /messaging/v1/sms/messages/{messageKey}
{
  "definitionKey": "chat-outbound",
  "recipient": { "to": "15555551234", "contactKey": "Astro25",
                 "attributes": { "FirstName": "Astro" } },
  "subscriptions": { "resubscribe": true }
}
```

Delivery is a hard prerequisite of subscription: "MobileConnect only delivers outbound SMS messages to mobile numbers that maintain a `Subscribed` status for the specified short code."

### Opting a number in

MobileConnect exposes no "subscribe this number" API.
The documented mechanism is `POST /sms/v1/queueMO`, which queues a mobile-originated message as though the handset had sent it; an inbound message whose first token is a registered keyword is what creates the subscription.

```
POST /sms/v1/queueMO
{
  "mobileNumbers": ["15555551212"],
  "shortCode": "86288",
  "messageText": "CHAT"
}
```

Returns `202 Accepted` with `results[].identifier`.

Constraints: `mobileNumbers` and `subscribers` are mutually exclusive, and sending both makes the API use `subscribers` and ignore `mobileNumbers`; at most 250 entries; numbers must be 8 to 15 digits including the country code, no separators.
There is no `keyword` or `countryCode` parameter on this route - the keyword travels as the message text.

Source: https://developer.salesforce.com/docs/marketing/marketing-cloud/references/mc_rest_sms/postQueueMO.html

Confirming it landed uses the subscription lookup, whose request key is `mobileNumber` holding an **array**, not `mobileNumbers`:

```
POST /sms/v1/contacts/subscriptions
{ "mobileNumber": ["15555555555"] }
```

The response is `{ count, createDate, completeDate, contacts: [...] }`, where each contact carries `mobileNumber`, `shortCode`, `keyword` and `optInDate`.
There is no status field, so `optInDate` is the evidence of a subscription.
The route also accepts `subscriberKey` as an array of up to 500 keys, which is what makes a bulk lookup of found subscribers a single call.

Source: https://developer.salesforce.com/docs/marketing/marketing-cloud/references/mc_rest_sms/contactsSubscriptions.html

### Finding an existing subscriber

There is no REST route that searches All Subscribers by a partial email or phone number.
The Contacts API offers exact-match lookup only (`POST /contacts/v1/addresses/email/search` takes whole email addresses), and `POST /contacts/v1/addresses/search/{attributeName}` filters on ContactKey, LastModifiedDate, Source, Channel, Status or AudienceID, never on the address value.

So search composes two documented reads:

1. SOAP `Retrieve` on `Subscriber` with a `like` filter over `EmailAddress` and `SubscriberKey`. This is the All Subscribers list itself and the only read that supports a partial match.
2. `POST /sms/v1/contacts/subscriptions` keyed by the subscriber keys step one returned. This supplies the mobile numbers, and a subscriber with no MobileConnect record simply produces no entry, which is the "has a phone number" filter.

The mobile number is not a property of the SOAP `Subscriber` object, which is why step two is needed rather than being an optimisation.

### Which code a message leaves on

The transactional message send documents only `definitionKey`, `recipient` and `content.message`; there is no way to name a code on the send.
The code is fixed by the send definition, whose `subscriptions.shortCode` and `subscriptions.keyword` are set at creation.

Consequently an account with several codes needs one keyword and one send definition per code, and a conversation belongs to exactly one code.

Sources:
https://developer.salesforce.com/docs/marketing/marketing-cloud/references/mc_rest_transactional_messaging_sms/sendSMSMessageSingleRecipient.html
https://developer.salesforce.com/docs/marketing/marketing-cloud/references/mc_rest_transactional_messaging_sms/createSMSSendDefinition.html

### Inbound SMS - resolved

There is no webhook for inbound SMS. Ranked options, with documentation status:

| # | Option | Latency | Status |
| --- | --- | --- | --- |
| 1 | AMPscript `HttpPost2()` inside a Text Response body, posting to our webhook | Sub-second, true push | **Undocumented.** Neither supported nor prohibited in writing. Must be lab-tested. |
| 2 | `InsertData()` inside a Text Response body writes the reply to a Data Extension; app reads the DE | Write synchronous, read = poll interval | **Documented.** The safe default. |
| 3 | SOAP `Perform` on a QueryDefinition over `_SMSMessageTracking`, triggered on demand | Seconds to minutes, self-clocked | **Documented.** Data view freshness is not documented. |
| 4 | Scheduled Automation Studio SQL Query Activity | Bounded by schedule | Mechanism documented, granularity unverified. |
| 5 | `GET /sms/v1/messageContact/{id}/history/{tokenId}/mobileNumber/{n}` | n/a | **Not viable.** Needs a prior send token, one number per call, MO rows undocumented. |
| 6 | ENS webhook for inbound SMS | n/a | **Does not exist.** |
| 7 | Journey Builder SMS-reply entry source | n/a | **Does not exist.** |

Our approach: build on option 2 as the guaranteed floor, test option 1 in a sandbox early, and use option 3 as a reconciliation sweep.
If `HttpPost2()` works from a Text Response, it becomes the transport and the Data Extension becomes the durable audit log.

Why `InsertData()` is trustworthy: the mobile functions guide states "In addition to these mobile-specific functions, you can also use the `InsertData()` and `DeleteData()` functions in MobileConnect messages."
That is the only place Salesforce enumerates which non-mobile AMPscript functions work in MobileConnect, and HTTP functions are not on that list.

#### Routing a free-form reply

MobileConnect splits an inbound message on its first token and treats that as the keyword.
A chat customer types arbitrary text, so two documented catchers matter, and a chat product needs both:

- **Conversation window.** Per keyword, per contact, time-boxed. Salesforce Help opens both conversation-window articles with "Use conversation windows to respond to inbound messages that don't have keywords assigned to them." Configured in Setup, MobileConnect, select the Short/Long Code, then the Conversation Window value in the Keyword Management grid. It is an admin setting, not an API field. Configurable windows shipped in the January 2021 release. The default duration and allowed range remain unverified.
- **Default keyword.** Per code, always armed, no session required. `IsDefaultKeyword` on the SOAP MO keyword objects "specifies if account defaults to this SMS keyword action if no other options are available." The widely repeated "one default per code" limit traces to a third-party site, not Salesforce, and is unverified.

`SetSmsConversationNextKeyword()` is the runtime steering wheel: it "doesn't set the keyword immediately, but rather when the contact sends the next message."
`NextMOKeyword` on `SendSMSMOKeyword` is its declarative, API-manageable twin.

The chain we intend to rely on - arm a conversation, customer types anything, MobileConnect routes it to that keyword's Text Response, `Msg(0)` yields the raw text, `InsertData()` persists it, re-arm for the next turn - has every link individually documented but is **never published end to end by Salesforce**.
Validate it in a sandbox before trusting it.

#### AMPscript placement rule

No Salesforce doc states that a per-send override string is evaluated as executable AMPscript.
The documented ceiling is substitution strings on the Transactional path, where `content.message` says "Use substitution strings to personalize the content."
MobileConnect's `messageText` is silent on the subject.

Therefore: **executable AMPscript lives in the saved message or definition body; the API passes values only.**
Do not embed `CreateSmsConversation()` or `HttpPost2()` in an API-supplied override.

`_SMSMOLog` does not exist as a documented data view.
`_MobileLineOrphanContactView` is a GroupConnect view, not MobileConnect.
There is no REST route for reading data views; the REST reference set contains no data-view resource.

### ENS mechanics, for the WhatsApp phase

Register a callback, respond 200 to the verification POST within 30 seconds, then confirm via `POST /platform/v1/ens-verify` within 4 hours.
`signatureKey` is returned **only** at callback creation; store it.
Notifications are signed HMAC-SHA256 in the `x-sfmc-ens-signature` header.

Runtime budget is 3 seconds per batch, so acknowledge and enqueue, never process inline.
Delivery is at-least-once with no documented ordering guarantee, so dedupe on `messageId` and sort by timestamp.
Batches are up to `maxBatchSize` (100-1000, default 1000), 200 subscriptions per callback.

WhatsApp MO payload quirks: no thread identifier, so synthesize a conversation key from `channelId` + `mobileNumber`; `contactId` is inconsistent with the `contactKey` used on every other OTT event; timestamps appear as seconds in some samples and milliseconds in others; the payload is an array in most samples and a bare object in others.

The 24-hour customer service window is the central constraint for WhatsApp: each inbound message resets a per-number timer that decides whether the next outbound may be a free-form session message or must be a pre-approved template.

### Scopes

Verified strings: `sms_read`, `sms_send`, `sms_write`, `tracking_events_read`, `data_extensions_read`, `data_extensions_write`, `list_and_subscribers_read`, `list_and_subscribers_write`, `offline`, and the eight `event_notification_callback_*` / `event_notification_subscription_*` scopes.

The Contacts API is gated by `list_and_subscribers_*`; there is no `contacts_read` scope.
OTT scope strings are **not published** - derive them empirically by requesting a token with no `scope` parameter and reading back what the response grants.

## Documentation caveats

`developer.salesforce.com` blocks plain fetching but serves raw Markdown at the same path with a `.md` suffix.
`help.salesforce.com` article bodies could not be retrieved during research; several numeric limits (SMS character counts, API call caps) live only there and remain unverified.
No numeric SFMC API rate limits are published on developer.salesforce.com. Commonly circulated figures come from community blogs and should not be treated as authoritative.

## Related documents

- `plan.md` - implementation plan and sequence
- `docs/claude-wip.md` - current and next work item
- `Project Intent.md` - original intent, superseded in the four respects above
