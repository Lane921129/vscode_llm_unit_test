import * as assert from 'assert';
import { spawnSync } from 'child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { test } from 'node:test';
import { buildTier1TestFile } from '../tier/tier1TestFileBuilder';
import { buildSemanticTraceCandidates } from '../tier/semanticTraceCandidates';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

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
    };
    acceptance: { min_mutation_score: number };
}

const fixtureRoot = resolve(__dirname, '../../test/fixtures/python');
const scriptsRoot = resolve(__dirname, '../../python_scripts');
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8')) as { fixtures: Fixture[] };
const pythonExecutable = resolvePythonExecutable(undefined, resolve(__dirname, '../..'));

function pythonJson(args: string[], label: string): any {
    const result = spawnSync(pythonExecutable, args, { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
}

test('Tier 1 corpus builds, executes, and mutation-checks deterministic tests from real Trace facts', () => {
    const fixtures = manifest.fixtures.filter(fixture => fixture.tier === 1);
    assert.ok(fixtures.length >= 3);

    for (const fixture of fixtures) {
        const tempDir = mkdtempSync(join(tmpdir(), `tier1-corpus-${fixture.id}-`));
        try {
            const original = join(fixtureRoot, fixture.source);
            const sourcePath = join(tempDir, fixture.source.split('/').pop()!);
            const moduleName = fixture.source.split('/').pop()!.replace(/\.py$/, '');
            const testPath = join(tempDir, `test_${moduleName}.py`);
            copyFileSync(original, sourcePath);

            const ast = pythonJson(
                [join(scriptsRoot, 'ast_extractor.py'), sourcePath, fixture.target],
                `${fixture.id} AST extraction`
            );
            const callers = pythonJson(
                [join(scriptsRoot, 'ast_caller_finder.py'), fixture.target, tempDir, sourcePath],
                `${fixture.id} caller extraction`
            ) as Array<Record<string, unknown>>;
            const inputs = callers
                .filter(caller => Array.isArray(caller.trace_args))
                .map(caller => ({
                    args: caller.trace_args,
                    kwargs: caller.trace_kwargs || {},
                    constructor_args: caller.trace_constructor_args,
                    constructor_kwargs: caller.trace_constructor_kwargs || {},
                }));
            const traceArgs = [join(scriptsRoot, 'dynamic_tracer.py'), sourcePath, fixture.target];
            if (inputs.length > 0) {
                traceArgs.push(JSON.stringify(inputs));
            }
            const trace = pythonJson(traceArgs, `${fixture.id} Dynamic Trace`);
            if (fixture.expected.semantic_trace_inputs?.length) {
                const semanticInputs = buildSemanticTraceCandidates({
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
                const semanticTraceArgs = [join(scriptsRoot, 'dynamic_tracer.py'), sourcePath, fixture.target, JSON.stringify([...inputs, ...semanticInputs])];
                const semanticTrace = pythonJson(semanticTraceArgs, `${fixture.id} semantic Dynamic Trace`);
                const appendUnique = (left: any[], right: any[]) => {
                    const seen = new Set<string>();
                    return [...left, ...right].filter(item => {
                        const key = JSON.stringify(item);
                        if (seen.has(key)) {return false;}
                        seen.add(key);
                        return true;
                    });
                };
                trace.examples = appendUnique(trace.examples, semanticTrace.examples);
                trace.errors = appendUnique(trace.errors, semanticTrace.errors);
            }
            assert.strictEqual(trace.load_error, null, `${fixture.id}: ${trace.load_error}`);
            for (const expectedInput of fixture.expected.trace_inputs || []) {
                assert.ok(
                    trace.examples.some((example: { args?: unknown[] }) =>
                        JSON.stringify(example.args || []) === JSON.stringify([expectedInput])
                    ),
                    `${fixture.id}: Dynamic Trace omitted declared input ${expectedInput}`
                );
            }
            for (const semanticInput of fixture.expected.semantic_trace_inputs || []) {
                assert.ok(
                    trace.examples.some((example: { args?: unknown[]; kwargs?: Record<string, unknown> }) =>
                        JSON.stringify(example.args || []) === JSON.stringify([])
                        && Object.values(example.kwargs || {}).includes(semanticInput)
                    ),
                    `${fixture.id}: semantic candidate ${semanticInput} was not executed by Dynamic Trace`
                );
            }

            const built = buildTier1TestFile({
                moduleName,
                functionName: ast.name,
                examples: trace.examples,
                errors: trace.errors,
                className: ast.class_name,
                methodKind: ast.method_kind,
                constructorParams: ast.class_context?.init?.required_params,
                callerContexts: callers as any,
                isAsync: ast.is_async,
            });
            assert.ok(built.code, `${fixture.id}: missing deterministic test code`);
            writeFileSync(testPath, built.code!, 'utf8');

            const execution = spawnSync(pythonExecutable, ['-m', 'unittest', testPath.split(/[/\\]/).pop()!], {
                cwd: tempDir,
                encoding: 'utf8',
            });
            assert.strictEqual(execution.status, 0, `${fixture.id}: ${execution.stdout}\n${execution.stderr}`);

            const mutation = pythonJson(
                [
                    join(scriptsRoot, 'basic_mutation_runner.py'),
                    sourcePath,
                    testPath,
                    '30',
                    '10',
                    fixture.target,
                    ast.class_name || '',
                ],
                `${fixture.id} mutation`
            );
            assert.strictEqual(mutation.baseline_passed, true, `${fixture.id}: ${mutation.baseline_output || ''}`);
            assert.ok(mutation.total > 0, `${fixture.id}: no mutation candidates`);
            const score = Math.round((mutation.killed / mutation.total) * 100);
            assert.ok(score >= fixture.acceptance.min_mutation_score,
                `${fixture.id}: ${score}% < ${fixture.acceptance.min_mutation_score}%\n${JSON.stringify(mutation)}`);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    }
});
