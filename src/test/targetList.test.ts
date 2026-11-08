import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vm from 'node:vm';
import {
    addTargetsToList,
    clearTargetList,
    compareTargetItems,
    deduplicateTargetList,
    defaultFunctionInventoryResolver,
    exportTargetListToJson,
    importTargetListFromJson,
    loadTargetListState,
    removeTargetFromList,
    saveTargetListState,
    serializeTargetListJson,
    sortFunctionNames,
    sortRelativeFiles,
    sortTargetItems,
    TARGET_LIST_VERSION,
    targetListStateKey
} from '../pipeline/targetList';
import { buildBatchScopeTargetCandidates, createBatchScopeSelection, resolveBatchScopeTargets } from '../pipeline/batchScope';
import { getWebviewContent } from '../ui/webviewContent';
import { setLanguage, t } from '../i18n/core';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture, readOllamaRoleRequest } from './ollamaRequestFixture';

test('R1 sorting orders functions and Class.method case-insensitively and tie-breaks equal names by relative file path', () => {
    const unsortedFunctions = [
        'zebra',
        'alpha',
        'Beta',
        'Service.run',
        'service.Init',
        'Service. cleanup'.replace(' ', ''),
        '_helper'
    ];
    assert.deepEqual(sortFunctionNames(unsortedFunctions), [
        '_helper',
        'alpha',
        'Beta',
        'Service.cleanup',
        'service.Init',
        'Service.run',
        'zebra'
    ]);

    const unsortedFiles = ['z/mod.py', 'A/first.py', 'a/Second.py', 'b.py'];
    assert.deepEqual(sortRelativeFiles(unsortedFiles), [
        'A/first.py',
        'a/Second.py',
        'b.py',
        'z/mod.py'
    ]);

    const targets = [
        { file: 'pkg/z.py', target: 'parse' },
        { file: 'pkg/a.py', target: 'parse' },
        { file: 'core.py', target: 'Client.send' },
        { file: 'core.py', target: 'client.connect' },
        { file: 'core.py', target: ' authenticate'.trim() }
    ];
    assert.deepEqual(sortTargetItems(targets), [
        { file: 'core.py', target: 'authenticate' },
        { file: 'core.py', target: 'client.connect' },
        { file: 'core.py', target: 'Client.send' },
        { file: 'pkg/a.py', target: 'parse' },
        { file: 'pkg/z.py', target: 'parse' }
    ]);
    assert.equal(compareTargetItems({ file: 'a.py', target: 'run' }, { file: 'b.py', target: 'run' }), -1);
});

test('R2 target list supports cross-file accumulation, deduplication, single removal, and clear all', () => {
    let list = clearTargetList();
    assert.deepEqual(list, []);

    list = addTargetsToList(list, [
        { file: 'first.py', target: 'beta' },
        { file: 'first.py', target: 'alpha' }
    ]);
    assert.deepEqual(list, [
        { file: 'first.py', target: 'beta' },
        { file: 'first.py', target: 'alpha' }
    ]);

    // Cross-file accumulation + duplicate suppression preserves original order
    list = addTargetsToList(list, [
        { file: 'first.py', target: 'beta' },
        { file: 'sub\\second.py', target: 'Service.execute' },
        { file: 'sub/second.py', target: 'Service.execute' }
    ]);
    assert.deepEqual(list, [
        { file: 'first.py', target: 'beta' },
        { file: 'first.py', target: 'alpha' },
        { file: 'sub/second.py', target: 'Service.execute' }
    ]);

    list = removeTargetFromList(list, { file: 'first.py', target: 'beta' });
    assert.deepEqual(list, [
        { file: 'first.py', target: 'alpha' },
        { file: 'sub/second.py', target: 'Service.execute' }
    ]);

    assert.deepEqual(deduplicateTargetList([
        { file: '../escape.py', target: 'bad' },
        { file: 'valid.py', target: 'good' },
        { file: 'valid.py', target: 'good' }
    ]), [{ file: 'valid.py', target: 'good' }]);

    list = clearTargetList();
    assert.deepEqual(list, []);
});

test('R3 batch scope linkage builds R1-sorted candidates from selected files and allows unchecking individual functions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'target-list-scope-'));
    try {
        const selection = createBatchScopeSelection(root, ['a.py', 'b.py', 'excluded.py'], ['a.py', 'b.py']);
        const candidates = buildBatchScopeTargetCandidates(selection, {
            'b.py': ['zebra', 'Common.run', 'alpha'],
            'a.py': ['Beta', 'Common.run'],
            'excluded.py': ['should_not_appear']
        });
        assert.deepEqual(candidates, [
            { file: 'b.py', target: 'alpha', selected: true },
            { file: 'a.py', target: 'Beta', selected: true },
            { file: 'a.py', target: 'Common.run', selected: true },
            { file: 'b.py', target: 'Common.run', selected: true },
            { file: 'b.py', target: 'zebra', selected: true }
        ]);

        // Uncheck one function
        candidates[1].selected = false;
        const resolved = resolveBatchScopeTargets(selection, candidates);
        assert.deepEqual(resolved, [
            { file: 'b.py', target: 'alpha' },
            { file: 'a.py', target: 'Common.run' },
            { file: 'b.py', target: 'Common.run' },
            { file: 'b.py', target: 'zebra' }
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('R4 JSON export/import round-trip preserves targets and reports nonexistent files or functions without ignoring them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'target-list-json-'));
    try {
        fs.mkdirSync(path.join(root, 'sub'));
        fs.writeFileSync(path.join(root, 'alpha.py'), 'def first():\n    return 1\n\ndef second():\n    return 2\n', 'utf8');
        fs.writeFileSync(path.join(root, 'sub', 'beta.py'), 'class Worker:\n    def run(self):\n        return True\n', 'utf8');

        const original = [
            { file: 'alpha.py', target: 'second' },
            { file: 'alpha.py', target: 'first' },
            { file: 'sub/beta.py', target: 'Worker.run' }
        ];
        const exported = exportTargetListToJson(original);
        assert.equal(exported.version, TARGET_LIST_VERSION);
        assert.deepEqual(exported.targets, {
            'alpha.py': ['second', 'first'],
            'sub/beta.py': ['Worker.run']
        });

        const rawJson = serializeTargetListJson(original);
        const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
        const roundTrip = await importTargetListFromJson(root, rawJson, defaultFunctionInventoryResolver(python));
        assert.deepEqual(roundTrip.missing, []);
        assert.deepEqual(roundTrip.targets, original);

        // Import with nonexistent file, nonexistent function, and invalid path
        const mixedDoc = {
            version: 'eval-screening-v1',
            targets: {
                'alpha.py': ['first', 'nonexistent_func'],
                'missing_file.py': ['ghost_a', 'ghost_b'],
                '../outside.py': ['escape_func'],
                'sub/beta.py': ['Worker.run', 'Worker.missing_method']
            }
        };
        const imported = await importTargetListFromJson(root, JSON.stringify(mixedDoc), defaultFunctionInventoryResolver(python));
        assert.deepEqual(imported.targets, [
            { file: 'alpha.py', target: 'first' },
            { file: 'sub/beta.py', target: 'Worker.run' }
        ]);
        assert.deepEqual(imported.missing, [
            { file: 'alpha.py', target: 'nonexistent_func', reason: 'missing-function' },
            { file: 'missing_file.py', target: 'ghost_a', reason: 'missing-file' },
            { file: 'missing_file.py', target: 'ghost_b', reason: 'missing-file' },
            { file: '../outside.py', target: 'escape_func', reason: 'invalid-path' },
            { file: 'sub/beta.py', target: 'Worker.missing_method', reason: 'missing-function' }
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('R4 importing eval_screening/targets.json produces exactly 26 valid targets and 0 missing items', async () => {
    const candidateDirs = [
        'D:/read/專題/test/eval_screening',
        'D:/read/專題/test/data/eval_screening'
    ];
    const evalDir = candidateDirs.find(dir => fs.existsSync(path.join(dir, 'targets.json')));
    assert.ok(evalDir, 'eval_screening directory with targets.json must exist');
    const targetsJsonPath = path.join(evalDir, 'targets.json');
    const raw = fs.readFileSync(targetsJsonPath, 'utf8');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const result = await importTargetListFromJson(evalDir, raw, defaultFunctionInventoryResolver(python));
    assert.deepEqual(result.missing, []);
    assert.equal(result.targets.length, 26);
});

test('R5 target list state persists per canonical project root in workspace state', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'target-state-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'target-state-b-'));
    try {
        assert.notEqual(targetListStateKey(rootA), targetListStateKey(rootB));
        const store = new Map<string, unknown>();
        const memento = {
            get: <T>(key: string) => store.get(key) as T | undefined,
            update: async (key: string, value: unknown) => { store.set(key, value); }
        };

        const itemsA = [
            { file: 'bmi.py', target: 'calculate_bmi' },
            { file: 'vehicle_db.py', target: 'authenticate_user' }
        ];
        const itemsB = [
            { file: 'other.py', target: 'Service.start' }
        ];

        await saveTargetListState(memento, rootA, itemsA);
        await saveTargetListState(memento, rootB, itemsB);

        assert.deepEqual(loadTargetListState(memento, rootA), itemsA);
        assert.deepEqual(loadTargetListState(memento, rootB), itemsB);
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
    }
});

test('Webview target list UI supports multi-file accumulation, batch scope linkage hiding single-file controls, and batch execution', () => {
    try {
        for (const language of ['zh-tw', 'en']) {
            setLanguage(language);
            const html = getWebviewContent(t);
            const elements = new Map<string, any>();
            const makeEl = (tag: string, id = '') => {
                const el: any = {
                    tag,
                    id,
                    value: '',
                    checked: false,
                    disabled: false,
                    textContent: '',
                    innerText: '',
                    className: '',
                    style: {},
                    dataset: {},
                    children: [] as any[],
                    appendChild(child: any) { this.children.push(child); },
                    addEventListener() {}
                };
                let markup = '';
                Object.defineProperty(el, 'innerHTML', {
                    get: () => markup,
                    set: (v: string) => { markup = v; el.children = []; }
                });
                return el;
            };
            for (const match of html.matchAll(/<(input|select|button|textarea|p|span|div)[^>]*\bid="([^"]+)"[^>]*>/g)) {
                const el = makeEl(match[1], match[2]);
                el.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
                elements.set(match[2], el);
            }
            elements.get('validation-mode').value = 'full';
            elements.get('env-type').value = 'local';
            elements.get('model-select').value = 'gpt-oss:20b';
            elements.get('project-path').value = '/project';

            const messages: any[] = [];
            let receive!: (event: { data: unknown }) => void;
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
                    getState: () => ({}),
                    setState: () => {}
                })
            });
            vm.runInContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1], context);

            // 1. Receive files and select first file
            receive({
                data: {
                    command: 'setFiles',
                    projectPath: '/project',
                    files: [
                        { name: 'b.py', path: '/project/b.py' },
                        { name: 'a.py', path: '/project/a.py' }
                    ]
                }
            });
            elements.get('file-select').value = '/project/a.py';
            elements.get('file-select').onchange({ target: { value: '/project/a.py' } });
            receive({
                data: {
                    command: 'setFunctions',
                    filePath: '/project/a.py',
                    relativeFile: 'a.py',
                    funcs: ['zebra', 'Alpha', 'ClassA.method']
                }
            });

            // Functions should be rendered sorted case-insensitively: Alpha, ClassA.method, zebra
            const checkboxRows = elements.get('func-checkbox-list').children;
            assert.equal(checkboxRows.length, 3);
            assert.deepEqual(checkboxRows.map((row: any) => row.children[0].value), ['Alpha', 'ClassA.method', 'zebra']);

            // Deselect all, then check only 'zebra' and 'Alpha', then click Add
            elements.get('btn-func-deselect-all').onclick();
            assert.ok(elements.get('func-checkbox-list').children.every((row: any) => !row.children[0].checked));
            const currentRows = elements.get('func-checkbox-list').children;
            currentRows[0].children[0].checked = true;
            currentRows[0].children[0].onchange();
            currentRows[2].children[0].checked = true;
            currentRows[2].children[0].onchange();
            elements.get('btn-add-targets').onclick();

            assert.equal(messages.at(-1).command, 'saveTargetList');
            assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).targets)), [
                { file: 'a.py', target: 'Alpha' },
                { file: 'a.py', target: 'zebra' }
            ]);

            // 2. Switch to second file and accumulate (with duplicate 'a.py:Alpha' ignored if re-added)
            elements.get('file-select').value = '/project/b.py';
            elements.get('file-select').onchange({ target: { value: '/project/b.py' } });
            receive({
                data: {
                    command: 'setFunctions',
                    filePath: '/project/b.py',
                    relativeFile: 'b.py',
                    funcs: ['beta_func']
                }
            });
            elements.get('btn-add-targets').onclick();
            assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).targets)), [
                { file: 'a.py', target: 'Alpha' },
                { file: 'a.py', target: 'zebra' },
                { file: 'b.py', target: 'beta_func' }
            ]);
            assert.match(elements.get('target-list-count').textContent, /3/);

            // Remove middle item ('a.py:zebra')
            const listItems = elements.get('target-list-container').children;
            assert.equal(listItems.length, 3);
            listItems[1].children[1].onclick();
            assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).targets)), [
                { file: 'a.py', target: 'Alpha' },
                { file: 'b.py', target: 'beta_func' }
            ]);

            // Run batch with explicit target list
            elements.get('btn-run').onclick();
            const runMsg = messages.at(-1);
            assert.equal(runMsg.command, 'startBatchAnalysis');
            assert.equal(runMsg.batchPath, '/project');
            assert.deepEqual(JSON.parse(JSON.stringify(runMsg.targets)), [
                { file: 'a.py', target: 'Alpha' },
                { file: 'b.py', target: 'beta_func' }
            ]);
            receive({ data: { command: 'analysisFinished' } });

            // 3. Batch scope linkage hides single-target controls and populates R1-sorted functions
            receive({
                data: {
                    command: 'batchScopeSelected',
                    projectRoot: '/project',
                    text: '2 / 2 selected',
                    targets: [
                        { file: 'b.py', target: 'parse', selected: true },
                        { file: 'a.py', target: 'parse', selected: true },
                        { file: 'a.py', target: ' Alpha'.trim(), selected: true }
                    ]
                }
            });
            assert.equal(elements.get('single-target-controls').style.display, 'none');
            assert.equal(elements.get('batch-scope-targets-panel').style.display, 'block');
            const batchRows = elements.get('batch-scope-targets-list').children;
            assert.deepEqual(batchRows.map((row: any) => row.children[0].value), [
                'a.py::Alpha',
                'a.py::parse',
                'b.py::parse'
            ]);
            // Uncheck 'a.py::parse'
            batchRows[1].children[0].checked = false;
            batchRows[1].children[0].onchange();
            assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).targets)), [
                { file: 'a.py', target: 'Alpha' },
                { file: 'b.py', target: 'parse' }
            ]);
        }
    } finally {
        setLanguage('zh-tw');
    }
});

test('batch execution with explicit target list (2 files, 3 functions) runs only those 3 targets in exact list order and records matching batch_manifest.json', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-explicit-targets-'));
    const output = path.join(root, 'results');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const executedOrder: string[] = [];
    let scopePrompts = 0;

    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 },
        ConfigurationTarget: { Global: 1 },
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        Uri: { file: (fsPath: string) => ({ fsPath }) },
        env: { openExternal: async () => true },
        workspace: {
            isTrusted: true,
            workspaceFolders: [{ uri: { fsPath: root } }],
            openTextDocument: async (file: string) => ({ file }),
            getConfiguration: () => ({
                get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : fallback,
                update: async () => {}
            })
        },
        window: {
            registerWebviewViewProvider: (_name: string, provider: any) => {
                provider.webview = { postMessage: async () => true };
                return { dispose() {} };
            },
            showInformationMessage: async () => {},
            showTextDocument: async () => {},
            showQuickPick: async () => { scopePrompts++; return []; },
            showWarningMessage: async () => undefined
        },
        commands: {
            registerCommand: (name: string, handler: (...args: any[]) => any) => {
                handlers.set(name, handler);
                return { dispose() {} };
            }
        }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName: 'fixture', contextLength: 32768 });
        if (metadata) { return metadata; }
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        let response: string;
        if (request.prompt.startsWith('=== ANALYSIS EVIDENCE V2 ===')) {
            response = '{"test_strategy":{"approach":"Verify exact target return value with a single direct call."}}';
        } else if (request.prompt.includes('def second_b():')) {
            executedOrder.push('second_mod.py:second_b');
            response = '```python\nimport unittest\nfrom second_mod import second_b\nclass Cases(unittest.TestCase):\n    def test_second_b(self):\n        self.assertEqual(second_b(), 20)\n```';
        } else if (request.prompt.includes('def first_only():')) {
            executedOrder.push('first_mod.py:first_only');
            response = '```python\nimport unittest\nfrom first_mod import first_only\nclass Cases(unittest.TestCase):\n    def test_first_only(self):\n        self.assertEqual(first_only(), 5)\n```';
        } else if (request.prompt.includes('def second_a():')) {
            executedOrder.push('second_mod.py:second_a');
            response = '```python\nimport unittest\nfrom second_mod import second_a\nclass Cases(unittest.TestCase):\n    def test_second_a(self):\n        self.assertEqual(second_a(), 10)\n```';
        } else {
            throw new Error('Unexpected target prompt: ' + request.prompt.slice(0, 200));
        }
        return new Response(JSON.stringify({ response }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
        fs.writeFileSync(path.join(root, 'second_mod.py'), 'def second_b():\n    return 20\n\ndef second_a():\n    return 10\n\ndef ignored_func():\n    return 99\n', 'utf8');
        fs.writeFileSync(path.join(root, 'first_mod.py'), 'def first_only():\n    return 5\n\ndef also_ignored():\n    return 0\n', 'utf8');
        fs.writeFileSync(path.join(root, 'third_excluded.py'), 'def should_never_run():\n    return -1\n', 'utf8');

        const explicitTargets = [
            { file: 'second_mod.py', target: 'second_b' },
            { file: 'first_mod.py', target: 'first_only' },
            { file: 'second_mod.py', target: 'second_a' }
        ];

        const { activate } = require('../orchestrator');
        activate({
            extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } },
            extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} },
            secrets: {},
            subscriptions: []
        });
        await handlers.get('llm-unit-test.updateModelProfile')!({
            envType: 'local',
            modelName: 'fixture',
            paramSize: '13B',
            contextLength: 32768,
            contextLengthKnown: true
        });
        await handlers.get('llm-unit-test.runBatchAnalysis')!({
            envType: 'local',
            modelName: 'fixture',
            batchPath: root,
            targets: explicitTargets,
            promptStrategy: 'tier2',
            validationMode: 'execution',
            requireRoleQualification: false,
            maxLoops: 1,
            timeoutSeconds: 30,
            outputPath: output
        });

        assert.equal(scopePrompts, 0, 'explicit target list must not prompt batch scope picker again');
        assert.deepEqual(executedOrder, [
            'second_mod.py:second_b',
            'first_mod.py:first_only',
            'second_mod.py:second_a'
        ]);

        const directories = fs.readdirSync(output).filter(name => fs.existsSync(path.join(output, name, 'batch_manifest.json')));
        assert.equal(directories.length, 1);
        const manifest = JSON.parse(fs.readFileSync(path.join(output, directories[0], 'batch_manifest.json'), 'utf8'));
        assert.equal(manifest.expectedTargets, 3);
        assert.equal(manifest.finishedTargets, 3);
        assert.deepEqual(
            manifest.targets.map((item: any) => ({ file: item.file, target: item.target })),
            explicitTargets
        );
        assert.ok(manifest.targets.every((item: any) => item.terminalStatus === 'execution-passed'));
    } finally {
        globalThis.fetch = originalFetch;
        Module._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
});test('SidebarProvider handles target list persistence, batchScope linkage, JSON export, and eval_screening JSON import', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-target-list-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load;
    const stored = new Map<string, unknown>();
    const warnings: string[] = [];
    const infos: string[] = [];
    const state = {
        get: (key: string) => stored.get(key),
        update: async (key: string, value: unknown) => { stored.set(key, value); }
    };
    const vscode = {
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        commands: { executeCommand: async () => {} },
        workspace: {
            getConfiguration: () => ({
                get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : key === 'projectPath' ? root : fallback,
                inspect: () => ({}),
                update: async () => {}
            })
        },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        env: { language: 'zh-tw' },
        Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: {
            showOpenDialog: async () => undefined,
            showSaveDialog: async () => ({ fsPath: path.join(root, 'exported_targets.json') }),
            showQuickPick: async (items: any[]) => items.filter(item => item.file === 'mod_b.py' || item.file === 'mod_a.py'),
            showInformationMessage: async (msg: string) => { infos.push(msg); },
            showWarningMessage: async (msg: string) => { warnings.push(msg); }
        }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };

    try {
        fs.writeFileSync(path.join(root, 'mod_a.py'), 'def zebra():\n    return 1\n\ndef Alpha():\n    return 2\n', 'utf8');
        fs.writeFileSync(path.join(root, 'mod_b.py'), 'class Service:\n    def execute(self):\n        return 3\n', 'utf8');

        delete require.cache[require.resolve('../ui/SidebarProvider')];
        delete require.cache[require.resolve('../ui/BatchScopeController')];
        const { MutationViewProvider } = require('../ui/SidebarProvider');
        const attach = () => {
            const provider = new MutationViewProvider({ get: async () => undefined }, state);
            const messages: any[] = [];
            let receive!: (message: unknown) => Promise<void>;
            provider.fetchLocalModels = async () => [];
            const webview = {
                options: {},
                html: '',
                postMessage: (message: unknown) => { messages.push(message); },
                onDidReceiveMessage: (handler: typeof receive) => { receive = handler; }
            };
            provider.resolveWebviewView({ webview });
            return { provider, messages, receive };
        };

        let view = attach();
        await view.receive({ command: 'getInitialData' });

        // 1. previewBatchScope extracts functions from selected files, sorts by R1, and saves to state
        await view.receive({ command: 'previewBatchScope', projectRoot: root, outputPath: path.join(root, 'out') });
        const batchScopeMsg = view.messages.find(m => m.command === 'batchScopeSelected');
        assert.ok(batchScopeMsg);
        assert.deepEqual(batchScopeMsg.targets, [
            { file: 'mod_a.py', target: 'Alpha', selected: true },
            { file: 'mod_b.py', target: 'Service.execute', selected: true },
            { file: 'mod_a.py', target: 'zebra', selected: true }
        ]);

        // 2. Recreating provider restores saved target list on getInitialData
        view = attach();
        await view.receive({ command: 'getInitialData' });
        const restoredMsg = view.messages.find(m => m.command === 'targetListUpdated');
        assert.ok(restoredMsg);
        assert.deepEqual(restoredMsg.targets, [
            { file: 'mod_a.py', target: 'Alpha' },
            { file: 'mod_b.py', target: 'Service.execute' },
            { file: 'mod_a.py', target: 'zebra' }
        ]);

        // 3. Export target list writes eval-screening-v1 JSON
        const exportPath = path.join(root, 'exported.json');
        await view.receive({
            command: 'exportTargetList',
            projectRoot: root,
            filePath: exportPath,
            targets: restoredMsg.targets
        });
        const exportedDoc = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
        assert.deepEqual(exportedDoc, {
            version: 'eval-screening-v1',
            targets: {
                'mod_a.py': ['Alpha', 'zebra'],
                'mod_b.py': ['Service.execute']
            }
        });

        // 4. Import with nonexistent items warns and lists missing items
        warnings.length = 0;
        await view.receive({
            command: 'importTargetList',
            projectRoot: root,
            rawJson: JSON.stringify({
                version: 'eval-screening-v1',
                targets: {
                    'mod_a.py': ['Alpha', 'missing_fn'],
                    'missing.py': ['nope']
                }
            })
        });
        const importMissingMsg = view.messages.filter(m => m.command === 'targetListUpdated').at(-1);
        assert.deepEqual(importMissingMsg.targets, [{ file: 'mod_a.py', target: 'Alpha' }]);
        assert.equal(importMissingMsg.missing.length, 2);
        assert.ok(warnings.some(w => w.includes('mod_a.py:missing_fn') && w.includes('missing.py:nope')));

        // 5. Import D:/read/專題/test/eval_screening/targets.json via SidebarProvider
        const evalDir = 'D:/read/專題/test/eval_screening';
        const evalTargetsPath = path.join(evalDir, 'targets.json');
        assert.ok(fs.existsSync(evalTargetsPath), 'D:/read/專題/test/eval_screening/targets.json must exist');
        await view.receive({
            command: 'importTargetList',
            projectRoot: evalDir,
            filePath: evalTargetsPath
        });
        const evalImportMsg = view.messages.filter(m => m.command === 'targetListUpdated').at(-1);
        assert.equal(evalImportMsg.projectRoot, evalDir);
        assert.equal(evalImportMsg.targets.length, 26);
        assert.deepEqual(evalImportMsg.missing, []);
    } finally {
        delete require.cache[require.resolve('../ui/SidebarProvider')];
        delete require.cache[require.resolve('../ui/BatchScopeController')];
        Module._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
