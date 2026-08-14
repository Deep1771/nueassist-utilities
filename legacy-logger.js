'use strict';

/**
 * Compatibility shim for the pre-standard per-service loggers.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * Fifteen services each ship their own `logger.js` built on Winston with a
 * File or DailyRotateFile transport. Those transports have to go: pod-local
 * log files are unencrypted at rest, unauditable, lost on restart (so they
 * have no audit value anyway), and are a second place PHI can sit outside the
 * shipping pipeline.
 *
 * Deleting them outright would mean rewriting ~485 call sites at once. This
 * shim instead reproduces the two legacy export shapes exactly, so each
 * service's `logger.js` becomes a thin delegation and no call site changes:
 *
 *   Family A (ESM, 6 services)  export { category1, category2, category3 }
 *                               plus `category1.stream` for morgan
 *   Family B (CJS, 9 services)  module.exports = <winston-shaped logger>
 *
 * ---------------------------------------------------------------------------
 * THE PART THAT MATTERS: `message` HERE IS UNTRUSTED
 * ---------------------------------------------------------------------------
 * The main logger (`logger.js`) enforces an allow-list on `context`. That is a
 * real control, and legacy call sites route around it completely, because they
 * put their data in the MESSAGE:
 *
 *   logger.info(`resident info is ${residentInfo.sys_entityAttributes.firstName}`)
 *   logger.info(`constructed tasks are ${JSON.stringify(taskDoc)}`)
 *
 * No allow-list can help with that — by the time the logger sees it, it is one
 * opaque string. So every line through this shim is treated as untrusted:
 *
 *   - the redaction backstop patterns are applied to the message
 *   - the message is length-capped harder than the main logger's
 *   - the line is tagged `legacy: true`, which makes the remaining surface
 *     queryable in Grafana (`{...} | json | legacy="true"`) and alertable
 *
 * NONE OF THAT MAKES AN INTERPOLATED MESSAGE SAFE. Redaction is a deny-list;
 * it catches emails, phone numbers and SSNs, and it will not catch a patient's
 * first name, an address, a diagnosis code, or a care note. The `legacy: true`
 * tag exists so the remaining call sites can be found and fixed, not so they
 * can be tolerated. Treat a non-zero legacy line count as outstanding work.
 *
 * The high-risk sites — the ones demonstrably interpolating entity documents
 * and patient names — were fixed at the call site when this shim landed,
 * because routing those to a vendor without a BAA would have been worse than
 * the local files they replaced.
 */

const { createLogger } = require('./logger');

const MAX_LEGACY_MESSAGE_LENGTH = Number(
    process.env.LOG_MAX_LEGACY_MESSAGE_LENGTH || 500
);

/**
 * Same deny-list as the Fluent Bit `redact_backstop` Lua filter, kept in sync
 * deliberately: catching a leak here rather than in the shipper means it never
 * leaves the pod. Neither is a control you may rely on.
 */
const REDACTIONS = [
    [/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
    [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]'],
    [/\(\d{3}\)\s*\d{3}-\d{4}/g, '[REDACTED_PHONE]'],
    [/\b\d{3}-\d{3}-\d{4}\b/g, '[REDACTED_PHONE]'],
    [/\+1\s?\d{3}\s?\d{3}\s?\d{4}/g, '[REDACTED_PHONE]'],
];

function scrub(text) {
    let out = text;
    for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
    return out;
}

/**
 * Legacy call sites pass anything: strings, Errors, objects, format strings
 * with extra args (`'%O'`, splat), or nothing.
 *
 * Errors and objects are the dangerous cases. `String(err)` yields
 * "Error: <message>", and error messages on this platform routinely carry the
 * value that caused the failure — a Mongo validation error naming a patient,
 * an HL7 parse error carrying a segment. So an Error contributes its NAME
 * only, and a plain object contributes a type marker rather than its contents.
 * That deliberately loses detail the old file logs had; the detail is exactly
 * what could not be shipped safely.
 */
function stringifyArg(arg) {
    if (arg === undefined || arg === null) return '';
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') {
        return String(arg);
    }
    if (arg instanceof Error) return `[${arg.name}]`;
    if (Array.isArray(arg)) return `[array:${arg.length}]`;
    return '[object]';
}

function buildMessage(args) {
    const parts = [];
    for (const arg of args) {
        const piece = stringifyArg(arg);
        if (piece !== '') parts.push(piece);
    }

    let message = scrub(parts.join(' ')).trim();
    if (message.length > MAX_LEGACY_MESSAGE_LENGTH) {
        message = message.slice(0, MAX_LEGACY_MESSAGE_LENGTH) + '…[truncated]';
    }
    return message || '(empty legacy log line)';
}

/**
 * Builds a winston-shaped logger backed by the shared structured logger.
 *
 * Supports `.info/.warn/.error/.debug/.log/.verbose/.silly` and a `.stream`
 * for morgan, which is all the legacy call sites use.
 */
function createLegacyLogger(options) {
    const logger = createLogger(options);

    const emit = (level) => (...args) => {
        // `legacy: true` is what makes the remaining unmigrated surface
        // findable in Grafana. It is a to-do list, not an exemption.
        logger[level](buildMessage(args), { legacy: true });
    };

    const shim = {
        error: emit('error'),
        warn: emit('warn'),
        info: emit('info'),
        debug: emit('debug'),
        // Winston aliases some services call.
        verbose: emit('debug'),
        silly: emit('debug'),
        // winston's `.log(level, msg)` and `.log(msg)` forms.
        log: (levelOrMessage, ...rest) => {
            if (typeof levelOrMessage === 'string' && ['error', 'warn', 'info', 'debug'].includes(levelOrMessage)) {
                return emit(levelOrMessage)(...rest);
            }
            return emit('info')(levelOrMessage, ...rest);
        },
    };

    // morgan(..., { stream }) writes a pre-formatted line with a trailing
    // newline. Note that morgan('combined') through this stream is STILL a
    // PHI leak — the query string is already baked into the string by the time
    // it arrives here. Services must move to request-logger.js; this exists so
    // the morgan('short') users in Imports/Exports/PublicAPI keep working
    // until they do.
    shim.stream = {
        write: (message, level) => {
            const text = typeof message === 'string' ? message.trim() : stringifyArg(message);
            if (typeof level === 'string' && typeof shim[level] === 'function') {
                return shim[level](text);
            }
            return shim.info(text);
        },
    };

    // Pass-throughs so a call site that reaches for the real API gets it.
    shim.runWithCorrelationId = logger.runWithCorrelationId;
    shim.getCorrelationId = logger.getCorrelationId;
    shim.serializeError = logger.serializeError;
    shim.allowKeys = logger.allowKeys;
    /** The underlying allow-list logger, for files being migrated properly. */
    shim.structured = logger;

    return shim;
}

module.exports = { createLegacyLogger };
