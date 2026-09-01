'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMailer, CODES } = require('../mailer');
const { createLogger } = require('../logger');

/**
 * A logger that records instead of writing, so tests can assert on what would
 * have been logged. That is the control that matters most here: the point of
 * the module is that no recipient, sender, subject or body ever reaches a log
 * line, on the success path or the failure path.
 */
function recordingLogger() {
    const lines = [];
    return {
        lines,
        info(message, context) { lines.push({ level: 'info', message, context }); },
        warn(message, context) { lines.push({ level: 'warn', message, context }); },
        error(message, context) { lines.push({ level: 'error', message, context }); },
    };
}

const MSG = {
    to: 'caregiver@example-agency.com',
    from: 'support@example-agency.com',
    subject: 'Visit 4417 needs review',
    text: 'Jane Doe, DOB 1948-03-02, visit not verified',
    html: '<p>Jane Doe, DOB 1948-03-02, visit not verified</p>',
};

function sendgridClient(result) {
    return {
        setApiKey() {},
        send() { return typeof result === 'function' ? result() : Promise.resolve(result); },
    };
}

function sesClient(result) {
    return {
        sendEmail() {
            return {
                promise() {
                    return typeof result === 'function' ? result() : Promise.resolve(result);
                },
            };
        },
    };
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

test('mailer defaults to sendgrid when MAIL_PROVIDER is unset', () => {
    delete process.env.MAIL_PROVIDER;
    const mailer = createMailer({
        service: 'test',
        logger: recordingLogger(),
        sendgrid: { apiKey: 'x', client: sendgridClient([]) },
    });
    assert.equal(mailer.provider, 'sendgrid');
});

test('mailer honours MAIL_PROVIDER=ses', () => {
    process.env.MAIL_PROVIDER = 'ses';
    const mailer = createMailer({
        service: 'test',
        logger: recordingLogger(),
        ses: { region: 'us-west-2', client: sesClient({}) },
    });
    assert.equal(mailer.provider, 'ses');
    delete process.env.MAIL_PROVIDER;
});

test('mailer rejects an unknown provider by name', () => {
    assert.throws(
        () => createMailer({ service: 'test', logger: recordingLogger(), provider: 'mailgun' }),
        /unknown MAIL_PROVIDER/
    );
});

test('mailer requires a logger', () => {
    assert.throws(() => createMailer({ service: 'test' }), /requires a logger/);
});

// ---------------------------------------------------------------------------
// Result normalisation — both providers produce one shape
// ---------------------------------------------------------------------------

test('sendgrid and ses results normalise to the same shape', async () => {
    const sg = createMailer({
        service: 'test',
        logger: recordingLogger(),
        sendgrid: {
            apiKey: 'x',
            client: sendgridClient([
                { statusCode: 202, headers: { 'x-message-id': 'sg-abc' } },
                {},
            ]),
        },
    });
    assert.deepEqual(await sg.send(MSG), {
        provider: 'sendgrid',
        statusCode: 202,
        messageId: 'sg-abc',
    });

    const ses = createMailer({
        service: 'test',
        logger: recordingLogger(),
        provider: 'ses',
        ses: {
            region: 'us-west-2',
            client: sesClient({
                MessageId: 'ses-def',
                $response: { httpResponse: { statusCode: 200 } },
            }),
        },
    });
    assert.deepEqual(await ses.send(MSG), {
        provider: 'ses',
        statusCode: 200,
        messageId: 'ses-def',
    });
});

test('ses maps the message onto SendEmail parameters', async () => {
    let captured = null;
    const mailer = createMailer({
        service: 'test',
        logger: recordingLogger(),
        provider: 'ses',
        ses: {
            region: 'us-west-2',
            configurationSetName: 'nueassist-events',
            client: {
                sendEmail(params) {
                    captured = params;
                    return { promise: () => Promise.resolve({ MessageId: 'x' }) };
                },
            },
        },
    });
    await mailer.send(MSG);
    assert.equal(captured.Source, MSG.from);
    assert.deepEqual(captured.Destination.ToAddresses, [MSG.to]);
    assert.equal(captured.Message.Subject.Data, MSG.subject);
    assert.equal(captured.Message.Body.Html.Data, MSG.html);
    assert.equal(captured.Message.Body.Text.Data, MSG.text);
    assert.equal(captured.ConfigurationSetName, 'nueassist-events');
});

test('ses omits ConfigurationSetName when none is configured', async () => {
    let captured = null;
    const mailer = createMailer({
        service: 'test',
        logger: recordingLogger(),
        provider: 'ses',
        ses: {
            region: 'us-west-2',
            client: {
                sendEmail(params) {
                    captured = params;
                    return { promise: () => Promise.resolve({ MessageId: 'x' }) };
                },
            },
        },
    });
    await mailer.send(MSG);
    assert.equal('ConfigurationSetName' in captured, false);
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test('an unverified sender maps to the same code on both providers', async () => {
    const sesErr = Object.assign(
        new Error('Email address is not verified. The following identities failed: support@example-agency.com'),
        { code: 'MessageRejected', statusCode: 400 }
    );
    const ses = createMailer({
        service: 'test',
        logger: recordingLogger(),
        provider: 'ses',
        ses: { region: 'us-west-2', client: sesClient(() => Promise.reject(sesErr)) },
    });
    await assert.rejects(ses.send(MSG), (err) => {
        assert.equal(err.code, CODES.UNVERIFIED_SENDER);
        assert.equal(err.provider, 'ses');
        assert.equal(err.retryable, false);
        return true;
    });

    const sgErr = Object.assign(new Error('Forbidden'), {
        code: 403,
        response: {
            body: {
                errors: [{ message: 'The from address does not match a verified Sender Identity.' }],
            },
        },
    });
    const sg = createMailer({
        service: 'test',
        logger: recordingLogger(),
        sendgrid: { apiKey: 'x', client: sendgridClient(() => Promise.reject(sgErr)) },
    });
    // One failure taxonomy across both providers is what lets a cutover be
    // judged without reading two sets of provider errors.
    await assert.rejects(sg.send(MSG), (err) => {
        assert.equal(err.code, CODES.UNVERIFIED_SENDER);
        assert.equal(err.provider, 'sendgrid');
        return true;
    });
});

test('throttling and 5xx are classified as retryable', async () => {
    const throttled = Object.assign(new Error('Maximum sending rate exceeded'), {
        code: 'Throttling',
        statusCode: 400,
    });
    const ses = createMailer({
        service: 'test',
        logger: recordingLogger(),
        provider: 'ses',
        ses: { region: 'us-west-2', client: sesClient(() => Promise.reject(throttled)) },
    });
    await assert.rejects(ses.send(MSG), (err) => {
        assert.equal(err.code, CODES.RATE_LIMITED);
        assert.equal(err.retryable, true);
        return true;
    });

    const unavailable = Object.assign(new Error('Service Unavailable'), { code: 503 });
    const sg = createMailer({
        service: 'test',
        logger: recordingLogger(),
        sendgrid: { apiKey: 'x', client: sendgridClient(() => Promise.reject(unavailable)) },
    });
    await assert.rejects(sg.send(MSG), (err) => {
        assert.equal(err.code, CODES.PROVIDER_UNAVAILABLE);
        assert.equal(err.retryable, true);
        return true;
    });
});

test('expired IRSA credentials are classified as an auth failure', async () => {
    const expired = Object.assign(new Error('The security token included in the request is expired'), {
        code: 'ExpiredTokenException',
        statusCode: 403,
    });
    const mailer = createMailer({
        service: 'test',
        logger: recordingLogger(),
        provider: 'ses',
        ses: { region: 'us-west-2', client: sesClient(() => Promise.reject(expired)) },
    });
    await assert.rejects(mailer.send(MSG), (err) => {
        assert.equal(err.code, CODES.AUTH_FAILED);
        return true;
    });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('a missing sender fails before the transport is reached', async () => {
    let called = false;
    const mailer = createMailer({
        service: 'test',
        logger: recordingLogger(),
        transport: { name: 'sendgrid', send() { called = true; return Promise.resolve({}); } },
    });
    const noFrom = Object.assign({}, MSG);
    delete noFrom.from;

    // auth-service MFA has no fallback sender, so an unset template field
    // arrives here as undefined. Catching it locally beats a provider
    // round-trip and a confusing 400.
    await assert.rejects(mailer.send(noFrom), (err) => {
        assert.equal(err.code, CODES.INVALID_MESSAGE);
        assert.equal(err.missingField, 'from');
        return true;
    });
    assert.equal(called, false, 'transport should not have been called');
});

test('a message with neither text nor html is rejected', async () => {
    const mailer = createMailer({
        service: 'test',
        logger: recordingLogger(),
        transport: { name: 'ses', send() { return Promise.resolve({}); } },
    });
    await assert.rejects(
        mailer.send({ to: 'a@b.com', from: 'c@d.com', subject: 's' }),
        (err) => {
            assert.equal(err.missingField, 'text|html');
            return true;
        }
    );
});

// ---------------------------------------------------------------------------
// The control that matters: nothing leaks
// ---------------------------------------------------------------------------

test('no recipient, sender, subject or body reaches a log line on success', async () => {
    const logger = recordingLogger();
    const mailer = createMailer({
        service: 'notifications',
        logger,
        transport: {
            name: 'ses',
            send() { return Promise.resolve({ provider: 'ses', statusCode: 200, messageId: 'm-1' }); },
        },
    });
    await mailer.send(MSG);

    const dump = JSON.stringify(logger.lines);
    assert.equal(dump.includes('caregiver@example-agency.com'), false, 'recipient leaked');
    assert.equal(dump.includes('support@example-agency.com'), false, 'sender leaked');
    assert.equal(dump.includes('Jane Doe'), false, 'body leaked');
    assert.equal(dump.includes('Visit 4417'), false, 'subject leaked');
    assert.equal(dump.includes('m-1'), true, 'messageId should be logged');
});

test('no provider error text reaches a log line or the thrown error', async () => {
    const logger = recordingLogger();
    // SES names the rejected identity in its message. This is the exact string
    // that must not survive.
    const rejected = Object.assign(
        new Error('Email address is not verified: support@example-agency.com'),
        { code: 'MessageRejected', statusCode: 400 }
    );
    const mailer = createMailer({
        service: 'notifications',
        logger,
        provider: 'ses',
        ses: { region: 'us-west-2', client: sesClient(() => Promise.reject(rejected)) },
    });

    await assert.rejects(mailer.send(MSG), (err) => {
        const context = JSON.stringify(err.toContext());
        assert.equal(context.includes('support@example-agency.com'), false);
        // The message reaches an HTTP 400 body on the password-reset path.
        assert.equal(err.message.includes('support@example-agency.com'), false);
        return true;
    });

    const dump = JSON.stringify(logger.lines);
    assert.equal(dump.includes('support@example-agency.com'), false, 'sender leaked via error');
    assert.equal(dump.includes('not verified'), false, 'provider message leaked');
    assert.equal(dump.includes('UNVERIFIED_SENDER'), true, 'error code should be logged');
});

test('every context key the mailer emits survives the real allow-list', async () => {
    // Against the actual logger, not the recording stub: a key that is not
    // allow-listed lands in `_dropped` instead of on the line, which is how
    // `provider` was lost the first time this shipped.
    const written = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
        written.push(String(chunk));
        return original(chunk, ...rest);
    };

    try {
        const logger = createLogger({ service: 'notifications' });
        const mailer = createMailer({
            service: 'notifications',
            logger,
            transport: {
                name: 'ses',
                send() {
                    return Promise.resolve({ provider: 'ses', statusCode: 200, messageId: 'm-2' });
                },
            },
        });
        await mailer.send(MSG);
    } finally {
        process.stdout.write = original;
    }

    const line = written.find((l) => l.includes('mail sent'));
    assert.ok(line, 'expected a log line');
    const parsed = JSON.parse(line);
    assert.equal(parsed._dropped, undefined, 'no field should be dropped: ' + line);
    assert.equal(parsed.context.provider, 'ses');
    assert.equal(parsed.context.messageId, 'm-2');
});
