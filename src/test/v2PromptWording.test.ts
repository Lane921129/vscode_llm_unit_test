import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaseRow } from '../pipeline/caseTable/caseTable';
import { collectSpecSources } from '../pipeline/caseTable/specSources';
import { getRowFixPrompt } from '../roles/bugFixer';
import { getSurvivorRowCorrectionPrompt, getSurvivorRowPrompt } from '../roles/qualityAnalyst';
import { CaseScenarioPromptFacts, getCaseRowCorrectionPrompt, getCaseScenarioPrompt } from '../roles/semanticAnalyzer';
import { diagnoseSpecPrediction, getSpecPredictionCorrectionPrompt, getSpecPredictionPrompt } from '../roles/specOracle';

/** PR #18 stage 4: user-approved wording revisions (2026-11-17), limited to the listed sentences. */
const facts: CaseScenarioPromptFacts = { signature: 'clamp(value, high=10)', className: null, methodKind: 'module', isAsync: false,
    docstring: 'Return value, but never more than high.', branches: [{ line: 2, kind: 'if', condition: 'value > high' }], raises: [],
    dependencies: [], source: 'def clamp(value, high=10):\n    if value > high:\n        return high\n    return value' };
const ARGS = '- "args": a Python tuple literal of the positional arguments, e.g. "(1, \'a\')"; write a single argument as "(x,)";'
    + ' write "<needs-setup: what must be built>" when an argument cannot be written as a literal';
const KWARGS = '- "kwargs": a Python dict literal of keyword arguments, e.g. "{\'k\': \'v\'}"; "{}" when there are none';
const INTERNAL = /\b(?:contract|hash|sha256|version|validator|case_row\w*|case-table|v2|guard|AST)\b/i;
const survivorOptions = { signature: 'clamp(value, high=10)', source: facts.source, startLine: 1,
    survivor: { line: 2, original: 'if value > high:', mutated: 'if value >= high:' } };

test('scenario, scenario-correction and survivor prompts use the revised args, kwargs and line wording', () => {
    const scenario = getCaseScenarioPrompt(facts, []).user;
    const boundary = getCaseScenarioPrompt(facts, [], { testFocus: 'boundary' }).user;
    const correction = getCaseRowCorrectionPrompt('{"scenario":"x"}', 'missing-field', 'category', facts, []).user;
    const survivor = getSurvivorRowPrompt(survivorOptions).user;
    const survivorCorrection = getSurvivorRowCorrectionPrompt('{"scenario":"x"}', 'missing-field', 'category', survivorOptions).user;
    for (const prompt of [scenario, correction, survivor, survivorCorrection]) {
        assert.ok(prompt.includes(ARGS) && prompt.includes(KWARGS));
        assert.ok(prompt.includes('- "category": one of normal, boundary, error, dependency-failure, state'), 'category list unchanged');
        assert.equal((prompt.match(/Example line:/g) || []).length, 1, 'still one example');
        assert.doesNotMatch(prompt, INTERNAL);
    }
    assert.ok(scenario.includes('Write at most 8 lines, one single-line JSON object per line (do not wrap in a JSON array).'));
    assert.ok(scenario.includes('Use each category at least once when it applies to this function.'), 'kept verbatim');
    assert.ok(boundary.includes('At least 4 of the lines must be category boundary or error.'), 'kept verbatim');
    assert.doesNotMatch(scenario, /one scenario per line|"\(1, 2\)"/);
});

test('the Bug Fixer prompt states exactly what may change and limits the reply to the one method', () => {
    const prompt = getRowFixPrompt({ signature: 'clamp(value, high=10)', scenario: 'value above high', methodName: 'test_c1',
        method: '    def test_c1(self):\n        result = target_module.clamp(*(11,), **{})\n        self.assertEqual(result, 10)', error: 'AssertionError' });
    assert.ok(prompt.user.includes('Change only the setup before the call under test. Keep the mock.patch setup, the call under test, '
        + 'the assertions and everything after the call unchanged.\nDo not add try, if or loops. Write any import you need inside the method, before the call.'));
    assert.ok(prompt.user.trim().endsWith('Output only the complete corrected test_c1 method in one ```python block, with no helper functions and no explanation.'));
    assert.match(prompt.system, /keep every expected value in the assertions exactly as it is/, 'the system prompt is unchanged');
    assert.doesNotMatch(prompt.system + prompt.user, INTERNAL);
});

test('the spec prompt asks for a verbatim basis and its correction names why the last answer was unusable', () => {
    const spec = collectSpecSources({ version: 'case-table-facts-v1', target: 'clamp', className: null, methodKind: 'module', isAsync: false,
        signature: facts.signature, parameters: [], returns: null, docstring: facts.docstring, branches: [], raises: [], dependencies: [],
        source: facts.source }, [{ id: 'R1', text: 'High itself is a valid result.' }]);
    const row: CaseRow = { id: 'C1', origin: 'analyst', scenario: 'above', category: 'boundary', call: { args: '(11,)', kwargs: '{}' },
        mocks: [], status: 'captured' };
    const basis = '- "basis": copy word for word one passage from the docstring or from a single requirement that decides the answer; do not reword or combine sentences';
    assert.ok(getSpecPredictionPrompt(spec, row, 'clamp').user.includes(basis));
    const cases: [string, string, string][] = [
        ['not json', 'invalid-json', 'Problem: it is not one valid JSON object.'],
        ['{"expect":"10","basis":"Return value, but never more than high."}', 'expect-format', 'Problem: "expect" does not start with "return" or "raise".'],
        ['{"expect":"return 10","basis":"  "}', 'basis-empty', 'Problem: "basis" is empty.']];
    for (const [reply, reason, line] of cases) {
        assert.equal(diagnoseSpecPrediction(reply), reason);
        const user = getSpecPredictionCorrectionPrompt(spec, row, 'clamp', reply).user;
        assert.ok(user.includes(`Your previous answer could not be used: ${reply}\n${line}\n`), reason);
        assert.ok(user.includes(basis));
        assert.ok(!user.includes('if value > high') && !user.includes('return high'), 'no function body');
        assert.doesNotMatch(user, INTERNAL);
    }
    assert.equal(diagnoseSpecPrediction('{"expect":"return 10","basis":"High itself is a valid result."}'), null);
});
