import * as assert from 'assert';
import { test } from 'node:test';
import { buildExternalMutationExecution, externalIsolationVerified } from '../mutation/mutationExecution';

test('builds a shell-free mutmut execution plan with literal paths', () => {
    const plan = buildExternalMutationExecution(
        'mutmut', '/project with spaces/src/target.py', 'loop1_test', '/results/report', 3, '/project with spaces/.venv/bin/python'
    );

    assert.strictEqual(plan.command, '/project with spaces/.venv/bin/python');
    assert.deepStrictEqual(plan.args, [
        '-m', 'mutmut', 'run', '--paths-to-mutate', '/project with spaces/src/target.py',
        '--runner', plan.args[6], '--test-time-multiplier', '3'
    ]);
    assert.ok(!plan.args.join(' ').includes('chcp'));
    assert.match(plan.args[6], /generated_test_runner\.py/);
    assert.match(plan.args[6], /loop1_test/);
    assert.doesNotMatch(plan.args[6], /-m unittest/);
});

test('builds a direct Python mutatest execution plan', () => {
    const plan = buildExternalMutationExecution(
        'mutatest', '/project/src/target.py', 'loop1_test', '/results/report', 2, '/project/.venv/bin/python'
    );

    assert.strictEqual(plan.command, '/project/.venv/bin/python');
    assert.deepStrictEqual(plan.args.slice(2), [
        '-s', '/project/src/target.py', '-t', plan.args[5],
        '-o', '/results/report.rst', '--timeout_factor', '2'
    ]);
    assert.ok(plan.args[1].includes('mutatest.cli'));
    assert.match(plan.args[5], /generated_test_runner\.py/);
});

test('external runners record safety failures and reject executable test-module text', () => {
    const plan = buildExternalMutationExecution('mutmut', '/project/source.py', 'suite', '/results/report', undefined,
        '/python path/python', '/results/violation.jsonl');
    assert.match(plan.args[6], /--violation-report/);
    assert.match(plan.args[6], /violation\.jsonl/);
    assert.throws(() => buildExternalMutationExecution('mutmut', '/source.py', 'suite;echo invalid', '/report'));
});

test('native engine scores require complete guarded-run records with a successful execution', () => {
    const runId = 'a'.repeat(32), second = 'b'.repeat(32);
    const started = { runId, event: 'started' };
    const completed = { runId, event: 'completed', status: 'passed' };
    const report = (...events: object[]) => events.map(e => JSON.stringify(e)).join('\n');
    assert.equal(externalIsolationVerified(report(started, completed)), true);
    for (const invalid of ['', 'invalid', report(started), report(completed), report(started, completed, started),
        report(started, { ...completed, status: 'isolation-blocked' }),
        report(started, { ...completed, status: 'failed' }),
        report(started, completed, { ...started, runId: second })]) {
        assert.equal(externalIsolationVerified(invalid), false);
    }
});
