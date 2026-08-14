'use strict';

/**
 * Error-first function instrumentation.
 *
 * Wraps functions so that a failure is logged exactly once, with the function
 * name, how long it ran before failing, and a PHI-safe reason — then rethrown
 * unchanged.
 *
 * ---------------------------------------------------------------------------
 * WHY A WRAPPER INSTEAD OF try/catch IN EVERY FUNCTION
 * ---------------------------------------------------------------------------
 * The obvious approach — a try/catch in each function that logs and rethrows —
 * produces one log line per stack frame. An error thrown five calls deep is
 * logged five times: five times the noise, five times the ingest cost, and a
 * reader who cannot tell whether one thing failed or five did.
 *
 * It also fails open. Every hand-written catch is a chance to forget the
 * rethrow, and a swallowed error is worse than an unlogged one.
 *
 * So: the wrapper marks the error the first time it sees it, and outer
 * wrappers re-throw without logging again. You get exactly one line per
 * failure, at the innermost frame that was instrumented — which is the frame
 * that actually knows what broke.
 *
 * ---------------------------------------------------------------------------
 * WHAT GETS LOGGED
 * ---------------------------------------------------------------------------
 *   { function, durationMs, errorName, errorCode, errorStack, reason? }
 *
 * NOT `err.message`. Error messages are built by whoever threw them, usually
 * by interpolating the value that failed — a Mongo validation error naming a
 * patient, an HL7 parse error carrying a segment. `serializeError` strips it
 * and keeps the stack frames, which are the diagnostic part.
 *
 * If you want more than the name and code, pass a `reason` you wrote yourself.
 *
 * ---------------------------------------------------------------------------
 * NODE 11
 * ---------------------------------------------------------------------------
 * Twelve services still build on node:11-alpine. No `??`, no `?.`, no
 * `randomUUID`. See the compatibility note at the top of logger.js.
 */

/**
 * Non-enumerable so it never appears in JSON.stringify(err) or in a spread,
 * and so it cannot leak into a log line by accident.
 */
const LOGGED = '__nueassistLogged';

function markLogged(err) {
    if (!err || typeof err !== 'object') return;
    try {
        Object.defineProperty(err, LOGGED, {
            value: true,
            enumerable: false,
            configurable: true,
            writable: true,
        });
    } catch (_) {
        /* frozen or exotic error object — worst case we log it twice */
    }
}

function alreadyLogged(err) {
    return !!(err && typeof err === 'object' && err[LOGGED]);
}

function isPromise(value) {
    return !!value && (typeof value === 'object' || typeof value === 'function')
        && typeof value.then === 'function';
}

/**
 * Wrap a single function with error logging.
 *
 * @param {object}   logger   A logger from createLogger().
 * @param {string}   name     Function name as it should appear in logs.
 * @param {function} fn       The function to wrap. Sync or async.
 * @param {object}  [options]
 * @param {number}  [options.slowMs]  Also log successful calls slower than this
 *                                    (at `warn`). Off by default — success
 *                                    logging is what blows up log volume.
 * @returns {function} Same signature and return value as `fn`.
 */
function wrapFunction(logger, name, fn, options) {
    const opts = options || {};
    const slowMs = typeof opts.slowMs === 'number' ? opts.slowMs : 0;

    function report(err, startedAt) {
        // Only the innermost instrumented frame logs; outer wrappers skip.
        if (alreadyLogged(err)) return;
        markLogged(err);

        const context = { function: name, durationMs: Date.now() - startedAt };
        const serialized = logger.serializeError(err);
        for (const key in serialized) {
            if (serialized[key] !== undefined) context[key] = serialized[key];
        }
        logger.error('Function failed', context);
    }

    function reportSlow(startedAt) {
        if (!slowMs) return;
        const durationMs = Date.now() - startedAt;
        if (durationMs >= slowMs) {
            logger.warn('Function slow', { function: name, durationMs });
        }
    }

    return function wrapped() {
        const startedAt = Date.now();
        let result;

        try {
            result = fn.apply(this, arguments);
        } catch (err) {
            report(err, startedAt);
            throw err;
        }

        if (isPromise(result)) {
            return result.then(
                function (value) { reportSlow(startedAt); return value; },
                function (err) { report(err, startedAt); throw err; }
            );
        }

        reportSlow(startedAt);
        return result;
    };
}

/**
 * Wrap every function on an object — the practical way to instrument "every
 * function" without touching each one.
 *
 *   const helpers = { buildClaim, submitClaim, parseAck };
 *   module.exports = wrapModule(logger, helpers, { prefix: 'claims' });
 *
 * Produces `function: "claims.submitClaim"` in the logs.
 *
 * Only own, enumerable function properties are wrapped. Classes and prototypes
 * are left alone deliberately: wrapping a constructor or a prototype chain
 * breaks `instanceof` and `this` in ways that are hard to debug and much worse
 * than missing a log line.
 */
function wrapModule(logger, target, options) {
    const opts = options || {};
    const prefix = opts.prefix ? opts.prefix + '.' : '';
    const skip = opts.skip || [];
    const out = Array.isArray(target) ? [] : {};

    for (const key of Object.keys(target)) {
        const value = target[key];
        if (typeof value === 'function' && skip.indexOf(key) === -1) {
            out[key] = wrapFunction(logger, prefix + key, value, opts);
        } else {
            out[key] = value;
        }
    }
    return out;
}

/**
 * Express error-handling middleware. Mount it AFTER all routes:
 *
 *   app.use(errorBoundary(logger));
 *
 * This is the single most valuable place to instrument, because every
 * unhandled route error passes through it whether or not the function that
 * threw was wrapped. If you only do one thing from this module, do this.
 *
 * Logs the route TEMPLATE, never req.originalUrl — the query string is the
 * easiest PHI leak in this stack.
 */
function errorBoundary(logger, options) {
    const opts = options || {};
    const passThrough = opts.passThrough === true;

    // Express identifies error handlers by arity — all four args are required.
    return function nueassistErrorBoundary(err, req, res, next) {
        const status = res.statusCode >= 400 ? res.statusCode : 500;

        if (!alreadyLogged(err)) {
            markLogged(err);
            const context = {
                method: req.method,
                path: req.route && req.route.path
                    ? (req.baseUrl || '') + req.route.path
                    : '(unmatched)',
                statusCode: status,
            };
            const serialized = logger.serializeError(err);
            for (const key in serialized) {
                if (serialized[key] !== undefined) context[key] = serialized[key];
            }
            logger.error('Unhandled request error', context);
        }

        // Do NOT hand off to Express's default error handler.
        //
        // That handler writes the full error — INCLUDING err.message and the
        // raw stack — to stderr unless process.env.NODE_ENV is exactly
        // "production". Services here use "prod", "TEST", "DOCKER" and
        // similar, so the check never passes and every unhandled error prints
        // its message verbatim. Fluent Bit then ships it.
        //
        // Error messages are the one place PHI most reliably ends up: a Mongo
        // validation error naming a patient, an HL7 parse error carrying a
        // segment. Everything else in this package works to keep those out of
        // the log stream; delegating here would hand them straight back.
        //
        // So the response is terminated here. Pass { passThrough: true } only
        // if the service has its OWN error handler mounted after this one AND
        // that handler does not print the error.
        if (passThrough || res.headersSent) return next(err);

        res.status(status);
        // The correlation ID is safe to return and lets support tie a user's
        // report to the log line without exposing anything about the failure.
        const correlationId = logger.getCorrelationId();
        return res.json(correlationId
            ? { error: 'Internal Server Error', correlationId: correlationId }
            : { error: 'Internal Server Error' });
    };
}

/**
 * Catch what escapes everything else.
 *
 * `unhandledRejection` is the important one: a rejected promise nobody awaited
 * produces no stack in the application's own logs and, on newer Node, can kill
 * the process. Without this handler those failures are invisible — which is
 * the worst category of bug to have on a system whose logs are its audit
 * trail.
 *
 * The process is NOT killed here. Deciding whether an uncaught exception is
 * fatal is the service's call, not this library's.
 */
function installProcessHandlers(logger) {
    process.on('unhandledRejection', function (reason) {
        if (alreadyLogged(reason)) return;
        markLogged(reason);
        const context = { reason: 'unhandledRejection' };
        const serialized = logger.serializeError(reason);
        for (const key in serialized) {
            if (serialized[key] !== undefined) context[key] = serialized[key];
        }
        logger.error('Unhandled promise rejection', context);
    });

    process.on('uncaughtException', function (err) {
        if (alreadyLogged(err)) return;
        markLogged(err);
        const context = { reason: 'uncaughtException' };
        const serialized = logger.serializeError(err);
        for (const key in serialized) {
            if (serialized[key] !== undefined) context[key] = serialized[key];
        }
        logger.error('Uncaught exception', context);
    });
}

module.exports = {
    wrapFunction,
    wrapModule,
    errorBoundary,
    installProcessHandlers,
};
