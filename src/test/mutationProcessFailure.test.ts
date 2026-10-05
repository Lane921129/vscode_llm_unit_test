import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { mutationProcessFailure } from '../mutation/mutationProcessFailure';
import { retryTransientProviderRequest } from '../llm/connectionTimeout';
import { TargetBudget } from '../pipeline/targetBudget';

test('mutation process failure preserves known error codes and exit code without accepting successful stdout', () => {
    const error = mutationProcessFailure('mutatest', { code: 2,
        stdout: JSON.stringify({ error: 'external-engine-unavailable', diagnosticCode: 'package-missing', secret: 'do-not-copy' }), stderr: '' });
    assert.equal(error.category, 'mutation');
    assert.match(error.message, /exitCode=2; package-missing/);
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /do-not-copy/);
    const invalid = mutationProcessFailure('builtin', { code: 1, stdout: '{"status":"complete"}', stderr: '' });
    assert.match(invalid.message, /no-structured-diagnostic/);
});

test('mutation traceback summary is bounded and excludes source lines and credentials', () => {
    const error = mutationProcessFailure('builtin', { code: 1, stdout: '',
        stderr: 'Traceback (most recent call last):\n  source code do-not-copy\nSyntaxError: invalid syntax\n' });
    assert.match(error.message, /SyntaxError: invalid syntax/);
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /do-not-copy|Traceback/);
    const secret = mutationProcessFailure('builtin', { code: 1, stdout: '', stderr: 'ValueError: password=do-not-copy\n' });
    assert.doesNotMatch(JSON.stringify(secret.diagnostic), /do-not-copy/);
    const empty = mutationProcessFailure('builtin', { code: null, stdout: '', stderr: '' });
    assert.match(empty.message, /exitCode=signal/);
});

test('transport budget exhaustion never schedules network retries or sends a request', async () => {
    for (const limits of [{ transportAttempts: 0 }, { estimatedInputTokens: 0 }]) {
        const budget = new TargetBudget(limits);
        let attempts = 0, network = 0, waits = 0, events = 0;
        await assert.rejects(retryTransientProviderRequest(async () => {
            attempts++; budget.consumeTransportAttempt(1); network++; return { status: 200 };
        }, { isCancelled: () => false, wait: async () => { waits++; }, onRetry: () => { events++; } }),
        (error: any) => error.category === 'budget' && error.stage === 'target-budget');
        assert.deepEqual({ attempts, network, waits, events }, { attempts: 1, network: 0, waits: 0, events: 0 });
    }
});
