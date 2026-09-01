# Logging — usage guide

Shared PHI-safe logger for all NueAssist services. Implements
`NueAssist-Microservices/docs/standards/logging.md`, which is the authority — this file is
how to use the module, not a restatement of the rules.

**Zero dependencies.** No Winston. Do not add one.

**Runtime:** Node.js 20.19 or newer. Older Node releases are unsupported and
must be upgraded before consuming this package.

---

## Quick start

```js
// CommonJS (auth-service, HL7, BulkActions, …)
const { createLogger } = require('nueassist-utilities/logger');
const { createRequestLogger } = require('nueassist-utilities/request-logger');

const logger = createLogger({ service: 'evv-service' });

app.use(createRequestLogger(logger));   // replaces morgan
```

```js
// ESM / Babel services (Reports, clusterer, Exports, …)
import loggerPkg from 'nueassist-utilities/logger.js';
import requestLoggerPkg from 'nueassist-utilities/request-logger.js';

const logger = loggerPkg.createLogger({ service: 'reports' });
app.use(requestLoggerPkg.createRequestLogger(logger));
```

Then:

```js
logger.info('Visit check-in recorded', { visitId, durationMs: 42 });
logger.warn('Retrying MQ publish', { queue: 'evv.visits', attempt: 2 });
logger.error('Order validation failed', { orderId, ...logger.serializeError(err) });
```

---

## The one thing to understand

**Fields are dropped unless they are explicitly allowed.** This is enforced at runtime, not
by convention. If a field does not appear in your log line, that is the module working.

```js
logger.info('Visit saved', { entity: visitDoc, visitId: '64b6f2aa' });
```

```json
{"level":"info","message":"Visit saved","context":{"visitId":"64b6f2aa"},
 "_dropped":{"entity":"key-not-allow-listed"}}
```

`_dropped` is **a bug at your call site**, not a control that worked. It is alerted on in
Grafana. Fix the call; don't add the key to the allow-list to silence it unless the field
genuinely can never hold PHI.

### Why fields get dropped

| Reason | Meaning |
|---|---|
| `key-not-allow-listed` | Not in `SAFE_KEYS`, not registered via `allowKeys()` |
| `non-primitive` | An object or array — this is what stops entity/payload dumps |
| `id-value-not-identifier-shaped` | An `*Id` key holding something that isn't an ID (e.g. a name) |
| `path-contains-query-string` | `path`/`route` with a `?` — log the route template, not the URL |
| `not-an-object` | `logger.info('msg', someValue)` — context must be an object |

---

## Registering extra keys

```js
logger.allowKeys(['sourceSystem', 'interfaceVersion']);   // once, at startup
```

Registering a key asserts **it can never hold PHI, in any code path, now or later**. Register
`sourceSystem`; never `patientIdentifierValue`. Adding a key should be a visible line in a
PR that a reviewer can question.

---

## Errors

Use `serializeError`. It keeps `errorName`, `errorCode` and the **stack frames**, and
deliberately discards `err.message`.

That last part is not an oversight. Error messages are built by whoever threw them, usually
by interpolating the value that failed — a Mongo validation error carrying a patient name,
an HL7 parse error carrying a segment. And `err.stack` *begins with the message*, which is
why hand-rolled `{ stack: err.stack }` logging leaks: the frames are safe, the first line is
not. `serializeError` strips it.

```js
try { await saveVisit(doc); }
catch (err) {
  logger.error('Visit save failed', { visitId, ...logger.serializeError(err) });
}
```

Need more detail? Pass a curated `reason` you wrote yourself.

---

## Correlation IDs

`createRequestLogger` establishes one per request and propagates it via `AsyncLocalStorage`,
so every log line inside the request carries it with no plumbing. To propagate across a
service hop, forward the header:

```js
headers: { 'x-correlation-id': logger.getCorrelationId() }
```

For non-HTTP entry points (MQ consumers, cron jobs), wrap the work yourself:

```js
logger.runWithCorrelationId(msg.properties.correlationId || crypto.randomUUID(), async () => {
  await handleMessage(msg);
});
```

Inbound correlation IDs are validated as UUIDs and replaced if they aren't — an unvalidated
header would be caller-controlled text on every line, and it's promoted to Loki structured
metadata.

---

## Volume controls (these are also the budget)

Grafana Cloud includes 50 GB/month. Staying under it is the difference between $0–19/month
and a real bill, so these defaults matter.

| Control | Default | Env var |
|---|---|---|
| `debug` off in prod | on | `LOG_LEVEL` |
| Health/probe requests dropped | on | — |
| Successful requests sampled in prod | 10% | `LOG_ACCESS_SAMPLE_RATE` |
| Slow requests always logged | ≥1000ms | `LOG_ACCESS_SLOW_MS` |
| Identical lines collapsed | 5 per 10s | `LOG_THROTTLE_AFTER`, `LOG_THROTTLE_WINDOW_MS` |
| String values truncated | 200 chars | `LOG_MAX_STRING_LENGTH` |

**Sampling never touches what matters.** 4xx, 5xx, slow requests and client disconnects are
always logged in full. Only healthy 2xx/3xx — the lines that prove nothing was wrong — are
thinned. During an incident, set `LOG_ACCESS_SAMPLE_RATE=1` on the affected deployment; no
code change needed.

Use `logger.event()` for genuinely once-per-process lines (startup, shutdown, migration
complete) so the throttle doesn't collapse them. Don't use it in a request path.

---

## Do not

- `console.log` — bypasses every control here. CI blocks new ones (`scripts/check-logging.js`).
- `morgan('combined')` — logs the query string. This is the biggest single PHI leak in the stack.
- Winston file transports — pod-local files are ephemeral, unencrypted and unauditable.
- Interpolate values into `message` — that's the one path around the allow-list. `message` is
  a short static string; variable data goes in `context`. Common identifier patterns are
  redacted as a final backstop, and the logging check rejects interpolated logger calls, but
  neither mechanism can reliably identify a person's name in arbitrary prose.

```js
logger.info(`Saved visit for ${patient.name}`);          // leaks, bypasses everything
logger.info('Visit saved', { visitId });                 // correct
```
