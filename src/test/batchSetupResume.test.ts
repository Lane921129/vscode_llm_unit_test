import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonEnvironmentActivity } from '../environment/pythonEnvironmentSetup';
import { preflightFailureCacheSize } from '../pipeline/modulePreflight';

test('real batch applies the confirmed isolated resource once and resumes the same scope; rejection/new blockers/abort stop', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-resume-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const settings: Record<string, unknown> = { pythonPath: python, importFixtures: [] };
    const output = path.join(root, 'results'), file = path.join(root, 'sample.py');
    let mode: 'ready' | 'declined' | 'new-blocker' | 'cancelled' | 'source-changed' | 'dependency-fixed' | 'default-output' = 'ready';
    let scopePrompts = 0, setupPrompts = 0, modelCalls = 0, updates = 0;
    const resumedCaches: number[] = [];
    const vscode = {
        ConfigurationTarget: { Global: 1 }, ExtensionMode: { Development: 2, Test: 3 },
        CancellationTokenSource: class { token = { isCancellationRequested: false }; cancel() { this.token.isCancellationRequested = true; } dispose() {} },
        Uri: { file: (fsPath: string) => ({ fsPath }) }, env: { openExternal: async () => true },
        workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: root } }],
            openTextDocument: async (file: string) => ({ file }),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback,
                update: async (key: string, value: unknown) => { updates++; settings[key] = value; } }) },
        window: {
            registerWebviewViewProvider: (_: string, provider: any) => { provider.webview = { postMessage: async (message: any) => {
                if (message.command === 'appendLog' && message.text?.includes('繼續同一批次')) { resumedCaches.push(preflightFailureCacheSize()); }
                return true;
            } }; return { dispose() {} }; },
            showInformationMessage: async () => {}, showTextDocument: async () => {},
            showQuickPick: async (items: any[]) => { scopePrompts++; return items.filter(item => item.file === 'sample.py'); },
            showWarningMessage: async (_text: string, _options: unknown, action?: string) => {
                if (action === '處理初始化設定') {
                    if (mode === 'dependency-fixed') {
                        assert.ok(preflightFailureCacheSize() > 0, 'the original analysis has a cached import failure');
                        fs.writeFileSync(path.join(root, 'neutral_missing_dependency.py'), 'VALUE = 1\n');
                    }
                    return action;
                }
                if (action === '套用此清單並重新檢查') {
                    setupPrompts++;
                    assert.equal(pythonEnvironmentActivity.acquire('use'), undefined, 'setup owns the environment exclusively');
                    if (mode === 'cancelled') { handlers.get('llm-unit-test.abortTest')!(); }
                    if (mode === 'source-changed') { fs.appendFileSync(file, '# changed during approval\n'); }
                    return mode === 'declined' ? undefined : action;
                }
                return undefined;
            }
        }, commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return { dispose() {} }; } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async () => { modelCalls++; throw new Error('No provider calls in this neutral stub fixture'); };
    try {
        fs.writeFileSync(path.join(root, 'excluded.py'), 'def broken(\n');
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        const run = handlers.get('llm-unit-test.runBatchAnalysis')!;
        for (const scenario of ['ready', 'declined', 'new-blocker', 'cancelled', 'source-changed', 'default-output', 'dependency-fixed'] as const) {
            mode = scenario; scopePrompts = 0; setupPrompts = 0; updates = 0;
            settings.importFixtures = []; settings.importFixtureRoot = '';
            const source = (scenario === 'dependency-fixed' ? 'import neutral_missing_dependency\n'
                : 'from pathlib import Path\nPath("owned_first").mkdir(exist_ok=True)\n')
                + (scenario === 'new-blocker' ? 'Path("owned_second").mkdir(exist_ok=True)\n' : '') + 'def target():\n    return 1\n';
            fs.writeFileSync(file, source);
            const outputRoot = scenario === 'default-output' ? root : output;
            const before = fs.existsSync(outputRoot) ? fs.readdirSync(outputRoot) : [];
            await run({ envType: 'local', modelName: 'fixture', batchPath: root, outputPath: scenario === 'default-output' ? undefined : output,
                promptStrategy: 'tier2', maxLoops: 1, timeoutSeconds: 30 });
            const created = fs.readdirSync(outputRoot).filter(name => !before.includes(name));
            const batchDirs = created.filter(name => fs.existsSync(path.join(outputRoot, name, 'batch_manifest.json')));
            assert.equal(batchDirs.length, 1, 'continuation must reuse the original batch directory');
            const directory = path.join(outputRoot, batchDirs[0]);
            const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'batch_manifest.json'), 'utf8'));
            assert.equal(scopePrompts, 1); assert.equal(setupPrompts, scenario === 'dependency-fixed' ? 0 : 1);
            assert.deepEqual(manifest.scope.selectedFiles, ['sample.py']);
            assert.deepEqual(manifest.scope.excludedFiles, ['excluded.py']);
            assert.equal(manifest.expectedTargets, 1); assert.equal(manifest.allTargetsPassed, false);
            assert.equal(manifest.preflightEvents[0].fixtureId, null);
            assert.equal(manifest.preflightEvents[0].resourceCount, 0);
            assert.equal(manifest.preflightEvents[0].blockedModules, 1);
            const setupDir = created.find(name => name.startsWith('import_check_'))!;
            assert.ok(setupDir);
            const checks = fs.readdirSync(path.join(outputRoot, setupDir)).filter(name => /^\d+$/.test(name));
            assert.equal(checks.length, ['ready', 'default-output', 'new-blocker'].includes(scenario) ? 2 : 1, 'only one confirmed rescan, never a repair loop');
            if (['ready', 'default-output', 'dependency-fixed'].includes(scenario)) {
                assert.equal(manifest.finishedTargets, 1);
                assert.equal(manifest.status, 'completed');
                assert.equal(manifest.preflightBlockedModules, 0);
                const ready = manifest.preflightEvents.find((event: any) => event.phase === 'setup' && event.status === 'ready');
                if (scenario !== 'dependency-fixed') { assert.match(ready.fixtureId, /^[a-f0-9]{64}$/); assert.equal(ready.resourceCount, 1); }
                else { assert.equal(ready.fixtureId, null); assert.equal(ready.resourceCount, 0); }
                assert.equal(path.isAbsolute(ready.report), false);
                assert.equal(fs.existsSync(path.resolve(directory, ready.report)), true);
                assert.equal(manifest.preflightEvents.at(-1).status, 'resumed');
                assert.equal(manifest.preflightEvents.at(-1).fixtureId, ready.fixtureId);
            } else {
                assert.equal(manifest.finishedTargets, 0);
                assert.equal(manifest.targets[0].state, 'pending');
                assert.equal(manifest.complete, false);
                assert.equal(manifest.status, ['declined', 'cancelled'].includes(scenario) ? 'cancelled' : 'environment-blocked');
                assert.ok(!manifest.preflightEvents.some((event: any) => event.status === 'resumed'));
                assert.ok(fs.existsSync(path.join(directory, 'failure_report.md')));
                if (scenario === 'new-blocker') { assert.equal(updates, 2); }
                else { assert.equal(updates, 0); }
            }
            assert.equal(modelCalls, 0);
            assert.equal(fs.existsSync(path.join(root, 'owned_first')), false);
            assert.equal(fs.existsSync(path.join(root, 'owned_second')), false);
            const release = pythonEnvironmentActivity.acquire('setup'); assert.ok(release); release();
        }
        assert.deepEqual(resumedCaches, [0, 0, 0], 'both changed and unchanged fixture IDs refresh the parent failure cache');
    } finally { globalThis.fetch = originalFetch; Module._load = originalLoad; fs.rmSync(root, { recursive: true, force: true }); }
});
