import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompactWriterContext, buildWriterRevisionContext } from '../prompts/compactWriterContext';
import { getReviewEvidence, getBugFixerUserPrompt } from '../roles/bugFixer';
import { getSemanticAnalyzerUserPrompt } from '../roles/semanticAnalyzer';
import { fitReviewPrompt, numberReviewLines } from '../roles/testReviewer';
import { estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { observationsForPrompt, WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';

const source = 'def target(value):\n    return globals()[value]\n';
const helper = 'def helper(value):\n' + '    # complete neutral source and spacing remain unchanged\n'.repeat(45) + '    return value\n';
const constructor = { name: 'Holder', init: { code: 'def __init__(self):\n    self.config = ' + JSON.stringify('SETUP_VALUE '.repeat(180)) } };
const imports = [{ module: 'unknown_namespace', metadata: 'UNKNOWN_IMPORT_BINDING '.repeat(30) }];
const globals = [{ name: 'OPTIONS', code: 'OPTIONS = ' + JSON.stringify('SOURCE_ONLY '.repeat(100)) }];
const trace = (name: string, value: string): any => ({ func_name: name, args: ['value'], run_id: `run-${value}`,
    complete: true, load_error: null, examples: [{ case_id: `case-${value}`, args: ['1'], result: value,
        call_assertable: false, result_assertable: false, oracle_reason: 'uncontrolled-ambient-read' }], errors: [] });
const context = () => ({ code: source, args: ['value'], class_context: constructor, file_imports: imports,
    referenced_globals: globals, traceResult: trace('target', 'TARGET_DIAGNOSTIC'), dependencyContexts: [0, 1, 2].map(index => ({
        name: `helper_alias_${index}`, code: helper, sourceHash: String(index).repeat(64), class_context: constructor,
        file_imports: imports, referenced_globals: globals, custom_setup: { required: `UNKNOWN_SETUP_${index}` },
        traceResult: trace(`helper_alias_${index}`, `DEPENDENCY_DIAGNOSTIC_${index}`)
    })) });
const evidence: WriterEvidenceBundleV3 = { schemaVersion: 'writer-evidence-v3', sourceHash: 'a'.repeat(64), semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'a'.repeat(64), ids: [], selectedRules: [],
        guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance'] };
const tests = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(target(1), 2)\n';

test('Reviewer and focused repair share complete identical setup/source while retaining every identity and observation', t => {
    const ast = context(), before = JSON.stringify(ast);
    const review = getReviewEvidence('', '', 'target', ['value'], source, ast, 'sample');
    const repair = getBugFixerUserPrompt(tests, 'FAIL: test_value (suite.Cases.test_value)\nAssertionError: mismatch',
        'target', ['value'], source, ast, 'sample');
    const uncompressed = JSON.stringify({ constructor, imports, globals,
        dependencies: ast.dependencyContexts.map(dep => ({ ...dep, traceResult: observationsForPrompt(dep.traceResult) })),
        observations: observationsForPrompt(ast.traceResult) });
    t.diagnostic(JSON.stringify({ completeRepeatedContextTokens: estimatePromptTokens(uncompressed),
        reviewerEvidenceTokens: estimatePromptTokens(review), bugFixerRequestTokens: estimatePromptTokens(repair) }));
    for (const prompt of [review, repair]) {
        assert.ok(estimatePromptTokens(prompt) < estimatePromptTokens(uncompressed) * 0.65,
            'production prompt removes substantial exact duplication, not required evidence');
        assert.equal(prompt.split(JSON.stringify(constructor)).length - 1, 1);
        assert.equal(prompt.split(JSON.stringify(helper)).length - 1, 1);
        for (let index = 0; index < 3; index++) {
            for (const required of [String(index).repeat(64), `helper_alias_${index}`, `UNKNOWN_SETUP_${index}`,
                `DEPENDENCY_DIAGNOSTIC_${index}`, `case-DEPENDENCY_DIAGNOSTIC_${index}`]) { assert.ok(prompt.includes(required), required); }
        }
        assert.ok(prompt.includes(source));
        assert.match(prompt, /UNKNOWN_IMPORT_BINDING/);
        assert.match(prompt, /same_complete_setup_as/);
        assert.match(prompt, /same_complete_source_as/);
        assert.match(prompt, /keep each identity and observation separate/);
        assert.match(prompt, /"result_assertable":false/);
        assert.match(prompt, /uncontrolled-ambient-read/);
    }
    const request = fitReviewPrompt({ tests, evidence: review, executionVerified: true }, Number.MAX_SAFE_INTEGER)!;
    assert.ok(request.includes(numberReviewLines(tests)), 'Reviewer still receives the complete numbered candidate');
    assert.equal(JSON.stringify(ast), before, 'artifact evidence is immutable');
});

test('Analyst references exact complete source only, retaining different source versions and separate observations', t => {
    const dependencies = context().dependencyContexts.map(dep => ({ name: dep.name, code: dep.code,
        sourceHash: dep.sourceHash, observations: dep.traceResult }));
    const base = { schemaVersion: 'analysis-evidence-v2' as const,
        target: { moduleName: 'sample', functionName: 'target', source, sourceHash: 'a'.repeat(64) }, callSites: [], dependencies };
    const prompt = getSemanticAnalyzerUserPrompt(base);
    assert.equal(prompt.split(helper).length - 1, 1);
    for (const dep of dependencies) {
        assert.ok(prompt.includes(dep.sourceHash));
        assert.ok(prompt.includes(JSON.stringify(observationsForPrompt(dep.observations))));
    }
    const distinct = getSemanticAnalyzerUserPrompt({ ...base, dependencies: dependencies.map((dep, index) => ({
        ...dep, code: dep.code + `# distinct source ${index}\n` })) });
    t.diagnostic(JSON.stringify({ repeatedSourcePromptTokens: estimatePromptTokens(distinct),
        sharedSourcePromptTokens: estimatePromptTokens(prompt) }));
    assert.ok(estimatePromptTokens(prompt) < estimatePromptTokens(distinct) * 0.7);
    assert.doesNotMatch(distinct, /same_complete_source_as/);
    const again = getSemanticAnalyzerUserPrompt(base);
    assert.equal(again, prompt, 'a new request gets its own complete first source, never a dangling cross-request reference');
});

test('Writer retains required helper sources even above budget and reuses setup only when completely identical', () => {
    const ast = context();
    ast.dependencyContexts[2].class_context = { ...constructor, name: 'DifferentHolder' };
    const input = { module: 'sample', name: 'target', source, context: ast, evidence };
    for (const prompt of [buildCompactWriterContext({ ...input, budgetTokens: 300 }), buildWriterRevisionContext(input)]) {
        assert.ok(prompt.includes(helper));
        assert.equal(prompt.split(helper).length - 1, 1);
        assert.equal(prompt.split(constructor.init.code).length - 1, 1, 'the complete shared constructor source is printed once');
        assert.match(prompt, /"name":"Holder"/);
        assert.match(prompt, /"name":"DifferentHolder"/, 'different class identity is not collapsed');
        assert.match(prompt, /"code":\{"same_complete_source_as":"SOURCE FRAGMENT/);
        for (const dep of ast.dependencyContexts) { assert.ok(prompt.includes(dep.sourceHash)); }
        assert.match(prompt, /DEPENDENCY_DIAGNOSTIC_0/);
        assert.match(prompt, /DEPENDENCY_DIAGNOSTIC_1/);
        assert.match(prompt, /DEPENDENCY_DIAGNOSTIC_2/);
        assert.doesNotMatch(prompt, /Dependency source omitted/);
        assert.equal(promptFits('', prompt, 300), false, 'insufficient capacity remains a real rejection');
    }
});

test('same-named dependencies reference the exact indexed complete source instead of an ambiguous name', () => {
    const first = helper + '# first source\n', second = helper + '# second source\n';
    const prompt = buildWriterRevisionContext({ module: 'sample', name: 'target', source, evidence,
        context: { dependencyContexts: [first, second, second].map((code, index) => ({ name: 'helper', code,
            sourceHash: String(index).repeat(64) })) } });
    assert.equal(prompt.split(first).length - 1, 1);
    assert.equal(prompt.split(second).length - 1, 1);
    assert.match(prompt, /Complete source is identical to RETRIEVED DEPENDENCY helper \[2\] above/);
    assert.doesNotMatch(prompt, /identical to RETRIEVED DEPENDENCY helper \[1\]/);
});

test('Writer and Analyst keep original dependency indices and source identities beside every observation', () => {
    const dependencies = [
        { name: 'helper', code: helper + '# first source\n', sourceHash: '1'.repeat(64), traceResult: trace('helper', 'FIRST') },
        { name: 'helper', code: helper + '# untraced source\n', sourceHash: '2'.repeat(64) },
        { name: 'helper', code: helper + '# third source\n', sourceHash: '3'.repeat(64), traceResult: trace('helper', 'THIRD') },
        { name: 'helper', code: helper + '# source without hash\n', traceResult: trace('helper', 'NO_HASH') }
    ];
    const before = JSON.stringify(dependencies);
    const writerInput = { module: 'sample', name: 'target', source, evidence, context: { dependencyContexts: dependencies } };
    const analyst = getSemanticAnalyzerUserPrompt({ schemaVersion: 'analysis-evidence-v2',
        target: { moduleName: 'sample', functionName: 'target', source, sourceHash: 'a'.repeat(64) }, callSites: [],
        dependencies: dependencies.map(dep => ({ name: dep.name, code: dep.code, sourceHash: dep.sourceHash,
            observations: dep.traceResult })) });
    const expected = [0, 2, 3].map(index => ({ dependencyIndex: index + 1, name: 'helper',
        ...(dependencies[index].sourceHash ? { sourceHash: dependencies[index].sourceHash } : {}),
        observations: observationsForPrompt(dependencies[index].traceResult) }));
    const prompts = [
        { prompt: buildCompactWriterContext({ ...writerInput, budgetTokens: 12000 }), marker: 'VERIFIED DEPENDENCY OBSERVATIONS (never substitute for target results):\n' },
        { prompt: buildWriterRevisionContext(writerInput), marker: 'VERIFIED DEPENDENCY OBSERVATIONS (never substitute for target results):\n' },
        { prompt: analyst, marker: '=== VERIFIED DEPENDENCY EXECUTION FACTS ===\n' }
    ];
    for (const { prompt, marker } of prompts) {
        assert.ok(prompt.includes(marker));
        let projected = JSON.parse(prompt.split(marker)[1].split('\n')[0]);
        if (marker.startsWith('VERIFIED DEPENDENCY')) {
            const diagnostic = JSON.parse(prompt.split('DIAGNOSTICS (never expected values, expected exceptions, fixture returns or fixture types):\n')[1].split('\n')[0]);
            projected = projected.map((entry: any, index: number) => {
                const { observationRunId: _run, ...details } = diagnostic.dependencies[index].diagnostics;
                assert.equal(diagnostic.dependencies[index].dependencyIndex, entry.dependencyIndex);
                return { dependencyIndex: entry.dependencyIndex, name: entry.name,
                    ...(entry.sourceHash ? { sourceHash: entry.sourceHash } : {}),
                    observations: { ...details, examples: [...entry.observations.examples, ...details.examples],
                        errors: [...entry.observations.errors, ...details.errors] } };
            });
        }
        assert.deepEqual(projected, JSON.parse(JSON.stringify(expected)), 'indices address the original source list, including untraced entries');
        assert.equal(Object.hasOwn(projected[2], 'sourceHash'), false, 'missing identity evidence is never fabricated');
    }
    assert.equal(JSON.stringify(dependencies), before, 'prompt projection never rewrites the source artifact');
});
