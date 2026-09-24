import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentOutcome, stageLabel, withOutcomeHeader } from '../pipeline/resultPresentation';
import { describeImportIssue } from '../environment/importDiagnostics';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

test('final status cannot be promoted by a high-scoring retained candidate or partial stage success', () => {
    for (const terminalStatus of ['failed', 'retained-after-failure', 'execution-passed-review-incomplete',
        'running', 'round-limit', 'stagnated', 'no-mutation-candidates', 'dummy-skipped', 'stub-skipped', 'stub-smoke-generated', 'cancelled', 'unknown']) {
        assert.notEqual(presentOutcome({ terminalStatus, qualityAssessment: { fullyPassed: true } }).kind, 'passed');
    }
    assert.notEqual(presentOutcome({ terminalStatus: 'passed' }).kind, 'passed');
    assert.equal(presentOutcome({ terminalStatus: 'passed', qualityAssessment: { fullyPassed: true } }).kind, 'passed');
    assert.equal(presentOutcome({ terminalStatus: 'passed', evidenceValid: false, qualityAssessment: { fullyPassed: true } }).kind, 'failed');
    const body = '# Evidence\n\nRan 2 tests\nOK\ncoverage 100%';
    const report = withOutcomeHeader(body, { terminalStatus: 'failed', failureCategory: 'environment' });
    assert.match(report.split('\n')[0], /未通過：匯入／環境受阻/);
    assert.ok(report.endsWith(body), 'original evidence remains intact');
    assert.match(stageLabel('passed'), /非最終結果/);
});

test('API incompatibility and unsafe initialization have different bounded advice', () => {
    const api = describeImportIssue({ exception_type: 'AttributeError', dependency_api: { module: 'vendor', attribute: 'launch' } }, 'module-import');
    assert.equal(api.kind, 'dependency-api'); assert.equal(api.issue, 'vendor.launch');
    const mkdir = describeImportIssue({ exception_type: 'TraceSafetyError', blocked_operation: 'os.mkdir',
        origin: { file: 'sub/config.py', line: 3 } }, 'module-import');
    assert.equal(mkdir.kind, 'import-side-effect'); assert.equal(mkdir.origin?.file, 'sub/config.py');
    assert.equal(describeImportIssue({ origin: { file: '../outside.py', line: 3 } }, 'module-import').origin, undefined);
    assert.equal(describeImportIssue({ exception_type: 'AttributeError', dependency_api: { module: 'raw\ntext', attribute: 'x' } }, 'module-import').kind, 'other');
});

test('the actual result-card renderer keeps 100% neutral unless the final outcome fully passes', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/ui/webviewContent.ts'), 'utf8');
    const renderer = source.slice(source.indexOf('function escapeHtml('), source.indexOf('function toggleItemCheck('));
    for (const terminalStatus of ['failed', 'retained-after-failure', 'execution-passed-review-incomplete', 'running']) {
        const outcome = presentOutcome({ terminalStatus, qualityAssessment: { fullyPassed: true } });
        const html = vm.runInNewContext(renderer + ';getScoreBadge("100%", "100%", outcome)', { outcome });
        assert.doesNotMatch(html, /#2ea043/);
        assert.ok(html.includes(outcome.label));
        assert.match(html, /100%/);
    }
    const outcome = presentOutcome({ terminalStatus: 'passed', qualityAssessment: { fullyPassed: true } });
    assert.match(vm.runInNewContext(renderer + ';getScoreBadge("100%", "100%", outcome)', { outcome }), /#2ea043/);
});
