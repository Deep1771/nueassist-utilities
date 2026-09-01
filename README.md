# nueassist-utilities

Shared query-building, permission, and structured-logging utilities for the NueAssist
platform services.

```sh
npm install nueassist-utilities
```

Requires **Node.js 20.19 or newer**.

## Modules

Import the module you need directly — there is no barrel export, so a service that
only builds queries does not load the HTTP client.

| Import | Provides |
| --- | --- |
| `nueassist-utilities` | `constructFilters` |
| `nueassist-utilities/readroute` | Mongo aggregation builders: `constructFilters`, `constructFinalQuery`, `constructGlobalSearchQuery`, `constructOrgFilters`, `constructPermittedEntitiesFilters`, `constructEntityBuilderFilters`, `getSearchKeys` |
| `nueassist-utilities/globalsearch` | `constructGlobalSearchQuery` |
| `nueassist-utilities/permission` | Permission-tree intersection: `compareTree`, `compareAppTree`, `compareModuleTree`, `compareTemplateTree`, `compareSectionTree`, `compareFields` |
| `nueassist-utilities/security` | `checkPermission` |
| `nueassist-utilities/user` | `isNJAdmin`, `isSuperAdmin`, `getUserAgency`, `getUserRole` |
| `nueassist-utilities/user-stats` | `getUserSystemDetails` |
| `nueassist-utilities/logger` | `createLogger`, `allowKeys`, `serializeError`, `SAFE_KEYS` |
| `nueassist-utilities/request-logger` | `createRequestLogger`, `isValidCorrelationId`, `CORRELATION_HEADER` |
| `nueassist-utilities/function-logger` | `wrapFunction`, `wrapModule`, `errorBoundary`, `installProcessHandlers` |
| `nueassist-utilities/legacy-logger` | `createLegacyLogger` — migration shim only |

## Logging

The logger emits structured JSON on stdout and is **allow-list based**: only keys in
`SAFE_KEYS` survive into a log line, everything else is dropped and recorded under
`_dropped`. This is a PHI control, not a formatting preference.

```js
const { createLogger } = require('nueassist-utilities/logger');
const logger = createLogger({ service: 'scheduling' });

logger.info('Saved visit', { patientId, visitId });   // ok
logger.info(`Saved visit for ${patient.name}`);       // leaks — never do this
```

`message` must be a short static string; all variable data goes in `context`.
Read [LOGGING.md](LOGGING.md) before adding log calls — it documents the allow-list,
correlation IDs, throttling, and the sampling rules for access logs.

### Request logging

```js
const { createRequestLogger } = require('nueassist-utilities/request-logger');
app.use(createRequestLogger(logger));
```

Attaches a correlation ID per request, samples successful responses in production, and
always logs 4xx/5xx, client disconnects, and slow requests.

## Configuration

| Environment variable | Default | Effect |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Minimum level emitted |
| `LOG_ACCESS_SAMPLE_RATE` | `0.1` in prod, `1` otherwise | Fraction of 2xx/3xx requests logged |
| `LOG_MAX_MESSAGE_LENGTH` | `160` | Message truncation cap |
| `LOG_MAX_STACK_LENGTH` | `2000` | Stack trace truncation cap |
| `IP_GEOLOCATION_BASE_URL` | unset | HTTPS geolocation endpoint for `getUserSystemDetails`. Lookups are **disabled** unless set. |

## Upgrading to 3.x

3.0.0 is a breaking release. Before upgrading:

- **Node.js 20.19+ is required.** Services still on older base images will not start.
- **axios 0.18 → 1.19** (major upgrade of a transitive HTTP client).
- **Uncaught exceptions now terminate the process** after logging. Pass
  `installProcessHandlers(logger, { exitOnUncaughtException: false })` to keep the old
  behaviour.
- **Permission filters fail closed.** `constructPermittedEntitiesFilters` and
  `constructEntityBuilderFilters` now return a deny-all filter instead of `[]` when
  access cannot be established.
- **Permission intersection is enforced.** `compareFields` and the feature/flag merges
  previously granted access whenever a key existed in both trees, ignoring the user's
  own denial. Effective permissions may narrow after upgrading.
- **IP geolocation is off by default.** Set `IP_GEOLOCATION_BASE_URL` to an approved
  HTTPS endpoint to restore `getUserSystemDetails` geo data.
- **Correlation IDs must be UUID v4.** Inbound `x-correlation-id` headers in any other
  format are rejected and replaced.
- **`host` is no longer an allow-listed log key.** Dashboards filtering on it need updating.

## Development

```sh
npm install
npm test        # eslint + logging guardrail + node:test
```

## License

ISC
