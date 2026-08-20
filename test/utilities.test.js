'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const readRoute = require('../readroute');
const permissions = require('../permission');
const users = require('../user');
const userStats = require('../user-stats');
const { createLogger } = require('../logger');
const { createRequestLogger, isValidCorrelationId } = require('../request-logger');

test('package root exports the working filter constructor', () => {
    assert.equal(require('..').constructFilters, readRoute.constructFilters);
});

test('field and feature permissions cannot be elevated', () => {
    const fieldResult = permissions.compareFields(
        { access: { read: true, write: true, delete: false } },
        { access: { read: true, write: false, delete: true } }
    );
    assert.deepEqual(fieldResult.access, { read: true, write: false, delete: false });

    const entityResult = permissions.compareTemplateTree(
        {
            access: { read: true, write: true },
            featureAccess: { exportData: true, disableMetaDataEditor: false },
            topSectionArray: [{ name: 'main', fields: [{ name: 'id', access: { read: true } }] }],
        },
        {
            friendlyName: 'Entity',
            access: { read: true, write: false },
            featureAccess: { exportData: false, disableMetaDataEditor: true },
            topSectionArray: [{ name: 'main', fields: [{ name: 'id', access: { read: true } }] }],
        }
    );
    assert.equal(entityResult.access.write, false);
    assert.equal(entityResult.featureAccess.exportData, false);
    assert.equal(entityResult.featureAccess.disableMetaDataEditor, true);
});

test('permission filters fail closed', () => {
    const denied = readRoute.constructPermittedEntitiesFilters({
        appname: 'care',
        modulename: 'records',
        entityname: 'Patient',
        user: { sys_entityAttributes: { roleName: { sys_gUid: 'role-1' } } },
        agency: {},
        roleData: {},
    });
    assert.deepEqual(denied, [{ _id: { $in: [] } }]);
});

test('all query filter families produce a match stage', () => {
    const result = readRoute.constructFinalQuery({
        globalSearchQuery: [{ $or: [{ name: 'x' }] }],
        skip: 0,
        limit: 10,
    });
    assert.deepEqual(result.dataQueryStages[0], {
        $match: { $and: [{ $or: [{ name: 'x' }] }] },
    });
    assert.equal(result.countQueryStages[1].$count, 'total_count');
});

test('constructFilters supports defaults, ObjectIds, escaped regex, and ISO datetimes', () => {
    const template = {
        sys_entityAttributes: {
            sys_topLevel: [
                { name: 'name', type: 'TEXTBOX' },
                { name: 'createdAt', type: 'DATETIME' },
            ],
        },
    };
    const objectIdResult = readRoute.constructFilters(
        { sys_ids: '["507f1f77bcf86cd799439011"]' },
        template
    );
    assert.equal(objectIdResult[0]._id.$in[0].toHexString(), '507f1f77bcf86cd799439011');

    const regexResult = readRoute.constructFilters({ name: '(a+)+$' }, template);
    assert.equal(regexResult[0]['sys_entityAttributes.name'].$regex, '\\(a\\+\\)\\+\\$');

    const dateTimeResult = readRoute.constructFilters(
        { createdAt: '2026-08-14T10:30:00.000Z:GTE' },
        template
    );
    assert.equal(
        dateTimeResult[0]['sys_entityAttributes.createdAt'].$gte,
        '2026-08-14T10:30:00.000Z'
    );
});

test('constructFilters rejects arbitrary MongoDB operators', () => {
    const template = { sys_entityAttributes: { sys_topLevel: [] } };

    // An unrecognised suffix is not an operator — the whole string stays a
    // literal value, so `$where` can never be formed.
    assert.deepEqual(
        readRoute.constructFilters({ missing: 'x:where' }, template),
        [{ 'sys_entityAttributes.missing': { $eq: 'x:where' } }]
    );
    assert.deepEqual(
        readRoute.constructFilters({ missing: 'x:$where' }, template),
        [{ 'sys_entityAttributes.missing': { $eq: 'x:$where' } }]
    );

    // A recognised operator outside the supported set is still refused rather
    // than passed through as `$cus` / `$btw`.
    assert.throws(
        () => readRoute.constructFilters({ missing: 'x:CUS' }, template),
        /Unsupported filter operator/
    );
});

test('filter values may contain colons on fields without a definition', () => {
    const template = { sys_entityAttributes: { sys_topLevel: [] } };

    assert.deepEqual(
        readRoute.constructFilters({ createdAt: '2026-08-14T10:30:00Z' }, template),
        [{ 'sys_entityAttributes.createdAt': { $eq: '2026-08-14T10:30:00Z' } }]
    );
    assert.deepEqual(
        readRoute.constructFilters({ createdAt: '2026-08-14T10:30:00Z:GTE' }, template),
        [{ 'sys_entityAttributes.createdAt': { $gte: '2026-08-14T10:30:00Z' } }]
    );
    assert.deepEqual(
        readRoute.constructFilters({ link: 'https://example.com/x' }, template),
        [{ 'sys_entityAttributes.link': { $eq: 'https://example.com/x' } }]
    );
});

test('calendar filters use supplied dates without relying on global request state', () => {
    const template = {
        sys_entityAttributes: {
            sys_topLevel: [{ name: 'visitStart', type: 'DATETIME' }],
            sys_calendar: {
                filters: [],
                eventFields: [{ startDate: 'visitStart' }],
            },
        },
    };
    const result = readRoute.constructFilters({
        isCalendar: 'true',
        startDate: '2026-08-01T00:00:00.000Z',
        endDate: '2026-08-31T23:59:59.999Z',
    }, template);
    assert.deepEqual(result, [{
        'sys_entityAttributes.visitStart': {
            $gte: '2026-08-01T00:00:00.000Z',
            $lte: '2026-08-31T23:59:59.999Z',
        },
    }]);
});

test('uppercase toggle values are parsed safely', () => {
    const template = {
        sys_entityAttributes: {
            sys_topLevel: [{ name: 'active', type: 'TOGGLE' }],
        },
    };
    const result = readRoute.constructFilters({ active: 'TRUE' }, template);
    assert.equal(result[0]['sys_entityAttributes.active'], true);
});

test('global search handles page layouts and escapes regex input', () => {
    const result = require('../globalsearch').constructGlobalSearchQuery({
        template: {
            sys_entityAttributes: {
                sys_topLevel: [{ name: 'name', type: 'TEXTBOX' }],
            },
        },
        value: '(a+)+$',
        pageLayout: 'summary',
    });
    assert.equal(result[0].sys_templateName, 'summary');
    assert.equal(result[0].$or[0]['sys_entityAttributes.name'].$regex, '\\(a\\+\\)\\+\\$');
});

test('user helpers tolerate incomplete user records', () => {
    assert.equal(users.isNJAdmin({}), false);
    assert.equal(users.isSuperAdmin({}), false);
    assert.equal(users.getUserAgency({}), false);
    assert.equal(users.getUserRole({}), false);
});

test('user statistics reject invalid client IP values without a network request', async () => {
    const result = await userStats.getUserSystemDetails({
        'ip-address': JSON.stringify({ ip: 'not-an-ip' }),
    });
    assert.deepEqual(result, {});
});

test('logger redacts common identifiers from messages and rejects host context', () => {
    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { output += chunk; return true; };
    try {
        createLogger({ service: 'test-service' }).info(
            'Contact person@example.com from 192.168.1.2',
            { host: '192.168.1.2' }
        );
    } finally {
        process.stdout.write = originalWrite;
    }

    const entry = JSON.parse(output);
    assert.equal(entry.message, 'Contact [REDACTED_EMAIL] from [REDACTED_IP]');
    assert.equal(entry._dropped.host, 'key-not-allow-listed');
});

test('failed health requests remain audit-visible', () => {
    const calls = [];
    const logger = {
        runWithCorrelationId: (id, callback) => callback(),
        error: (message, context) => calls.push({ message, context }),
        warn: (message, context) => calls.push({ message, context }),
        info: (message, context) => calls.push({ message, context }),
    };
    const middleware = createRequestLogger(logger);
    const response = new EventEmitter();
    response.statusCode = 500;
    response.writableEnded = true;
    response.setHeader = () => {};
    middleware(
        { headers: {}, path: '/health', method: 'GET', route: { path: '/health' }, baseUrl: '' },
        response,
        () => response.emit('finish')
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, 'Request failed');
});

test('correlation IDs must be UUID v4 values', () => {
    assert.equal(isValidCorrelationId('550e8400-e29b-41d4-a716-446655440000'), true);
    assert.equal(isValidCorrelationId('550e8400-e29b-11d4-a716-446655440000'), false);
});

test('uncaught exceptions terminate a child process by default', () => {
    const script = `
        const { installProcessHandlers } = require('./function-logger');
        installProcessHandlers({
            serializeError: () => ({}),
            error: () => {}
        });
        setImmediate(() => { throw new Error('fatal'); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: packageRoot });
    assert.equal(result.status, 1);
});

test('the crash log survives the exit on a backed-up stdout pipe', async () => {
    // stdout is a pipe in every container this runs in, so its writes are
    // asynchronous. `process.exit()` would discard everything still queued —
    // including the uncaught-exception line the handler exists to emit.
    const lineCount = 2000;
    const script = `
        const { installProcessHandlers } = require('./function-logger');
        const { createLogger } = require('./logger');
        const logger = createLogger({ service: 'exit-flush-test' });
        installProcessHandlers(logger);
        for (let i = 0; i < ${lineCount}; i++) logger.info('filler line number ' + i);
        setImmediate(() => { throw new Error('fatal'); });
    `;

    const child = spawn(process.execPath, ['-e', script], {
        cwd: packageRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
    });

    // Hold the pipe shut long enough for it to fill and the child to block on
    // it, which is the condition under which buffered output gets dropped.
    child.stdout.pause();
    let output = '';
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stdout.resume();

    const exitCode = await new Promise((resolve) => child.on('close', resolve));

    assert.equal(exitCode, 1);
    const lines = output.trim().split('\n');
    assert.equal(lines.length, lineCount + 1);
    assert.equal(JSON.parse(lines[lines.length - 1]).message, 'Uncaught exception');
});
