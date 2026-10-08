import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeImportIssue, summarizeImportException } from '../environment/importDiagnostics';

test('missing isolated schema has actionable fixture advice without guessing an assertion', () => {
    const issue = describeImportIssue({ exception_type: 'TraceSafetyError', blocked_operation: 'resource-schema-required' }, 'module-import');
    assert.equal(issue.issue, 'resource-schema-required');
    assert.match(issue.advice, /隔離測試資源/);
    assert.match(issue.advice, /不會猜/);
    assert.equal(describeImportIssue({ exception_type: 'ValueError', blocked_operation: 'resource-schema-required' }, 'module-import').kind, 'other');
});

test('runtime policy labels with spaces retain initialization diagnostics without copying arbitrary text', () => {
    for (const operation of ['network connection', 'file read', 'shell / subprocess', 'os.mkdir']) {
        const issue = describeImportIssue({ exception_type: 'TraceSafetyError', blocked_operation: operation,
            origin: { file: 'main.py', line: 2322 } }, 'module-import');
        assert.equal(issue.kind, 'import-side-effect');
        assert.equal(issue.issue, operation);
        assert.match(issue.advice, /初始化設定/);
    }
    for (const operation of ['network connection\n', 'file read password=private-value', 'https://example.invalid']) {
        assert.equal(describeImportIssue({ exception_type: 'TraceSafetyError', blocked_operation: operation }, 'module-import').kind, 'other');
    }
});

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

test('preflight tool diagnostics retain only known codes and safe metadata', () => {
    for (const reasonCode of ['timeout', 'process-failed', 'invalid-result']) {
        const diagnostic = { schemaVersion: 'module-preflight-tool-diagnostic-v1', reasonCode, exitCode: 17,
            stderr: 'private-fixture', message: 'private-fixture', reason: 'private-fixture' };
        const summary = summarizeImportException(diagnostic);
        assert.equal(summary?.reasonCode, reasonCode); assert.equal(summary?.exitCode, 17);
        assert.equal(summary?.exceptionType, 'ModulePreflightToolError');
        assert.doesNotMatch(JSON.stringify(summary), /private-fixture|stderr/);
        assert.equal(describeImportIssue(diagnostic, 'module-preflight').issue, reasonCode);
        assert.equal(describeImportIssue(diagnostic, 'module-preflight').kind, 'other');
    }
    for (const diagnostic of [{ reasonCode: 'timeout' },
        { schemaVersion: 'module-preflight-tool-diagnostic-v1', reasonCode: 'private-fixture' }]) {
        assert.equal(summarizeImportException(diagnostic), undefined);
    }
    const invalidCode = summarizeImportException({ schemaVersion: 'module-preflight-tool-diagnostic-v1',
        reasonCode: 'invalid-result', exitCode: 'private-fixture', detailCode: 'private-fixture' });
    assert.equal(invalidCode?.exitCode, undefined); assert.equal(invalidCode?.detailCode, undefined);
});
