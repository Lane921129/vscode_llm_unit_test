import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createImportFixturePlan, ImportFixtureRule } from '../pipeline/importFixtures';
import { pythonEnvironmentActivity } from '../environment/pythonEnvironmentSetup';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import type { ImportCheck, ImportCheckTarget } from '../environment/projectImportCheck';

test('batch planning confirms once, resumes the same 212 targets, and preserves the latest blockers or cancellation', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-planning-'));
    const output = path.join(root, 'results');
    const selectedFiles = ['nested/selected.py', 'sample.py'];
    const dependency = 'initialization_only.py';
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const settings: Record<string, unknown> = { pythonPath: python };
    let mode: 'ready' | 'new-blocker' | 'declined' | 'cancelled' = 'ready';
    let scopePrompts = 0, approvals = 0, preliminaryPrompts = 0, scans = 0, updates = 0, startedTargets = 0, modelCalls = 0;
    let beforeApproval: any;
    const scansWithTargets: ImportCheckTarget[][] = [];
    const logs: string[] = [];
    const targetNames = Array.from({ length: 106 }, (_, index) => `target_${String(index).padStart(3, '0')}`);
    const sourceHash = (file: string) => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    const manifests = () => fs.readdirSync(output).map(name => path.join(output, name, 'batch_manifest.json')).filter(fs.existsSync);
    const readManifest = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const inventory = (manifest: any) => manifest.targets.map(({ id, file, target }: any) => ({ id, file, target }));
    const vscode = {
        ConfigurationTarget: { Global: 1 }, ExtensionMode: { Development: 2, Test: 3 },
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        Uri: { file: (fsPath: string) => ({ fsPath }) }, env: { openExternal: async () => true },
        workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: root } }],
            openTextDocument: async (file: string) => ({ file }),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback,
                update: async (key: string, value: unknown) => { updates++; settings[key] = value; } }) },
        window: {
            registerWebviewViewProvider: (_name: string, provider: any) => {
                provider.webview = { postMessage: async (message: any) => {
                    if (message.command === 'appendLog') { logs.push(message.text); }
                    if (message.command === 'appendLog' && message.text?.includes('批次目標：')) {
                        startedTargets++;
                        // Scope continuation is the subject here; stop before unrelated target/model execution.
                        handlers.get('llm-unit-test.abortTest')!();
                    }
                    return true;
                } };
                return { dispose() {} };
            },
            showInformationMessage: async () => {}, showTextDocument: async () => {},
            showQuickPick: async (items: any[]) => { scopePrompts++; return items.filter(item => selectedFiles.includes(item.file)); },
            showWarningMessage: async (_message: string, _options: unknown, action?: string) => {
                if (action === '處理初始化設定') { preliminaryPrompts++; return action; }
                if (action !== '套用此清單並重新檢查') { return undefined; }
                approvals++;
                assert.equal(pythonEnvironmentActivity.acquire('use'), undefined, 'the real setup controller owns its exclusive lease');
                beforeApproval = manifests().map(readManifest).find(manifest => manifest.status === 'running');
                assert.ok(beforeApproval);
                assert.equal(beforeApproval.expectedTargets, 212);
                assert.equal(beforeApproval.finishedTargets, 0);
                assert.ok(beforeApproval.targets.every((target: any) => target.state === 'pending'));
                assert.equal(scans, 2, 'the batch plan and setup preview precede the only approval');
                if (mode === 'cancelled') { handlers.get('llm-unit-test.abortTest')!(); }
                return mode === 'declined' ? undefined : action;
            }
        },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async () => { modelCalls++; throw new Error('No model execution belongs to this batch coordination fixture'); };
    let restore = () => {};
    try {
        fs.mkdirSync(path.join(root, 'nested'));
        for (const [index, file] of [...selectedFiles, dependency].entries()) {
            fs.writeFileSync(path.join(root, file), 'from pathlib import Path\n'
                + `Path("owned_${index}").mkdir(exist_ok=True)\n`
                + (file === dependency ? '' : targetNames.map(name => `def ${name}():\n    return 1\n`).join('')));
        }
        fs.writeFileSync(path.join(root, 'excluded.py'), 'def invalid(\n');
        const utilities = require('../utils/utils');
        const checks = require('../environment/projectImportCheck');
        const originalExtract = utilities.extractFunctionsWithAst, originalInspect = checks.inspectProjectImports;
        restore = () => { utilities.extractFunctionsWithAst = originalExtract; checks.inspectProjectImports = originalInspect; };
        utilities.extractFunctionsWithAst = async (file: string) => {
            assert.ok(selectedFiles.includes(path.relative(root, file).replace(/\\/g, '/')));
            return targetNames.map(name => ({ name, fullName: name, className: null, isAsync: false, args: [] }));
        };
        checks.inspectProjectImports = async (scanRoot: string, scanPython: string, targets: ImportCheckTarget[], directory: string,
            rules: ImportFixtureRule[], _log: unknown, boundRoot: string, planBeforeImport: boolean): Promise<ImportCheck> => {
            scans++;
            assert.equal(planBeforeImport, true, 'batch and setup must request the pre-import planning path');
            assert.equal(scanRoot, root); assert.equal(scanPython, python);
            scansWithTargets.push(structuredClone(targets));
            const check: ImportCheck = { root: fs.realpathSync(root), python, directory,
                fixtureId: createImportFixturePlan(root, rules, boundRoot)?.id || null,
                rows: selectedFiles.map(file => ({ file, status: 'loaded' })),
                proposedRules: structuredClone(rules), proposedPlan: null, proposals: [] };
            if (!rules.length) {
                check.planningSources = [...selectedFiles, dependency].map(file => ({ file, sourceHash: sourceHash(file) }));
                check.proposedRules = check.planningSources.map(({ file, sourceHash: hash }, index) => ({ file,
                    resources: [{ kind: 'directory', path: `owned_${index}` }], resourceSourceHash: hash }));
                check.proposedPlan = createImportFixturePlan(root, check.proposedRules);
                check.rows.forEach(row => { row.status = 'blocked'; row.stage = 'initialization-plan'; });
            } else {
                assert.equal(approvals, 1, 'the import rescan occurs only after confirmation');
                assert.equal(scans, 3, 'there is exactly one confirmed rescan');
                if (mode === 'new-blocker') {
                    check.rows[0] = { file: selectedFiles[0], status: 'blocked', stage: 'module-import',
                        issue: { kind: 'other', issue: 'new-dynamic-operation', advice: 'Inspect the dynamic blocker.' } };
                }
            }
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'import_check.md'), '# Neutral initialization scan\n');
            return check;
        };
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        const run = handlers.get('llm-unit-test.runBatchAnalysis')!;
        for (const scenario of ['ready', 'new-blocker', 'declined', 'cancelled'] as const) {
            await t.test(scenario, async () => {
                mode = scenario; scopePrompts = approvals = preliminaryPrompts = scans = updates = startedTargets = 0;
                scansWithTargets.length = 0; logs.length = 0; beforeApproval = undefined;
                settings.importFixtures = []; settings.importFixtureRoot = '';
                const before = fs.existsSync(output) ? manifests() : [];
                await run({ envType: 'local', modelName: 'fixture', batchPath: root, outputPath: output,
                    promptStrategy: 'tier2', maxLoops: 1, timeoutSeconds: 30 });
                const created = manifests().filter(file => !before.includes(file));
                assert.equal(created.length, 1, 'setup continuation reuses the original batch directory: ' + logs.join('\n'));
                const manifest = readManifest(created[0]);
                assert.equal(scopePrompts, 1); assert.equal(preliminaryPrompts, 0); assert.equal(approvals, 1);
                assert.equal(manifest.batchId, beforeApproval.batchId);
                assert.deepEqual(manifest.scope, beforeApproval.scope);
                assert.deepEqual(manifest.scope.selectedFiles, selectedFiles);
                assert.deepEqual(manifest.scope.excludedFiles, ['excluded.py', dependency]);
                assert.deepEqual(inventory(manifest), inventory(beforeApproval));
                assert.equal(manifest.expectedTargets, 212); assert.equal(manifest.finishedTargets, 0);
                assert.deepEqual(manifest.discoveryFailures, []);
                const expectedImportTargets = selectedFiles.map(file => ({ file: path.join(root, file), target: targetNames[0] }));
                assert.ok(scansWithTargets.every(targets => JSON.stringify(targets) === JSON.stringify(expectedImportTargets)),
                    'dependency-only planning evidence must not broaden the selected target scope');
                assert.equal(manifest.preflightEvents[0].status, 'planned-awaiting-confirmation');
                assert.equal(manifest.preflightEvents[0].blockedModules, 2, 'the initial historical observation remains intact');
                const setup = manifest.preflightEvents.find((event: any) => event.phase === 'setup' && event.status !== 'requested');
                assert.ok(setup);
                if (scenario === 'ready') {
                    assert.equal(setup.status, 'ready'); assert.equal(setup.blockedModules, 0);
                    assert.equal(manifest.preflightBlockedModules, 0);
                    assert.equal(manifest.preflightEvents.at(-1).status, 'resumed');
                    assert.equal(manifest.preflightEvents.at(-1).fixtureId, setup.fixtureId);
                    assert.equal(startedTargets, 1, 'ready actually schedules the original batch before the test aborts it');
                    assert.equal(manifest.status, 'cancelled', 'the fixture deliberately stops before target execution');
                } else {
                    assert.equal(startedTargets, 0);
                    assert.ok(!manifest.preflightEvents.some((event: any) => event.status === 'resumed'));
                    assert.ok(manifest.targets.every((target: any) => target.state === 'pending'));
                    assert.equal(manifest.status, scenario === 'new-blocker' ? 'environment-blocked' : 'cancelled');
                    if (scenario === 'new-blocker') {
                        assert.equal(setup.status, 'blocked'); assert.equal(setup.blockedModules, 1);
                        assert.equal(manifest.preflightBlockedModules, 1, 'latest dynamic blockers replace the initial planning count');
                    }
                }
                assert.equal(scans, ['ready', 'new-blocker'].includes(scenario) ? 3 : 2);
                assert.equal(updates, ['ready', 'new-blocker'].includes(scenario) ? 2 : 0);
                assert.equal(modelCalls, 0);
                assert.ok(!fs.existsSync(path.join(root, 'owned_0')));
                const release = pythonEnvironmentActivity.acquire('setup'); assert.ok(release); release();
            });
        }
    } finally {
        restore(); globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
