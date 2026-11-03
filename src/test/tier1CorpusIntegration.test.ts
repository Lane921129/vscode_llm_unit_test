import * as assert from 'assert';
import { spawnSync } from 'child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildTier1TestFile } from '../tier/tier1TestFileBuilder';
import { buildSupplementalProbeInputs } from '../tier/supplementalProbeInputs';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { buildProbeInputs } from '../pipeline/probeInputs';
import { parseBehaviorObservations, mergeBehaviorObservations } from '../pipeline/behaviorObservations';
import { evidenceHash } from '../pipeline/analysisJournal';
import { assessTargetCoverageEvidence } from '../mutation/targetCoverage';
import { parseBuiltinMutationRun } from '../mutation/mutationResult';
import { createFixtureQualityPolicy, evaluateQuality } from '../pipeline/qualityPolicy';

interface Fixture {
    id: string;
    tier: number;
    source: string;
    target: string;
    expected: {
        method_kind: 'module' | 'instance' | 'static' | 'class' | 'property';
        is_async: boolean;
        trace_inputs?: string[];
        semantic_trace_inputs?: string[];
        inherited_constructor_required?: string[];
        truthiness_parameters?: string[];
    };
    acceptance: { min_line_coverage: number; min_mutation_score: number };
}

const fixtureRoot = resolve(__dirname, '../../test/fixtures/python');
const scriptsRoot = resolve(__dirname, '../../python_scripts');
const manifestSource = readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestSource) as { fixtures: Fixture[] };
const pythonExecutable = resolvePythonExecutable(undefined, resolve(__dirname, '../..'));

function pythonJson(args: string[], label: string, cwd?: string): any {
    const result = spawnSync(pythonExecutable, args, { encoding: 'utf8', cwd, timeout: 90000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.strictEqual(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
}

test('Tier 1 corpus builds, executes, and mutation-checks deterministic tests from real Trace facts', () => {
    const fixtures = manifest.fixtures.filter(fixture => fixture.tier === 1);
    assert.ok(fixtures.length >= 3);

    for (const fixture of fixtures) {
        const tempDir = mkdtempSync(join(tmpdir(), `tier1-corpus-${fixture.id}-`));
        try {
            const policy = createFixtureQualityPolicy({ fixtureId: fixture.id, manifestHash: evidenceHash(manifestSource),
                minLineCoverage: fixture.acceptance.min_line_coverage, minMutationScore: fixture.acceptance.min_mutation_score });
            const original = join(fixtureRoot, fixture.source);
            const sourcePath = join(tempDir, fixture.source.split('/').pop()!);
            const moduleName = fixture.source.split('/').pop()!.replace(/\.py$/, '');
            const testPath = join(tempDir, `test_${moduleName}.py`);
            copyFileSync(original, sourcePath);

            const ast = pythonJson(
                [join(scriptsRoot, 'ast_extractor.py'), sourcePath, fixture.target],
                `${fixture.id} AST extraction`
            );
            if (fixture.expected.inherited_constructor_required) {
                assert.deepStrictEqual(
                    ast.class_context?.effective_init?.required_params,
                    fixture.expected.inherited_constructor_required,
                    `${fixture.id}: inherited constructor requirements were not preserved`
                );
            }
            if (fixture.expected.truthiness_parameters) {
                const observed = (ast.condition_facts || [])
                    .filter((fact: { kind?: string }) => fact.kind === 'truthiness')
                    .map((fact: { parameter?: string }) => fact.parameter);
                assert.deepStrictEqual(
                    [...new Set(observed)],
                    fixture.expected.truthiness_parameters,
                    `${fixture.id}: direct truthiness branch facts were not preserved`
                );
            }
            const callers = pythonJson(
                [join(scriptsRoot, 'ast_caller_finder.py'), fixture.target, tempDir, sourcePath],
                `${fixture.id} caller extraction`
            ) as Array<Record<string, unknown>>;
            const inputs = buildProbeInputs(callers);
            const traceArgs = [join(scriptsRoot, 'dynamic_tracer.py'), sourcePath, fixture.target, JSON.stringify(inputs)];
            let trace = parseBehaviorObservations(pythonJson(traceArgs, `${fixture.id} initial behavior probe`), fixture.target);
            if (fixture.expected.semantic_trace_inputs?.length) {
                const supplementalInputs = buildSupplementalProbeInputs({
                    test_strategy: {
                        approach: 'neutral corpus semantic candidate',
                        input_hints: [{
                            param_name: ast.args[0],
                            strategy: 'source candidate',
                            boundary_inputs: fixture.expected.semantic_trace_inputs,
                            invalid_inputs: [],
                            notes: ''
                        }],
                        assertion_style: 'mixed',
                        mock_needed: false,
                        key_rules: []
                    }
                }, ast.signature);
                const semanticTraceArgs = [join(scriptsRoot, 'dynamic_tracer.py'), sourcePath, fixture.target,
                    JSON.stringify(buildProbeInputs([], supplementalInputs))];
                const semanticTrace = parseBehaviorObservations(pythonJson(semanticTraceArgs,
                    `${fixture.id} supplemental behavior probe`), fixture.target);
                trace = mergeBehaviorObservations(trace, semanticTrace);
            }
            assert.strictEqual(trace.load_error, null, `${fixture.id}: ${trace.load_error}`);
            for (const expectedInput of fixture.expected.trace_inputs || []) {
                assert.ok(
                    trace.examples.some((example: { args?: unknown[] }) =>
                        JSON.stringify(example.args || []) === JSON.stringify([expectedInput])
                    ),
                    `${fixture.id}: behavior probe omitted declared input ${expectedInput}`
                );
            }
            for (const semanticInput of fixture.expected.semantic_trace_inputs || []) {
                assert.ok(
                    trace.examples.some((example: { args?: unknown[]; kwargs?: Record<string, unknown> }) =>
                        JSON.stringify(example.args || []) === JSON.stringify([])
                        && Object.values(example.kwargs || {}).includes(semanticInput)
                    ),
                    `${fixture.id}: analyst-proposed input ${semanticInput} was not executed by the behavior probe`
                );
            }

            const built = buildTier1TestFile({
                moduleName,
                functionName: ast.name,
                examples: trace.examples,
                errors: trace.errors,
                className: ast.class_name,
                methodKind: ast.method_kind,
                constructorParams: ast.class_context?.effective_init?.required_params
                    || ast.class_context?.init?.required_params,
                callerContexts: callers as any,
                isAsync: ast.is_async,
            });
            assert.ok(built.code, `${fixture.id}: missing deterministic test code`);
            writeFileSync(testPath, built.code!, 'utf8');

            const invocationPath = join(tempDir, 'invocation.json');
            const testRunId = randomUUID();
            const testHash = evidenceHash(built.code!);
            const sourceHash = evidenceHash(readFileSync(sourcePath, 'utf8'));
            const targetScope = { kind: 'function' as const, qualifiedName: fixture.target };
            const execution = spawnSync(pythonExecutable, [join(scriptsRoot, 'generated_test_runner.py'),
                `test_${moduleName}`, `--coverage-source=${tempDir}`, '--target-file', sourcePath,
                '--target-name', fixture.target, '--target-evidence', invocationPath,
                '--target-run-id', testRunId, '--target-test-file', testPath], {
                cwd: tempDir, encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            });
            assert.strictEqual(execution.status, 0, `${fixture.id}: ${execution.stdout}\n${execution.stderr}`);

            const nativeCoverage = pythonJson([join(scriptsRoot, 'coverage_read.py'), sourcePath, fixture.target,
                '--invocation-evidence', invocationPath, '--expected-run-id', testRunId, '--expected-test-hash', testHash],
                `${fixture.id} guarded target coverage`, tempDir);
            const assessment = assessTargetCoverageEvidence(nativeCoverage, sourcePath, fixture.target, sourceHash,
                { testRunId, testHash });

            const mutation = pythonJson(
                [
                    join(scriptsRoot, 'basic_mutation_runner.py'),
                    sourcePath,
                    testPath,
                    '0',
                    '5',
                    fixture.target,
                    ast.class_name || '',
                    '60',
                ],
                `${fixture.id} mutation`
            );
            const measured = parseBuiltinMutationRun(mutation, { sourcePath, sourceHash, testHash, targetScope });
            const quality = evaluateQuality(policy, { identity: { sourcePath, sourceHash, testHash, targetScope,
                policyHash: policy.policyHash }, executionPassed: true,
                coverage: { sourceHash, testHash, targetScope, assessment }, mutation: measured,
                reviewStatus: 'not-required', generationMode: 'deterministic-fallback', qualityGaps: [] });
            assert.equal(quality.fullyPassed, true,
                `${fixture.id}: ${JSON.stringify({ quality, mutationDiagnostic: measured.diagnostic,
                    counts: measured.counts, coverage: assessment, rawMutation: mutation })}`);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    }
});
