import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { executionHelperRepairGuidance, sourceHelperUsePointNames } from '../prompts/dependencyMockContract';
import { createHash } from 'node:crypto';

const context = { name: 'select_item', calls: ['refresh', 'other'] };
const failure = (file: string, name = 'refresh') => `  File "${file}", line 8, in ${name}\n`
    + "AttributeError: 'SimpleNamespace' object has no attribute 'controls'";

test('direct same-module helpers remain available even without from-import dependencies', () => {
    const code = 'def refresh(value):\n    return None';
    const helper = { name: 'refresh', code, sourceHash: createHash('sha256').update(code).digest('hex'),
        retrieval: { kind: 'same-module-symbol', depth: 1 } };
    assert.deepEqual(sourceHelperUsePointNames({ ...context, dependencies: [], localDependencyContexts: [helper] }), ['refresh']);
    for (const change of [{ sourceHash: '0'.repeat(64) }, { name: 'unknown' },
        { retrieval: { kind: 'same-module-symbol', depth: 2 } }, { retrieval: { kind: 'external', depth: 1 } }]) {
        assert.deepEqual(sourceHelperUsePointNames({ ...context, localDependencyContexts: [{ ...helper, ...change }] }), []);
    }
});

test('fixture repair gives one exact source helper context without supplying an input or expected assertion', () => {
    const text = executionHelperRepairGuidance(failure(__filename), 'subject', __filename, context, ['refresh']);
    assert.match(text, /with patch\("subject\.refresh"\):/);
    assert.match(text, /may edit setup local to the failing test method/);
    assert.match(text, /Keep passing methods and module\/class fixtures unchanged/);
    assert.match(text, /not executable/);
    assert.doesNotMatch(text, /assertEqual|assertIn|selected_plates|return_value\s*=/);
});

test('unknown helpers, other source files and non-attribute failures do not create a fixture task', () => {
    for (const [output, helpers] of [[failure(__filename, 'unknown'), ['refresh']],
        [failure(__filename + '.missing'), ['refresh']],
        ['AssertionError: mismatch', ['refresh']], [failure(__filename), ['unrelated']]] as Array<[string, string[]]>) {
        assert.equal(executionHelperRepairGuidance(output, 'subject', __filename, context, helpers), '');
    }
});

test('target recursion, class ownership, invalid modules and ambiguous helper traces stay unknown', () => {
    assert.equal(executionHelperRepairGuidance(failure(__filename, 'select_item'), 'subject', __filename,
        { ...context, calls: ['select_item'] }, ['select_item']), '');
    assert.equal(executionHelperRepairGuidance(failure(__filename), 'subject', __filename,
        { ...context, class_name: 'Owner' }, ['refresh']), '');
    assert.equal(executionHelperRepairGuidance(failure(__filename), 'invalid-module', __filename, context, ['refresh']), '');
    assert.equal(executionHelperRepairGuidance(failure(__filename) + '\n' + failure(__filename, 'other'),
        'subject', __filename, context, ['refresh', 'other']), '');
});
