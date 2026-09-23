import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EnvironmentInspection, findRequirementFiles, preparePythonEnvironment, PythonEnvironmentActivity,
    SetupCommand, SetupRunner, setupEnvironment, runSetupCommand, dependencyConflictSummary } from '../environment/pythonEnvironmentSetup';
import { DependencyInventory, inventoryReport, isDependencyInventory } from '../environment/dependencyInventory';
import { PythonInstallationDecision, PythonInstallationPlan } from '../environment/pythonInstallationPlan';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-setup-'));
    const file = path.join(root, 'sample.py');
    const tools = path.join(root, 'tools.txt');
    fs.writeFileSync(file, 'def target(value):\n    return value + 1\n');
    fs.writeFileSync(tools, 'coverage\n');
    const python = path.join(root, 'existing-python');
    const options = { projectRoot: root, file, toolRequirements: tools, candidates: [{ executable: python }],
        packageName: async (missing: string) => missing, confirmInstall: async () => true };
    return { root, python, options, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function ready(python: string): EnvironmentInspection {
    return { python, version: [3, 12, 0], virtual: false, coverage: true, status: 'ready' };
}
function harness(inspect: (command: SetupCommand) => EnvironmentInspection,
    install: (command: SetupCommand) => void = () => {}) {
    const commands: SetupCommand[] = [];
    const runner: SetupRunner = async command => {
        commands.push(command);
        if (command.args.some(arg => arg.endsWith('environment_probe.py'))) {
            return { code: 0, stdout: JSON.stringify(inspect(command)), stderr: '' };
        }
        if (command.args.includes('install')) { install(command); }
        return { code: 0, stdout: '', stderr: '' };
    };
    return { commands, runner, installations: () => commands.filter(command => command.args.includes('install')) };
}

test('reused environments still fail on existing conflicts and report only safe dependency tokens', async () => {
    const f = fixture();
    try {
        const h = harness(() => ready(f.python));
        await assert.rejects(preparePythonEnvironment(f.options, command => command.args.includes('check')
            ? Promise.resolve({ code: 1, stdout: 'mutatest 3.1.0 has requirement coverage<6.0,>=4.4, but you have coverage 7.16.1.\nPRIVATE_RESPONSE https://token:secret@example.invalid', stderr: '' })
            : h.runner(command)), error => {
                assert.match(String(error), /mutatest 3.1.0.*coverage<6.0,>=4.4.*coverage 7.16.1/);
                assert.doesNotMatch(String(error), /PRIVATE_RESPONSE|secret|example.invalid/);
                return true;
            });
        assert.equal(h.installations().length, 0);
        assert.equal(dependencyConflictSummary('https://token:secret@example.invalid'), '');
    } finally { f.dispose(); }
});

test('finds an already-working user interpreter before installing anything into the first candidate', async () => {
    const f = fixture();
    try {
        const other = path.join(f.root, 'other-python');
        const h = harness(command => command.executable === f.python
            ? { ...ready(f.python), status: 'missing', missing: 'neutral_dependency' } : ready(other));
        const result = await preparePythonEnvironment({ ...f.options, candidates: [{ executable: f.python }, { executable: other }] }, h.runner);
        assert.equal(result.python, other);
        assert.deepEqual(result.installed, []);
        assert.equal(h.installations().length, 0);
        assert.equal(h.commands.some(command => command.args.includes('check')), true);
        assert.equal(fs.existsSync(path.join(f.root, '.venv')), false);
    } finally { f.dispose(); }
});

test('installs the nearest requirements once in its directory and rechecks the same interpreter', async () => {
    const f = fixture();
    try {
        const application = path.join(f.root, 'nested'); fs.mkdirSync(application);
        const file = path.join(application, 'sample.py'); fs.copyFileSync(f.options.file, file);
        const requirements = path.join(application, 'requirements.txt'); fs.writeFileSync(requirements, 'neutral_dependency==1.0\n');
        fs.writeFileSync(path.join(f.root, 'requirements.txt'), 'unrelated_dependency\n');
        let installed = false;
        const h = harness(() => installed ? ready(f.python) : { ...ready(f.python), status: 'missing', missing: 'neutral_dependency' }, command => {
            assert.deepEqual(command.args.slice(-2), ['-r', requirements]);
            assert.equal(command.cwd, application); installed = true;
        });
        const result = await preparePythonEnvironment({ ...f.options, file }, h.runner);
        assert.equal(result.requirements, requirements);
        assert.equal(h.installations().length, 1);
        assert.ok(h.commands.every(command => command.executable === f.python));
        assert.ok(h.commands.some(command => command.args.includes('check')));
    } finally { f.dispose(); }
});

test('without requirements installs one missing package at a time, with an explicit import-name mapping', async () => {
    const f = fixture();
    try {
        const pending = ['neutral_alpha', 'neutral_beta'];
        const h = harness(() => pending.length ? { ...ready(f.python), status: 'missing', missing: pending[0] } : ready(f.python), command => {
            assert.equal(command.args.at(-1), pending[0] === 'neutral_alpha' ? 'neutral-alpha-distribution' : 'neutral_beta'); pending.shift();
        });
        const result = await preparePythonEnvironment({ ...f.options,
            packageName: async name => name === 'neutral_alpha' ? 'neutral-alpha-distribution' : name }, h.runner);
        assert.deepEqual(result.installed, ['neutral-alpha-distribution', 'neutral_beta']);
        assert.equal(h.installations().length, 2);
        assert.equal(fs.existsSync(path.join(f.root, '.venv')), false);
    } finally { f.dispose(); }
});

test('a repeated missing import stops after one installation and never claims success', async () => {
    const f = fixture();
    try {
        const h = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'neutral_missing' }));
        await assert.rejects(preparePythonEnvironment(f.options, h.runner), /停止重複安裝/);
        assert.equal(h.installations().length, 1);
    } finally { f.dispose(); }
});

test('one confirmation installs same-name candidates and saved mappings for a folder, then verifies every required import', async () => {
    const f = fixture();
    try {
        const pending = ['neutral_alpha', 'neutral_beta'];
        let confirmations = 0;
        const h = harness(() => ({ ...ready(f.python), status: pending.length ? 'missing' : 'ready', missing: pending[0],
            inventory: { ...inventory([...pending]), optionalMissing: ['neutral_optional'] } }), command => {
            assert.equal(confirmations, 1);
            assert.equal(command.args.at(-1), pending[0] === 'neutral_alpha' ? 'neutral-dist' : 'neutral_beta');
            pending.shift();
        });
        const result = await preparePythonEnvironment({ ...f.options, file: f.root, scope: 'folder',
            packageName: async name => name === 'neutral_alpha' ? 'neutral-dist' : undefined,
            savePackageMappings: async () => assert.fail('Automatic candidates must not become persisted mappings'),
            confirmInstall: async plan => {
                confirmations++; assert.equal(h.installations().length, 0);
                assert.equal(plan.blockers.length, 0);
                assert.deepEqual(plan.missing.map(item => item.sameNameCandidate), [false, true]);
                assert.deepEqual(plan.operations.map(operation => operation.args), [['neutral-dist'], ['neutral_beta']]);
                return true;
            } }, h.runner);
        assert.equal(confirmations, 1); assert.equal(h.installations().length, 2);
        assert.deepEqual(result.inventory?.missing, []);
        assert.deepEqual(result.inventory?.optionalMissing, ['neutral_optional']);
    } finally { f.dispose(); }
});

test('a same-name candidate rejected by pip does not retry guesses or report the environment ready', async () => {
    const f = fixture();
    try {
        const h = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'neutral_unknown' }));
        let attempts = 0;
        await assert.rejects(preparePythonEnvironment({ ...f.options, packageName: undefined }, async command => {
            if (command.args.includes('install')) {
                attempts++;
                return { code: 1, stdout: 'PRIVATE_RESPONSE_SENTINEL', stderr: 'No matching distribution found' };
            }
            return h.runner(command);
        }), error => {
            assert.match(String(error), /import 名稱可能與安裝名稱不同/);
            assert.doesNotMatch(String(error), /PRIVATE_RESPONSE/); return true;
        });
        assert.equal(attempts, 1); assert.equal(h.commands.some(command => command.args.includes('check')), false);
    } finally { f.dispose(); }
});

test('same-name proposals require confirmation even when no package mapping exists', async () => {
    const f = fixture();
    try {
        for (const packageName of [undefined, async () => undefined]) {
            for (const confirmInstall of [undefined, async () => false]) {
                const h = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'neutral_dependency' }));
                await assert.rejects(preparePythonEnvironment({ ...f.options, packageName, confirmInstall }, h.runner), /未確認安裝清單/);
                assert.equal(h.installations().length, 0);
                assert.equal(h.commands.some(command => command.args.includes('check')), false);
            }
        }
    } finally { f.dispose(); }
});

test('an incomplete requirements file is reported instead of silently overriding project dependencies', async () => {
    const f = fixture();
    try {
        fs.writeFileSync(path.join(f.root, 'requirements.txt'), '# Missing a dependency\n');
        const h = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'neutral_missing' }));
        await assert.rejects(preparePythonEnvironment(f.options, h.runner), /補齊原應用相依清單/);
        assert.equal(h.installations().length, 1);
    } finally { f.dispose(); }
});

test('local, standard-library and side-effect failures do not trigger package installation', async () => {
    const f = fixture();
    try {
        for (const status of ['local-or-submodule', 'stdlib', 'blocked', 'import-error'] as const) {
            const h = harness(() => ({ ...ready(f.python), status, missing: 'neutral_missing' }));
            await assert.rejects(preparePythonEnvironment(f.options, h.runner));
            assert.equal(h.installations().length, 0);
        }
    } finally { f.dispose(); }
});

test('installer failure, cancellation and dependency conflicts never produce ready results or leak raw output', async () => {
    const f = fixture();
    try {
        const h = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'neutral_missing' }));
        await assert.rejects(preparePythonEnvironment(f.options, async command => command.args.includes('install')
            ? { code: 1, stdout: 'PRIVATE_OUTPUT_SENTINEL', stderr: 'ResolutionImpossible' } : h.runner(command)), error => {
                assert.match(String(error), /版本衝突/); assert.doesNotMatch(String(error), /PRIVATE_OUTPUT_SENTINEL/); return true;
            });
        const controller = new AbortController();
        const cancelled = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'neutral_missing' }), () => controller.abort());
        await assert.rejects(preparePythonEnvironment({ ...f.options, signal: controller.signal }, cancelled.runner), /取消/);
        assert.equal(cancelled.installations().length, 1);
        assert.equal(cancelled.commands.at(-1)?.args.includes('install'), true);
        let installed = false;
        const conflict = harness(() => installed ? ready(f.python) : { ...ready(f.python), status: 'missing', missing: 'neutral_missing' }, () => { installed = true; });
        await assert.rejects(preparePythonEnvironment(f.options, async command => command.args.includes('check')
            ? { code: 1, stdout: 'dependency conflict', stderr: '' } : conflict.runner(command)), /尚未標示環境就緒/);
    } finally { f.dispose(); }
});

test('missing coverage is installed in the selected environment and verified after package installation', async () => {
    const f = fixture();
    try {
        let tools = false;
        const h = harness(() => ({ ...ready(f.python), coverage: tools }), () => { tools = true; });
        const result = await preparePythonEnvironment(f.options, h.runner);
        assert.deepEqual(result.installed, ['test-tools']);
        assert.deepEqual(h.installations()[0].args.slice(-2), ['-r', f.options.toolRequirements]);
    } finally { f.dispose(); }
});

test('tool installation preserves the application requirements even when target import already succeeds', async () => {
    const f = fixture();
    try {
        const requirements = path.join(f.root, 'requirements.txt');
        fs.writeFileSync(requirements, 'neutral_dependency==1.0\n');
        let tools = false;
        const h = harness(() => ({ ...ready(f.python), coverage: tools }), command => {
            assert.deepEqual(command.args.slice(-4), ['-r', f.options.toolRequirements, '-r', requirements]);
            tools = true;
        });
        const result = await preparePythonEnvironment(f.options, h.runner);
        assert.equal(result.requirements, requirements);
        assert.deepEqual(result.installed, ['test-tools']);
        assert.equal(h.installations().length, 1);
    } finally { f.dispose(); }
});

test('package names cannot inject pip options, paths or URLs; requirements picker cancellation installs nothing', async () => {
    const f = fixture();
    try {
        for (const name of ['', '--upgrade', '../package', 'https://example.invalid/package', 'name another']) {
            const h = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'neutral_missing' }));
            await assert.rejects(preparePythonEnvironment({ ...f.options, packageName: async () => name }, h.runner), /單一套件名稱/);
            assert.equal(h.installations().length, 0);
        }
        fs.writeFileSync(path.join(f.root, 'requirements-dev.txt'), 'one\n');
        fs.writeFileSync(path.join(f.root, 'requirements-prod.txt'), 'two\n');
        assert.equal(findRequirementFiles(f.root, f.options.file).length, 2);
        const h = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'neutral_missing' }));
        await assert.rejects(preparePythonEnvironment({ ...f.options, chooseRequirements: async () => undefined }, h.runner), /尚未選擇/);
        assert.equal(h.installations().length, 0);
    } finally { f.dispose(); }
});

test('installation destinations are cleared and environment activity cannot overlap active Python use', () => {
    const env = setupEnvironment({ PIP_TARGET: '/elsewhere', PIP_PREFIX: '/other', PIP_USER: 'true',
        PYTHONPATH: '/project', PYTHONHOME: '/unrelated', PIP_INDEX_URL: 'https://example.invalid/simple' });
    for (const key of ['PIP_TARGET', 'PIP_PREFIX', 'PIP_USER', 'PYTHONPATH', 'PYTHONHOME']) { assert.equal(env[key], undefined); }
    assert.equal(env.PIP_INDEX_URL, 'https://example.invalid/simple');
    const activity = new PythonEnvironmentActivity();
    const first = activity.acquire('use')!, second = activity.acquire('use')!;
    assert.equal(activity.acquire('setup'), undefined);
    first(); first(); assert.equal(activity.acquire('setup'), undefined);
    second(); const setup = activity.acquire('setup')!;
    assert.equal(activity.acquire('use'), undefined); assert.equal(activity.acquire('setup'), undefined);
    setup(); assert.ok(activity.acquire('use'));
});

function inventory(missing: string[] = [], complete = true): DependencyInventory {
    return { schemaVersion: 'dependency-inventory-v1', filesScanned: 2, excludedDirectories: 1,
        dynamicImports: 0, complete, missing, optionalMissing: [], issues: complete ? [] : [{ file: 'broken.py', reason: 'source-parse-error' }],
        imports: missing.map(module => ({ module, kind: 'external', availability: 'missing',
            references: [{ file: 'nested/source.py', line: 2, context: 'required' }] })) };
}

test('folder setup reports every missing import, selects root requirements and verifies the whole scope after installation', async () => {
    const f = fixture();
    try {
        const requirements = path.join(f.root, 'requirements.txt'); fs.writeFileSync(requirements, 'neutral_alpha\nneutral_beta\n');
        const reports: DependencyInventory[] = [];
        let installed = false;
        const h = harness(command => {
            const payload = JSON.parse(command.input!);
            assert.equal(payload.scanRoot, f.root); assert.equal(payload.file, undefined);
            assert.deepEqual(payload.excludedPaths, [path.join(f.root, 'results')]);
            return { ...ready(f.python), status: installed ? 'ready' : 'missing', missing: installed ? undefined : 'neutral_alpha',
                inventory: inventory(installed ? [] : ['neutral_alpha', 'neutral_beta']) };
        }, command => { assert.deepEqual(command.args.slice(-2), ['-r', requirements]); installed = true; });
        const result = await preparePythonEnvironment({ ...f.options, file: f.root, scope: 'folder',
            excludedPaths: [path.join(f.root, 'results')], inventory: scan => reports.push(scan) }, h.runner);
        assert.deepEqual(reports[0].missing, ['neutral_alpha', 'neutral_beta']);
        assert.deepEqual(result.inventory?.missing, []);
        assert.equal(h.installations().length, 1);
        assert.equal(result.requirements, requirements);
    } finally { f.dispose(); }
});

test('partial or malformed scans cannot install or mark an environment ready; partial diagnostics survive', async () => {
    const f = fixture();
    try {
        let report: DependencyInventory | undefined;
        const h = harness(() => ({ ...ready(f.python), status: 'import-error', inventory: inventory(['neutral_alpha'], false) }));
        await assert.rejects(preparePythonEnvironment({ ...f.options, file: f.root, scope: 'folder', inventory: scan => { report = scan; } }, h.runner), /掃描不完整/);
        assert.equal(report?.issues[0].reason, 'source-parse-error');
        assert.equal(h.installations().length, 0);
        for (const value of [{ ...ready(f.python), inventory: inventory(['neutral_alpha']) }, ready(f.python),
            { ...ready(f.python), inventory: { ...inventory(), imports: [{ module: 'bad' }] } }]) {
            const malformed = harness(() => value as EnvironmentInspection);
            await assert.rejects(preparePythonEnvironment({ ...f.options, file: f.root, scope: 'folder' }, malformed.runner));
            assert.equal(malformed.installations().length, 0);
        }
    } finally { f.dispose(); }
});

test('folder mapping fallback installs distinct required dependencies only and retains all missing names on failure', async () => {
    const f = fixture();
    try {
        const missing = ['neutral_alpha', 'neutral_beta'];
        const h = harness(() => ({ ...ready(f.python), status: missing.length ? 'missing' : 'ready', missing: missing[0],
            inventory: { ...inventory([...missing]), optionalMissing: ['neutral_optional'] } }), () => { missing.shift(); });
        const result = await preparePythonEnvironment({ ...f.options, file: f.root, scope: 'folder' }, h.runner);
        assert.deepEqual(result.installed, ['neutral_alpha', 'neutral_beta']);
        assert.deepEqual(result.inventory?.optionalMissing, ['neutral_optional']);
        const reports: DependencyInventory[] = [];
        const failed = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'neutral_alpha', inventory: inventory(['neutral_alpha', 'neutral_beta']) }));
        await assert.rejects(preparePythonEnvironment({ ...f.options, file: f.root, scope: 'folder',
            packageName: undefined, inventory: scan => reports.push(scan) }, failed.runner), /停止重複安裝/);
        assert.deepEqual(reports.at(-1)?.missing, ['neutral_alpha', 'neutral_beta']);
        assert.equal(failed.installations().length, 1);
    } finally { f.dispose(); }
});

test('inventory report lists provenance, unresolved imports and limitations without rendering source paths as HTML', () => {
    const scan = inventory(['neutral_alpha']);
    scan.imports[0].references[0].file = '<script>|unsafe.py';
    assert.equal(isDependencyInventory(scan), true);
    const report = inventoryReport(scan, ['original_missing']);
    assert.match(report, /original_missing/); assert.match(report, /neutral_alpha/);
    assert.match(report, /&#60;script&#62;&#124;unsafe.py:2/);
    assert.doesNotMatch(report, /<script>/);
    assert.match(report, /不執行專案或外部套件/);
    assert.match(report, /正式測試預檢/);
});

test('large scan output preserves UTF-8 paths across process chunks and supports more than the installer output cap', async () => {
    const result = await runSetupCommand({ executable: process.execPath, cwd: os.tmpdir(), env: process.env,
        stdoutLimit: 256000, timeoutMs: 10000, args: ['-e',
            "const b=Buffer.from('測試.py'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>{process.stdout.write(b.subarray(2)); process.stdout.write('x'.repeat(70000));},30);"] });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '測試.py' + 'x'.repeat(70000));
});

test('an installation never starts without explicit confirmation, including requirements and test tools', async () => {
    const f = fixture();
    try {
        fs.writeFileSync(path.join(f.root, 'requirements.txt'), 'neutral_dependency==1.0\n');
        for (const confirmInstall of [undefined, async () => false]) {
            for (const current of [{ ...ready(f.python), status: 'missing' as const, missing: 'neutral_dependency' }, { ...ready(f.python), coverage: false }]) {
                const h = harness(() => current);
                await assert.rejects(preparePythonEnvironment({ ...f.options, confirmInstall }, h.runner), /未確認安裝清單/);
                assert.equal(h.installations().length, 0);
                assert.equal(h.commands.some(command => command.args.includes('check')), false);
            }
        }
        const readyHarness = harness(() => ready(f.python));
        await preparePythonEnvironment({ ...f.options, confirmInstall: async () => { assert.fail('No install needs no confirmation'); } }, readyHarness.runner);
    } finally { f.dispose(); }
});

test('folder confirmation includes all known dependencies and tools; invalid mapping blocks every installation', async () => {
    const f = fixture();
    try {
        const pending = ['neutral_alpha', 'neutral_beta'];
        let tools = false, requests = 0;
        const h = harness(() => ({ ...ready(f.python), coverage: tools, status: pending.length ? 'missing' : 'ready', missing: pending[0],
            inventory: inventory([...pending]) }), command => {
                if (command.args.includes('-r')) { tools = true; } else { pending.shift(); }
            });
        await preparePythonEnvironment({ ...f.options, file: f.root, scope: 'folder', confirmInstall: async plan => {
            requests++; assert.equal(h.installations().length, 0);
            assert.deepEqual(plan.missing.map(item => item.module), ['neutral_alpha', 'neutral_beta']);
            assert.equal(plan.operations.length, 3); assert.equal(plan.python, f.python);
            assert.equal(plan.declarations[0].package, 'coverage');
            assert.deepEqual(plan.missing[0].locations, ['nested/source.py:2']); return true;
        } }, h.runner);
        assert.equal(requests, 1); assert.equal(h.installations().length, 3);
        let blocked: PythonInstallationPlan | undefined;
        const unknown = harness(() => ({ ...ready(f.python), coverage: false, status: 'missing', missing: 'neutral_alpha', inventory: inventory(['neutral_alpha', 'neutral_beta']) }));
        await assert.rejects(preparePythonEnvironment({ ...f.options, file: f.root, scope: 'folder',
            packageName: async name => name === 'neutral_alpha' ? name : '--invalid',
            confirmInstall: async plan => { blocked = plan; return true; } }, unknown.runner), /單一套件名稱/);
        assert.equal(blocked?.missing.length, 2); assert.ok(blocked?.blockers.length);
        assert.equal(unknown.installations().length, 0);
    } finally { f.dispose(); }
});

test('newly discovered single-file imports require a new list and cancellation preserves only previously installed packages', async () => {
    const f = fixture();
    try {
        const pending = ['neutral_alpha', 'neutral_beta'];
        const plans: PythonInstallationPlan[] = [];
        const h = harness(() => ({ ...ready(f.python), status: 'missing', missing: pending[0] }), () => { pending.shift(); });
        await assert.rejects(preparePythonEnvironment({ ...f.options, confirmInstall: async plan => {
            plans.push(plan); return plans.length === 1;
        } }, h.runner), /先前已完成的安裝會保留/);
        assert.equal(plans.length, 2);
        assert.equal(plans[1].missing[0].module, 'neutral_beta');
        assert.deepEqual(plans[1].previouslyInstalled, ['neutral_alpha']);
        assert.equal(h.installations().length, 1);
    } finally { f.dispose(); }
});

test('requirements changed during confirmation, abort after confirmation and modified preview objects cannot expand installation', async () => {
    const f = fixture();
    try {
        const requirements = path.join(f.root, 'requirements.txt');
        fs.writeFileSync(requirements, 'neutral_alpha==1\n');
        const h = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'neutral_alpha' }));
        await assert.rejects(preparePythonEnvironment({ ...f.options, confirmInstall: async () => {
            fs.writeFileSync(requirements, 'neutral_beta==2\n'); return true;
        } }, h.runner), /確認期間已變更/);
        assert.equal(h.installations().length, 0);
        const abort = new AbortController();
        await assert.rejects(preparePythonEnvironment({ ...f.options, signal: abort.signal,
            confirmInstall: async () => { abort.abort(); return true; } }, h.runner), /取消/);
        assert.equal(h.installations().length, 0);
        fs.unlinkSync(requirements);
        let installed = false;
        const mutation = harness(() => installed ? ready(f.python) : { ...ready(f.python), status: 'missing', missing: 'neutral_alpha' }, command => {
            assert.equal(command.args.at(-1), 'neutral_alpha'); installed = true;
        });
        await preparePythonEnvironment({ ...f.options, confirmInstall: async plan => {
            plan.operations[0].args = ['unapproved_package']; plan.mappings.neutral_alpha = 'unapproved_package'; return true;
        } }, mutation.runner);
        assert.equal(mutation.installations().length, 1);
    } finally { f.dispose(); }
});

test('a requirements change after one approved operation blocks the next operation without silently approving it again', async () => {
    const f = fixture();
    try {
        let dependencyInstalled = false, confirmations = 0;
        const h = harness(() => dependencyInstalled ? { ...ready(f.python), coverage: false }
            : { ...ready(f.python), coverage: false, status: 'missing', missing: 'neutral_alpha' }, () => {
            dependencyInstalled = true;
            fs.writeFileSync(f.options.toolRequirements, 'unapproved_tool\n');
        });
        await assert.rejects(preparePythonEnvironment({ ...f.options, confirmInstall: async () => { confirmations++; return true; } }, h.runner), /requirements 已變更/);
        assert.equal(h.installations().length, 1); assert.equal(confirmations, 1);
        assert.equal(h.commands.some(command => command.args.includes('check')), false);
    } finally { f.dispose(); }
});

test('a same-name proposal can be changed in the preview, saved and installed only after confirming a rebuilt plan', async () => {
    const f = fixture();
    try {
        let installed = false;
        const plans: PythonInstallationPlan[] = [], saved: Record<string, string>[] = [];
        const h = harness(() => installed ? ready(f.python) : { ...ready(f.python), status: 'missing', missing: 'neutral_alpha' }, command => {
            assert.equal(plans.length, 2); assert.equal(command.args.at(-1), 'neutral-distribution'); installed = true;
        });
        await preparePythonEnvironment({ ...f.options, packageName: undefined,
            savePackageMappings: async mappings => { saved.push(mappings); assert.equal(h.installations().length, 0); },
            confirmInstall: async (plan): Promise<PythonInstallationDecision> => {
                plans.push(plan);
                if (plans.length === 1) {
                    assert.equal(plan.blockers.length, 0); assert.equal(plan.missing[0].sameNameCandidate, true);
                    assert.equal(plan.missing[0].mappingEditable, true);
                    return { mappings: { neutral_alpha: 'neutral-distribution' } };
                }
                assert.equal(plan.blockers.length, 0); assert.notEqual(plan.id, plans[0].id);
                assert.equal(plan.mappings.neutral_alpha, 'neutral-distribution');
                assert.equal(h.installations().length, 0); return true;
            } }, h.runner);
        assert.deepEqual(saved, [{ neutral_alpha: 'neutral-distribution' }]);
        assert.equal(h.installations().length, 1);
    } finally { f.dispose(); }
});

test('saving names does not approve installation, and invalid or unsaved edits cannot run pip', async () => {
    const f = fixture();
    try {
        const inspection = () => ({ ...ready(f.python), status: 'missing' as const, missing: 'neutral_alpha' });
        const cancelled = harness(inspection);
        const saved: Record<string, string>[] = [];
        let reviews = 0;
        await assert.rejects(preparePythonEnvironment({ ...f.options, packageName: undefined,
            savePackageMappings: async mappings => { saved.push(mappings); },
            confirmInstall: async (): Promise<PythonInstallationDecision> => ++reviews === 1
                ? { mappings: { neutral_alpha: 'neutral-dist' } } : false }, cancelled.runner), /未確認安裝清單/);
        assert.equal(cancelled.installations().length, 0); assert.equal(saved.length, 1);
        const invalidMappings: Record<string, string>[] = [
            { other_import: 'neutral-dist' }, { neutral_alpha: '--upgrade' }, { neutral_alpha: '../package' }, { neutral_alpha: '' }
        ];
        for (const mappings of invalidMappings) {
            const invalid = harness(inspection);
            await assert.rejects(preparePythonEnvironment({ ...f.options, packageName: undefined,
                savePackageMappings: async () => assert.fail('Invalid mappings must not be saved'),
                confirmInstall: async () => ({ mappings }) }, invalid.runner), /安裝名稱無效/);
            assert.equal(invalid.installations().length, 0);
        }
        const failed = harness(inspection);
        await assert.rejects(preparePythonEnvironment({ ...f.options, packageName: undefined,
            confirmInstall: async () => ({ mappings: { neutral_alpha: 'neutral-dist' } }),
            savePackageMappings: async () => { throw new Error('PRIVATE_STORAGE_ERROR'); } }, failed.runner), error => {
            assert.match(String(error), /無法儲存安裝名稱/); assert.doesNotMatch(String(error), /PRIVATE_STORAGE_ERROR/); return true;
        });
        assert.equal(failed.installations().length, 0);
    } finally { f.dispose(); }
});

test('inline mappings cannot override requirements pins or unrelated plan entries', async () => {
    const f = fixture();
    try {
        fs.writeFileSync(path.join(f.root, 'requirements.txt'), 'neutral_alpha==1.0\n');
        const h = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'neutral_alpha' }));
        await assert.rejects(preparePythonEnvironment({ ...f.options,
            confirmInstall: async plan => {
                assert.equal(plan.missing[0].mappingEditable, false);
                return { mappings: { neutral_alpha: 'override-pin' } };
            } }, h.runner), /安裝名稱無效/);
        assert.equal(h.installations().length, 0);
    } finally { f.dispose(); }
});
