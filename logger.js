'use strict';

/**
 * Shared PHI-safe structured logger for all NueAssist services.
 *
 * Implements docs/standards/logging.md from the NueAssist-Microservices repo.
 * Replaces the ~12 divergent per-service `logger.js` files and `morgan`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE ENFORCES INSTEAD OF DOCUMENTS
 * ---------------------------------------------------------------------------
 * The per-service loggers this replaces all carry a comment saying "allow-list
 * API — callers must pass explicit, curated fields." None of them actually
 * check. `write()` passed `context` straight through to Winston, so
 * `logger.info('Saved', entity)` logged the entire entity, PHI and all. A
 * comment is not a control.
 *
 * This module makes the allow-list real at runtime. A field reaches the log
 * line only if it clears four gates:
 *
 *   1. Its KEY is on the allow-list (SAFE_KEYS, plus whatever the service
 *      deliberately registers via `allowKeys()`).
 *   2. Its VALUE is a primitive. Objects and arrays are rejected outright —
 *      that is what stops a whole entity/request/HL7 payload being dumped.
 *   3. Keys shaped like identifiers must hold values shaped like identifiers,
 *      so `entityId: 'Margaret Whitfield'` is dropped rather than logged.
 *   4. Strings are length-capped, because free-text care notes and payload
 *      fragments are long and IDs are short.
 *
 * Anything rejected is replaced by a marker in `_dropped` — never silently
 * discarded. `_dropped` being non-empty is a BUG AT THE CALL SITE, and it is
 * alertable (see the Grafana alerting section of the Phase 0 plan). It is not
 * a control that worked; it is a control that caught someone.
 *
 * ---------------------------------------------------------------------------
 * WHY IT ALSO ENFORCES VOLUME
 * ---------------------------------------------------------------------------
 * Every unaudited log line is both a PHI risk and a byte on the invoice. The
 * two problems have the same fix and the same owner, so the throttle and the
 * sampling live here rather than in the shipper, where they would be a second
 * place to look. Controlling volume in code keeps us inside Grafana Cloud's
 * 50 GB/month included allowance, which is what makes this project affordable.
 *
 * ---------------------------------------------------------------------------
 * ZERO DEPENDENCIES, DELIBERATELY
 * ---------------------------------------------------------------------------
 * No Winston. This package is consumed by ~30 services split across CommonJS
 * and Babel/ESM builds; adding a logging framework to it means a shared
 * version constraint across all of them forever, for features we do not use.
 * Structured JSON on stdout is the entire contract Fluent Bit needs.
 */

/**
 * ---------------------------------------------------------------------------
 * NODE 11 COMPATIBILITY — READ BEFORE ADDING MODERN SYNTAX
 * ---------------------------------------------------------------------------
 * Twelve services in this platform still build on `node:11-alpine`
 * (heirarchy, napi, triggers, notification, publicapi, iotapi, and others).
 * This file is loaded by every one of them, so it must parse and run on
 * Node 11.
 *
 * That rules out, at minimum:
 *   - `??` nullish coalescing        (Node 14+)  — a SYNTAX error, so the
 *                                                  service will not even start
 *   - `?.` optional chaining         (Node 14+)  — same
 *   - `crypto.randomUUID()`          (Node 14.17+)
 *   - `Object.fromEntries`           (Node 12+)
 *   - `String.prototype.matchAll`    (Node 12+)
 *   - `AsyncLocalStorage`            (Node 12.17+) — see below
 *
 * A syntax error here does not degrade one feature; it stops the service
 * booting at all. Do not add newer syntax without checking every Dockerfile.
 *
 * The real fix is upgrading those base images — Node 11 went end-of-life in
 * 2019 and is a standing security exposure on a system handling PHI. Until
 * that happens, this file is written to the old floor.
 */

// AsyncLocalStorage arrived in Node 12.17. On Node 11 this is `undefined`,
// which is handled rather than thrown: the logger still emits correctly, it
// just cannot propagate a correlation ID implicitly. Those services must pass
// identifiers explicitly until their base image is upgraded.
const AsyncLocalStorage = require('async_hooks').AsyncLocalStorage;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const ENVIRONMENT = (process.env.NODE_ENV || 'development').toLowerCase();
const IS_PROD = ENVIRONMENT === 'prod' || ENVIRONMENT === 'production';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// `debug` is off in prod. Per the standard, debug is where PHI leaks happen —
// it is where people dump whole objects to see what is inside them.
const REQUESTED_LEVEL = LEVELS[
    (process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug')).toLowerCase()
];
const ACTIVE_LEVEL = REQUESTED_LEVEL === undefined ? LEVELS.info : REQUESTED_LEVEL;

// Collapse identical repeated lines within this window into one line carrying
// a `repeated` count. This is the runaway-loop guard: a retry loop logging the
// same error thousands of times a second is the classic way a log bill or a
// rate limit arrives without warning.
const THROTTLE_WINDOW_MS = Number(process.env.LOG_THROTTLE_WINDOW_MS || 10000);
const THROTTLE_AFTER = Number(process.env.LOG_THROTTLE_AFTER || 5);

const MAX_STRING_LENGTH = Number(process.env.LOG_MAX_STRING_LENGTH || 200);
const MAX_STACK_LENGTH = Number(process.env.LOG_MAX_STACK_LENGTH || 2000);
const MAX_MESSAGE_LENGTH = Number(process.env.LOG_MAX_MESSAGE_LENGTH || 160);
const MAX_CONTEXT_KEYS = 25;

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

/**
 * Keys any service may log without registering them.
 *
 * The test for membership is NOT "is this field useful" — it is "can this
 * field ever hold PHI, PII, or a secret, in any service, under any code path,
 * including future ones." If the answer is anything other than a confident no,
 * it does not belong here.
 *
 * Note what is deliberately absent: name, email, phone, address, dob, mrn,
 * ssn, note, comment, description, body, payload, message body, query, url,
 * token, password, otp. Several of those look harmless. `description` is how a
 * free-text care note reaches a log line.
 */
const SAFE_KEYS = new Set([
    // Identifiers — opaque handles, never the record behind them
    'entityId', 'visitId', 'messageId', 'orderId', 'jobId', 'batchId',
    'agencyId', 'userId', 'caregiverEntityId', 'patientEntityId', 'tenantId',
    'correlationId', 'requestId', 'scheduleId', 'exportId', 'importId',
    'claimId', 'documentId', 'deviceId', 'parentId', 'templateId',

    // HTTP — route templates and status only. See PATH_KEYS below for why
    // `path` gets extra scrutiny.
    'method', 'path', 'route', 'statusCode',

    // Outcome and control flow
    'status', 'outcome', 'reason', 'code', 'errorName', 'errorCode',
    'operation', 'action', 'event', 'eventName', 'stage', 'step', 'result',
    'errorStack',

    // `function` is the name of the function that failed. It is code
    // structure, not data, and the standard explicitly requires it ("Errors
    // carry service, function, and reason") — omitting it from this list made
    // the standard contradict its own enforcement, silently dropping the field
    // from every error log that followed the rule.
    'function',

    // Message/channel classification. Bounded enumerations describing the KIND
    // of thing handled, never its content: 'ORU', 'ADT', 'email', 'sms'.
    // Note what is absent: sourceHost. An IP address is one of HIPAA's 18 Safe
    // Harbor identifiers, so a service that needs it must register it
    // deliberately via allowKeys() rather than get it for free here.
    'messageType', 'channel',

    // Counts, sizes, timings — aggregate facts carry no PHI
    'count', 'total', 'processed', 'succeeded', 'failed', 'skipped',
    'recordCount', 'fileCount', 'rowCount', 'durationMs', 'elapsedMs',
    'attempt', 'retryCount', 'sizeBytes', 'page', 'limit', 'offset',

    // Infrastructure
    'service', 'environment', 'queue', 'topic', 'exchange', 'collection',
    'database', 'version', 'host', 'port', 'region', 'bucket', 'cronExpression',

    // Bookkeeping emitted by this package itself (throttle, access sampling,
    // and the legacy-logger shim's unmigrated-call-site marker)
    'repeated', 'windowMs', 'sampled', 'legacy',
]);

/**
 * Keys whose values must look like machine identifiers.
 *
 * This catches the most damaging realistic mistake: a variable named like an
 * ID that actually holds a human-readable value. `entityId: patient.name`
 * passes the key gate and the primitive gate, and only this check stops it.
 */
const ID_KEY_PATTERN = /Id$|^id$/;
const ID_VALUE_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/;

/**
 * `path` must be a route template or a bare path — never `req.originalUrl`,
 * which carries the query string. A query string is the single easiest PHI
 * leak in this stack (see the standard, §5 on morgan).
 */
const PATH_KEYS = new Set(['path', 'route']);

/** Per-process registry of additional keys a service has deliberately allowed. */
const registeredKeys = new Set();

/**
 * Register extra safe keys for this service.
 *
 * Deliberately a function call at startup rather than a config file: adding a
 * key should be a visible line in a pull request that a reviewer can question,
 * not a quiet entry in JSON.
 *
 * Registering a key is an assertion that it can never hold PHI. Register
 * `sourceSystem`, not `patientIdentifierValue`.
 */
function allowKeys(keys) {
    for (const key of keys) registeredKeys.add(key);
}

function isKeyAllowed(key) {
    return SAFE_KEYS.has(key) || registeredKeys.has(key);
}

// ---------------------------------------------------------------------------
// Context sanitisation — the actual control
// ---------------------------------------------------------------------------

/**
 * Returns { context, dropped }.
 *
 * `dropped` maps rejected keys to the reason, so a leak attempt is visible in
 * the log rather than invisible. The value is never included in the reason —
 * that would defeat the entire purpose.
 */
function sanitizeContext(context) {
    if (context === undefined || context === null) {
        return { context: undefined, dropped: undefined };
    }

    // A non-object context is almost always `logger.info('msg', someValue)`,
    // which is exactly the shape the allow-list exists to prevent.
    if (typeof context !== 'object' || Array.isArray(context)) {
        return { context: undefined, dropped: { _context: 'not-an-object' } };
    }

    const safe = {};
    const dropped = {};
    let keyCount = 0;

    for (const key of Object.keys(context)) {
        if (keyCount >= MAX_CONTEXT_KEYS) {
            dropped._truncated = 'too-many-keys';
            break;
        }

        const value = context[key];

        // Skip silently: `{ errorCode: undefined }` is an absent field, not a
        // leak attempt, and `serializeError` produces exactly that shape.
        if (value === undefined) continue;

        if (!isKeyAllowed(key)) {
            dropped[key] = 'key-not-allow-listed';
            continue;
        }

        // Gate 2: primitives only. This is what stops entity dumps, request
        // bodies, and HL7 payloads, all of which arrive as objects.
        const type = typeof value;
        if (value === null) {
            safe[key] = null;
            keyCount++;
            continue;
        }
        if (type === 'object' || type === 'function' || type === 'symbol') {
            dropped[key] = 'non-primitive';
            continue;
        }
        if (type === 'bigint') {
            safe[key] = value.toString();
            keyCount++;
            continue;
        }
        if (type === 'number' || type === 'boolean') {
            safe[key] = value;
            keyCount++;
            continue;
        }

        // type === 'string' from here.
        if (key === 'errorStack') {
            // Stack frames are file paths and line numbers — safe, and the
            // main reason to log an error at all. Exempt from the ordinary
            // string cap, which exists for free-text and would eat the trace.
            // `serializeError` has already stripped the message line.
            safe[key] = value.length > MAX_STACK_LENGTH
                ? value.slice(0, MAX_STACK_LENGTH) + '…[truncated]'
                : value;
            keyCount++;
            continue;
        }
        if (PATH_KEYS.has(key) && value.includes('?')) {
            dropped[key] = 'path-contains-query-string';
            continue;
        }
        if (ID_KEY_PATTERN.test(key) && !ID_VALUE_PATTERN.test(value)) {
            dropped[key] = 'id-value-not-identifier-shaped';
            continue;
        }
        if (value.length > MAX_STRING_LENGTH) {
            // Truncate rather than drop: a long `reason` is usually a stack
            // fragment worth keeping the head of. The cap is what stops a
            // free-text note riding along in full.
            safe[key] = value.slice(0, MAX_STRING_LENGTH) + '…[truncated]';
            keyCount++;
            continue;
        }

        safe[key] = value;
        keyCount++;
    }

    return {
        context: Object.keys(safe).length ? safe : undefined,
        dropped: Object.keys(dropped).length ? dropped : undefined,
    };
}

// ---------------------------------------------------------------------------
// Correlation IDs
// ---------------------------------------------------------------------------

// `null` on Node 11, where AsyncLocalStorage does not exist. Everything below
// degrades to "no implicit correlation ID" rather than throwing — losing
// request tracing on a handful of legacy services is bad; failing to start
// them is worse, and losing their logs entirely would defeat the purpose of
// this pipeline.
const correlationContext = AsyncLocalStorage ? new AsyncLocalStorage() : null;

/** Whether implicit correlation-ID propagation is available on this runtime. */
const supportsCorrelationIds = correlationContext !== null;

function getCorrelationId() {
    if (!correlationContext) return undefined;
    const store = correlationContext.getStore();
    return store ? store.correlationId : undefined;
}

/**
 * Run `fn` with a correlation ID bound to every logger call inside it.
 *
 * On Node 11 there is no async context to bind to, so `fn` is simply invoked.
 * Callers keep working; their log lines just carry no correlationId.
 */
function runWithCorrelationId(correlationId, fn) {
    if (!correlationContext) return fn();
    return correlationContext.run({ correlationId }, fn);
}

// ---------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------

const throttleState = new Map();

/**
 * Returns null to emit normally, a number to emit with a `repeated` count, or
 * false to suppress.
 *
 * Keyed on level + message only — deliberately not on context, so a loop
 * logging the same failure for a thousand different IDs still collapses. The
 * IDs are lost, which is the correct trade: a thousand near-identical lines is
 * not diagnostically richer than one line saying it happened a thousand times,
 * and it costs a thousand times as much.
 */
function throttleDecision(level, message, now) {
    const key = level + ' ' + message;
    const state = throttleState.get(key);

    if (!state || now - state.windowStart >= THROTTLE_WINDOW_MS) {
        // Close out the previous window by reporting what it suppressed.
        const suppressed = state && state.count > THROTTLE_AFTER
            ? state.count - THROTTLE_AFTER
            : 0;
        throttleState.set(key, { windowStart: now, count: 1 });
        return suppressed > 0 ? suppressed : null;
    }

    state.count++;
    return state.count <= THROTTLE_AFTER ? null : false;
}

// Bound memory: without this, a message built by interpolation (which the
// standard forbids, but which will happen) would grow the map without limit.
setInterval(() => {
    const cutoff = Date.now() - THROTTLE_WINDOW_MS * 2;
    for (const [key, state] of throttleState) {
        if (state.windowStart < cutoff) throttleState.delete(key);
    }
}, THROTTLE_WINDOW_MS * 2).unref();

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function createLogger(options) {
    const serviceName = (options && options.service)
        || process.env.SERVICE_NAME;

    if (!serviceName) {
        throw new Error(
            'nueassist-utilities/logger: `service` is required. '
            + 'Pass createLogger({ service: "auth-service" }) or set SERVICE_NAME.'
        );
    }

    /**
     * A logger must never throw into the code that called it. Losing one log
     * line is an annoyance; taking down a request path because sanitisation
     * hit an exotic value is an outage. The fallback line is deliberately
     * minimal — it carries no caller-supplied data, because the reason we are
     * here is that caller-supplied data could not be processed safely.
     */
    function write(level, message, context, extra) {
        try {
            writeUnsafe(level, message, context, extra);
        } catch (err) {
            try {
                process.stdout.write(JSON.stringify({
                    timestamp: new Date().toISOString(),
                    level: 'error',
                    service: serviceName,
                    environment: ENVIRONMENT,
                    message: 'Logger failed to emit a line',
                    context: { errorName: (err && err.name) || 'Error' },
                }) + '\n');
            } catch (_) { /* stdout itself is gone; nothing left to try */ }
        }
    }

    function writeUnsafe(level, message, context, extra) {
        if (LEVELS[level] > ACTIVE_LEVEL) return;

        // `message` must be a short static string. Interpolating a value into
        // it is how PHI bypasses the context allow-list entirely, so it is
        // capped as a backstop. The real control is code review plus the CI
        // guardrail; this only bounds the damage.
        let safeMessage = typeof message === 'string' ? message : String(message);
        if (safeMessage.length > MAX_MESSAGE_LENGTH) {
            safeMessage = safeMessage.slice(0, MAX_MESSAGE_LENGTH) + '…[truncated]';
        }

        const now = Date.now();
        let repeated;
        if (!(extra && extra.skipThrottle)) {
            const decision = throttleDecision(level, safeMessage, now);
            if (decision === false) return;
            if (typeof decision === 'number') repeated = decision;
        }

        const { context: safeContext, dropped } = sanitizeContext(context);

        const entry = {
            timestamp: new Date(now).toISOString(),
            level,
            service: serviceName,
            environment: ENVIRONMENT,
            message: safeMessage,
        };

        const correlationId = getCorrelationId();
        if (correlationId) entry.correlationId = correlationId;
        if (safeContext) entry.context = safeContext;
        if (dropped) entry._dropped = dropped;
        if (repeated) {
            entry.context = Object.assign({}, entry.context, {
                repeated,
                windowMs: THROTTLE_WINDOW_MS,
            });
        }

        // stdout only. No file transport: pod-local logs are ephemeral and
        // unauditable, and a second copy on disk is a second place PHI can sit
        // unencrypted. Fluent Bit reads stdout.
        process.stdout.write(JSON.stringify(entry) + '\n');
    }

    return {
        error: (message, context) => write('error', message, context),
        warn: (message, context) => write('warn', message, context),
        info: (message, context) => write('info', message, context),
        debug: (message, context) => write('debug', message, context),

        /**
         * Bypasses the throttle. For lifecycle events that are genuinely
         * once-per-process (startup, shutdown, migration complete) and must
         * not be collapsed. Do not use it inside a request path.
         */
        event: (message, context) => write('info', message, context, { skipThrottle: true }),

        allowKeys,
        getCorrelationId,
        runWithCorrelationId,
        serializeError,

        // Exported for the CI guardrail's unit tests and for services that
        // need to check a value before logging it.
        _sanitizeContext: sanitizeContext,
    };
}

/**
 * Turn an Error into allow-listed context fields.
 *
 * Note what this does NOT do: it does not log `err.message`. Error messages
 * are constructed by whoever threw them, frequently by interpolating the value
 * that caused the failure — which on this platform means a Mongo validation
 * error carrying a patient's name, or an HL7 parse error carrying a message
 * segment. `err.message` is untrusted text and cannot be allow-listed.
 *
 * The stack frames ARE kept, because file paths and line numbers are safe and
 * are the main diagnostic value of logging an error at all. The catch — and
 * the reason the per-service loggers this replaces were unsafe despite looking
 * careful — is that `err.stack` BEGINS with the error message. Everything
 * before the first `\n    at ` is the message, and it is stripped here.
 *
 * If you need more than the name and the code, pass a curated `reason`.
 */
const STACK_FRAME_START = /\n\s+at\s/;

function serializeError(err) {
    if (!err) return undefined;
    if (typeof err === 'string') return { errorName: 'Error' };

    let errorStack;
    if (typeof err.stack === 'string') {
        const firstFrame = err.stack.search(STACK_FRAME_START);
        // If there are no recognisable frames, drop the stack entirely rather
        // than ship what would be a bare (untrusted) message string.
        errorStack = firstFrame === -1 ? undefined : err.stack.slice(firstFrame).trim();
    }

    return {
        errorName: err.name || 'Error',
        errorCode: err.code !== undefined ? String(err.code) : undefined,
        errorStack,
    };
}

module.exports = { createLogger, allowKeys, serializeError, SAFE_KEYS };
