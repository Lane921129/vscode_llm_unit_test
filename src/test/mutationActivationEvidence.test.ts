import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { mutationCandidateSetId, parseBuiltinMutationRun, readStoredMutationRun,
    FUNCTION_MUTATION_BACKEND, FUNCTION_ACTIVATION_POLICY } from '../mutation/mutationResult';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { runSpawn } from '../utils/processRunner';

test('function mutation scores require identity-bound baseline and trial activation in both readers', async () => {
    const context = { sourcePath: '/project/neutral.py', sourceHash: 'a'.repeat(64), testHash: 'b'.repeat(64),
        targetScope: { kind: 'function' as const, qualifiedName: 'target' } };
    const activation = (variantHash: string) => ({ schemaVersion: 'mutation-function-activation-v1', policy: FUNCTION_ACTIVATION_POLICY,
        sourceHash: context.sourceHash, testHash: context.testHash, target: 'target', variantHash, status: 'activated', activatedModules: 1 });
    const id = 'c'.repeat(64), variant = 'd'.repeat(64);
    const raw = { ...context, schemaVersion: 1, engine: 'builtin', operatorSetVersion: 'builtin-ast-v3', scopeVersion: 'selected-function-body-v1',
        executionBackend: FUNCTION_MUTATION_BACKEND, activationPolicy: FUNCTION_ACTIVATION_POLICY,
        baselineFunctionActivation: activation(context.sourceHash), candidateIds: [id], candidateSetId: mutationCandidateSetId([id]),
        status: 'complete', scoreAvailable: true, scope_found: true, baseline_passed: true, baselineStatus: 'passed',
        counts: { available: 1, selected: 1, executed: 1, notRun: 0, killed: 1, survived: 0, timeout: 0, error: 0 },
        excluded: { noop: 0, duplicate: 0, invalid: 0 }, mutants: [{ id, kind: 'return_value', line: 2, column: 4, position: 0,
            from: 'return_value', to: 'None', status: 'KILLED', killedBy: ['Cases.test_value'],
            variantSourceHash: variant, functionActivation: activation(variant) }] };
    const accepted = parseBuiltinMutationRun(raw, context);
    assert.equal(accepted.status, 'complete', accepted.diagnostic);
    assert.equal(accepted.executionBackend, FUNCTION_MUTATION_BACKEND);
    assert.ok(readStoredMutationRun(accepted, context).ok);
    const mutants = [
        (v: any) => { delete v.baselineFunctionActivation; },
        (v: any) => { delete v.mutants[0].functionActivation; },
        (v: any) => { v.baselineFunctionActivation.sourceHash = 'e'.repeat(64); },
        (v: any) => { v.mutants[0].functionActivation.variantHash = 'e'.repeat(64); },
        (v: any) => { v.mutants[0].functionActivation.testHash = 'e'.repeat(64); },
        (v: any) => { v.mutants[0].functionActivation.target = 'other'; },
        (v: any) => { v.mutants[0].functionActivation.status = 'not-activated'; },
        (v: any) => { v.mutants[0].functionActivation.activatedModules = true; },
        (v: any) => { v.mutants[0].functionActivation.extra = 'not-evidence'; },
        (v: any) => { v.activationPolicy = 'unknown'; }
    ];
    for (const mutate of mutants) {
        const changed = structuredClone(raw); mutate(changed);
        assert.equal(parseBuiltinMutationRun(changed, context).scoreAvailable, false);
    }
    const stored = [accepted, ...mutants.map(mutate => { const changed: any = structuredClone(accepted); mutate(changed); return changed; })];
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const reply = await runSpawn(python, ['-B', '-c',
        'import sys,json;sys.path.insert(0,"python_scripts");from quality_policy import read_stored_mutation_run;v=json.load(sys.stdin);print(json.dumps([read_stored_mutation_run(r,v["context"])["ok"] for r in v["runs"]]))'],
        { cwd: path.resolve(__dirname, '../..'), input: JSON.stringify({ context, runs: stored }), timeout: 10000 });
    assert.equal(reply.code, 0, reply.stderr);
    assert.deepEqual(JSON.parse(reply.stdout), [true, ...mutants.map(() => false)]);
});
