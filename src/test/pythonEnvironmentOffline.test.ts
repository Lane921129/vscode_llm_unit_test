import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { preparePythonEnvironment, runSetupCommand, SetupCommand } from '../environment/pythonEnvironmentSetup';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { PythonInstallationPlan } from '../environment/pythonInstallationPlan';

test('offline real pip installs a prefilled same-name candidate after one confirmation and the next preparation reuses it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-offline-'));
    const developmentPython = resolvePythonExecutable('', path.resolve(__dirname, '../..'));
    const execute = (python: string, args: string[]) => {
        const result = spawnSync(python, args, { encoding: 'utf8', timeout: 60000,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    try {
        const existing = path.join(root, 'existing-environment');
        execute(developmentPython, ['-m', 'venv', existing]);
        const python = path.join(existing, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        const wheelhouse = path.join(root, 'wheelhouse'); fs.mkdirSync(wheelhouse);
        execute(developmentPython, ['-c', [
            'import base64, hashlib, pathlib, sys, zipfile',
            "info = 'neutral_environment_fixture-1.0.dist-info/'",
            "files = {'neutral_environment_fixture.py': 'def step(value):\\n    return value + 1\\n',",
            "info + 'METADATA': 'Metadata-Version: 2.1\\nName: neutral-environment-fixture\\nVersion: 1.0\\n',",
            "info + 'WHEEL': 'Wheel-Version: 1.0\\nGenerator: neutral-fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}",
            "records = [name + ',sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data.encode()).digest()).decode().rstrip('=') + ',' + str(len(data.encode())) for name, data in files.items()]",
            "files[info + 'RECORD'] = '\\n'.join(records + [info + 'RECORD,,']) + '\\n'",
            "with zipfile.ZipFile(pathlib.Path(sys.argv[1]) / 'neutral_environment_fixture-1.0-py3-none-any.whl', 'w') as wheel:",
            '    for name, data in files.items(): wheel.writestr(name, data)'
        ].join('\n'), wheelhouse]);
        const coverageSite = execute(developmentPython, ['-c', 'import coverage, pathlib; print(pathlib.Path(coverage.__file__).parent.parent)']);
        const file = path.join(root, 'sample.py');
        fs.writeFileSync(file, 'from neutral_environment_fixture import step\ndef target(value):\n    return step(value)\n');
        const installed: SetupCommand[] = [];
        const runner = async (command: SetupCommand) => {
            const probe = command.args.some(arg => arg.endsWith('environment_probe.py'));
            if (command.args.includes('install')) { installed.push(command); }
            const result = await runSetupCommand({ ...command,
                // Reuse the known development coverage installation without downloading anything.
                env: probe ? { ...command.env, PYTHONPATH: coverageSite } : command.env,
                args: command.args.includes('install') ? [...command.args, '--no-index', '--find-links', wheelhouse] : command.args });
            if (command.args.includes('install')) { assert.equal(result.code, 0, result.stdout + result.stderr); }
            return result;
        };
        let confirmations = 0;
        const options = { projectRoot: root, file, candidates: [{ executable: python }],
            confirmInstall: async (plan: PythonInstallationPlan) => {
                confirmations++; assert.equal(installed.length, 0);
                assert.equal(plan.python.toLowerCase(), python.toLowerCase());
                assert.equal(plan.blockers.length, 0);
                assert.equal(plan.missing[0].sameNameCandidate, true);
                assert.equal(plan.missing[0].installation, 'neutral_environment_fixture'); return true;
            },
            savePackageMappings: async () => assert.fail('Same-name candidates are not saved as confirmed mappings'),
            toolRequirements: path.resolve(__dirname, '../../requirements.txt') };
        fs.writeFileSync(path.join(root, 'second.py'), 'def later():\n    import neutral_environment_fixture\n');
        await assert.rejects(preparePythonEnvironment({ ...options, file: root, scope: 'folder', confirmInstall: async () => false }, runner), /未確認安裝清單/);
        assert.equal(installed.length, 0);
        const first = await preparePythonEnvironment({ ...options, file: root, scope: 'folder' }, runner);
        assert.equal(first.inventory?.filesScanned, 2);
        assert.deepEqual(first.inventory?.missing, []);
        assert.equal(first.python.toLowerCase(), python.toLowerCase());
        assert.deepEqual(first.installed, ['neutral_environment_fixture']);
        assert.equal(installed.length, 1);
        execute(python, ['-c', 'import neutral_environment_fixture; assert neutral_environment_fixture.step(2) == 3']);
        const second = await preparePythonEnvironment(options, runner);
        assert.deepEqual(second.installed, []);
        assert.equal(installed.length, 1);
        assert.equal(fs.existsSync(path.join(root, '.venv')), false);
        assert.equal(confirmations, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
