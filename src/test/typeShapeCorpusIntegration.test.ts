import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildTier1TestFile } from '../tier/tier1TestFileBuilder';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { parseBehaviorObservations } from '../pipeline/behaviorObservations';
import { BehaviorObservation, BehaviorObservations } from '../pipeline/evidenceContracts';
import { evidenceHash } from '../pipeline/analysisJournal';
import { assessTargetCoverageEvidence } from '../mutation/targetCoverage';
import { parseBuiltinMutationRun } from '../mutation/mutationResult';
import { createFixtureQualityPolicy, evaluateQuality } from '../pipeline/qualityPolicy';

interface ShapeFixture {
    id: string; tier: number; source: string; target: string;
    context: { class_name: null; method_kind: 'module' };
    expected: { type_shape_case?: string; method_kind: 'module'; is_async: boolean };
    acceptance: { min_line_coverage: number; min_mutation_score: number };
}
interface WireValue { type: string; value?: string | boolean; items?: unknown[] }
interface WireEntry { key: WireValue; value: WireValue }
interface ObservedCall { args: WireValue[]; kwargs: Map<string, WireValue>; observation: BehaviorObservation }

const root = resolve(__dirname, '../..');
const fixtureRoot = join(root, 'test/fixtures/python');
const scripts = join(root, 'python_scripts');
const manifestText = readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8');
const fixtures = (JSON.parse(manifestText).fixtures as ShapeFixture[]).filter(item => item.expected.type_shape_case);
const python = resolvePythonExecutable(undefined, root);

function runPython(args: string[], directory: string, label: string, timeout = 90000): string {
    const result = spawnSync(python, ['-B', ...args], { cwd: directory, encoding: 'utf8', timeout,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}\n${result.error?.message || ''}`);
    return result.stdout;
}
function pythonJson(args: string[], directory: string, label: string): any {
    return JSON.parse(runPython(args, directory, label));
}
const items = (value: WireValue): WireValue[] => value.items as WireValue[];
const isInt = (value: WireValue | undefined): boolean => value?.type === 'int';
const isListOfInts = (value: WireValue | undefined): boolean => value?.type === 'list' && items(value).every(isInt);
const parameter = (call: ObservedCall, name: string, index = 0): WireValue | undefined => call.kwargs.get(name) || call.args[index];

function successfulCalls(trace: BehaviorObservations): ObservedCall[] {
    return trace.examples.filter(observation => observation.call_assertable !== false && observation.result_assertable !== false)
        .map(observation => {
            const observedCase = trace.cases!.find(item => item.case_id === observation.case_id)!;
            assert.equal(observedCase.status, 'returned');
            assert.equal(observedCase.source.kind, 'source_guided');
            assert.equal(observedCase.input_before.replayable, true);
            const snapshot = observedCase.input_before;
            return { observation, args: snapshot.args!.value.items as WireValue[],
                kwargs: new Map((snapshot.kwargs!.value.items as WireEntry[]).map(pair => [String(pair.key.value), pair.value])) };
        });
}

function assertShapes(fixture: ShapeFixture, ast: any, trace: BehaviorObservations): void {
    assert.equal(ast.type_shape_version, 'type-shape-v1', fixture.id);
    const shapes = new Map<string, any>(ast.signature.map((entry: any) => [entry.name, entry.type_shape]));
    const calls = successfulCalls(trace);
    assert.ok(calls.length > 0, `${fixture.id}: no assertable returns`);
    assert.equal(trace.errors.length, 0, `${fixture.id}: annotation-conforming probes should not merely produce errors`);
    assert.equal(calls.length, trace.examples.length, `${fixture.id}: no diagnostic result may masquerade as a useful probe`);
    for (const call of calls) {
        assert.notEqual(call.observation.result, 'None', `${fixture.id}: a generic None return does not demonstrate this fixture`);
    }
    const firstValues = calls.map(call => parameter(call, ast.signature[0].name));
    switch (fixture.expected.type_shape_case) {
        case 'list-int':
            assert.equal(shapes.get('values').kind, 'list');
            assert.deepEqual(shapes.get('values').element, { kind: 'scalar', name: 'int' });
            assert.ok(firstValues.every(isListOfInts));
            assert.ok(firstValues.some(value => items(value!).length === 0));
            assert.ok(firstValues.some(value => items(value!).length > 0));
            break;
        case 'fixed-tuple':
            assert.equal(shapes.get('pair').kind, 'tuple');
            assert.equal(shapes.get('pair').variadic, false);
            assert.deepEqual(shapes.get('pair').elements, [{ kind: 'scalar', name: 'int' }, { kind: 'scalar', name: 'str' }]);
            assert.ok(firstValues.every(value => value?.type === 'tuple' && items(value).length === 2
                && isInt(items(value)[0]) && items(value)[1].type === 'str'));
            break;
        case 'nested-dict': {
            const shape = shapes.get('groups');
            assert.equal(shape.kind, 'dict');
            assert.deepEqual(shape.key, { kind: 'scalar', name: 'str' });
            assert.equal(shape.value.kind, 'list');
            assert.deepEqual(shape.value.element, { kind: 'scalar', name: 'int' });
            assert.ok(firstValues.every(value => value?.type === 'dict' && (value.items as WireEntry[])
                .every(pair => pair.key.type === 'str' && isListOfInts(pair.value))));
            assert.ok(firstValues.some(value => (value!.items as WireEntry[]).some(pair => items(pair.value).length > 0)),
                'a populated nested list must return successfully');
            break;
        }
        case 'optional-list':
            assert.equal(shapes.get('values').kind, 'union');
            assert.ok(shapes.get('values').members.some((member: any) => member.kind === 'scalar' && member.name === 'none'));
            assert.ok(shapes.get('values').members.some((member: any) => member.kind === 'list' && member.element.name === 'int'));
            assert.ok(firstValues.every(value => value?.type === 'none' || isListOfInts(value)));
            assert.ok(firstValues.some(value => value?.type === 'none'));
            assert.ok(firstValues.some(value => isListOfInts(value) && items(value!).length > 0));
            break;
        case 'scalar-union':
            assert.equal(shapes.get('value').kind, 'union');
            assert.deepEqual(new Set(shapes.get('value').members.map((member: any) => member.name)), new Set(['int', 'str']));
            assert.deepEqual(new Set(firstValues.map(value => value?.type)), new Set(['int', 'str']));
            break;
        case 'omitted-defaults':
            assert.ok(calls.some(call => !parameter(call, 'value') && !call.kwargs.has('suffix')), 'both defaults can remain omitted');
            assert.ok(calls.some(call => isInt(parameter(call, 'value'))), 'the optional positional parameter is also supplied explicitly');
            assert.ok(calls.some(call => call.kwargs.get('suffix')?.type === 'str'), 'keyword-only values are supplied by keyword');
            assert.ok(calls.every(call => call.args.length <= 1 && (!parameter(call, 'value') || isInt(parameter(call, 'value')))));
            break;
        case 'container-length':
            assert.equal(shapes.get('values').kind, 'list');
            assert.ok(firstValues.every(isListOfInts), 'length boundary values remain typed containers');
            for (const length of [1, 2, 3]) {
                assert.ok(firstValues.some(value => items(value!).length === length), `missing length boundary ${length}`);
            }
            break;
        case 'parameter-relation': {
            const relations = new Set(calls.map(call => {
                const low = parameter(call, 'low'), high = parameter(call, 'high', 1);
                assert.ok(isInt(low) && isInt(high));
                const left = BigInt(low!.value as string), right = BigInt(high!.value as string);
                return left < right ? 'less' : left > right ? 'greater' : 'equal';
            }));
            assert.deepEqual(relations, new Set(['less', 'equal', 'greater']));
            break;
        }
        default: assert.fail(`Unknown shape fixture ${fixture.expected.type_shape_case}`);
    }
}

test('source-guided type shapes produce real return observations and pass the complete fixture policy without callers', () => {
    assert.equal(fixtures.length, 8, 'this independently verified slice contains eight shape families');
    for (const fixture of fixtures) {
        const directory = mkdtempSync(join(tmpdir(), `${fixture.id}-`));
        try {
            assert.deepEqual(fixture.context, { class_name: null, method_kind: 'module' });
            const sourcePath = join(directory, basename(fixture.source));
            const moduleName = basename(fixture.source, '.py');
            copyFileSync(join(fixtureRoot, fixture.source), sourcePath);
            const ast = pythonJson([join(scripts, 'ast_extractor.py'), sourcePath, fixture.target], directory, `${fixture.id}: AST`);
            assert.equal(ast.method_kind, 'module');
            const callers = pythonJson([join(scripts, 'ast_caller_finder.py'), fixture.target, directory, sourcePath], directory, `${fixture.id}: callers`);
            assert.deepEqual(callers, [], `${fixture.id}: source-guided proof must not borrow a caller`);
            const rawTrace = pythonJson([join(scripts, 'dynamic_tracer.py'), sourcePath, fixture.target], directory, `${fixture.id}: Trace`);
            const trace = parseBehaviorObservations(rawTrace, fixture.target);
            assert.equal(trace.load_error, null, fixture.id);
            assert.equal(trace.complete, true, fixture.id);
            assert.equal(rawTrace.input_plan?.schema_version, 'input-plan-v1');
            assertShapes(fixture, ast, trace);

            const built = buildTier1TestFile({ moduleName, functionName: ast.name, examples: trace.examples, errors: trace.errors,
                className: ast.class_name, methodKind: ast.method_kind, isAsync: ast.is_async, callerContexts: [] });
            assert.ok(built.code, `${fixture.id}: no deterministic tests from successful observations`);
            assert.equal(built.methodCount, trace.examples.length, `${fixture.id}: every assertable shape observation remains in tests`);
            const testPath = join(directory, 'candidate_test.py');
            writeFileSync(testPath, built.code, 'utf8');
            const sourceHash = evidenceHash(readFileSync(sourcePath, 'utf8')), testHash = evidenceHash(built.code);
            const testRunId = randomUUID(), invocation = join(directory, 'invocation.json');
            runPython([join(scripts, 'generated_test_runner.py'), 'candidate_test', `--coverage-source=${directory}`,
                '--target-file', sourcePath, '--target-name', fixture.target, '--target-evidence', invocation,
                '--target-run-id', testRunId, '--target-test-file', testPath], directory, `${fixture.id}: guarded tests`, 30000);
            const nativeCoverage = pythonJson([join(scripts, 'coverage_read.py'), sourcePath, fixture.target,
                '--invocation-evidence', invocation, '--expected-run-id', testRunId, '--expected-test-hash', testHash], directory, `${fixture.id}: coverage`);
            const coverage = assessTargetCoverageEvidence(nativeCoverage, sourcePath, fixture.target, sourceHash, { testRunId, testHash });
            const targetScope = { kind: 'function' as const, qualifiedName: fixture.target };
            const rawMutation = pythonJson([join(scripts, 'basic_mutation_runner.py'), sourcePath, testPath,
                '0', '5', fixture.target, '', '60'], directory, `${fixture.id}: full mutation`);
            const mutation = parseBuiltinMutationRun(rawMutation, { sourcePath, sourceHash, testHash, targetScope });
            const policy = createFixtureQualityPolicy({ fixtureId: fixture.id, manifestHash: evidenceHash(manifestText),
                minLineCoverage: fixture.acceptance.min_line_coverage, minMutationScore: fixture.acceptance.min_mutation_score });
            const quality = evaluateQuality(policy, { identity: { sourcePath, sourceHash, testHash, targetScope, policyHash: policy.policyHash },
                executionPassed: true, coverage: { sourceHash, testHash, targetScope, assessment: coverage }, mutation,
                reviewStatus: 'not-required', generationMode: 'deterministic-fallback', qualityGaps: [] });
            assert.equal(quality.fullyPassed, true, `${fixture.id}: ${JSON.stringify({ quality, coverage, mutation })}`);
            assert.equal(mutation.counts.available, mutation.counts.executed, `${fixture.id}: samples are not complete acceptance`);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

test('unknown or shadowed annotations request input instead of manufacturing a source-guided oracle', () => {
    const cases = [
        { name: 'unknown', source: "from __future__ import annotations\ndef target(value: MissingShape):\n    return value\n" },
        { name: 'shadowed', source: "from __future__ import annotations\nlist = 17\ndef target(value: list[int]):\n    return len(value)\n" },
    ];
    for (const item of cases) {
        const directory = mkdtempSync(join(tmpdir(), 'shape-needs-input-'));
        try {
            const sourcePath = join(directory, 'sample.py');
            writeFileSync(sourcePath, item.source, 'utf8');
            const ast = pythonJson([join(scripts, 'ast_extractor.py'), sourcePath, 'target'], directory, `${item.name}: AST`);
            assert.equal(ast.signature[0].type_shape.kind, 'unknown');
            const rawTrace = pythonJson([join(scripts, 'dynamic_tracer.py'), sourcePath, 'target'], directory, `${item.name}: Trace`);
            const trace = parseBehaviorObservations(rawTrace, 'target');
            assert.equal(trace.load_error, null, `${item.name}: unresolved input is a planning diagnosis, not an import failure`);
            assert.ok(rawTrace.input_plan?.diagnostics?.some((diagnostic: any) =>
                diagnostic.parameter === 'value' && ['needs-input', 'needs-fixture'].includes(diagnostic.code)), item.name);
            assert.equal(trace.examples.filter(item => item.call_assertable !== false && item.result_assertable !== false).length, 0);
            assert.equal(trace.errors.filter(item => item.call_assertable !== false).length, 0);
            const built = buildTier1TestFile({ moduleName: 'sample', functionName: 'target', examples: trace.examples, errors: trace.errors });
            assert.equal(built.methodCount, 0, `${item.name}: missing input must not become an exception assertion`);
            assert.equal(built.code, undefined);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});
