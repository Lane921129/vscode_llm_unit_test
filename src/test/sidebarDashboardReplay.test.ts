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

function replay(language: string) {
    setLanguage(language);
    const html = getWebviewContent(t);
    const elements = new Map<string, ReplayElement>();
    for (const match of html.matchAll(/<(input|select|button|textarea|p|span|div)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const element = match[1] === 'input' ? new ReplayInput('input') : new ReplayElement(match[1]);
        element.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
        element.root = true;
        elements.set(match[2], element);
    }
    const element = (id: string) => { const item = elements.get(id); assert.ok(item, id); return item; };
    element('validation-mode').value = 'full';
    element('env-type').value = 'local';
    element('model-select').value = 'fixture-model';
    element('project-path').value = '/fixture';
    const messages: any[] = [];
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
        acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) })
    });
    vm.runInContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1], context);
    const send = (data: unknown) => receive({ data });
    const run = (source: string) => vm.runInContext(source, context);
    const coverage = (file: string, func = 'first') => send({ command: 'updateCoverage', fileName: file + ':' + func,
        file, func, score: '測試中', coverage: 'N/A', reason: '' });
    return { html, element, groups, messages, send, run, coverage };
}

test('grouped dashboard preserves live collapsed folders through running updates, mode switches and delayed toggles', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            const ui = replay(language);
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
