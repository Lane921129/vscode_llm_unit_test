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
    onchange?: (event?: any) => void;
    onclick?: (event?: any) => void;
    addEventListener: (event: string, handler: (e?: any) => void) => void;
    dispatch: (event: string, e?: any) => void;
    appendChild: (child: MockElement) => void;
    dataset?: Record<string, string>;
    innerHTML?: string;
}

function createMockEnvironment(options: { language?: 'zh-tw' | 'en'; initialState?: Record<string, unknown> } = {}) {
    const lang = options.language || 'zh-tw';
    setLanguage(lang);
    const html = getWebviewContent(t, lang);
    const elements = new Map<string, MockElement>();

    const makeEl = (tagName: string, id?: string): MockElement => {
        const listeners = new Map<string, Array<(e?: any) => void>>();
        const el: MockElement = {
            tagName,
            id,
            value: '',
            textContent: '',
            open: false,
            style: {},
            children: [],
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
            }
        };
        let markup = '';
        Object.defineProperty(el, 'innerHTML', {
            get: () => markup,
            set: (v: string) => { markup = v; el.children = []; }
        });
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
            }
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

    return { html, elements, messages, receive: (msg: unknown) => receive({ data: msg }), currentState, makeEl };
}

test('PR #13: advanced settings details is collapsed by default and persists user toggle', () => {
    // 1. Default HTML rendering has details without open attribute
    const htmlZh = getWebviewContent(t, 'zh-tw');
    assert.match(htmlZh, /<details\b[^>]*id="advanced-settings-details"(?![^>]*\bopen\b)/, 'advanced settings must not be open by default in zh-tw');
    const htmlEn = getWebviewContent(t, 'en');
    assert.match(htmlEn, /<details\b[^>]*id="advanced-settings-details"(?![^>]*\bopen\b)/, 'advanced settings must not be open by default in en');

    // 2. Default state in client environment
    const env = createMockEnvironment();
    const details = env.elements.get('advanced-settings-details');
    assert.ok(details, 'advanced-settings-details element must exist');
    assert.equal(details.open, false, 'details must be closed by default');

    // 3. User toggle saves state
    details.open = true;
    details.dispatch('toggle');
    assert.equal(env.currentState.advancedSettingsOpen, true, 'toggling details should persist advancedSettingsOpen = true');

    details.open = false;
    details.dispatch('toggle');
    assert.equal(env.currentState.advancedSettingsOpen, false, 'toggling details closed should persist advancedSettingsOpen = false');

    // 4. Initial state with advancedSettingsOpen = true restores details.open = true
    const envRestored = createMockEnvironment({ initialState: { advancedSettingsOpen: true } });
    const detailsRestored = envRestored.elements.get('advanced-settings-details');
    assert.equal(detailsRestored?.open, true, 'saved open state must be restored');
});

test('PR #13: require-role-qualification checkbox is completely removed from HTML', () => {
    for (const lang of ['zh-tw', 'en'] as const) {
        const html = getWebviewContent(t, lang);
        assert.equal(html.includes('id="require-role-qualification"'), false, `require-role-qualification must not exist in HTML for ${lang}`);
    }
    const env = createMockEnvironment();
    assert.equal(env.elements.has('require-role-qualification'), false, 'require-role-qualification element must not be found');
});

test('PR #13: function selection counter updates dynamically with checkboxes and select/deselect all', () => {
    for (const lang of ['zh-tw', 'en'] as const) {
        const env = createMockEnvironment({ language: lang });
        const counter = env.elements.get('func-selected-counter');
        assert.ok(counter, 'func-selected-counter element must exist');
        assert.equal(counter.textContent, '', 'counter must be empty before file selection');

        // Check renamed buttons
        const selectAllBtn = env.elements.get('btn-func-select-all');
        const deselectAllBtn = env.elements.get('btn-func-deselect-all');
        assert.ok(selectAllBtn);
        assert.ok(deselectAllBtn);

        // Select a file with 3 functions
        env.elements.get('file-select')!.value = '/project/math.py';
        env.receive({
            command: 'setFunctions',
            filePath: '/project/math.py',
            relativeFile: 'math.py',
            funcs: ['add', 'subtract', 'multiply']
        });

        const expected3 = lang === 'zh-tw' ? '已選 3／3' : 'Selected 3/3';
        assert.equal(counter.textContent, expected3, 'all functions initially checked');

        // Deselect all
        deselectAllBtn.onclick?.();
        const expected0 = lang === 'zh-tw' ? '已選 0／3' : 'Selected 0/3';
        assert.equal(counter.textContent, expected0, 'counter updates to 0 after deselect all');

        // Select all
        selectAllBtn.onclick?.();
        assert.equal(counter.textContent, expected3, 'counter updates back to 3 after select all');
    }
});

test('PR #13: testConnection triggers testConnection command and modelProbeResult renders role qualification summary', () => {
    const env = createMockEnvironment();
    const summary = env.elements.get('role-qualification-summary');
    assert.ok(summary, 'role-qualification-summary must exist');
    assert.equal(summary.style.display, 'none', 'summary is hidden initially');

    // 1. Test local connection triggers command
    env.elements.get('env-type')!.value = 'local';
    env.elements.get('model-select')!.value = 'test-model';
    env.elements.get('btn-test-local')!.onclick?.();
    const testLocalMsg = env.messages.find(m => m.command === 'testConnection' && m.envType === 'local');
    assert.ok(testLocalMsg, 'testConnection command must be posted on test connection click');
    assert.equal(testLocalMsg.modelName, 'test-model');

    // 2. Receive modelProbeResult with roleQualification
    env.receive({
        command: 'modelProbeResult',
        profile: {
            roleQualification: {
                writer: { state: 'verified' },
                reviewer: { state: 'verified' },
                bugFixer: { state: 'unverified', reason: 'syntax error' }
            }
        }
    });

    assert.equal(summary.style.display, 'block', 'summary must be displayed after probe result');
    assert.match(summary.innerHTML || '', /Writer/, 'must display Writer result');
    assert.match(summary.innerHTML || '', /Reviewer/, 'must display Reviewer result');
    assert.match(summary.innerHTML || '', /Bug Fixer/, 'must display Bug Fixer result');
    assert.match(summary.innerHTML || '', /通過/, 'must indicate passing state');
    assert.match(summary.innerHTML || '', /未通過/, 'must indicate failing state');
});

test('PR #13: v1/v2 pipeline version toggle updates v2-settings display and posts setPipelineSetting', () => {
    const env = createMockEnvironment();
    const pipelineSelect = env.elements.get('pipeline-version');
    const v2Settings = env.elements.get('v2-settings');
    assert.ok(pipelineSelect);
    assert.ok(v2Settings);

    // Switch to v2
    pipelineSelect.value = 'v2-case-table';
    pipelineSelect.onchange?.({ target: { value: 'v2-case-table' } });
    assert.equal(v2Settings.style.display, 'block', 'v2-settings should be visible in v2 mode');
    const v2Msg = env.messages.find(m => m.command === 'setPipelineSetting' && m.key === 'pipelineVersion');
    assert.ok(v2Msg);
    assert.equal(v2Msg.value, 'v2-case-table');

    // Switch back to v1
    pipelineSelect.value = 'v1';
    pipelineSelect.onchange?.({ target: { value: 'v1' } });
    assert.equal(v2Settings.style.display, 'none', 'v2-settings should be hidden in v1 mode');
    assert.equal(env.messages.at(-1).value, 'v1');
});
