import * as assert from 'assert';
import { test } from 'node:test';
import { buildExternalMutationExecution } from '../mutationExecution';

test('builds a shell-free mutmut execution plan with literal paths', () => {
    const plan = buildExternalMutationExecution(
        'mutmut', '/project with spaces/src/target.py', 'loop1_test', '/results/report', 3
    );

    assert.strictEqual(plan.command, 'mutmut');
    assert.deepStrictEqual(plan.args, [
        'run', '--paths-to-mutate', '/project with spaces/src/target.py',
        '--runner', 'python -m unittest loop1_test', '--test-time-multiplier', '3'
    ]);
    assert.ok(!plan.args.join(' ').includes('chcp'));
});

test('builds a direct Python mutatest execution plan', () => {
    const plan = buildExternalMutationExecution(
        'mutatest', '/project/src/target.py', 'loop1_test', '/results/report', 2
    );

    assert.strictEqual(plan.command, 'python');
    assert.deepStrictEqual(plan.args.slice(2), [
        '-s', '/project/src/target.py', '-t', 'python -m unittest loop1_test',
        '-o', '/results/report.rst', '--timeout_factor', '2'
    ]);
    assert.ok(plan.args[1].includes('mutatest.cli'));
});
