import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentOutcome, presentSummaryOutcome, stageLabel, withOutcomeHeader, describeStageEvent } from '../pipeline/resultPresentation';
import { formatTierHistory, TierHistory } from '../pipeline/tierHistory';
import { describeImportIssue } from '../environment/importDiagnostics';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import zhTw from '../i18n/zh-tw';
import { getLanguage, setLanguage } from '../i18n/core';

test('mutation progress is localized and never describes selection as a completed measurement', () => {
    const originalLanguage = getLanguage();
    try {
        for (const lang of ['zh-tw', 'en']) {
            setLanguage(lang);
            const selected = describeStageEvent('mutation-engine', 'selected', { actual: 'mutatest', raw: 'PRIVATE_RESPONSE' });
            const failed = describeStageEvent('mutation-engine', 'failed', { reason: 'package-missing', raw: 'PRIVATE_RESPONSE' });
            const started = describeStageEvent('mutation', 'started', { engine: 'mutatest', raw: 'PRIVATE_RESPONSE' });
            assert.match(selected, lang === 'en' ? /awaiting measurement/ : /等待量測/);
            assert.match(failed, lang === 'en' ? /package-missing; stopped without switching/ : /package-missing；已停止，未更換/);
            assert.match(started, lang === 'en' ? /after completion/ : /完成後才能判定/);
            for (const label of [selected, failed, started]) {
                assert.doesNotMatch(label, /PRIVATE_RESPONSE/);
                if (lang === 'en') { assert.doesNotMatch(label, /\p{Script=Han}/u); }
            }
            assert.doesNotMatch(describeStageEvent('mutation-engine', 'failed', { raw: 'PRIVATE_RESPONSE' }), /PRIVATE_RESPONSE/);
        }
    } finally { setLanguage(originalLanguage); }
});

test('progress explains rejection, incomplete review and intermediate acceptance without raw replies', () => {
    assert.match(describeStageEvent('structure', 'rejected', { reason: '沒有 test_ 方法', raw: 'PRIVATE_RESPONSE' }), /沒有 test_ 方法.*Writer/);
    assert.doesNotMatch(describeStageEvent('structure', 'rejected', { raw: 'PRIVATE_RESPONSE' }), /PRIVATE_RESPONSE/);
    assert.match(describeStageEvent('reviewer', 'invalid-response', { diagnostics: ['target-self-mock'], raw: 'PRIVATE_RESPONSE' }), /target-self-mock.*不採用/);
    assert.match(describeStageEvent('reviewer', 'unavailable', {}), /審查未完成.*繼續工具量測/);
    assert.match(describeStageEvent('validation', 'accepted', {}), /不代表完整通過/);
    assert.match(describeStageEvent('validation', 'passed', {}, 'execution'), /本模式不執行品質審查與突變/);
    assert.doesNotMatch(describeStageEvent('validation', 'accepted', {}, 'execution'), /繼續量測突變/);
    for (const [stage, status] of [['structure', 'passed'], ['scenarios', 'observed'], ['coverage', 'measured'],
        ['validation', 'passed'], ['executable-baseline', 'checkpointed'], ['model-request', 'requested'], ['model-request', 'completed'], ['writer-seed', 'started'], ['writer-seed', 'accepted'],
            ['quality-experiment', 'observed'], ['quality-experiment', 'improved'], ['quality-experiment', 'unchanged'],
            ['quality-experiment-baseline', 'passed'], ['quality-novelty', 'duplicate'], ['reviewer', 'repair-requested'],
            ['candidate-artifact', 'rejected']]) {
        assert.notEqual(describeStageEvent(stage, status, {}), status);
    }
});

test('tier summary preserves fallback history across a restart, rollback and interrupted measurement', () => {
    const history: TierHistory = { requested: 'tier2', initial: 2,
        rounds: [{ loop: 1, start: 2 }, { loop: 2, start: 2 }],
        transitions: [{ loop: 1, from: 2, to: 1, reason: '候選驗證失敗' }] };
    const state = { tierHistory: history, executableBaseline: { tier: 2 } };
    const running = formatTierHistory(state);
    assert.match(running, /曾自動降級：是.*第 1 輪 Tier 2 → 1/);
    assert.match(running, /第 2 輪 Tier 2/);
    assert.match(running, /目前保留候選：Tier 2/);
    assert.match(formatTierHistory({ ...state, acceptedTest: 'loop1_test.py', resolvedTier: 1 }), /目前保留候選：Tier 1/);
    assert.match(formatTierHistory({ tierHistory: history }), /尚無已驗證候選/);
    assert.equal(formatTierHistory({ resolvedTier: 2 }), '', 'old reports must not invent a transition history');
});

test('final status cannot be promoted by a high-scoring retained candidate or partial stage success', () => {
    for (const terminalStatus of ['failed', 'retained-after-failure', 'execution-passed-review-incomplete',
        'running', 'round-limit', 'stagnated', 'no-mutation-candidates', 'dummy-skipped', 'stub-skipped', 'stub-smoke-generated', 'cancelled', 'unknown']) {
        assert.notEqual(presentOutcome({ terminalStatus, qualityAssessment: { fullyPassed: true } }).kind, 'passed');
    }
    assert.notEqual(presentOutcome({ terminalStatus: 'passed' }).kind, 'passed');
    assert.notEqual(presentOutcome({ terminalStatus: 'passed', validationMode: 'execution', qualityAssessment: { fullyPassed: true } }).kind, 'passed');
    assert.notEqual(presentOutcome({ terminalStatus: 'execution-passed', validationMode: 'execution' }).kind, 'executed');
    assert.equal(presentOutcome({ terminalStatus: 'passed', qualityAssessment: { fullyPassed: true } }).kind, 'passed');
    assert.equal(presentOutcome({ terminalStatus: 'passed', evidenceValid: false, qualityAssessment: { fullyPassed: true } }).kind, 'failed');
    const body = '# Evidence\n\nRan 2 tests\nOK\ncoverage 100%';
    const report = withOutcomeHeader(body, { terminalStatus: 'failed', failureCategory: 'environment' });
    assert.match(report.split('\n')[0], /未通過：匯入／環境受阻/);
    assert.ok(report.endsWith(body), 'original evidence remains intact');
    assert.match(stageLabel('passed'), /非最終結果/);
});

test('execution-only outcomes explain absent mutation even after a successful run', () => {
    const evidence = { validationMode: 'execution', terminalStatus: 'execution-passed', executionVerified: true };
    assert.match(presentOutcome(evidence).label, /未執行突變/);
    const report = withOutcomeHeader('# Saved evidence', evidence);
    assert.match(report, /突變測試未執行：本次選擇/);
    assert.match(report, /完整品質驗證（含突變）.*重新執行/);
    assert.ok(report.endsWith('# Saved evidence'));
    assert.doesNotMatch(withOutcomeHeader('# Full run', { validationMode: 'full', terminalStatus: 'running' }), /本次選擇「僅執行驗證」/);
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
        const html = vm.runInNewContext(renderer + ';getScoreBadge("100%", "100%", outcome)', { outcome, i18n: zhTw.ui });
        assert.doesNotMatch(html, /#2ea043/);
        assert.ok(html.includes(outcome.label));
        assert.match(html, /100%/);
    }
    const outcome = presentOutcome({ terminalStatus: 'passed', qualityAssessment: { fullyPassed: true } });
    assert.match(vm.runInNewContext(renderer + ';getScoreBadge("100%", "100%", outcome)', { outcome, i18n: zhTw.ui }), /#2ea043/);
});


test('demo summary omits incomplete review without claiming full approval or hiding real failures', () => {
    const evidence = { terminalStatus: 'execution-passed-review-incomplete',
        qualityAssessment: { toolsSatisfied: true, fullyPassed: false } };
    assert.match(presentSummaryOutcome(evidence).label, /測試執行與量測達標/);
    assert.equal(presentSummaryOutcome(evidence).kind, 'pending');
    assert.match(presentOutcome(evidence).label, /審查未完成/);
    for (const extra of [{ evidenceValid: false }, { failureCategory: 'environment' },
        { terminalStatus: 'failed' }, { terminalStatus: 'retained-after-failure' },
        { qualityAssessment: { toolsSatisfied: false, fullyPassed: false } }]) {
        assert.notEqual(presentSummaryOutcome({ ...evidence, ...extra }).label, presentSummaryOutcome(evidence).label);
    }
});
