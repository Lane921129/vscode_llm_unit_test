import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaseRow } from '../pipeline/caseTable/caseTable';
import { CaseTableFacts } from '../pipeline/caseTable/caseTableFacts';
import { basisVerified, collectSpecSources, hasSpecSource } from '../pipeline/caseTable/specSources';
import { SPEC_PREDICTION_COUNT, getSpecPredictionCorrectionPrompt, getSpecPredictionPrompt, parseSpecPrediction } from '../roles/specOracle';

const BODY_MARKER = 'BODY_ONLY_MARKER_4711';
const facts: CaseTableFacts = {
    version: 'case-table-facts-v1', target: 'clamp', className: null, methodKind: 'module', isAsync: false,
    signature: 'clamp(value: int, high: int = 10) -> int',
    parameters: [{ name: 'value', kind: 'positional_or_keyword', annotation: 'int', default: null },
        { name: 'high', kind: 'positional_or_keyword', annotation: 'int', default: '10' }],
    returns: 'int', docstring: 'Return value, but never more than high.\nValues equal to high are returned unchanged.',
    branches: [{ line: 3, kind: 'if', condition: 'value >= high' }], raises: [], dependencies: [{ name: 'store.read', patch: 'store.read', chain: [] }],
    source: `def clamp(value: int, high: int = 10) -> int:\n    ${BODY_MARKER} = 1\n    if value >= high:\n        return high - 1\n    return value\n`
};
const row: CaseRow = { id: 'C2', origin: 'analyst', scenario: 'value equal to high', category: 'boundary',
    call: { args: '(10,)', kwargs: '{}' }, mocks: [{ dependency: 'store.read', behavior: 'return', value: '3' }], status: 'captured',
    actual: { kind: 'return', value: '9' } };
const forbidden = [BODY_MARKER, 'high - 1', 'value >= high', 'verified', 'Verified', '已驗證', 'trace', 'observed', 'actual', 'coverage', 'mutation'];

test('the spec prompt contains only signature, docstring, annotations, requirements and the row inputs', () => {
    const spec = collectSpecSources(facts, [{ id: 'R1', text: 'High itself is a valid result.' }]);
    for (const prompt of [getSpecPredictionPrompt(spec, row, 'clamp'), getSpecPredictionCorrectionPrompt(spec, row, 'clamp', '{"expect":"x"}')]) {
        const text = prompt.system + '\n' + prompt.user;
        for (const word of forbidden) { assert.ok(!text.includes(word), `spec prompt must not contain ${word}`); }
        assert.ok(!text.includes(facts.source.split('\n')[1]), 'no function body line');
        assert.ok(!/\b9\b/.test(text), 'the captured outcome never reaches the prompt');
        for (const expected of ['Function: clamp(value: int, high: int = 10) -> int', 'Values equal to high are returned unchanged.',
            '- value: int', '- returns: int', 'R1: High itself is a valid result.', 'Scenario: value equal to high',
            'Call: clamp(*(10,), **{})', '- store.read returns 3']) {
            assert.ok(text.includes(expected), expected);
        }
    }
    assert.equal(SPEC_PREDICTION_COUNT, 3);
});

test('spec presence, basis verification and prediction parsing', () => {
    const spec = collectSpecSources(facts, []);
    assert.ok(hasSpecSource(spec));
    assert.equal(hasSpecSource(collectSpecSources({ ...facts, docstring: null }, [])), false, 'annotations alone are not a spec');
    assert.ok(basisVerified('docstring: "Values equal to high are returned unchanged."', spec));
    assert.ok(basisVerified('never more than high', spec));
    assert.equal(basisVerified('The function name clamp says so.', spec), false);
    assert.equal(basisVerified('clamp', spec), false, 'the function name alone is weak evidence');
    assert.equal(basisVerified('high', spec), false, 'too short to verify');
    assert.deepEqual(parseSpecPrediction('{"expect":"return (1, \'a\')","basis":"x y z"}'), { kind: 'return', value: "(1, 'a')", basis: 'x y z' });
    assert.deepEqual(parseSpecPrediction('Sure:\n{"expect":"raise ValueError","basis":"b"}'), { kind: 'raise', value: 'ValueError', basis: 'b' });
    for (const bad of ['no json', '{"expect":"maybe 3","basis":"b"}', '{"expect":"return 3"}', '{"expect":"raise Value Error","basis":"b"}']) {
        assert.equal(parseSpecPrediction(bad), null, bad);
    }
});
