import * as assert from 'assert';
import { spawnSync } from 'child_process';
import { test } from 'node:test';
import { buildTier1TestMethods } from '../tier1TestBuilder';

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
