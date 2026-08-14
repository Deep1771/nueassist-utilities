'use strict';

/**
 * PHI-safe HTTP access logging + correlation-ID propagation.
 *
 * Drop-in replacement for `app.use(morgan('combined'))`, which is still live in
 * delete-entity-service, migration-service, read-entity-service, evv-service
 * and warning-service.
 *
 * ---------------------------------------------------------------------------
 * WHY MORGAN HAS TO GO
 * ---------------------------------------------------------------------------
 * The Apache "combined" format logs the full request line, including the query
 * string. Any endpoint that accepts a patient ID, an MRN, or a name search as
 * a query parameter writes that value verbatim, on every request, forever.
 * The HIPAA logging report calls this "the single easiest and most systemic
 * PHI leak in this stack" and it is correct: it needs no bug to trigger, only
 * a URL.
 *
 * This middleware logs the ROUTE TEMPLATE (`/api/patients/:id`) rather than
 * the resolved URL, so the identifier never reaches the log line at all — not
 * redacted, not hashed, absent.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS ALSO THE MAIN COST LEVER
 * ---------------------------------------------------------------------------
 * Access logs are the highest-volume line type in the platform, and most of
 * them say "a healthy request succeeded," which nobody has ever needed at 3am.
 * Two controls here do most of the work of staying inside Grafana Cloud's
 * 50 GB/month included allowance:
 *
 *   - Health/readiness probes are dropped entirely. Kubernetes probes every
 *     pod every few seconds forever; across ~30 services with multiple
 *     replicas this is comfortably the largest single source of log lines in
 *     the cluster, and its entire information content is "the probe that
 *     already has its own alerting is still passing."
 *
 *   - Successful (2xx/3xx) requests are sampled in prod. Errors, redirects to
 *     auth, slow requests, and anything 4xx/5xx are ALWAYS logged. The lines
 *     that matter during an incident are kept at full fidelity; the ones that
 *     only prove the service is alive are thinned.
 */

const crypto = require('crypto');

const CORRELATION_HEADER = 'x-correlation-id';

const ENVIRONMENT = (process.env.NODE_ENV || 'development').toLowerCase();
const IS_PROD = ENVIRONMENT === 'prod' || ENVIRONMENT === 'production';

/**
 * Fraction of successful requests to log in prod. 0.1 keeps a representative
 * sample for traffic-shape questions while cutting the dominant line type by
 * 90%. Outside prod the default is 1 — test volume is small and complete logs
 * are more useful while the platform is being debugged.
 *
 * Raise it to 1 temporarily during an incident via the env var; no deploy of
 * this file is needed.
 */
// Written without `??` deliberately: this package must parse on Node 11, where
// nullish coalescing is a syntax error and would stop the service booting.
// See the compatibility note at the top of logger.js.
const RAW_SAMPLE_RATE = process.env.LOG_ACCESS_SAMPLE_RATE;
const SAMPLE_RATE = Number(
    RAW_SAMPLE_RATE === undefined || RAW_SAMPLE_RATE === ''
        ? (IS_PROD ? 0.1 : 1)
        : RAW_SAMPLE_RATE
);

/**
 * Requests slower than this are always logged regardless of sampling — a slow
 * 200 is a real signal and is exactly what sampling would otherwise hide.
 */
const ALWAYS_LOG_SLOWER_THAN_MS = Number(
    process.env.LOG_ACCESS_SLOW_MS || 1000
);

const DEFAULT_IGNORED_PATHS = [
    '/health', '/healthz', '/healthcheck', '/health-check',
    '/ready', '/readyz', '/live', '/livez',
    '/ping', '/metrics', '/favicon.ico',
];

/**
 * The route template, never the resolved URL.
 *
 * `req.route.path` is populated by Express once a route has matched, and is
 * the pattern (`/:id`), not the value. `req.baseUrl` is the mount prefix and
 * is static. Neither contains user input.
 *
 * The fallback matters and is the subtle part: if no route matched (a 404, or
 * an error thrown before routing), `req.route` is undefined. Falling back to
 * `req.path` would log an attacker- or client-supplied string, which on a 404
 * sweep is exactly where junk — and occasionally a real identifier someone
 * pasted into the wrong URL — shows up. So unmatched requests log a constant.
 */
function safeRoute(req) {
    if (req.route && req.route.path) {
        return `${req.baseUrl || ''}${req.route.path}`;
    }
    return '(unmatched)';
}

/**
 * @param {object}   logger              A logger from `createLogger()`.
 * @param {object}  [options]
 * @param {string[]} [options.ignorePaths]  Extra paths to drop, in addition to
 *                                          the health/probe defaults.
 * @param {number}  [options.sampleRate]    Override the env-derived rate.
 */
function createRequestLogger(logger, options) {
    const opts = options || {};
    const ignored = new Set(
        DEFAULT_IGNORED_PATHS.concat(opts.ignorePaths || [])
    );
    const sampleRate = opts.sampleRate !== undefined
        ? opts.sampleRate
        : SAMPLE_RATE;

    return function requestLogger(req, res, next) {
        // Accept an inbound correlation ID so a request keeps its identity
        // across service hops, but only if it looks like one we issued.
        // An unvalidated header is caller-controlled text that would land in
        // every log line for the request — and correlationId is promoted to
        // Loki structured metadata, so junk there is both a leak vector and a
        // storage problem.
        const inbound = req.headers[CORRELATION_HEADER];
        const correlationId = isValidCorrelationId(inbound)
            ? inbound
            : newCorrelationId();

        res.setHeader(CORRELATION_HEADER, correlationId);

        logger.runWithCorrelationId(correlationId, () => {
            // Probes are dropped before any work is done, but the correlation
            // context is still established so anything the handler itself logs
            // remains traceable.
            if (ignored.has(req.path)) return next();

            const startedAt = Date.now();

            // `finish` fires when the response is flushed. `close` covers the
            // client hanging up mid-response, which `finish` misses — those
            // are precisely the requests worth seeing, so they are not
            // sampled away below.
            let settled = false;
            const record = (aborted) => {
                if (settled) return;
                settled = true;

                const durationMs = Date.now() - startedAt;
                const statusCode = res.statusCode;

                const mustLog = aborted
                    || statusCode >= 400
                    || durationMs >= ALWAYS_LOG_SLOWER_THAN_MS;

                if (!mustLog && Math.random() >= sampleRate) return;

                const context = {
                    method: req.method,
                    path: safeRoute(req),
                    statusCode,
                    durationMs,
                };
                if (aborted) context.outcome = 'client-disconnected';
                if (!mustLog) context.sampled = true;

                // Level follows the outcome, so that a service running at
                // LOG_LEVEL=error still records WHICH endpoint failed.
                //
                // Emitting every access log at `info` — as this did
                // originally — means turning the level up to `error` for cost
                // reasons silently discards the 5xx lines too, leaving errors
                // with no route, status or duration attached to them. That is
                // the opposite of what raising the level is meant to achieve.
                if (statusCode >= 500 || aborted) {
                    logger.error('Request failed', context);
                } else if (statusCode >= 400) {
                    logger.warn('Request failed', context);
                } else {
                    logger.info('Request completed', context);
                }
            };

            res.on('finish', () => record(false));
            res.on('close', () => record(!res.writableEnded));

            next();
        });
    };
}

/**
 * Generate a UUID v4.
 *
 * `crypto.randomUUID()` is Node 14.17+, and twelve services here still run
 * Node 11, so it is used when present and hand-rolled from `randomBytes`
 * otherwise. Both paths use the same CSPRNG; the fallback just formats it.
 */
function newCorrelationId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;   // version 4
    b[8] = (b[8] & 0x3f) | 0x80;   // variant 10x
    const h = b.toString('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16)
        + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

/** UUID v4, or the same shape we issue. Anything else is discarded. */
const CORRELATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidCorrelationId(value) {
    return typeof value === 'string' && CORRELATION_PATTERN.test(value);
}

module.exports = { createRequestLogger, CORRELATION_HEADER, isValidCorrelationId };
