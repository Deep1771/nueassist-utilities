'use strict';

/**
 * Shared mail transport for all NueAssist services.
 *
 * Replaces six near-identical `mailDriver` copies spread across three SendGrid
 * SDK generations — @sendgrid/mail v6, v7 and v8, plus the deprecated
 * callback-based `sendgrid` v4/v5 — with one module and a pluggable provider.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROVIDER IS A RUNTIME SWITCH
 * ---------------------------------------------------------------------------
 * SendGrid is not a HIPAA Eligible Service and Twilio will not sign a BAA for
 * it, so this platform has to leave it. The provider is chosen by the
 * MAIL_PROVIDER environment variable rather than by an import, which makes the
 * cutover and the rollback the same operation: change one variable, no
 * redeploy. A service can be moved to SES and moved back inside a minute if
 * deliverability turns out wrong.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not write `notificationlog`. The consuming services write to
 * different collections through different drivers — `insertData`,
 * `addManyDriver`, `entityModel.addData` — and attach service-specific fields.
 * That write stays in each service's thin driver. This module owns the
 * transport and nothing else.
 *
 * It does not implement sandbox mode. "Sandbox" in this platform means
 * redirecting mail to a test mailbox instead of the real recipient, and that
 * happens in the controllers, where the notification group and the original
 * recipient are both in scope. It is already provider-agnostic.
 *
 * Note the name collision, which has caused confusion before. Three unrelated
 * things are called "sandbox": our recipient redirection (in use); SendGrid's
 * `mail_settings.sandbox_mode`, which validates without delivering (not used
 * live anywhere); and the AWS SES account sandbox, an account state capping
 * sends at 200/day in which every RECIPIENT must also be a verified identity.
 * The last one has a real consequence — the test mailbox has to be verified in
 * SES or redirected mail will not deliver at all.
 *
 * ---------------------------------------------------------------------------
 * COMPATIBILITY
 * ---------------------------------------------------------------------------
 * CommonJS, and no syntax newer than Node 11. This package declares
 * `engines.node >= 20.19.0`, but several consuming services still run
 * node:11-alpine and node:14-alpine, and npm installs through that warning.
 * Until those base images move, code here has to actually run on them: no
 * optional chaining, no nullish coalescing, no class fields.
 *
 * Both SDKs are required lazily, so a service that only sends through SendGrid
 * never needs aws-sdk installed, and vice versa.
 */

const { allowKeys } = require('./logger');

// `provider` is not in the logger's default allow-list, so without this every
// mail log line would arrive with the one field a cutover is judged on sitting
// in `_dropped` instead. It is a bounded enum, so it is safe to register.
allowKeys(['provider']);

const TRANSPORTS = ['sendgrid', 'ses'];
const REQUIRED_FIELDS = ['to', 'from', 'subject'];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Provider errors are classified here and never travel any further.
 *
 * Both SendGrid and SES name the rejected address in their error message and
 * response body. A raw provider error must therefore not reach a log line, a
 * database row, or an HTTP response — application logs ship to Grafana Cloud
 * Loki, a vendor without a BAA, and at least one caller was putting the
 * provider's text straight into a 400 response body.
 *
 * Callers get a stable `code` instead: safe to log, safe to store, safe to
 * branch on, and identical across providers.
 */
const CODES = {
    // The From address is not a verified identity. This is the failure mode
    // the SES migration is most likely to hit: sender addresses come from
    // Mongo (agency.supportemail, notificationtemplate.supportMail), SendGrid
    // tolerates unverified senders and SES does not. It gets its own code so
    // failures can be counted per agency without logging an address.
    UNVERIFIED_SENDER: 'UNVERIFIED_SENDER',
    // Recipient rejected: malformed, suppressed, or on a bounce list.
    INVALID_RECIPIENT: 'INVALID_RECIPIENT',
    // Message itself rejected — missing field, size, encoding.
    INVALID_MESSAGE: 'INVALID_MESSAGE',
    // Credentials or IAM role rejected.
    AUTH_FAILED: 'AUTH_FAILED',
    // Over the send quota or rate limit.
    RATE_LIMITED: 'RATE_LIMITED',
    // Provider 5xx or transport failure.
    PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
    // Anything unrecognised.
    PROVIDER_ERROR: 'PROVIDER_ERROR',
};

const RETRYABLE = {
    RATE_LIMITED: true,
    PROVIDER_UNAVAILABLE: true,
};

function MailError(code, provider, meta) {
    const info = meta || {};
    Error.call(this, code);
    this.name = 'MailError';
    // Deliberately generic. This string ends up in an HTTP response body on
    // the password-reset path, so it must carry no provider text.
    this.message = 'mail send failed: ' + code;
    this.code = code;
    this.provider = provider;
    this.statusCode = typeof info.statusCode === 'number' ? info.statusCode : null;
    this.retryable = RETRYABLE[code] === true;
    if (Error.captureStackTrace) {
        Error.captureStackTrace(this, MailError);
    }
}

MailError.prototype = Object.create(Error.prototype);
MailError.prototype.constructor = MailError;

/** Everything safe to put on a log line or in a notificationlog row. */
MailError.prototype.toContext = function toContext() {
    return {
        provider: this.provider,
        errorCode: this.code,
        statusCode: this.statusCode,
    };
};

function errorText(err) {
    if (!err) return '';
    const parts = [];
    if (err.message) parts.push(String(err.message));
    if (err.code && typeof err.code === 'string') parts.push(err.code);
    // SendGrid nests the real reason here.
    if (err.response && err.response.body && err.response.body.errors) {
        const errors = err.response.body.errors;
        for (let i = 0; i < errors.length; i++) {
            if (errors[i] && errors[i].message) parts.push(String(errors[i].message));
        }
    }
    return parts.join(' | ').toLowerCase();
}

function errorStatus(err) {
    if (!err) return null;
    if (typeof err.statusCode === 'number') return err.statusCode;
    // SendGrid puts the HTTP status on `code` as a number.
    if (typeof err.code === 'number') return err.code;
    if (err.response && typeof err.response.statusCode === 'number') {
        return err.response.statusCode;
    }
    return null;
}

/**
 * Map a provider error onto a MailError. The provider's text is read here to
 * classify it and then discarded — it is never propagated.
 */
function normalise(err, provider) {
    if (err instanceof MailError) return err;

    const text = errorText(err);
    const status = errorStatus(err);
    const awsCode = err && typeof err.code === 'string' ? err.code : '';

    let code = CODES.PROVIDER_ERROR;

    if (
        awsCode === 'MessageRejected' ||
        text.indexOf('not verified') !== -1 ||
        text.indexOf('does not match a verified') !== -1 ||
        text.indexOf('from address does not match') !== -1
    ) {
        code = CODES.UNVERIFIED_SENDER;
    } else if (
        awsCode === 'AccountSendingPausedException' ||
        text.indexOf('suppress') !== -1 ||
        text.indexOf('invalid recipient') !== -1 ||
        text.indexOf('does not contain a valid address') !== -1
    ) {
        code = CODES.INVALID_RECIPIENT;
    } else if (
        awsCode === 'Throttling' ||
        awsCode === 'TooManyRequestsException' ||
        status === 429 ||
        text.indexOf('maximum sending rate') !== -1 ||
        text.indexOf('rate exceeded') !== -1
    ) {
        code = CODES.RATE_LIMITED;
    } else if (
        awsCode === 'InvalidClientTokenId' ||
        awsCode === 'UnrecognizedClientException' ||
        awsCode === 'CredentialsError' ||
        awsCode === 'ExpiredTokenException' ||
        status === 401 ||
        status === 403
    ) {
        code = CODES.AUTH_FAILED;
    } else if (typeof status === 'number' && status >= 500) {
        code = CODES.PROVIDER_UNAVAILABLE;
    } else if (status === 400 || status === 413) {
        code = CODES.INVALID_MESSAGE;
    }

    return new MailError(code, provider, { statusCode: status });
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/**
 * SendGrid, via @sendgrid/mail v6 through v8. All three resolve to
 * [response, body] and reject with an error carrying `code` and
 * `response.body.errors`, so one wrapper covers them.
 *
 * The v4/v5 `sendgrid` package is not supported. It is a different,
 * callback-based API and it is deprecated; NApi keeps a local callback adapter
 * over this module rather than that shape being carried into the package.
 */
function createSendgridTransport(options) {
    const opts = options || {};
    const apiKey = opts.apiKey || process.env.SENDGRID_API_KEY;
    // Injectable so tests need neither the SDK nor a network.
    const client = opts.client || require('@sendgrid/mail');

    if (apiKey) {
        client.setApiKey(apiKey);
    }

    return {
        name: 'sendgrid',
        send: function send(msg) {
            return Promise.resolve()
                .then(function () {
                    return client.send({
                        to: msg.to,
                        from: msg.from,
                        subject: msg.subject,
                        text: msg.text,
                        html: msg.html,
                    });
                })
                .then(function (result) {
                    const response = Array.isArray(result) ? result[0] : result;
                    const headers = response && response.headers ? response.headers : {};
                    return {
                        provider: 'sendgrid',
                        statusCode: response && response.statusCode ? response.statusCode : null,
                        messageId: headers['x-message-id'] || null,
                    };
                })
                .catch(function (err) {
                    throw normalise(err, 'sendgrid');
                });
        },
    };
}

/**
 * Amazon SES, on aws-sdk v2.
 *
 * v2 rather than @aws-sdk/client-sesv2 deliberately: the current v3 line
 * requires Node >= 20 and several mail services still run node:11-alpine. v2
 * runs on all of them. Swapping to v3 later changes only this function.
 *
 * No credentials are passed. The SDK's default provider chain resolves them,
 * which is what lets an IRSA-annotated pod authenticate with no static key at
 * all. Local development still works through the usual AWS_* variables.
 *
 * Attachments, cc and bcc are not supported, because nothing in this platform
 * sends them — every message is a single recipient with text and/or html.
 * Supporting them would mean SendRawEmail and a MIME builder, which is a
 * different shape of work; better to not silently drop fields.
 */
function createSesTransport(options) {
    const opts = options || {};
    const region = opts.region || process.env.SES_REGION || process.env.AWS_REGION;
    const configurationSetName =
        opts.configurationSetName || process.env.SES_CONFIGURATION_SET;

    let client = opts.client;
    if (!client) {
        const AWS = require('aws-sdk');
        client = new AWS.SES({ region: region });
    }

    function buildBody(msg) {
        const body = {};
        if (msg.html) {
            body.Html = { Data: msg.html, Charset: 'UTF-8' };
        }
        if (msg.text) {
            body.Text = { Data: msg.text, Charset: 'UTF-8' };
        }
        return body;
    }

    return {
        name: 'ses',
        send: function send(msg) {
            return Promise.resolve()
                .then(function () {
                    const params = {
                        Source: msg.from,
                        Destination: { ToAddresses: [].concat(msg.to) },
                        Message: {
                            Subject: { Data: msg.subject, Charset: 'UTF-8' },
                            Body: buildBody(msg),
                        },
                    };
                    // Required for bounce and complaint events to reach SNS.
                    // Omitted rather than defaulted: an unknown configuration
                    // set name is a hard send failure, so a wrong guess would
                    // break every send.
                    if (configurationSetName) {
                        params.ConfigurationSetName = configurationSetName;
                    }
                    return client.sendEmail(params).promise();
                })
                .then(function (result) {
                    let status = null;
                    if (result && result.$response && result.$response.httpResponse) {
                        status = result.$response.httpResponse.statusCode;
                    }
                    return {
                        provider: 'ses',
                        // SendGrid returns 202 for an accepted send, SES 200.
                        // Reported as-is rather than normalised: notificationlog
                        // rows written before the cutover carry SendGrid's
                        // codes, and rewriting history would be worse than the
                        // mismatch.
                        statusCode: status,
                        messageId: result && result.MessageId ? result.MessageId : null,
                    };
                })
                .catch(function (err) {
                    throw normalise(err, 'ses');
                });
        },
    };
}

const FACTORIES = {
    sendgrid: createSendgridTransport,
    ses: createSesTransport,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function resolveProvider(explicit) {
    let name = explicit || process.env.MAIL_PROVIDER || 'sendgrid';
    name = String(name).toLowerCase().trim();
    if (!FACTORIES[name]) {
        throw new Error(
            'unknown MAIL_PROVIDER "' + name + '" — expected one of: ' + TRANSPORTS.join(', ')
        );
    }
    return name;
}

function validate(msg) {
    if (!msg || typeof msg !== 'object') {
        throw new MailError(CODES.INVALID_MESSAGE, 'none', {});
    }
    for (let i = 0; i < REQUIRED_FIELDS.length; i++) {
        const field = REQUIRED_FIELDS[i];
        if (!msg[field]) {
            // The field NAME is safe to report; its value is not.
            const err = new MailError(CODES.INVALID_MESSAGE, 'none', {});
            err.missingField = field;
            throw err;
        }
    }
    if (!msg.text && !msg.html) {
        const bodyErr = new MailError(CODES.INVALID_MESSAGE, 'none', {});
        bodyErr.missingField = 'text|html';
        throw bodyErr;
    }
}

/**
 * @param {object} config
 * @param {string} config.service     service name, for log context
 * @param {object} config.logger      a logger from ./logger or ./legacy-logger
 * @param {string} [config.provider]  'sendgrid' | 'ses'. Defaults to
 *                                    MAIL_PROVIDER, then 'sendgrid'.
 * @param {object} [config.transport] pre-built transport, for tests
 * @param {object} [config.sendgrid]  { apiKey, client }
 * @param {object} [config.ses]       { region, configurationSetName, client }
 */
function createMailer(config) {
    const cfg = config || {};
    const service = cfg.service || 'unknown';
    const logger = cfg.logger;

    if (!logger || typeof logger.info !== 'function') {
        throw new Error('createMailer requires a logger');
    }
    // Services are split between logger.x() and logger.structured.x(); accept
    // either so no call site has to know which shim it is holding.
    const log =
        logger.structured && typeof logger.structured.info === 'function'
            ? logger.structured
            : logger;

    let transport = cfg.transport;
    let providerName;

    if (transport) {
        providerName = transport.name || 'injected';
    } else {
        providerName = resolveProvider(cfg.provider);
        transport = FACTORIES[providerName](cfg[providerName] || {});
    }

    return {
        provider: providerName,

        /**
         * Send one message.
         *
         * Resolves to { provider, statusCode, messageId } and rejects with a
         * MailError carrying a safe `code`. Nothing about `msg` is ever logged:
         * recipient, subject and body are PII or PHI, and the body is rendered
         * from the record that triggered the notification.
         */
        send: function send(msg) {
            return Promise.resolve()
                .then(function () {
                    validate(msg);
                    return transport.send(msg);
                })
                .then(function (result) {
                    log.info('mail sent', {
                        function: 'mailer.send',
                        service: service,
                        provider: result.provider,
                        statusCode: result.statusCode,
                        messageId: result.messageId,
                    });
                    return result;
                })
                .catch(function (err) {
                    const mailError =
                        err instanceof MailError ? err : normalise(err, providerName);
                    const context = mailError.toContext();
                    context.function = 'mailer.send';
                    context.service = service;
                    if (mailError.missingField) {
                        // `reason` rather than a `missingField` key: it is
                        // already allow-listed, and the value is a field name,
                        // never a value.
                        context.reason = 'missing_' + mailError.missingField;
                    }
                    log.error('mail send failed', context);
                    throw mailError;
                });
        },
    };
}

module.exports = { createMailer, MailError, CODES };
