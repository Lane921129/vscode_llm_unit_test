import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeImportIssue, summarizeImportException } from '../environment/importDiagnostics';

test('missing module APIs remain identifiable when AttributeError has no name/obj metadata', () => {
    const message = "module 'example_vendor' has no attribute 'launch'";
    assert.equal(describeImportIssue({ exception_type: 'AttributeError', message }, 'module-import').issue, 'example_vendor.launch');
    for (const altered of [message + '\nextra', message + '\n', 'prefix ' + message, "module '../bad' has no attribute 'launch'"]) {
        assert.equal(describeImportIssue({ exception_type: 'AttributeError', message: altered }, 'module-import').kind, 'other');
    }
    assert.equal(describeImportIssue({ exception_type: 'RuntimeError', message }, 'module-import').kind, 'other');
    assert.equal(describeImportIssue({ exception_type: 'AttributeError', message,
        dependency_api: { module: 'actual_vendor', attribute: 'start' } }, 'module-import').issue, 'actual_vendor.start');
});

test('generic import failures preserve bounded structured exceptions without copying a traceback', () => {
    const value = { exception_type: 'ValueError', message: 'invalid mode\nexpected numeric input',
        traceback: 'must not copy arbitrary traceback', origin: { file: 'app/main.py', line: 12 } };
    assert.equal(describeImportIssue(value, 'module-import').issue, 'ValueError');
    assert.deepEqual(summarizeImportException(value), { exceptionType: 'ValueError', message: 'invalid mode expected numeric input' });
    assert.equal(summarizeImportException({ exception_type: '<unsafe>', message: 'x' }), undefined);
    assert.equal(summarizeImportException({ exception_type: 'ValueError\n', message: 'x' }), undefined);
    assert.equal(summarizeImportException(new Error('arbitrary process output')), undefined);
    assert.equal(summarizeImportException({ exception_type: 'ValueError', message: 'x'.repeat(1200) })?.message.length, 601);
});

test('import exception details omit credential-bearing and connection URL messages', () => {
    for (const message of ['api_key=private-value', 'password: private-value', 'Authorization: Bearer private-value',
        'failed https://user:private-value@example.invalid/path', 'postgresql://user:private-value@db/example',
        'x'.repeat(1000) + ' token=private-value', 'sk-' + 'a'.repeat(30), 'AIza' + 'a'.repeat(30)]) {
        const summary = summarizeImportException({ exception_type: 'RuntimeError', message });
        assert.equal(summary?.exceptionType, 'RuntimeError');
        assert.match(summary?.message || '', /已省略/);
        assert.equal(summary?.message.includes('private-value'), false);
    }
});
