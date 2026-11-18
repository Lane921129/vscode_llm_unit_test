import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vm from 'node:vm';
import { getWebviewContent } from '../ui/webviewContent';
import { setLanguage, t } from '../i18n/core';

/** A small DOM for replaying the shipped script, including detached details and
 * delayed toggle delivery. No dashboard function is replaced by a test double. */
class ReplayElement {
    readonly children: ReplayElement[] = [];
    readonly style: Record<string, string> = {};
    readonly dataset: Record<string, string> = {};
    readonly listeners = new Map<string, ((event: any) => void)[]>();
    parent?: ReplayElement;
    root = false;
    className = '';
    value = '';
    checked = false;
    disabled = false;
    open = false;
    textContent = '';
    innerText = '';
    title = '';
    type = '';
    tabIndex = -1;
    onclick?: (event?: any) => void;
    onchange?: (event?: any) => void;
    onkeydown?: (event?: any) => void;
    private markup = '';
    constructor(readonly tag: string) {}
    get innerHTML(): string { return this.markup; }
    set innerHTML(value: string) {
        this.markup = value;
        for (const child of this.children) { child.parent = undefined; }
        this.children.length = 0;
        if (this.tag === 'select') { this.value = value.match(/<option\b[^>]*value="([^"]*)"/)?.[1] || ''; }
    }
    get isConnected(): boolean { return this.root || !!this.parent?.isConnected; }
    appendChild(child: ReplayElement): void { child.parent = this; this.children.push(child); }
    addEventListener(event: string, handler: (event: any) => void): void {
        this.listeners.set(event, [...(this.listeners.get(event) || []), handler]);
    }
    dispatch(event: string): void { for (const handler of this.listeners.get(event) || []) { handler({ target: this }); } }
    descendants(): ReplayElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
}
class ReplayInput extends ReplayElement {}

function replay(language: string, initialState: Record<string, unknown> = {}) {
    setLanguage(language);
    const html = getWebviewContent(t);
    const elements = new Map<string, ReplayElement>();
    for (const match of html.matchAll(/<(input|select|button|textarea|p|span|div|details)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const element = match[1] === 'input' ? new ReplayInput('input') : new ReplayElement(match[1]);
        element.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
        element.root = true;
        if (element.tag === 'details') { element.open = /\sopen(?:[\s=>])/.test(match[0]); }
        elements.set(match[2], element);
    }
    const element = (id: string) => { const item = elements.get(id); assert.ok(item, id); return item; };
    element('validation-mode').value = 'full';
    element('env-type').value = 'local';
    element('model-select').value = 'fixture-model';
    element('project-path').value = '/fixture';
    const messages: any[] = [];
    const persistedState: Record<string, unknown> = { ...initialState };
    let receive!: (event: { data: unknown }) => void;
    const groups = () => element('dashboard-container').descendants().filter(item => item.className === 'file-group');
    const context = vm.createContext({
        document: {
            getElementById: element,
            createElement: (tag: string) => tag === 'input' ? new ReplayInput(tag) : new ReplayElement(tag),
            querySelectorAll: (selector: string) => {
                assert.equal(selector, '#dashboard-container details.file-group');
                return groups();
            }
        },
        HTMLInputElement: ReplayInput,
        window: { addEventListener: (event: string, handler: typeof receive) => { if (event === 'message') { receive = handler; } } },
        acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message),
            getState: () => ({ ...persistedState }),
            setState: (state: Record<string, unknown>) => { Object.assign(persistedState, JSON.parse(JSON.stringify(state))); } })
    });
    vm.runInContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1], context);
    const send = (data: unknown) => receive({ data });
    const run = (source: string) => vm.runInContext(source, context);
    const coverage = (file: string, func = 'first') => send({ command: 'updateCoverage', fileName: file + ':' + func,
        file, func, score: '測試中', coverage: 'N/A', reason: '' });
    return { html, element, groups, messages, send, run, coverage, persistedState };
}

/** PR #19: Start never falls back to a whole-folder run, so tests that start a batch first make an explicit scope choice,
 * exactly as "Choose batch sources" reports it to the Webview. */
function chooseExplicitScope(ui: ReturnType<typeof replay>, projectRoot = '/fixture') {
    ui.send({ command: 'batchScopeSelected', projectRoot, text: 'scope', selectedFiles: ['scope.py'],
        targets: [{ file: 'scope.py', target: 'first', selected: true }] });
}

test('grouped dashboard preserves live collapsed folders through running updates, mode switches and delayed toggles', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            const ui = replay(language);
            chooseExplicitScope(ui);
            ui.coverage('database.py');
            ui.coverage('config.py');
            ui.run("setViewMode('grouped')");
            const oldDatabase = ui.groups()[0];
            oldDatabase.open = false; // Real toggle notification can be queued after the next Host message.
            ui.coverage('database.py', 'second');
            assert.equal(ui.groups()[0].open, false);
            assert.equal(ui.groups()[1].open, true, 'other file stays independently expanded');
            ui.groups()[0].open = true;
            ui.groups()[0].dispatch('toggle');
            oldDatabase.dispatch('toggle'); // Detached old nodes must not overwrite the current choice.
            ui.send({ command: 'updateOutcome', fileName: 'database.py:first', outcome: { label: 'Failed', kind: 'failed' } });
            assert.equal(ui.groups()[0].open, true);
            ui.groups()[0].open = false;
            ui.groups()[0].dispatch('toggle');
            ui.send({ command: 'attachResultReport', fileName: 'database.py:first', reportPath: '/fixture/final_report.md' });
            assert.equal(ui.groups()[0].open, false);
            ui.run("setViewMode('flat'); setViewMode('grouped')");
            assert.equal(ui.groups()[0].open, false);
            ui.run('setAllGroupsOpen(false)');
            ui.coverage('new.py');
            assert.ok(ui.groups().every(group => !group.open), 'collapse all also applies to new file groups');
            ui.run('setAllGroupsOpen(true)');
            ui.coverage('config.py', 'third');
            assert.ok(ui.groups().every(group => group.open));
            ui.element('btn-run').onclick!();
            ui.send({ command: 'analysisFinished' });
            ui.run('setAllGroupsOpen(false)');
            ui.element('project-path').value = '/another-fixture';
            ui.element('btn-run').onclick!();
            assert.equal(ui.groups().length, 0);
            ui.coverage('database.py');
            assert.equal(ui.groups()[0].open, true, 'a different project starts with independent group state');
        }
    } finally { setLanguage('zh-tw'); }
});

test('dashboard redraw preserves checkbox selection and report actions with separated title and metric rows', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            const ui = replay(language);
            ui.coverage('很長的受測檔名.py', 'Service.a_very_long_qualified_method');
            const card = ui.element('dashboard-container').children[0];
            const header = card.children[0];
            assert.equal(header.children[0].className, 'result-title');
            assert.equal(header.children[1].className, 'result-metrics');
            const title = header.children[0];
            assert.equal(title.children[1].className, 'result-label');
            assert.match(title.children[1].innerHTML, /很長的受測檔名\.py/);
            assert.match(title.children[1].innerHTML, /Service\.a_very_long_qualified_method/);
            const checkbox = title.children[0];
            checkbox.checked = true;
            checkbox.onchange!();
            ui.send({ command: 'attachResultReport', fileName: '很長的受測檔名.py:Service.a_very_long_qualified_method', reportPath: '/fixture/report.md' });
            ui.run("setViewMode('grouped')");
            const updatedCard = ui.groups()[0].children[1].children[0];
            assert.equal(updatedCard.children[0].children[0].children[0].checked, true);
            updatedCard.onclick!({ target: updatedCard });
            assert.equal(ui.messages.at(-1).command, 'openTestResult');
            assert.equal(ui.messages.at(-1).reportPath, '/fixture/report.md');
            const style = ui.html.match(/<style>([\s\S]*?)<\/style>/)![1];
            assert.match(style, /\.result-header\s*\{[^}]*flex-direction:\s*column/);
            assert.match(style, /\.result-label\s*\{[^}]*word-break:\s*normal/);
            assert.doesNotMatch(style, /word-break:\s*break-all/);
            assert.match(style, /\.dashboard-view-toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
        }
    } finally { setLanguage('zh-tw'); }
});

test('abort reaches the Host and keeps the sidebar locked until cleanup actually finishes', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            const ui = replay(language);
            chooseExplicitScope(ui);
            ui.element('btn-run').onclick!();
            assert.equal(ui.messages.at(-1).command, 'startBatchAnalysis');
            assert.equal(ui.element('prompt-strategy').disabled, true);
            const runningCount = ui.messages.length;
            ui.element('prompt-strategy').onchange!({ target: { value: 'tier2' } });
            assert.equal(ui.messages.length, runningCount, 'running analysis cannot rebuild its Webview through a Tier change');
            ui.element('btn-abort').onclick!();
            assert.equal(ui.messages.at(-1).command, 'abortTest');
            assert.equal(ui.element('btn-run').disabled, true, 'clicking stop alone never claims completion');
            const stopping = language === 'en' ? 'Stopping and cleaning up…' : '正在中止並清理…';
            ui.send({ command: 'analysisStopping', text: stopping });
            assert.equal(ui.element('btn-abort').textContent, stopping);
            assert.equal(ui.element('btn-abort').style.display, 'block');
            assert.equal(ui.element('btn-abort').disabled, true);
            ui.send({ command: 'environmentPreparationFinished' });
            const count = ui.messages.length;
            ui.element('btn-run').onclick!();
            assert.equal(ui.messages.length, count, 'environment cleanup cannot unlock a stopping analysis');
            assert.equal(ui.element('model-select').disabled, true);
            assert.equal(ui.element('prompt-strategy').disabled, true);
            ui.element('prompt-strategy').onchange!({ target: { value: 'tier3' } });
            assert.equal(ui.messages.length, count, 'stopping analysis cannot rebuild its Webview through a Tier change');
            ui.send({ command: 'analysisFinished' });
            assert.equal(ui.element('btn-run').disabled, false);
            assert.equal(ui.element('btn-abort').style.display, 'none');
            assert.equal(ui.element('btn-abort').disabled, false);
            assert.equal(ui.element('btn-abort').textContent, t('ui.abortBtn'));
            assert.equal(ui.element('prompt-strategy').disabled, false);
            ui.element('prompt-strategy').onchange!({ target: { value: 'tier2' } });
            assert.equal(ui.messages.at(-1).command, 'setPromptStrategy');
            assert.equal(ui.messages.at(-1).strategy, 'tier2');
            ui.element('btn-run').onclick!();
            assert.equal(ui.messages.at(-1).command, 'startBatchAnalysis');
        }
    } finally { setLanguage('zh-tw'); }
});

test('timing controls distinguish long API waits from each function total and freeze with the run', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            const ui = replay(language);
            chooseExplicitScope(ui);
            ui.send({ command: 'executionTimingSettings', timeoutSeconds: 1800, targetTimeoutSeconds: 3600 });
            assert.equal(Number(ui.element('timeout-sec').value), 1800);
            assert.equal(Number(ui.element('target-timeout-sec').value), 3600);
            assert.match(ui.element('execution-timing-status').textContent, /1800/);
            assert.match(ui.element('execution-timing-status').textContent, /3600/);
            if (language === 'en') {
                assert.match(ui.html, /Total time limit per function/);
                assert.doesNotMatch(ui.element('execution-timing-status').textContent, /[\u3400-\u9fff]/);
            }
            ui.element('btn-run').onclick!();
            assert.equal(ui.messages.at(-1).timeoutSeconds, 1800);
            assert.equal(ui.messages.at(-1).targetTimeoutSeconds, 3600);
            assert.equal(ui.element('timeout-sec').disabled, true);
            assert.equal(ui.element('target-timeout-sec').disabled, true);
            ui.send({ command: 'analysisFinished' });
            assert.equal(ui.element('target-timeout-sec').disabled, false);
        }
    } finally { setLanguage('zh-tw'); }
});

test('invalid timing blocks start and delayed initial settings cannot erase edited timing', () => {
    const ui = replay('zh-tw');
    chooseExplicitScope(ui);
    ui.element('timeout-sec').value = '60000000';
    ui.element('timeout-sec').dispatch('input');
    ui.send({ command: 'executionTimingSettings', timeoutSeconds: 60, targetTimeoutSeconds: 600 });
    assert.equal(ui.element('timeout-sec').value, '60000000');
    ui.element('btn-run').onclick!();
    assert.equal(ui.messages.at(-1).command, 'appendLog');
    assert.match(ui.messages.at(-1).text, /86400/);
    assert.equal(ui.element('btn-run').disabled, false);
    ui.element('timeout-sec').value = '1800';
    ui.element('target-timeout-sec').value = '0';
    ui.element('btn-run').onclick!();
    assert.equal(ui.messages.at(-1).command, 'appendLog');
    ui.element('target-timeout-sec').value = '7200';
    ui.element('btn-run').onclick!();
    assert.equal(ui.messages.at(-1).command, 'startBatchAnalysis');
    assert.equal(ui.messages.at(-1).targetTimeoutSeconds, 7200);
    ui.send({ command: 'analysisFinished' });
    ui.element('model-select').value = '';
    ui.send({ command: 'setModels', models: ['first-local-model', 'second-local-model'] });
    assert.equal(ui.element('model-select').value, 'first-local-model');
    ui.element('btn-run').onclick!();
    assert.equal(ui.messages.at(-1).command, 'startBatchAnalysis');
    assert.equal(ui.messages.at(-1).modelName, 'first-local-model');
});

test('Custom selection survives Webview rebuild and repeated menus preserve live fields', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            const keys = {
                first: { url: 'https://first.example.invalid/v1', model: 'first-model', key: 'fixture-first-secret' },
                second: { url: 'https://second.example.invalid/v1', model: 'second-model', key: 'fixture-second-secret' }
            };
            const ui = replay(language, { envType: 'custom', customKeyName: 'second' });
            chooseExplicitScope(ui);
            assert.equal(ui.element('env-type').value, 'custom');
            ui.send({ command: 'setCustomKeys', keys });
            assert.equal(ui.element('custom-api-select').value, 'second');
            assert.equal(ui.element('custom-url').value, keys.second.url);
            assert.equal(ui.element('custom-model').value, 'second-model');
            assert.equal(ui.element('custom-key').value, keys.second.key);
            ui.element('custom-api-select').value = 'first';
            ui.element('custom-api-select').onchange!({ target: ui.element('custom-api-select') });
            assert.equal(ui.persistedState.customKeyName, 'first');
            assert.equal(ui.element('custom-model').value, 'first-model');
            ui.element('custom-model').value = 'unsaved-current-model';
            ui.send({ command: 'setCustomKeys', keys });
            assert.equal(ui.element('custom-api-select').value, 'first');
            assert.equal(ui.element('custom-model').value, 'unsaved-current-model');
            ui.element('btn-run').onclick!();
            assert.equal(ui.messages.at(-1).modelName, 'unsaved-current-model');
            assert.equal(ui.messages.at(-1).customUrl, keys.first.url);
            const restored = replay(language, ui.persistedState);
            restored.send({ command: 'setCustomKeys', keys });
            assert.equal(restored.element('custom-api-select').value, 'first');
            assert.equal(restored.element('custom-model').value, 'first-model');
            assert.doesNotMatch(JSON.stringify(ui.persistedState), /fixture-.*-secret|example\.invalid/);
        }
    } finally { setLanguage('zh-tw'); }
});

test('replay registers PR13 details, qualification summary and survivor control with live events', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            const ui = replay(language);
            const details = ui.element('advanced-settings-details');
            assert.equal(details.tag, 'details');
            assert.equal(details.open, false);
            details.open = true;
            details.dispatch('toggle');
            assert.equal(ui.persistedState.advancedSettingsOpen, true);
            details.open = false;
            details.dispatch('toggle');
            assert.equal(ui.persistedState.advancedSettingsOpen, false);

            // Rebuilding from the full saved state (envType included) keeps the user's last choice.
            for (const open of [true, false]) {
                details.open = open;
                details.dispatch('toggle');
                const saved = { ...ui.persistedState };
                assert.ok(['cloud', 'local', 'custom'].includes(String(saved.envType)), 'the full state carries envType');
                assert.equal(saved.advancedSettingsOpen, open);
                const rebuilt = replay(language, saved);
                const rebuiltDetails = rebuilt.element('advanced-settings-details');
                assert.equal(rebuiltDetails.open, open, `rebuild restores advancedSettingsOpen=${open}`);
                assert.equal(rebuilt.element('env-type').value, saved.envType);
                assert.equal(rebuilt.persistedState.advancedSettingsOpen, open, 'restoring envType must not overwrite the saved choice');
                rebuiltDetails.dispatch('toggle'); // delayed notification for the programmatic restore
                assert.equal(rebuilt.persistedState.advancedSettingsOpen, open);
            }
            assert.equal(details.open, false);

            const summary = ui.element('role-qualification-summary');
            assert.equal(summary.tag, 'div');
            ui.send({ command: 'modelProbeResult', profile: { roleQualification: {
                writer: { state: 'verified' }, reviewer: { state: 'verified' }, bugFixer: { state: 'verified' }
            } } });
            assert.equal(summary.style.display, 'block');
            assert.match(summary.innerHTML, /Writer/);
            assert.match(summary.innerHTML, /Reviewer/);
            assert.match(summary.innerHTML, /Bug Fixer/);

            const qualityAnalyst = ui.element('quality-analyst');
            assert.equal(qualityAnalyst.tag, 'select');
            for (const value of ['off', 'auto']) {
                qualityAnalyst.value = value;
                qualityAnalyst.onchange!({ target: qualityAnalyst });
                assert.equal(ui.messages.at(-1).command, 'setPipelineSetting');
                assert.equal(ui.messages.at(-1).key, 'qualityAnalyst');
                assert.equal(ui.messages.at(-1).value, value);
            }
        }
    } finally { setLanguage('zh-tw'); }
});

test('v2 quality-passed cards retain their tier and row count in both languages', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            const ui = replay(language);
            ui.coverage('sample.py', 'inc');
            for (const tier of ['quality-passed', 'usable', 'failed']) {
                ui.send({ command: 'updateOutcome', fileName: 'sample.py:inc',
                    outcome: { label: `v2 ${tier}`, kind: tier === 'quality-passed' ? 'passed' : tier === 'usable' ? 'executed' : 'failed' },
                    caseTable: { tier, usableRows: 1, totalRows: 1, specMismatch: 0 } });
                const metrics = ui.element('dashboard-container').children[0].children[0].children[1];
                assert.ok(metrics.innerHTML.includes(`v2 ${tier}`), metrics.innerHTML);
                assert.ok(metrics.innerHTML.includes('1/1'), metrics.innerHTML);
                if (tier === 'quality-passed') {
                    assert.doesNotMatch(metrics.innerHTML, /v2 failed/);
                    assert.match(metrics.innerHTML, /#16803c/);
                }
            }
        }
    } finally { setLanguage('zh-tw'); }
});

// Messages come from the vm realm; compare them as plain JSON values.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const startMessages = (ui: ReturnType<typeof replay>) => plain(ui.messages.filter(item => item.command === 'startBatchAnalysis' || item.command === 'startAnalysis'));

test('PR19: an empty or partly missing list, or no scope at all, never starts and the Start button shows why', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            const fresh = replay(language);
            fresh.element('btn-run').onclick!();
            assert.deepEqual(startMessages(fresh), [], 'no list, no file: no implicit whole-folder run');
            assert.equal(fresh.messages.at(-1).command, 'appendLog');
            assert.equal(fresh.messages.at(-1).text, t('ui.runNeedsScope'));
            assert.equal(fresh.element('run-block-reason').textContent, t('ui.runNeedsScope'));
            assert.equal(fresh.element('btn-run').disabled, false, 'pressing only shows the hint');

            const empty = replay(language);
            empty.send({ command: 'targetListUpdated', projectRoot: '/fixture', targets: [],
                missing: [{ file: 'hist/bottle_utils.py', target: 'tob', reason: 'missing-file' }], statusText: 'imported 0' });
            const reason = t('ui.runBlockedImportIssue', 0, 1);
            assert.equal(empty.element('run-block-reason').textContent, reason);
            assert.equal(empty.element('run-block-reason').style.display, 'block');
            assert.equal(empty.element('btn-run').title, reason, 'the Start button itself carries the reason');
            empty.element('btn-run').onclick!();
            assert.deepEqual(startMessages(empty), [], 'a list that loaded 0 targets sends no start request');
            assert.equal(empty.messages.at(-1).text, reason);

            const partial = replay(language);
            partial.send({ command: 'targetListUpdated', projectRoot: '/fixture', targets: [{ file: 'a.py', target: 'f' }],
                missing: [{ file: 'b.py', target: 'g', reason: 'missing-function' }], statusText: 'imported 1' });
            partial.element('btn-run').onclick!();
            assert.deepEqual(startMessages(partial), [], 'missing entries also block until the list is fixed or cleared');
            assert.equal(partial.element('btn-run').title, t('ui.runBlockedImportIssue', 1, 1));

            const clean = replay(language);
            clean.send({ command: 'targetListUpdated', projectRoot: '/fixture', targets: [{ file: 'a.py', target: 'f' }], missing: [], statusText: 'ok' });
            assert.equal(clean.element('run-block-reason').style.display, 'none');
            clean.element('btn-run').onclick!();
            assert.deepEqual(startMessages(clean).map(item => item.targets), [[{ file: 'a.py', target: 'f' }]], 'a complete list still runs');
        }
    } finally { setLanguage('zh-tw'); }
});

test('PR19: a single file with two checked functions sends exactly those two targets; none checked does not start', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            const select = (ui: ReturnType<typeof replay>) => {
                ui.element('file-select').value = '/fixture/pkg/calc.py';
                ui.send({ command: 'setFunctions', filePath: '/fixture/pkg/calc.py', relativeFile: 'pkg/calc.py', funcs: ['sub', 'add', 'mul', 'div'] });
                return ui.element('func-checkbox-list').descendants().filter(item => item.className === 'func-check');
            };
            const ui = replay(language);
            const boxes = select(ui);
            assert.deepEqual(boxes.map(box => [box.value, box.checked]), [['add', true], ['div', true], ['mul', true], ['sub', true]]);
            for (const box of boxes.filter(item => item.value === 'div' || item.value === 'sub')) { box.checked = false; box.onchange!(); }
            ui.element('btn-run').onclick!();
            const sent = startMessages(ui);
            assert.equal(sent.length, 1);
            assert.equal(sent[0].command, 'startBatchAnalysis');
            assert.equal(sent[0].batchPath, '/fixture');
            assert.deepEqual(sent[0].targets, [{ file: 'pkg/calc.py', target: 'add' }, { file: 'pkg/calc.py', target: 'mul' }]);

            const all = replay(language);
            select(all);
            all.element('btn-run').onclick!();
            assert.deepEqual(startMessages(all).map(item => [item.command, item.filePath, item.funcName]),
                [['startAnalysis', '/fixture/pkg/calc.py', '']], 'all checked keeps the single-file flow');

            const none = replay(language);
            select(none);
            none.element('btn-func-deselect-all').onclick!();
            none.element('btn-run').onclick!();
            assert.deepEqual(startMessages(none), []);
            assert.equal(none.messages.at(-1).text, t('ui.runNoCheckedFunctions'));
        }
    } finally { setLanguage('zh-tw'); }
});

test('PR19: Clear all is available while anything is shown and clears list, scope, checks, status and warnings', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            const ui = replay(language);
            ui.send({ command: 'targetListUpdated', projectRoot: '/fixture', targets: [],
                missing: [{ file: 'x.py', reason: 'missing-file' }], statusText: 'loaded 0, 1 missing' });
            assert.equal(ui.element('btn-clear-targets').disabled, false, 'an empty list with a status or warning can still be cleared');
            chooseExplicitScope(ui);
            ui.element('file-select').value = '';
            assert.ok(ui.element('batch-scope-targets-list').descendants().length > 0);
            ui.element('btn-clear-targets').onclick!();
            assert.equal(ui.element('target-list-count').textContent, t('ui.targetListCount', 0));
            assert.equal(ui.element('target-list-status').textContent, '');
            assert.equal(ui.element('run-block-reason').style.display, 'none');
            assert.equal(ui.element('run-block-reason').textContent, '');
            assert.equal(ui.element('btn-run').title, '');
            assert.equal(ui.element('batch-scope-status').textContent, t('ui.batchScopeGuide'));
            assert.equal(ui.element('batch-scope-targets-panel').style.display, 'none', 'scope candidates are gone');
            assert.equal(ui.element('btn-clear-targets').disabled, true, 'nothing left to clear');
            assert.equal(ui.element('btn-export-targets').disabled, true);
            const saved = plain(ui.messages.filter(item => item.command === 'saveTargetList').at(-1));
            assert.deepEqual([saved.projectRoot, saved.targets], ['/fixture', []]);
            ui.element('btn-run').onclick!();
            assert.deepEqual(startMessages(ui), [], 'after clearing, Start asks for a scope again');
        }
    } finally { setLanguage('zh-tw'); }
});
