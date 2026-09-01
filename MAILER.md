# Mailer — usage guide

One mail transport for every service, with the provider chosen at runtime.
Replaces six near-identical `mailDriver` copies spread across three SendGrid SDK
generations.

The reason it exists: SendGrid is not a HIPAA Eligible Service and Twilio will
not sign a BAA for it, so this platform has to leave it. Making the provider a
runtime switch means the cutover and the rollback are the same operation.

## Quick start

```js
const { createMailer, CODES } = require('nueassist-utilities/mailer');
const logger = require('./lib/logger');

const mailer = createMailer({ service: 'notifications', logger });

try {
    const { provider, statusCode, messageId } = await mailer.send({
        to, from, subject, text, html,
    });
} catch (err) {
    // err.code is one of CODES. err.toContext() is safe to log or store.
    // err.message is safe to return in an HTTP response.
}
```

| Option | Default | Notes |
|---|---|---|
| `service` | `'unknown'` | Appears in log context |
| `logger` | *required* | From `./logger` or `./legacy-logger`; either call shape works |
| `provider` | `MAIL_PROVIDER`, then `'sendgrid'` | `'sendgrid'` \| `'ses'` |
| `sendgrid` | `{}` | `{ apiKey, client }` |
| `ses` | `{}` | `{ region, configurationSetName, client }` |
| `transport` | — | Pre-built transport; bypasses provider selection, for tests |

Switching provider is an environment change, not a deploy: set
`MAIL_PROVIDER=ses`. Rollback is setting it back.

## The one thing to understand

**Nothing about the message is ever logged.** Recipient, sender, subject and
body are PII or PHI — the body is rendered from the record that triggered the
notification — and application logs ship to Grafana Cloud Loki, a vendor
without a BAA. Only `provider`, `statusCode` and `messageId` leave this module.

That applies to provider errors too, and it is not theoretical: both SendGrid
and SES name the rejected address in their error message and response body, and
one caller was putting that text straight into an HTTP 400 response.

## Errors

Provider errors are classified and never propagated raw:

| Code | Meaning | Retryable |
|---|---|---|
| `UNVERIFIED_SENDER` | From address is not a verified identity | no |
| `INVALID_RECIPIENT` | Rejected, suppressed, or malformed recipient | no |
| `INVALID_MESSAGE` | Missing required field, size, encoding | no |
| `AUTH_FAILED` | Credentials or IAM role rejected | no |
| `RATE_LIMITED` | Over quota or send rate | yes |
| `PROVIDER_UNAVAILABLE` | Provider 5xx or transport failure | yes |
| `PROVIDER_ERROR` | Unrecognised | no |

`UNVERIFIED_SENDER` has its own code because it is the failure the SES
migration is most likely to hit. Sender addresses come from Mongo —
`agency.supportemail` and `notificationtemplate.supportMail` — SendGrid
tolerates unverified senders and SES does not. **Both providers map onto the
same code**, so a cutover can be judged against one failure taxonomy, and
per-agency failures can be counted without logging a single address.

`err.toContext()` returns `{ provider, errorCode, statusCode }` — safe for a log
line or a `notificationlog` row. `err.message` is a generic
`mail send failed: <CODE>` with no provider text, so it is safe to return to a
client.

## What this does not do

**It does not write `notificationlog`.** Consuming services write to different
collections through different drivers and attach service-specific fields. That
write stays in each service's thin driver.

**It does not implement sandbox mode.** "Sandbox" here means redirecting mail to
a test mailbox instead of the real recipient, which happens in the controllers
where the notification group and the original recipient are both in scope. It is
already provider-agnostic.

Three unrelated things share that name, which has caused confusion:

| Name | What it is | Status |
|---|---|---|
| Our sandbox mode | Redirect to a test mailbox | In use, provider-agnostic |
| SendGrid `mail_settings.sandbox_mode` | Validate, do not deliver | Not used live anywhere |
| AWS SES account sandbox | 200/day cap, recipients must be verified | Applies until production access |

The last one has a real consequence: while the account is in the SES sandbox,
**every recipient** must be a verified identity, so the test mailbox has to be
verified in SES or redirected mail will not deliver at all.

**No attachments, cc or bcc.** Nothing in this platform sends them — every
message is a single recipient with text and/or html. Supporting them means
`SendRawEmail` and a MIME builder, which is a different shape of work.

## Why SES runs on aws-sdk v2

`@aws-sdk/client-sesv2` requires Node >= 20. Several mail services still run
`node:11-alpine` and `node:14-alpine`. v2 runs on all of them, and web identity
support — which IRSA depends on entirely — has been present since v2.521.0.
Moving to v3 later changes only `createSesTransport`.

The SES transport passes **no credentials**. The SDK's default provider chain
resolves them, which is what lets an IRSA-annotated pod authenticate with no
static key at all.

Note that `aws-sdk` v2 has reached end-of-support: it is deprecated on npm and
receives no updates, security fixes included. That is a reason to bump the base
images, not a reason to break Node 11 services today.

## Compatibility

CommonJS, and no syntax newer than Node 11 — no optional chaining, no nullish
coalescing. This package declares `engines.node >= 20.19.0`, but consuming
services still run `node:11-alpine` and `node:14-alpine` and npm installs
through that warning. Until those base images move, code here has to run on
them.

Both SDKs are required lazily, so a service that only sends through SendGrid
never needs `aws-sdk` installed, and vice versa. Declare whichever you use as a
dependency of the service.

## Do not

- **Do not log the message, or any part of it.** Not the recipient, not the
  subject, not the body. Log `messageId`.
- **Do not catch a `MailError` and re-throw the provider's original.** The
  original is gone by design.
- **Do not add a field to the log context without checking it is allow-listed.**
  `provider` had to be registered explicitly; anything unregistered lands in
  `_dropped` and never reaches the line. There is a test that catches this.
- **Do not move `notificationlog` writes in here.** Six services, six shapes.
