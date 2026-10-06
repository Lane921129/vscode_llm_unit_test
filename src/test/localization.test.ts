import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLanguage, localize, setLanguage, t, withLanguage } from '../i18n/core';
import en from '../i18n/en';
import zhTw from '../i18n/zh-tw';
import { englishMessages } from '../i18n/messages';
import { getWebviewContent } from '../ui/webviewContent';
import { presentOutcome, describeStageEvent, withOutcomeHeader } from '../pipeline/resultPresentation';
import { formatTierHistory } from '../pipeline/tierHistory';
import { validateUnittestStructure } from '../validation/generatedTestValidator';
import { createPythonInstallationPlan, installationPlanReport } from '../environment/pythonInstallationPlan';
import { classifyExecutionFailure } from '../utils/executionFailureCategory';
import { formatRepairDiagnostic, RepairDiagnostic } from '../pipeline/repairDiagnostics';
import { formatModelQualificationLog, QUALIFICATION_VERSION, selectAnalysisResponseFormat } from '../llm/modelQualification';

test('English catalog covers both dictionaries and preserves all evidence placeholders', () => {
    const keys = (object: object, prefix = ''): string[] => Object.entries(object).flatMap(([key, value]) =>
        typeof value === 'string' ? [prefix + key] : keys(value, prefix + key + '.'));
    assert.deepEqual(keys(en).sort(), keys(zhTw).sort());
    const root = path.resolve(__dirname, '../..');
    const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const defaultNls = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
    const chineseNls = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-tw.json'), 'utf8'));
    for (const match of manifest.matchAll(/"%([^%]+)%"/g)) {
        assert.equal(typeof defaultNls[match[1]], 'string');
        assert.equal(typeof chineseNls[match[1]], 'string');
        assert.doesNotMatch(defaultNls[match[1]], /\p{Script=Han}/u);
    }
    for (const [source, translated] of Object.entries(englishMessages)) {
        assert.doesNotMatch(translated, /\p{Script=Han}/u, source);
        const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
        assert.deepEqual(placeholders(translated), placeholders(source), source);
    }
    setLanguage('en');
    assert.equal(localize('模型「{0}」不存在、目前 API Key 無權使用，或不支援 generateContent。請改用可用模型：{1}', '中文{1}', 'other'),
        "Model '中文{1}' does not exist, is unavailable to this API Key, or does not support generateContent. Available models: other");
    assert.equal(localize('toString'), 'toString');
    setLanguage('zh-tw');
});

test('English renders the complete sidebar and its actual dynamic script without Chinese UI strings', () => {
    setLanguage('en');
    try {
        const html = getWebviewContent(t, 'en');
        const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '')
            .replace('繁體中文', 'Traditional Chinese'); // Language autonym is intentional.
        assert.doesNotMatch(markup, /\p{Script=Han}/u);
        assert.match(markup, /Full quality verification \(includes mutation, default\)/);
        const elements = new Map<string, any>();
        for (const match of html.matchAll(/<(?:input|select|button|textarea|p|span)[^>]*\bid="([^"]+)"[^>]*>/g)) {
            elements.set(match[1], { value: '', style: {}, addEventListener() {} });
        }
        elements.get('validation-mode').value = 'full';
        const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1];
        const context = vm.createContext({ document: { getElementById: (id: string) => elements.get(id) },
            window: { addEventListener() {} }, acquireVsCodeApi: () => ({ postMessage() {} }) });
        vm.runInContext(script, context);
        assert.match(elements.get('validation-scope').textContent, /includes mutation testing/);
        elements.get('validation-mode').value = 'execution'; vm.runInContext('updateValidationScope()', context);
        assert.match(elements.get('validation-scope').textContent, /skips mutation/);
        assert.equal(elements.get('mutpy-timeout').disabled, true);
        const badge = vm.runInContext('getScoreBadge("測試中", null)', context);
        assert.doesNotMatch(badge, /\p{Script=Han}/u);
        assert.match(badge, /Testing/); assert.doesNotMatch(badge, /#2ea043/);
        assert.doesNotMatch(vm.runInContext('getScoreBadge("失敗", "100%")', context), /\p{Script=Han}/u);
    } finally { setLanguage('zh-tw'); }
});

test('English stage, rejection, fallback and repair messages preserve non-passing outcomes', () => {
    setLanguage('en');
    try {
        const rejected = validateUnittestStructure('import unittest\nclass Tests(unittest.TestCase):\n    pass', 'target');
        assert.equal(rejected.valid, false); assert.doesNotMatch(rejected.reason!, /\p{Script=Han}/u);
        assert.match(describeStageEvent('structure', 'rejected', { reason: rejected.reason }), /Writer/);
        for (const [stage, status] of [['structure', 'passed'], ['reviewer', 'invalid-response'], ['reviewer', 'unavailable'],
            ['validation', 'accepted'], ['coverage', 'measured'], ['model-request', 'completed'], ['writer-seed', 'started'], ['writer-seed', 'accepted'],
            ['quality-experiment', 'observed'], ['quality-experiment', 'improved'], ['quality-experiment', 'unchanged'],
            ['quality-experiment-baseline', 'passed'], ['quality-novelty', 'duplicate'], ['reviewer', 'repair-requested'],
            ['candidate-artifact', 'rejected'], ['reviewer', 'approved'], ['reviewer', 'rejected'],
            ['quality-evidence', 'writer-required'], ['numeric-skill', 'verified']]) {
            assert.doesNotMatch(describeStageEvent(stage, status, {}), /\p{Script=Han}/u);
        }
        assert.match(withOutcomeHeader('原始證據{1}', { validationMode: 'execution', terminalStatus: 'execution-passed', executionVerified: true }),
            /Mutation was not run/);
        assert.ok(withOutcomeHeader('原始證據{1}', { terminalStatus: 'failed' }).endsWith('原始證據{1}'));
        const summary = formatTierHistory({ tierHistory: { requested: 'tier2', initial: 2, rounds: [{ loop: 1, start: 2 }],
            transitions: [{ loop: 1, from: 2, to: 1, reason: 'contract' }] }, executableBaseline: { tier: 1 } });
        assert.match(summary, /Automatic fallback occurred: Yes.*Round 1: Tier 2 → 1/);
        assert.match(summary, /Currently retained candidate: Tier 1/);
        assert.doesNotMatch(summary, /\p{Script=Han}/u);
        const diagnostic: RepairDiagnostic = { version: 'repair-diagnostics-v1', gate: 'response-format', reasonCodes: ['class-wrapper'],
            previousTestHash: 'hash', previousTestUnchanged: true };
        assert.doesNotMatch(formatRepairDiagnostic(1, { attempt: 1, diagnostic }), /\p{Script=Han}/u);
        assert.notEqual(presentOutcome({ terminalStatus: 'execution-passed-review-incomplete' }).kind, 'passed');
        assert.equal(selectAnalysisResponseFormat({ testGenerationReady: true, testGenerationMode: 'plain-python' }), 'text');
        assert.doesNotMatch(formatModelQualificationLog({ envType: 'local', modelName: 'fixture',
            testGenerationReady: true, testGenerationMode: '純 Python unittest', qualificationVersion: QUALIFICATION_VERSION }), /\p{Script=Han}/u);
        for (const [source, expected] of [['模型產生的程式碼內容為空 (已重試失敗)', 'model-format'],
            ['模型連續兩次未通過證據／Python unittest 驗證：{0}', 'model-format'],
            ['API 請求超時 (超過 {0} 秒總時限)', 'timeout'], ['使用者強制中止', 'cancelled'],
            ['Coverage 無法辨識目標模組；目標覆蓋狀態未知。', 'coverage'],
            ['目標分析總時限已耗盡；保留已有成果並停止。', 'timeout'],
            ['目標分析預算已耗盡（{0}）；保留已有成果並停止。', 'budget']]) {
            assert.equal(classifyExecutionFailure(localize(source, 20)), expected);
        }
    } finally { setLanguage('zh-tw'); }
});

test('English AI workflow blocking reasons explain the stopped stage without untranslated framework text', () => {
    const originalLanguage = getLanguage();
    setLanguage('en');
    try {
        for (const [source, meaning] of [
            ['工具僅提供算術假設；測試由 AI 修訂，再經實際執行驗證。', /only provides arithmetic hypotheses.*AI revises the tests.*actual execution/],
            ['完整 AI 流程需要可用的 Writer 與 Reviewer；請先完成角色測試連線。', /qualified Writer and Reviewer/],
            ['完整流程的 Auto 需要先完成 Writer 與 Reviewer 角色測試連線。', /Auto.*Writer and Reviewer role connection tests/],
            ['分析師回覆無效；已停止，尚未進入測試生成。', /Analyst response is invalid.*before test generation/],
            ['分析師未完成；已停止，尚未進入測試生成。', /Analyst did not complete.*before test generation/],
            ['完整審查證據超過預算；已保留測試，突變測試未執行。', /review evidence exceeds the budget.*mutation testing was not run/],
            ['此候選尚未取得有效審查批准；突變測試未執行。', /no valid review approval.*mutation testing was not run/]
        ] as const) {
            const label = localize(source);
            assert.doesNotMatch(label, /\p{Script=Han}/u);
            assert.match(label, meaning);
        }
        const outcome = presentOutcome({ workflowVersion: 'ai-reviewed-loop-v1', terminalStatus: 'review-blocked' });
        assert.equal(outcome.kind, 'pending');
        assert.match(outcome.label, /Review not approved/);
        assert.doesNotMatch(withOutcomeHeader('Raw evidence preserved', {
            workflowVersion: 'ai-reviewed-loop-v1', terminalStatus: 'review-blocked'
        }), /\p{Script=Han}/u);
    } finally { setLanguage(originalLanguage); }
});

test('language switches follow explicit selection and auto while active runs keep a consistent report locale', async () => {
    setLanguage('auto', 'en-US'); assert.equal(getLanguage(), 'en');
    await withLanguage(async () => {
        setLanguage('zh-tw', 'en'); await Promise.resolve();
        assert.equal(getLanguage(), 'en'); assert.equal(t('prompt.languageName'), 'English');
    });
    assert.equal(getLanguage(), 'zh-tw');
    setLanguage('en', 'zh-tw'); assert.equal(getLanguage(), 'en');
    setLanguage('auto', 'zh-TW'); assert.equal(getLanguage(), 'zh-tw');
});

test('English installation preview and report retain confirmation, valid script and package identity', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'localized-install-'));
    const Module = require('module'), originalLoad = Module._load;
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? {} : originalLoad.call(this, name, ...args); };
    setLanguage('en');
    try {
        const { installationPreviewHtml } = require('../environment/pythonInstallationPreview');
        const plan = await createPythonInstallationPlan({ python: 'python', virtual: true, projectRoot: directory,
            target: 'sample.py', missing: ['neutral_dependency'], toolRequirements: '', needsTools: false, previouslyInstalled: ['older_package'] });
        const html = installationPreviewHtml(plan, 'test-nonce');
        assert.doesNotMatch(html, /\p{Script=Han}/u);
        assert.match(html, /Confirm and install/); assert.match(html, /mapping unverified/);
        assert.match(html, /data-module="neutral_dependency" value="neutral_dependency"/);
        new vm.Script(html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/)![1]);
        assert.doesNotMatch(installationPlanReport(plan, false), /\p{Script=Han}/u);
        assert.match(installationPlanReport(plan, false), /Unconfirmed \/ cancelled; list not installed/);
    } finally { setLanguage('zh-tw'); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); }
});

test('settings changes refresh the sidebar, respect workspace overrides and defer active-view replacement', async () => {
    const Module = require('module'), originalLoad = Module._load;
    let language = 'zh-tw', receive: (message: any) => Promise<void> = async () => {};
    let changed: (event: any) => void = () => {};
    let provider: any;
    const updates: unknown[] = [], subscriptions: unknown[] = [];
    const config = { get: (key: string, fallback: unknown) => key === 'language' ? language : fallback,
        inspect: () => ({ workspaceValue: language }), update: async (_key: string, value: string, target: unknown) => {
            updates.push(target); language = value; changed({ affectsConfiguration: () => true });
        } };
    const vscode = { ExtensionMode: { Development: 2, Test: 3 }, ConfigurationTarget: { Workspace: 2 }, env: { language: 'zh-tw' },
        workspace: { getConfiguration: () => config, onDidChangeConfiguration: (listener: typeof changed) => {
            changed = listener; return { dispose() {} };
        } }, window: { registerWebviewViewProvider: (_id: string, instance: any) => { provider = instance; return { dispose() {} }; } },
        commands: { registerCommand: () => ({ dispose() {} }) } };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    try {
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture', packageJSON: { version: '0' } }, extensionMode: 3,
            globalState: { get() {} }, secrets: {}, subscriptions });
        const view = { title: '', webview: { html: '', options: {}, onDidReceiveMessage: (handler: typeof receive) => { receive = handler; } } };
        provider.resolveWebviewView(view);
        assert.match(view.title, /模型/);
        await receive({ command: 'setLanguage', lang: 'en' });
        assert.deepEqual(updates, [2]); assert.match(view.title, /Model/);
        assert.match(view.webview.html, /Saved Cloud settings/);
        provider.beginAnalysis('old'); language = 'zh-tw'; changed({ affectsConfiguration: () => true });
        assert.match(view.title, /Model/, 'do not discard a live run view');
        provider.beginAnalysis('new'); provider.endAnalysis('old'); assert.match(view.title, /Model/);
        provider.endAnalysis('new'); assert.match(view.title, /模型/);
        language = 'en'; changed({ affectsConfiguration: () => true }); assert.match(view.title, /Model/);
    } finally { Module._load = originalLoad; setLanguage('zh-tw'); }
});
