import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { selectMutationEngine, mutationArguments } from '../mutation/mutationSelection';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const validProbe = { schemaVersion: 'external-mutation-probe-v1', engine: 'mutatest', supported: true,
    engineVersion: '3.1.0', operatorSetVersion: 'mutatest-ast-3.1.0-v1', platform: 'Windows', diagnosticCode: null };

test('builtin selection is explicit and does not launch an external probe', async () => {
    const selected = await selectMutationEngine(undefined, undefined, async () => { throw Error('unexpected probe'); });
    assert.deepEqual(selected, { requested: 'builtin', actual: 'builtin', workers: 2,
        operatorSetVersion: 'builtin-ast-v2', executionBackend: 'isolated-unittest-v1' });
    const args = mutationArguments(selected, 'source with spaces.py', 'test with spaces.py', 'compute', 'Calculator', 30);
    assert.equal(path.basename(args[0]), 'basic_mutation_runner.py');
    assert.deepEqual(args.slice(1), ['source with spaces.py', 'test with spaces.py', '0', '5', 'compute', 'Calculator', '30', '2', 'builtin-ast-v2']);
});

test('external selection retains requested engine and builds the real adapter command', async () => {
    const selected = await selectMutationEngine('mutatest', 4, async args => {
        assert.deepEqual([args[0], path.basename(args[1]), ...args.slice(2)], ['-B', 'external_mutation_runner.py', '--probe', 'mutatest']);
        return { code: 0, stdout: JSON.stringify(validProbe) };
    });
    assert.equal(selected.requested, 'mutatest'); assert.equal(selected.actual, 'mutatest');
    assert.equal(selected.engineVersion, '3.1.0');
    const args = mutationArguments(selected, 'source.py', 'test_source.py', 'compute', '', 3);
    assert.deepEqual([path.basename(args[0]), ...args.slice(1)], ['external_mutation_runner.py', 'mutatest',
        'source.py', 'test_source.py', '0', '3', 'compute', '', '3', '4']);
});

test('bad settings are rejected before any probe and cannot coerce into valid engines', async () => {
    for (const [engine, workers] of [['unknown', 2], [['builtin'], 2], [{ toString: () => 'mutatest' }, 2],
        ['builtin', 0], ['builtin', 5], ['builtin', 1.5], ['builtin', '2'], ['builtin', NaN]] as Array<[unknown, unknown]>) {
        await assert.rejects(selectMutationEngine(engine, workers, async () => { throw Error('unexpected probe'); }),
            (error: unknown) => error instanceof AnalysisStageError && error.stage === 'mutation-preflight');
    }
});

test('unavailable selected engine stops with its stable diagnostic and no fallback', async () => {
    for (const diagnosticCode of ['package-missing', 'unsupported-version', 'unsupported-platform', 'adapter-unavailable', 'self-check-failed']) {
        let calls = 0;
        await assert.rejects(selectMutationEngine('mutatest', 2, async () => {
            calls++; return { code: 0, stdout: JSON.stringify({ ...validProbe, supported: false, diagnosticCode }) };
        }), (error: unknown) => error instanceof AnalysisStageError && error.category === 'environment'
            && (error.diagnostic as { reasonCode: string }).reasonCode === diagnosticCode);
        assert.equal(calls, 1);
    }
});

test('malformed wrong-engine and unverified-version probes cannot authorize execution', async () => {
    const probes = [
        { code: 1, stdout: JSON.stringify(validProbe) }, { code: 0, stdout: 'private arbitrary tool text' },
        { code: 0, stdout: JSON.stringify({ ...validProbe, engine: 'builtin' }) },
        { code: 0, stdout: JSON.stringify({ ...validProbe, supported: 'true' }) },
        { code: 0, stdout: JSON.stringify({ ...validProbe, engineVersion: '3.2.0' }) },
        { code: 0, stdout: JSON.stringify({ ...validProbe, operatorSetVersion: 'builtin-ast-v2' }) }
    ];
    for (const probe of probes) {
        await assert.rejects(selectMutationEngine('mutatest', 2, async () => probe), (error: unknown) =>
            error instanceof AnalysisStageError && !error.message.includes('private arbitrary tool text'));
    }
    await assert.rejects(selectMutationEngine('mutmut', 2, async () => ({ code: 0,
        stdout: JSON.stringify({ ...validProbe, engine: 'mutmut', supported: true }) })), AnalysisStageError);
});
