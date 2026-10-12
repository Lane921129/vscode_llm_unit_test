import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { partitionBatchPreflight, safeBatchPreflightRows, BatchPreflightRow } from '../pipeline/batchPreflightPartition';

const targets = [{ id: 0, file: 'plain.py', target: 'calculate' },
    { id: 1, file: 'app/consumer.py', target: 'Client.load' }, { id: 2, file: 'app/consumer.py', target: 'helper' }];
const observed = { actualImports: true, identityValid: true };
const blocked: BatchPreflightRow = { file: 'app/consumer.py', status: 'blocked', stage: 'module-import',
    issue: { kind: 'import-side-effect', issue: 'network connection', advice: 'Use an explicit mock.', origin: { file: 'app/dependency.py', line: 12 } },
    diagnostic: { exceptionType: 'TraceSafetyError', message: 'Dynamic trace safety gate blocked network connection' } };

test('one blocked import dependency does not stop an independently loaded source in the same selected root', () => {
    const result = partitionBatchPreflight(targets, [{ file: 'plain.py', status: 'loaded' }, blocked], observed);
    assert.equal(result.status, 'partial'); assert.deepEqual(result.runnableIds, [0]);
    assert.deepEqual(result.blocked.map(target => [target.id, target.target, target.reason]),
        [[1, 'Client.load', 'module-blocked'], [2, 'helper', 'module-blocked']]);
    assert.deepEqual(result.blocked[0].environment.origin, { file: 'app/dependency.py', line: 12 });
});

test('an unchecked source remains blocked even if its dependency or neighbouring source loaded', () => {
    const result = partitionBatchPreflight(targets, [{ file: 'plain.py', status: 'loaded' },
        { file: 'app/dependency.py', status: 'loaded' }], observed);
    assert.deepEqual(result.runnableIds, [0]); assert.equal(result.blocked[0].reason, 'not-checked');
    assert.equal(result.blocked[0].environment.issue, 'preflight-not-checked');
});

test('incomplete tools, static planning and conflicting rows cannot become readiness', () => {
    for (const rows of [
        [{ file: 'app/consumer.py', status: 'incomplete' }],
        [{ file: 'app/consumer.py', status: 'loaded', stage: 'initialization-plan' }],
        [{ file: 'app/consumer.py', status: 'blocked', stage: 'module-preflight',
            diagnostic: { exceptionType: 'ModulePreflightToolError', message: 'incomplete', reasonCode: 'timeout' } }],
        [{ file: 'app/consumer.py', status: 'loaded' }, blocked],
        [{ file: 'app/consumer.py', status: 'loaded', issue: blocked.issue }]
    ] as BatchPreflightRow[][]) {
        const result = partitionBatchPreflight(targets, [{ file: 'plain.py', status: 'loaded' }, ...rows], observed);
        assert.deepEqual(result.runnableIds, [0]); assert.equal(result.blocked[0].reason, 'diagnostic-incomplete');
    }
    assert.equal(partitionBatchPreflight(targets, [{ file: 'plain.py', status: 'loaded' }],
        { ...observed, actualImports: false }).invalidReason, 'not-observed');
});

test('all blocked or absent sources have no runnable targets and never imply a pass', () => {
    const result = partitionBatchPreflight(targets, [blocked], observed);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.runnableIds, []); assert.equal(result.blocked.length, 3);
    const ready = partitionBatchPreflight(targets, [{ file: 'plain.py', status: 'loaded' }, { file: 'app/consumer.py', status: 'loaded' }], observed);
    assert.equal(ready.status, 'ready'); assert.deepEqual(ready.runnableIds, [0, 1, 2]);
});

test('cancellation or changed source identity prevents every continuation without inventing environment failures', () => {
    for (const options of [{ ...observed, cancelled: true }, { ...observed, identityValid: false }]) {
        const result = partitionBatchPreflight(targets, [{ file: 'plain.py', status: 'loaded' }, blocked], options);
        assert.equal(result.status, 'invalid'); assert.deepEqual(result.runnableIds, []); assert.deepEqual(result.blocked, []);
    }
});

test('invalid or duplicated target identities cannot schedule or mutate a journal', () => {
    for (const changed of [[...targets, targets[0]], [{ ...targets[0], file: '../outside.py' }], [{ ...targets[0], target: ' ' }]]) {
        assert.equal(partitionBatchPreflight(changed, [{ file: 'plain.py', status: 'loaded' }], observed).invalidReason, 'invalid-targets');
    }
});

test('preflight snapshots retain bounded diagnostics without credentials, provider objects or out-of-root paths', () => {
    const rows = safeBatchPreflightRows([{ ...blocked,
        issue: { ...blocked.issue!, issue: 'https://fixture.invalid/?token=hidden-value', advice: 'api_key=hidden-value',
            origin: { file: '../outside.py', line: 2 } },
        diagnostic: { exceptionType: 'TraceSafetyError', message: 'Bearer hidden-value' } },
    { file: '../outside.py', status: 'loaded' }]);
    assert.equal(rows.length, 1); assert.equal(rows[0].issue?.origin, undefined);
    assert.doesNotMatch(JSON.stringify(rows), /hidden-value|https:\/\//);
    assert.equal(rows[0].diagnostic?.exceptionType, 'TraceSafetyError');
    assert.deepEqual(Object.keys(rows[0]).sort(), ['diagnostic', 'file', 'issue', 'stage', 'status']);
});
