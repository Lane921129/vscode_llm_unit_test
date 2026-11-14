import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vm from 'node:vm';
import { getWebviewContent } from '../ui/webviewContent';
import { setLanguage, t } from '../i18n/core';

interface MockElement {
    tagName: string;
    id?: string;
    value: string;
    textContent: string;
    open?: boolean;
    style: Record<string, string>;
    disabled?: boolean;
    children: MockElement[];
    options: Array<{ value: string; textContent: string; selected?: boolean }>;
    selectedIndex: number;
    dataset?: Record<string, string>;
    onchange?: (event?: any) => void;
    onclick?: (event?: any) => void;
    onkeydown?: (event?: any) => void;
    addEventListener: (event: string, handler: (e?: any) => void) => void;
    dispatch: (event: string, e?: any) => void;
    appendChild: (child: MockElement) => void;
    innerHTML?: string;
}

function createMockEnvironment(options: { language?: 'zh-tw' | 'en'; initialState?: Record<string, unknown> } = {}) {
    const lang = options.language || 'zh-tw';
    setLanguage(lang);
    const html = getWebviewContent(t, lang);
    const elements = new Map<string, MockElement>();

    const makeEl = (tagName: string, id?: string): MockElement => {
        const listeners = new Map<string, Array<(e?: any) => void>>();
        let _id = id;
        const el: MockElement = {
            tagName,
            get id() { return _id; },
            set id(v: string | undefined) {
                _id = v;
                if (v) { elements.set(v, el); }
            },
            value: '',
            textContent: '',
            open: false,
            style: {},
            children: [],
            options: [],
            selectedIndex: 0,
            dataset: {},
            addEventListener: (event: string, handler: (e?: any) => void) => {
                if (!listeners.has(event)) { listeners.set(event, []); }
                listeners.get(event)!.push(handler);
            },
            dispatch: (event: string, e?: any) => {
                for (const handler of listeners.get(event) || []) {
                    handler(e);
                }
            },
            appendChild: (child: MockElement) => {
                el.children.push(child);
                if (child.tagName === 'option') {
                    el.options.push({ value: child.value, textContent: child.textContent });
                }
            }
        };
        let markup = '';
        Object.defineProperty(el, 'innerHTML', {
            get: () => {
                let out = markup;
                for (const child of el.children) {
                    out += child.innerHTML || '';
                }
                return out;
            },
            set: (v: string) => {
                markup = v;
                el.children = [];
                for (const m of v.matchAll(/<(input|select|button|textarea|p|span|div|details|table)[^>]*\bid="([^"]+)"[^>]*>/g)) {
                    if (!elements.has(m[2])) {
                        const childEl = makeEl(m[1], m[2]);
                        elements.set(m[2], childEl);
                    }
                }
            }
        });
        if (id) { elements.set(id, el); }
        return el;
    };

    for (const match of html.matchAll(/<(input|select|button|textarea|p|span|div|details)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const el = makeEl(match[1], match[2]);
        el.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
        if (match[1] === 'details') {
            el.open = match[0].includes(' open');
        }
        const styleMatch = match[0].match(/\bstyle="([^"]*)"/);
        if (styleMatch) {
            styleMatch[1].split(';').forEach(pair => {
                const [k, v] = pair.split(':').map(s => s.trim());
                if (k && v) { el.style[k] = v; }
            });
        }
        elements.set(match[2], el);
    }

    const messages: any[] = [];
    let receive!: (event: { data: unknown }) => void;
    const currentState = { ...(options.initialState || {}) };

    const context = vm.createContext({
        document: {
            getElementById: (id: string) => elements.get(id),
            createElement: (tag: string) => makeEl(tag),
            querySelectorAll: () => []
        },
        window: {
            addEventListener: (event: string, handler: typeof receive) => {
                if (event === 'message') { receive = handler; }
            },
            confirm: () => true
        },
        acquireVsCodeApi: () => ({
            postMessage: (msg: unknown) => messages.push(msg),
            getState: () => currentState,
            setState: (state: any) => Object.assign(currentState, state)
        })
    });

    const scriptMatch = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
    assert.ok(scriptMatch, 'script tag must exist in Webview HTML');
    vm.runInContext(scriptMatch[1], context);

    return { html, elements, messages, receive: (msg: unknown) => receive({ data: msg }), currentState, makeEl, context };
}

test('PR #13b: sidebar is rearranged into six sections with correct ordering and default fold states', () => {
    for (const lang of ['zh-tw', 'en'] as const) {
        setLanguage(lang);
        const html = getWebviewContent(t, lang);

        // 1. Verify six sections appear in order: ① env -> ② test-data -> ③ test-method -> ④ basic-settings -> ⑤ advanced-settings -> ⑥ actions
        const envIdx = html.indexOf('id="section-env"');
        const dataIdx = html.indexOf('id="section-test-data"');
        const methodIdx = html.indexOf('id="section-test-method"');
        const basicIdx = html.indexOf('id="section-basic-settings"');
        const advIdx = html.indexOf('id="advanced-settings-details"');
        const actIdx = html.indexOf('id="section-actions"');

        assert.ok(envIdx !== -1, 'section-env must exist');
        assert.ok(dataIdx !== -1, 'section-test-data must exist');
        assert.ok(methodIdx !== -1, 'section-test-method must exist');
        assert.ok(basicIdx !== -1, 'section-basic-settings must exist');
        assert.ok(advIdx !== -1, 'advanced-settings-details must exist');
        assert.ok(actIdx !== -1, 'section-actions must exist');

        assert.ok(envIdx < dataIdx, '① section-env must precede ② section-test-data');
        assert.ok(dataIdx < methodIdx, '② section-test-data must precede ③ section-test-method');
        assert.ok(methodIdx < basicIdx, '③ section-test-method must precede ④ section-basic-settings');
        assert.ok(basicIdx < advIdx, '④ section-basic-settings must precede ⑤ advanced-settings-details');
        assert.ok(advIdx < actIdx, '⑤ advanced-settings-details must precede ⑥ section-actions');

        // 2. Verify ①～④ are default open, ⑤ is default closed
        assert.match(html, /<details\b[^>]*id="section-env"[^>]*\bopen\b/);
        assert.match(html, /<details\b[^>]*id="section-test-data"[^>]*\bopen\b/);
        assert.match(html, /<details\b[^>]*id="section-test-method"[^>]*\bopen\b/);
        assert.match(html, /<details\b[^>]*id="section-basic-settings"[^>]*\bopen\b/);
        assert.match(html, /<details\b[^>]*id="advanced-settings-details"(?![^>]*\bopen\b)/);
    }
});

test('PR #13b: v1/v2 explanation button toggles help panel and summary updates on pipeline change', () => {
    for (const lang of ['zh-tw', 'en'] as const) {
        const env = createMockEnvironment({ language: lang });
        const helpBtn = env.elements.get('btn-pipeline-help');
        const helpPanel = env.elements.get('pipeline-help-panel');
        const summary = env.elements.get('pipeline-version-summary');
        const pipelineSelect = env.elements.get('pipeline-version');

        assert.ok(helpBtn, 'btn-pipeline-help must exist');
        assert.ok(helpPanel, 'pipeline-help-panel must exist');
        assert.ok(summary, 'pipeline-version-summary must exist');
        assert.ok(pipelineSelect, 'pipeline-version select must exist');

        // Initially help panel is hidden
        assert.equal(helpPanel.style.display, 'none');

        // Click help button -> panel shows
        helpBtn.onclick?.();
        assert.equal(helpPanel.style.display, 'block');

        // Click again -> panel hides
        helpBtn.onclick?.();
        assert.equal(helpPanel.style.display, 'none');

        // Default summary displays v1 text
        assert.ok(summary.textContent.includes(lang === 'zh-tw' ? 'v1 標準流程' : 'v1 Standard Workflow'));

        // Change to v2 -> summary updates to v2 text
        pipelineSelect.value = 'v2-case-table';
        pipelineSelect.onchange?.({ target: { value: 'v2-case-table' } });
        assert.ok(summary.textContent.includes(lang === 'zh-tw' ? 'v2 案例表' : 'v2 Case Table'));

        // Change back to v1 -> summary updates back to v1
        pipelineSelect.value = 'v1';
        pipelineSelect.onchange?.({ target: { value: 'v1' } });
        assert.ok(summary.textContent.includes(lang === 'zh-tw' ? 'v1 標準流程' : 'v1 Standard Workflow'));
    }
});

test('PR #13b: mutation focus warning is shown in v2 when qualityAnalyst is off', () => {
    const env = createMockEnvironment();
    const hint = env.elements.get('focus-mutation-hint');
    const strategy = env.elements.get('prompt-strategy');
    const pipeline = env.elements.get('pipeline-version');
    const qa = env.elements.get('quality-analyst');

    assert.ok(hint);
    assert.ok(strategy);
    assert.ok(pipeline);
    assert.ok(qa);

    // Initial state (full, v1, qa auto): hint hidden
    assert.equal(hint.style.display, 'none');

    // Switch to v2, mutation focus, and qualityAnalyst = off -> hint shown
    pipeline.value = 'v2-case-table';
    pipeline.onchange?.({ target: { value: 'v2-case-table' } });
    strategy.value = 'mutation';
    strategy.onchange?.({ target: { value: 'mutation' } });
    qa.value = 'off';
    qa.onchange?.({ target: { value: 'off' } });

    assert.equal(hint.style.display, 'block', 'hint must be displayed when mutation focus and qualityAnalyst is off in v2');

    // Turn qualityAnalyst back to auto -> hint hidden
    qa.value = 'auto';
    qa.onchange?.({ target: { value: 'auto' } });
    assert.equal(hint.style.display, 'none');

    // Turn qualityAnalyst to off again, but switch pipeline to v1 -> hint hidden
    qa.value = 'off';
    qa.onchange?.({ target: { value: 'off' } });
    assert.equal(hint.style.display, 'block');

    pipeline.value = 'v1';
    pipeline.onchange?.({ target: { value: 'v1' } });
    assert.equal(hint.style.display, 'none');
});

test('PR #13b: apply demo settings batches settings without executing analysis', () => {
    const env = createMockEnvironment();
    const btnDemo = env.elements.get('btn-apply-demo-settings');
    assert.ok(btnDemo, 'btn-apply-demo-settings must exist');

    btnDemo.onclick?.();

    // Verify DOM inputs updated
    assert.equal(env.elements.get('env-type')!.value, 'local');
    assert.equal(env.elements.get('model-select')!.value, 'gpt-oss:20b');
    assert.equal(env.elements.get('runtime-context-tokens')!.value, '8192');
    assert.equal(env.elements.get('thinking-mode')!.value, 'disabled');
    assert.equal(env.currentState.thinkingMode, 'disabled');
    assert.equal(env.messages.find(m => m.command === 'setThinkingMode')?.mode, 'disabled');
    assert.equal(env.elements.get('mutation-engine')!.value, 'mutatest');
    assert.equal(env.elements.get('prompt-strategy')!.value, 'full');
    assert.equal(env.elements.get('failure-limit')!.value, '5');
    assert.equal(env.elements.get('quality-no-improvement-limit')!.value, '3');
    assert.equal(env.elements.get('batch-failure-limit')!.value, '0');

    // Verify messages posted
    const stopMsg = env.messages.find(m => m.command === 'setStopPolicy');
    assert.ok(stopMsg);
    assert.deepEqual({ ...stopMsg.settings }, { failureLimit: 5, qualityNoImprovementLimit: 3, batchFailureLimit: 0 });

    const engineMsg = env.messages.find(m => m.command === 'setMutationEngine');
    assert.ok(engineMsg);
    assert.equal(engineMsg.engine, 'mutatest');

    const strategyMsg = env.messages.find(m => m.command === 'setPromptStrategy');
    assert.ok(strategyMsg);
    assert.equal(strategyMsg.strategy, 'full');

    const contextMsg = env.messages.find(m => m.command === 'setModelRuntimeContextTokens');
    assert.ok(contextMsg);
    assert.equal(contextMsg.modelName, 'gpt-oss:20b');
    assert.equal(contextMsg.tokens, 8192);

    // Verify NO analysis command was posted
    const runMsg = env.messages.find(m => m.command === 'runAnalysis' || m.command === 'runBatch');
    assert.equal(runMsg, undefined, 'demo button must only update settings without starting execution');
});

test('PR #13b: v2 spec mismatch badge and table render on outcome with spec mismatch', () => {
    const env = createMockEnvironment();
    const container = env.elements.get('dashboard-container')!;
    assert.ok(container);

    env.receive({
        command: 'updateOutcome',
        fileName: 'test_calc.py:divide',
        file: 'test_calc.py',
        func: 'divide',
        outcome: { label: 'v2 usable', kind: 'executed' },
        caseTable: {
            tier: 'usable',
            usableRows: 4,
            totalRows: 5,
            specMismatch: 2,
            specMismatchDetails: {
                mismatches: [
                    { id: 1, input: '(10, 0)', expected: 'raise ZeroDivisionError', actual: 'None', basis: 'docstring requirement' }
                ],
                needsReview: [
                    { id: 2, input: '("a", 2)', predicted: 'raise TypeError', actual: 'TypeError', basis: 'spec heuristic' }
                ]
            }
        }
    });

    // Check that card was rendered with spec mismatch badge
    assert.ok(container.innerHTML?.includes('spec-mismatch-badge'), 'card must include spec-mismatch-badge');
    assert.ok(container.innerHTML?.includes('規格不符 2 個'), 'badge must indicate 2 spec mismatches');

    // Check spec mismatch panel was rendered
    const panel = env.elements.get('spec-mismatch-panel-test_calc.py:divide');
    assert.ok(panel, 'panel element must exist in elements map');
    assert.ok(panel.innerHTML?.includes('ZeroDivisionError'), 'mismatch table must contain expected text');
    assert.ok(panel.innerHTML?.includes('docstring requirement'), 'mismatch table must contain basis');
    assert.ok(panel.innerHTML?.includes('需人工確認清單'), 'needsReview section must exist');
    assert.ok(panel);
    assert.equal(panel.style.display, 'none');

    // Call toggle function exposed on window
    const win = (env.context as any).window;
    assert.ok(typeof win.toggleSpecMismatch === 'function');
    win.toggleSpecMismatch('test_calc.py:divide');
    assert.equal(panel.style.display, 'block');

    win.toggleSpecMismatch('test_calc.py:divide');
    assert.equal(panel.style.display, 'none');
});


test('demo confirmation includes thinking in both languages and cancellation preserves settings', () => {
    for (const language of ['zh-tw', 'en'] as const) {
        const env = createMockEnvironment({ language, initialState: { thinkingMode: 'provider-default' } });
        const before = env.messages.length;
        let prompt = '';
        env.context.window.confirm = (message: string) => { prompt = message; return false; };
        env.elements.get('btn-apply-demo-settings')!.onclick?.();
        assert.equal(env.messages.length, before);
        assert.equal(env.elements.get('thinking-mode')!.value, 'provider-default');
        assert.equal(env.currentState.thinkingMode, 'provider-default');
        assert.match(prompt, language === 'zh-tw' ? /思考模式（thinking）：關閉/ : /Thinking mode: Off/);
        assert.match(env.html, language === 'zh-tw' ? /思考模式（thinking）/ : /Thinking mode/);
        assert.match(env.html, language === 'zh-tw' ? /關閉（省輸出額度，建議小模型使用）/ : /Off \(saves output tokens; recommended for small models\)/);
    }
});
