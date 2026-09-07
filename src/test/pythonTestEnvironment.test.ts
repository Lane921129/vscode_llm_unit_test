import * as assert from 'assert';
import * as path from 'path';
import { test } from 'node:test';
import { buildGeneratedTestEnvironment, generatedUnittestArguments } from '../utils/pythonTestEnvironment';

test('builds a portable Python environment without shell placeholders', () => {
    const environment = buildGeneratedTestEnvironment(
        { PYTHONPATH: ['inherited', 'shared'].join(path.delimiter) },
        ['target', 'parent', 'target', 'test-output']
    );

    assert.strictEqual(environment.PYTHONIOENCODING, 'utf-8');
    assert.deepStrictEqual(environment.PYTHONPATH?.split(path.delimiter), [
        'target', 'parent', 'test-output', 'inherited', 'shared'
    ]);
    assert.ok(!environment.PYTHONPATH?.includes('%PYTHONPATH%'));
    assert.ok(!environment.PYTHONPATH?.includes('$PYTHONPATH'));
});

test('uses direct Python arguments for coverage and unittest execution', () => {
    assert.deepStrictEqual(
        generatedUnittestArguments('loop1_test', '/portable/project', true),
        ['-m', 'coverage', 'run', '--branch', '--source=/portable/project', '-m', 'unittest', 'loop1_test']
    );
    assert.deepStrictEqual(
        generatedUnittestArguments('loop1_test', '/portable/project', false),
        ['-m', 'unittest', 'loop1_test']
    );
});
