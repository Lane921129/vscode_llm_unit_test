import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = path.resolve(__dirname, '../..');
const config = require(path.join(root, 'test/verificationConfig.js'));
const runner = require(path.join(root, 'test/verificationRunner.js'));
const nodeRunner = require(path.join(root, 'test/run_unit_tests.js'));
const pythonRunner = require(path.join(root, 'test/run_python_tests.js'));
const quiet = { log: () => undefined, error: () => undefined };
const options = (mode: string, list = false) => ({ mode, list, node: [], python: [] });

test('fast and integration partition every current Node and original Python test without overlap', () => {
    const inventory = config.discoverTests();
    assert.equal(inventory.python.length, 52, 'preserve the prior modules and append method-edit coverage');
    assert.equal(new Set(inventory.python).size, 52);
    const additions = new Set(['python_scripts/test_parameter_fixture_experiments.py', 'python_scripts/test_mutation_activation.py',
        'python_scripts/test_edit_test_methods.py']);
    const originalPython = inventory.python.filter((file: string) => !additions.has(file));
    // Snapshot of the original runner's ordered 49-module list, not of tier output.
    assert.equal(createHash('sha256').update(JSON.stringify(originalPython)).digest('hex'),
        'd944706c9adf2e92b700689274a03291a9a71941c4efdcd93309db8bd6332205');
    const fast = config.partitionTests(inventory, 'fast');
    const integration = config.partitionTests(inventory, 'integration');
    const full = config.partitionTests(inventory, 'full');
    for (const kind of ['node', 'python']) {
        assert.ok(fast[kind].length > 0);
        assert.ok(integration[kind].length > 0);
        assert.equal(fast[kind].filter((file: string) => integration[kind].includes(file)).length, 0);
        assert.deepEqual([...fast[kind], ...integration[kind]].sort(), [...full[kind]].sort());
        assert.deepEqual(full[kind], inventory[kind]);
    }
    assert.ok(fast.node.includes('src/test/roleTransportMatrix.test.ts'), 'mocked five-role transport remains cheap fast coverage');
    assert.ok(integration.node.includes('src/test/bmiFocusedExpansionIntegration.test.ts'));
    assert.ok(integration.python.includes('python_scripts/test_external_mutation_runner.py'));
    assert.ok(integration.python.includes('python_scripts/test_secret_scan.py'));
    assert.ok(integration.python.includes('python_scripts/test_edit_test_methods.py'));
    assert.ok(integration.node.includes('src/test/writerMethodEdits.test.ts'));
    assert.ok(integration.python.includes('python_scripts/test_parameter_fixture_experiments.py'));
    assert.ok(integration.python.includes('python_scripts/test_mutation_activation.py'));
});

test('a new Node test defaults to integration and remains in full without a classification edit', () => {
    const inventory = { node: ['src/test/newUnclassifiedContract.test.ts'], python: [] };
    assert.deepEqual(config.partitionTests(inventory, 'fast').node, []);
    assert.deepEqual(config.partitionTests(inventory, 'integration').node, inventory.node);
    assert.deepEqual(config.partitionTests(inventory, 'full').node, inventory.node);
});

test('source inventory excludes stale output and the pre-existing separate Mocha suites', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-inventory-'));
    try {
        fs.mkdirSync(path.join(directory, 'src/test'), { recursive: true });
        fs.mkdirSync(path.join(directory, 'out/test'), { recursive: true });
        for (const file of ['current.test.ts', 'core.test.ts', 'extension.test.ts', 'helper.ts']) {
            fs.writeFileSync(path.join(directory, 'src/test', file), '');
        }
        fs.writeFileSync(path.join(directory, 'out/test/stale.test.js'), '');
        assert.deepEqual(config.discoverTests(directory).node, ['src/test/current.test.ts']);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('selectors accept exact source/compiled paths and filename fragments, with exact match priority', () => {
    const files = ['src/test/review.test.ts', 'src/test/reviewer.test.ts', 'src/test/second.test.ts'];
    assert.deepEqual(config.selectTests(files, ['review.test.ts']), [files[0]]);
    assert.deepEqual(config.selectTests(files, ['out/test/review.test.js']), [files[0]]);
    assert.deepEqual(config.selectTests(files, [path.join(root, 'src/test/review.test.ts')]), [files[0]]);
    assert.deepEqual(config.selectTests(files, ['review', 'second.test.js', 'review.test.ts']), files);
    assert.deepEqual(config.selectTests(['python_scripts/test_review_test_facts.py'], ['test_review_test_facts']),
        ['python_scripts/test_review_test_facts.py']);
});

test('every unmatched, external, empty or option-like selector fails instead of silently dropping tests', () => {
    const files = ['src/test/review.test.ts'];
    for (const selector of ['unknown', '../outside/review.test.ts', '/other/review.test.ts',
        '--test-name-pattern=skip', '', 'review\n--skip', '\0']) {
        assert.throws(() => config.selectTests(files, [selector]));
    }
    assert.throws(() => config.selectTests(files, ['review', 'not-a-test']), /No repository tests match/);
});

test('related rejects empty selection and invalid CLI flags before any subprocess', () => {
    for (const argv of [[], ['related'], ['related', '--list'], ['related', '--node'],
        ['related', '--python', '--list'], ['fast', '--node', 'review'], ['full', '--unexpected']]) {
        let calls = 0;
        assert.equal(runner.runVerification(argv, { ...quiet, spawn: () => { calls++; return { status: 0 }; } }), 1);
        assert.equal(calls, 0);
    }
    assert.deepEqual(runner.parseVerificationArguments(['related', '--node', 'review', '--node', 'writer',
        '--python', 'test_review', '--list']), { mode: 'related', list: true, node: ['review', 'writer'], python: ['test_review'] });
});

test('tier plans keep checks, Webview, complete history scan and production bundle in the intended scope', () => {
    const plans = Object.fromEntries(['fast', 'integration', 'full'].map(mode => [mode,
        runner.buildVerificationPlan(options(mode))]));
    const names = (mode: string) => plans[mode].steps.map((step: { name: string }) => step.name);
    assert.deepEqual(names('fast'), ['check-types', 'lint', 'compile-tests', 'Node regressions', 'Webview syntax', 'Python regressions']);
    assert.deepEqual(names('integration'), ['compile-tests', 'Node regressions', 'Python regressions']);
    assert.deepEqual(names('full'), ['check-types', 'lint', 'compile-tests', 'Node regressions', 'Webview syntax',
        'Python regressions', 'tracked files and reachable history secret scan', 'production package (types and lint already passed)']);
    const full = plans.full;
    assert.deepEqual(full.steps[0].args, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit']);
    assert.deepEqual(full.steps[1].args, [path.join(root, 'node_modules/eslint/bin/eslint.js'), 'src']);
    assert.deepEqual(full.steps[2].args, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', '.', '--outDir', 'out']);
    assert.deepEqual(full.steps[3].args, [path.join(root, 'test/run_unit_tests.js'), '--tier', 'full']);
    assert.deepEqual(full.steps[4].args, [path.join(root, 'test/extract_script.js')]);
    assert.deepEqual(full.steps[5].args, [path.join(root, 'test/run_python_tests.js'), '--tier', 'full', '--skip-secret-scan']);
    assert.deepEqual(full.steps[6].args, ['python_scripts/secret_scan.py', '--history']);
    assert.equal(full.steps[7].command, process.execPath);
    assert.deepEqual(full.steps[7].args, [path.join(root, 'esbuild.js'), '--production']);
    assert.equal(full.steps.filter((step: { name: string }) => step.name === 'lint').length, 1);
    assert.equal(full.steps.filter((step: { name: string }) => step.name === 'check-types').length, 1);
});

test('related compiles once and runs only selected inventoried files without history scanning or a bundle', () => {
    const plan = runner.buildVerificationPlan(runner.parseVerificationArguments(['related',
        '--node', 'reviewerCommunicationContract', '--python', 'test_review_test_facts']));
    assert.deepEqual(plan.selected, { node: ['src/test/reviewerCommunicationContract.test.ts'],
        python: ['python_scripts/test_review_test_facts.py'] });
    assert.deepEqual(plan.steps.map((step: { name: string }) => step.name), ['compile-tests', 'Node regressions', 'Python regressions']);
    assert.deepEqual(plan.steps[1].args.slice(1), ['--select', 'src/test/reviewerCommunicationContract.test.ts']);
    assert.deepEqual(plan.steps[2].args.slice(1), ['--select', 'python_scripts/test_review_test_facts.py', '--skip-secret-scan']);
});

test('list builds a complete plan without compiled output, a venv or subprocess execution', () => {
    const plan = runner.buildVerificationPlan(options('full', true), { root: path.join(os.tmpdir(), 'absent-verification-root'),
        inventory: { node: ['src/test/new.test.ts'], python: ['python_scripts/test_quality_policy.py'] } });
    const logs: string[] = [];
    assert.equal(runner.executeVerificationPlan(plan, { log: (line: string) => logs.push(line),
        spawn: () => { throw new Error('list must never spawn'); } }), 0);
    assert.ok(logs.some(line => line.includes('[list] Plan only')));
    assert.ok(logs.some(line => line.includes('Python files 1/1')));
    assert.ok(logs.some(line => line.includes('live LLM/DGX')));
});

test('execution propagates an exact nonzero status and stops before later tests and the build', () => {
    const plan = runner.buildVerificationPlan(options('full'));
    const calls: unknown[][] = [];
    const result = runner.executeVerificationPlan(plan, { ...quiet, env: { SENTINEL: 'retained' },
        spawn: (command: string, args: string[], settings: { cwd: string; shell: boolean; env: NodeJS.ProcessEnv }) => {
            calls.push([command, args]);
            assert.equal(settings.cwd, root);
            assert.equal(settings.shell, false);
            assert.equal(settings.env.SENTINEL, 'retained');
            assert.equal(settings.env.PYTHONUTF8, '1');
            return { status: calls.length === 2 ? 7 : 0 };
        } });
    assert.equal(result, 7);
    assert.equal(calls.length, 2);
    assert.equal(runner.executeVerificationPlan(plan, { ...quiet, spawn: () => ({ status: null, signal: 'SIGTERM' }) }), 1);
    assert.equal(runner.executeVerificationPlan(plan, { ...quiet, spawn: () => ({ status: null, error: new Error('ENOENT') }) }), 1);
});

test('partial success prints an explicit unverified-full reminder', () => {
    const logs: string[] = [];
    const plan = runner.buildVerificationPlan(options('integration'));
    assert.equal(runner.executeVerificationPlan(plan, { log: (line: string) => logs.push(line),
        spawn: () => ({ status: 0 }) }), 0);
    assert.ok(logs.some(line => line.includes('Partial verification only')));
    assert.ok(logs.some(line => line.includes('full verification remains outstanding')));
});

test('legacy Node entry still runs every compiled non-Mocha suite serially and propagates failure', () => {
    const invocations: string[][] = [];
    const code = nodeRunner.runNodeTests([], { ...quiet, root,
        fileSystem: { existsSync: () => true, readdirSync: () => ['b.test.js', 'core.test.js', 'extension.test.js', 'a.test.js', 'helper.js'] },
        spawn: (_command: string, args: string[], settings: { shell: boolean; cwd: string }) => {
            invocations.push(args);
            assert.equal(settings.shell, false);
            assert.equal(settings.cwd, root);
            return { status: 9 };
        } });
    assert.equal(code, 9);
    assert.deepEqual(invocations, [['--test', '--test-concurrency=1',
        path.join(root, 'out/test/a.test.js'), path.join(root, 'out/test/b.test.js')]]);
});

test('legacy Python entry retains the complete original list and scans history only after success', () => {
    const calls: string[][] = [];
    assert.equal(pythonRunner.runPythonTests([], { ...quiet, fileSystem: { existsSync: () => true },
        spawn: (_command: string, args: string[]) => { calls.push(args); return { status: 0 }; } }), 0);
    assert.equal(calls[0].length, 54, '52 modules plus -m unittest');
    assert.deepEqual(calls[0].slice(2), config.pythonTests, 'the legacy entry runs every current module in order');
    assert.deepEqual(calls[0].slice(0, 4), ['-m', 'unittest', 'python_scripts/test_rescue_unittest.py', 'python_scripts/test_ast_pipeline.py']);
    assert.deepEqual(calls[0].slice(-2), ['python_scripts/test_secret_scan.py', 'python_scripts/test_edit_test_methods.py'],
        'the former list remains in order and the new suite is appended');
    assert.deepEqual(calls[1], ['python_scripts/secret_scan.py', '--history']);
    let failures = 0;
    assert.equal(pythonRunner.runPythonTests([], { ...quiet, fileSystem: { existsSync: () => true },
        spawn: () => { failures++; return { status: 6 }; } }), 6);
    assert.equal(failures, 1, 'failed tests must not be followed by a misleading successful scan');
});

test('both low-level list modes execute nothing and related Python has no implicit history scan', () => {
    const noExecution = { ...quiet, fileSystem: { existsSync: () => false },
        spawn: () => { throw new Error('must not spawn'); } };
    assert.equal(nodeRunner.runNodeTests(['--tier', 'full', '--list'], noExecution), 0);
    assert.equal(pythonRunner.runPythonTests(['--list'], noExecution), 0);
    const calls: string[][] = [];
    assert.equal(pythonRunner.runPythonTests(['--select', 'test_quality_policy'], { ...quiet,
        fileSystem: { existsSync: () => true }, spawn: (_command: string, args: string[]) => { calls.push(args); return { status: 0 }; } }), 0);
    assert.deepEqual(calls, [['-m', 'unittest', 'python_scripts/test_quality_policy.py']]);
});

test('missing compiled tests or the Python venv fail before launching any test process', () => {
    let calls = 0;
    const unavailable = { ...quiet, fileSystem: { existsSync: () => false },
        spawn: () => { calls++; return { status: 0 }; } };
    assert.equal(nodeRunner.runNodeTests(['--tier', 'fast'], unavailable), 1);
    assert.equal(pythonRunner.runPythonTests([], unavailable), 1);
    assert.equal(calls, 0);
    const statuses = [0, 12];
    assert.equal(pythonRunner.runPythonTests([], { ...quiet, fileSystem: { existsSync: () => true },
        spawn: () => ({ status: statuses.shift() }) }), 12, 'history scan failure is never swallowed');
});

test('public CLI list works from a different cwd and exits nonzero for every unresolved related selector', () => {
    const executable = path.join(root, 'test/verification.js');
    const listed = spawnSync(process.execPath, [executable, 'related', '--node', 'verificationRunner', '--list'],
        { cwd: os.tmpdir(), encoding: 'utf8', shell: false });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /Node files 1\//);
    assert.match(listed.stdout, /Plan only/);
    for (const args of [['related'], ['related', '--node', 'not-a-real-test', '--list'],
        ['related', '--node', 'verificationRunner', '--python', 'not-a-python-test', '--list']]) {
        const rejected = spawnSync(process.execPath, [executable, ...args], { cwd: os.tmpdir(), encoding: 'utf8', shell: false });
        assert.equal(rejected.status, 1);
    }
});
