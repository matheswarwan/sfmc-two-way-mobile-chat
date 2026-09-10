# SFMC Setup Runbook

Most of this is now driven from the app's **Setup** screen (`/#setup`), which checks each artefact
against your tenant and creates the ones that have a create API.

This document explains the same steps for reference, and covers what the screen cannot do.

## What can and cannot be automated

| Artefact | Created by the app? | Why |
| --- | --- | --- |
| Installed Package + API Integration | No | No API exists. It is what issues the credentials, so it is the bootstrap. |
| Short or long code | No | Procured through your Salesforce Account Executive. Carrier approval takes weeks. |
| Inbound Data Extension | **Yes** | SOAP `Create` on `DataExtension`. |
| Keyword | **Yes** | `POST /sms/v1/keyword`. |
| Transactional send definition | **Yes** | `POST /messaging/v1/sms/definitions`. |
| MobileConnect Text Response message | No | No API creates a MobileConnect message, and the MO keyword SOAP objects are Retrieve-only. |
| Conversation window | No | Setup UI only. |

The inbound half is where automation stops. Everything that decides *what happens when a customer
texts you* lives behind the MobileConnect UI and Salesforce exposes it read-only.

## 1. Installed Package (manual, do first)

Setup, then Apps, then Installed Packages, then New.
Add Component, then API Integration, then Server-to-Server.

Scopes: `sms_read`, `sms_send`, `sms_write`, `data_extensions_read`, `data_extensions_write`,
`list_and_subscribers_read`.

Two irreversible things worth knowing: the client secret is shown **once** and cannot be recovered,
and an API Integration component **can never be removed** from a package once added.

Changes take up to 5 minutes to propagate.

**Outputs:** `SFMC_CLIENT_ID`, `SFMC_CLIENT_SECRET`, `SFMC_SUBDOMAIN`, optionally `SFMC_ACCOUNT_ID`.

For anything distributed, choose **Web App** rather than Server-to-Server: Salesforce states that
"AppExchange partners can't upload a package with a server-to-server integration to AppExchange."

## 2. Short or long code (manual, start early)

Contact your Salesforce Account Executive. This is paperwork and carrier approval, not self-service,
and it takes weeks. Begin before anything else.

**Outputs:** `SFMC_SHORT_CODE`, `SFMC_COUNTRY_CODE`.

## 3. Verify credentials

```bash
npm run check:sfmc
```

Authenticates, prints granted scopes, flags any required scope the package is missing, and reads the
Data Extension. Never sends a message.

## 4. Provision from the Setup screen

Start the app, open `/#setup`, and use **Create for me** on:

- the inbound Data Extension (schema in `inbound-data-extension.md`)
- the keyword
- the transactional send definition

All three are idempotent, so the buttons are safe to press again.

## 5. Text Response message (manual)

MobileConnect, Messages, Create Message, Text Response template.
Select your code and the keyword the app created.
Paste the AMPscript the Setup screen generates, which already has your Data Extension key and keyword
substituted. Activate it.

For a chat product you usually do not want a canned auto-reply on every turn, so keep the rendered
output empty or minimal and let the agent's reply be the response.

## 6. Conversation window (manual)

Setup, search MobileConnect, select your code, then the Conversation Window value in the Keyword
Management grid.

Range is **10 minutes to 7 days, default 60 minutes**. The default is usually too short for a support
conversation: when the window closes, a customer's plain-prose reply no longer routes to your Text
Response.

This is the mechanism that makes free-form chat work at all. Salesforce describes conversation
windows as existing "to respond to inbound messages that don't have keywords assigned to them".

## 7. Verify inbound

On the Setup screen, use **Run verification**. It replays an inbound message with `queueMO` and waits
for it to reach the app, testing the manual Text Response step without needing a handset.

## 8. The HttpPost2 experiment (optional)

Inbound currently arrives by polling the Data Extension, which always works. A real-time push is
possible if AMPscript HTTP functions run inside a MobileConnect message, which Salesforce documents
neither way.

To test: generate the AMPscript with a webhook URL, point it at a request bin, copy your Text
Response message, and text the keyword. Record whether the bin received the POST, whether the SMS
reply still arrived, and how long it took. If all three are good, point it at `/inbound/ampscript`.
If not, delete the copy and nothing is lost.
