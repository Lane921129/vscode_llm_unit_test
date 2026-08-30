import * as assert from 'assert';
import { spawnSync } from 'child_process';
import { test } from 'node:test';
import { buildTier1TestMethods } from '../tier1TestBuilder';

test('Tier 1 generated tests execute against a dependency that returns exact strings', () => {
    const methods = buildTier1TestMethods('login_user', [
        { args: ["''"], result: "'Login Failed: Input rejected'", result_type: 'str' },
        { args: ["'1234567890'"], result: "'Welcome: 12345'", result_type: 'str' }
    ], []);
    const generatedTest = [
        'import unittest',
        'from service_auth import login_user',
        '',
        'class TestGenerated(unittest.TestCase):',
        methods.join('\n\n'),
    ].join('\n');
    const encodedTest = Buffer.from(generatedTest, 'utf8').toString('base64');
    const runner = [
        'import base64, sys, types, unittest',
        "core = types.ModuleType('core_utils')",
        "exec(\"def validate(value):\\n    if not value or len(value) < 10: raise ValueError('bad')\\n    return {'prefix': value[:5]}\", core.__dict__)",
        "sys.modules['core_utils'] = core",
        "auth = types.ModuleType('service_auth')",
        "exec(\"from core_utils import validate\\ndef login_user(value):\\n    try: return 'Welcome: ' + validate(value)['prefix']\\n    except ValueError: return 'Login Failed: Input rejected'\", auth.__dict__)",
        "sys.modules['service_auth'] = auth",
        "namespace = {'__name__': 'generated_test'}",
        "exec(base64.b64decode(sys.argv[1]), namespace)",
        "suite = unittest.defaultTestLoader.loadTestsFromTestCase(namespace['TestGenerated'])",
        "result = unittest.TextTestRunner(verbosity=0).run(suite)",
        'sys.exit(0 if result.wasSuccessful() else 1)',
    ].join('; ');
    const result = spawnSync('python', ['-c', runner, encodedTest], { encoding: 'utf8' });

    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
});
