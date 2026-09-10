# Data Extension: ChatInbound

Create this before activating the Text Response message.
The Text Response writes into it with `InsertData()`, and the app reads it with `GET /data/v1/customobjectdata/key/ChatInbound/rowset`.

External key must be `ChatInbound`, or update `SFMC_INBOUND_DE_KEY`.

| Field | Type | Length | Primary key | Nullable | Notes |
| --- | --- | --- | --- | --- | --- |
| `MessageId` | Text | 100 | Yes | No | `{mobileNumber}:{receivedAt}`. The app's dedupe key. |
| `MobileNumber` | Text | 20 | No | No | Digits only, including country code. |
| `SubscriberKey` | Text | 254 | No | Yes | From `_subscriberkey`. |
| `MessageBody` | Text | 500 | No | Yes | The raw inbound text. Blank is legitimate. |
| `Keyword` | Text | 50 | No | Yes | First token, useful for diagnosing routing. |
| `ShortCode` | Text | 20 | No | Yes | The code the message arrived on. |
| `ReceivedAt` | Date | | No | No | UTC. The poller's high-water mark, so it must be set on every row. |

Do not set a retention policy shorter than your reconciliation window, or the sweep will miss rows.

`MessageBody` is sized at 500 rather than 160 deliberately: concatenated SMS can exceed a single segment, and truncation here silently loses customer text.
