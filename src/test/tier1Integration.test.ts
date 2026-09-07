import * as assert from 'assert';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { test } from 'node:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTier1InstanceSetup, buildTier1TestMethods } from '../tier/tier1TestBuilder';

test('Tier 1 generated tests execute against a dependency that returns exact strings', () => {
    const methods = buildTier1TestMethods('format_value', [
        { args: ["''"], result: "'Input rejected'", result_type: 'str' },
        { args: ["'abcdef'"], result: "'Value: ab'", result_type: 'str' }
    ], []);
    const generatedTest = [
        'import unittest',
        'from formatter import format_value',
        '',
        'class TestGenerated(unittest.TestCase):',
        methods.join('\n\n'),
    ].join('\n');
    const encodedTest = Buffer.from(generatedTest, 'utf8').toString('base64');
    const runner = [
        'import base64, sys, types, unittest',
        "core = types.ModuleType('value_utils')",
        "exec(\"def normalize(value):\\n    if not value: raise ValueError('empty')\\n    return {'prefix': value[:2]}\", core.__dict__)",
        "sys.modules['value_utils'] = core",
        "formatter = types.ModuleType('formatter')",
        "exec(\"from value_utils import normalize\\ndef format_value(value):\\n    try: return 'Value: ' + normalize(value)['prefix']\\n    except ValueError: return 'Input rejected'\", formatter.__dict__)",
        "sys.modules['formatter'] = formatter",
        "namespace = {'__name__': 'generated_test'}",
        "exec(base64.b64decode(sys.argv[1]), namespace)",
        "suite = unittest.defaultTestLoader.loadTestsFromTestCase(namespace['TestGenerated'])",
        "result = unittest.TextTestRunner(verbosity=0).run(suite)",
        'sys.exit(0 if result.wasSuccessful() else 1)',
    ].join('; ');
    const result = spawnSync('python', ['-c', runner, encodedTest], { encoding: 'utf8' });

    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
});

test('Tier 1 generated tests execute keyword-only calls from verified trace data', () => {
    const methods = buildTier1TestMethods('multiply', [
        { args: ['3'], kwargs: { factor: '2' }, result: '6', result_type: 'int' }
    ], []);
    const generatedTest = [
        'import unittest',
        'from arithmetic import multiply',
        '',
        'class TestGenerated(unittest.TestCase):',
        methods.join('\n\n'),
    ].join('\n');
    const encodedTest = Buffer.from(generatedTest, 'utf8').toString('base64');
    const runner = [
        'import base64, sys, types, unittest',
        "module = types.ModuleType('arithmetic')",
        "exec(\"def multiply(value, *, factor):\\n    return value * factor\", module.__dict__)",
        "sys.modules['arithmetic'] = module",
        "namespace = {'__name__': 'generated_test'}",
        "exec(base64.b64decode(sys.argv[1]), namespace)",
        "suite = unittest.defaultTestLoader.loadTestsFromTestCase(namespace['TestGenerated'])",
        "result = unittest.TextTestRunner(verbosity=0).run(suite)",
        'sys.exit(0 if result.wasSuccessful() else 1)',
    ].join('; ');
    const result = spawnSync('python', ['-c', runner, encodedTest], { encoding: 'utf8' });

    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
});

test('Tier 1 generated instance-method tests reuse verified constructor literals', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tier1-instance-'));
    try {
        writeFileSync(join(tempDir, 'worker.py'), [
            'class Service:',
            '    def __init__(self, prefix):',
            '        self.prefix = prefix',
            '',
            '    def render(self, value):',
            '        return self.prefix + value',
            ''
        ].join('\n'), 'utf8');
        const setup = buildTier1InstanceSetup('Service', [{
            trace_constructor_args: ['prefix:'],
            trace_constructor_kwargs: {},
            constructor_args: ["'prefix:'"],
            constructor_kwargs: {}
        }]);
        const methods = buildTier1TestMethods('render', [
            { args: ["'value'"], result: "'prefix:value'", result_type: 'str' }
        ], []).map(method => method.replace(/(?<![._])\brender\(/g, 'self._instance.render('));
        writeFileSync(join(tempDir, 'test_worker.py'), [
            'import unittest',
            'from worker import Service',
            '',
            'class TestService(unittest.TestCase):',
            setup,
            '',
            methods.join('\n\n'),
            ''
        ].join('\n'), 'utf8');

        const result = spawnSync('python', ['-m', 'unittest', 'test_worker.py'], {
            cwd: tempDir,
            encoding: 'utf8'
        });
        assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Tier 1 generated tests execute ordinary coroutine targets from verified trace facts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tier1-coroutine-'));
    try {
        writeFileSync(join(tempDir, 'async_target.py'), [
            'async def double(value):',
            '    if value < 0:',
            '        raise ValueError("negative")',
            '    return value * 2',
            ''
        ].join('\n'), 'utf8');
        const methods = buildTier1TestMethods('double', [
            { args: ['3'], result: '6', result_type: 'int' }
        ], [
            { args: ['-1'], exception: 'ValueError' }
        ], true);
        writeFileSync(join(tempDir, 'test_async_target.py'), [
            'import unittest',
            'from async_target import double',
            '',
            'class TestDouble(unittest.TestCase):',
            methods.join('\n\n'),
            ''
        ].join('\n'), 'utf8');

        const result = spawnSync('python', ['-m', 'unittest', 'test_async_target.py'], {
            cwd: tempDir,
            encoding: 'utf8'
        });
        assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Tier 1 generated async instance-method tests combine constructor and coroutine facts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tier1-async-instance-'));
    try {
        writeFileSync(join(tempDir, 'worker.py'), [
            'class Service:',
            '    def __init__(self, prefix):',
            '        self.prefix = prefix',
            '',
            '    async def render(self, value):',
            '        if value == "bad":',
            '            raise ValueError("bad")',
            '        return self.prefix + value',
            ''
        ].join('\n'), 'utf8');
        const setup = buildTier1InstanceSetup('Service', [{
            trace_constructor_args: ['prefix:'],
            trace_constructor_kwargs: {},
            constructor_args: ["'prefix:'"],
            constructor_kwargs: {}
        }]);
        const methods = buildTier1TestMethods('render', [
            { args: ["'value'"], result: "'prefix:value'", result_type: 'str' }
        ], [
            { args: ["'bad'"], exception: 'ValueError' }
        ], true).map(method => method.replace(/(?<![._])\brender\(/g, 'self._instance.render('));
        writeFileSync(join(tempDir, 'test_worker.py'), [
            'import unittest',
            'from worker import Service',
            '',
            'class TestService(unittest.TestCase):',
            setup,
            '',
            methods.join('\n\n'),
            ''
        ].join('\n'), 'utf8');

        const result = spawnSync('python', ['-m', 'unittest', 'test_worker.py'], {
            cwd: tempDir,
            encoding: 'utf8'
        });
        assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Tier 1 generated tests execute finite sync and async generator assertions', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tier1-generator-'));
    try {
        writeFileSync(join(tempDir, 'generator_target.py'), [
            'def numbers(limit):',
            '    for value in range(limit):',
            '        yield value * 2',
            '',
            'async def async_numbers(limit):',
            '    for value in range(limit):',
            '        yield value * 3',
            ''
        ].join('\n'), 'utf8');
        const syncMethods = buildTier1TestMethods('numbers', [
            { args: ['3'], result: '[0, 2, 4]', result_type: 'generator', result_truncated: false }
        ], []);
        const asyncMethods = buildTier1TestMethods('async_numbers', [
            { args: ['3'], result: '[0, 3, 6]', result_type: 'async_generator', result_truncated: false }
        ], []);
        writeFileSync(join(tempDir, 'test_generator_target.py'), [
            'import unittest',
            'from generator_target import async_numbers, numbers',
            '',
            'class TestGenerated(unittest.TestCase):',
            syncMethods.join('\n\n'),
            '',
            asyncMethods.join('\n\n'),
            ''
        ].join('\n'), 'utf8');

        const result = spawnSync('python', ['-m', 'unittest', 'test_generator_target.py'], {
            cwd: tempDir,
            encoding: 'utf8'
        });
        assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test('condition-guided trace produces Tier 1 tests that kill boundary mutations', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tier1-mutation-'));
    try {
        const sourcePath = join(tempDir, 'route_target.py');
        const testPath = join(tempDir, 'test_route_target.py');
        writeFileSync(sourcePath, [
            'def route(value: str, mode: str):',
            '    if not value or len(value) < 4:',
            '        raise ValueError("value is too short")',
            '    if mode == "first":',
            '        return "first-route"',
            '    if mode == "second":',
            '        return "second-route"',
            '    return "default-route"',
            ''
        ].join('\n'), 'utf8');

        const trace = spawnSync(
            'python',
            [join(process.cwd(), 'python_scripts', 'dynamic_tracer.py'), sourcePath, 'route'],
            { encoding: 'utf8' }
        );
        assert.strictEqual(trace.status, 0, trace.stdout + trace.stderr);
        const traceData = JSON.parse(trace.stdout) as {
            examples: Array<{ args: string[]; result: string; result_type: string }>;
            errors: Array<{ args: string[]; exception: string }>;
        };
        const methods = buildTier1TestMethods('route', traceData.examples, traceData.errors);
        writeFileSync(testPath, [
            'import unittest',
            'from route_target import route',
            '',
            'class TestRoute(unittest.TestCase):',
            methods.join('\n\n'),
            ''
        ].join('\n'), 'utf8');

        const mutation = spawnSync(
            'python',
            [join(process.cwd(), 'python_scripts', 'basic_mutation_runner.py'), sourcePath, testPath],
            { encoding: 'utf8' }
        );
        assert.strictEqual(mutation.status, 0, mutation.stdout + mutation.stderr);
        const mutationData = JSON.parse(mutation.stdout) as { total: number; killed: number; survived: number };
        assert.ok(mutationData.total >= 3, mutation.stdout);
        assert.strictEqual(mutationData.killed, mutationData.total, mutation.stdout);
        assert.strictEqual(mutationData.survived, 0, mutation.stdout);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test('relative numeric trace probes produce runnable Tier 1 tests for derived threshold branches', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tier1-derived-threshold-'));
    try {
        const sourcePath = join(tempDir, 'derived_thresholds.py');
        const testPath = join(tempDir, 'test_derived_thresholds.py');
        writeFileSync(sourcePath, [
            'def classify(numerator, denominator):',
            '    score = round(numerator / (denominator / 100) ** 2, 2)',
            '    if score < 18.5:',
            '        return "low"',
            '    if score < 24:',
            '        return "middle"',
            '    if score < 27:',
            '        return "high"',
            '    return "top"',
            ''
        ].join('\n'), 'utf8');

        const trace = spawnSync(
            'python',
            [join(process.cwd(), 'python_scripts', 'dynamic_tracer.py'), sourcePath, 'classify'],
            { encoding: 'utf8' }
        );
        assert.strictEqual(trace.status, 0, trace.stdout + trace.stderr);
        const traceData = JSON.parse(trace.stdout) as {
            examples: Array<{ args: string[]; result: string; result_type: string }>;
            errors: Array<{ args: string[]; exception: string }>;
        };
        assert.deepStrictEqual(
            new Set(traceData.examples.map(example => example.result)),
            new Set(["'low'", "'middle'", "'high'", "'top'"])
        );
        const methods = buildTier1TestMethods('classify', traceData.examples, traceData.errors);
        writeFileSync(testPath, [
            'import unittest',
            'from derived_thresholds import classify',
            '',
            'class TestDerivedThresholds(unittest.TestCase):',
            methods.join('\n\n'),
            ''
        ].join('\n'), 'utf8');

        const run = spawnSync('python', ['-m', 'unittest', 'test_derived_thresholds.py'], {
            cwd: tempDir,
            encoding: 'utf8'
        });
        assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
