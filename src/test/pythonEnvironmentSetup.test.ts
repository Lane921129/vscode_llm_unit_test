import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EnvironmentInspection, findRequirementFiles, preparePythonEnvironment, PythonEnvironmentActivity,
    SetupCommand, SetupRunner, setupEnvironment } from '../environment/pythonEnvironmentSetup';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-setup-'));
    const file = path.join(root, 'sample.py');
    const tools = path.join(root, 'tools.txt');
    fs.writeFileSync(file, 'def target(value):\n    return value + 1\n');
    fs.writeFileSync(tools, 'coverage\n');
    const python = path.join(root, 'existing-python');
    const options = { projectRoot: root, file, toolRequirements: tools, candidates: [{ executable: python }],
        packageName: async (missing: string) => missing };
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
        assert.equal(h.commands.some(command => command.args.includes('check')), false);
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

test('an undeclared import never causes a guessed distribution install, including cancelled mapping selection', async () => {
    const f = fixture();
    try {
        for (const packageName of [undefined, async () => undefined, async () => '']) {
            const h = harness(() => ({ ...ready(f.python), status: 'missing', missing: 'project_helper' }));
            await assert.rejects(preparePythonEnvironment({ ...f.options, packageName }, h.runner), /packageMappings/);
            assert.equal(h.installations().length, 0);
            assert.equal(h.commands.some(command => command.args.includes('check')), false);
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
        for (const name of ['--upgrade', '../package', 'https://example.invalid/package', 'name another']) {
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
