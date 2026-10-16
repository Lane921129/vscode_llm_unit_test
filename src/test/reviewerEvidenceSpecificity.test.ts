import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildReviewFacts, ReviewFacts } from '../roles/reviewFacts';
import { parseTestReviewDetailed, ReviewConstraints } from '../roles/testReviewer';
import { reviewWithContractRepair } from '../roles/reviewContractRepair';
import { BehaviorObservations, TraceValueSnapshot } from '../pipeline/evidenceContracts';
import { typedCallFields } from '../pipeline/probeInputs';

const python = path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const identity = { runId: 'saved-review-replay', sourceHash: 'a'.repeat(64) };
const bmi = 'import unittest\nfrom bmi import calculate_bmi\n\nclass TestCalculateBmi(unittest.TestCase):\n'
    + '    def test_calculate_bmi(self):\n        weight_kg = 1\n        height_cm = 1\n'
    + "        bmi, status = calculate_bmi(weight_kg, height_cm)\n        self.assertEqual(bmi, 10000.0)\n        self.assertEqual(status, '肥胖')";
const clock = 'import unittest\nfrom unittest.mock import patch\nfrom datetime import datetime\nfrom database import _now_text\n\n'
    + 'class TestNowText(unittest.TestCase):\n    def test_now_text(self):\n'
    + "        with patch('database.datetime') as clock_stub:\n"
    + '            clock_stub.now.return_value = datetime(2026, 10, 14, 15, 42, 47)\n'
    + "            self.assertEqual(_now_text(), '2026-10-14 15:42:47')\n\nif __name__ == '__main__':\n    unittest.main()";
const constraints = (facts: ReviewFacts): ReviewConstraints => ({ target: facts.target, module: facts.module,
    methodKind: 'module', identity: { ...identity, target: facts.target }, facts, dependencyUsePoints: ['database.datetime'] });
const facts = (code: string, module: string, target: string) => buildReviewFacts({ ...identity, module, target,
    code, executionVerified: true, python, env: process.env });
const finding = (test_line: string, category: string, reason: string, action: string) => ({ category, test_line, reason, action });
const envelope = (...findings: object[]) => JSON.stringify({ findings });
const echoedRule = 'Expected value is not a proven wrong value. Never invent its replacement from model arithmetic, type annotations or a return expression. For a concrete verification gap, name missing evidence and request a controlled observation or explicit contract in action; unknown is not a contradiction.';
const echoedAction = 'Verify expected value separately. Uncontrolled clocks/randomness, model hypotheses, source formulas and annotations are not independent oracles; annotations do not enforce input types.';

test('saved BMI findings that repeat instructions are invalid assessments, never Writer corrections', () => {
    const parsed = parseTestReviewDetailed(envelope(finding('L9', 'assertion-quality', echoedRule, echoedAction),
        finding('L10', 'assertion-quality', echoedRule, echoedAction)), bmi, true);
    assert.equal(parsed.review, undefined);
    assert.deepEqual(parsed.diagnostics, ['non-actionable-reason']);
});

test('generic verification advice is rejected while a concrete unknown verification gap stays reviewable', () => {
    const generic = parseTestReviewDetailed(envelope(finding('L9', 'assertion-quality',
        'The calculate_bmi(1, 1) assertion expects 10000.0; verify this expected value.', 'Verify expected value separately.')), bmi, true);
    assert.equal(generic.review, undefined);
    assert.deepEqual(generic.diagnostics, ['non-actionable-action']);
    const concrete = parseTestReviewDetailed(envelope(finding('L9', 'assertion-quality',
        'The calculate_bmi(1, 1) assertion expects 10000.0; no independent business specification establishes this edge case.',
        'Request an explicit business contract for calculate_bmi(1, 1) before changing the expected value.')), bmi, true);
    assert.equal(concrete.review?.issues.length, 1, 'observed behavior is not an independent business specification');
});

test('saved BMI tuple assertions retain exact-input observation facts', async () => {
    const scalar = (type: 'int' | 'float' | 'str', value: string) => ({ type, value });
    const call: TraceValueSnapshot = { schema_version: 'trace-value-v1', replayable: true, value: { type: 'dict', items: [
        { key: scalar('str', 'args'), value: { type: 'list', items: [scalar('int', '1'), scalar('int', '1')] } },
        { key: scalar('str', 'kwargs'), value: { type: 'dict', items: [] } },
        { key: scalar('str', 'constructor_args'), value: { type: 'list', items: [] } },
        { key: scalar('str', 'constructor_kwargs'), value: { type: 'dict', items: [] } }
    ] } };
    const fields = typedCallFields(call)!;
    const snapshot = (value: TraceValueSnapshot['value']): TraceValueSnapshot => ({ schema_version: 'trace-value-v1', replayable: true, value });
    const input = { replayable: true, call_graph: call, args: snapshot(fields.args), kwargs: snapshot(fields.kwargs),
        constructor_args: snapshot(fields.constructor_args!), constructor_kwargs: snapshot(fields.constructor_kwargs!) };
    const observation = { case_id: 'case_1', args: ['1', '1'], result: "(10000.0, '肥胖')", result_type: 'tuple',
        input_before: input, input_after: input, inputs_mutated: false, status: 'returned', duration_ms: 1,
        source: { kind: 'source_guided' }, call_assertable: true, result_assertable: true,
        result_snapshot: { schema_version: 'trace-value-v1', replayable: true, value: { type: 'tuple',
            items: [scalar('float', '10000.0'), scalar('str', '肥胖')] } } };
    // The historical pure-call observation is replayed as AST evidence only.
    const observed = { schema_version: 'behavior-observations-v2', func_name: 'calculate_bmi', args: ['weight_kg', 'height_cm'],
        isolation: 'fresh-process-per-case', run_id: 'saved-trace-worker',
        examples: [observation], errors: [], cases: [observation], complete: true, load_error: null, blocked_operations: [] };
    const actual = await buildReviewFacts({ ...identity, module: 'bmi', target: 'calculate_bmi', code: bmi,
        executionVerified: true, python, env: process.env,
        observations: { ...identity, target: 'calculate_bmi', value: observed as BehaviorObservations } });
    assert.deepEqual(actual.methods[0].assertions.map(item => item.observationVerified), [true, true]);
});

const savedClockClaims = [
    finding('L1', 'setup-error', 'Import unittest.mock.patch is not used in the test case.', "Add patch('database.datetime') as clock_stub to the test case."),
    finding('L4', 'target-binding', 'The target binding is not correct.', "Change the target binding to 'database._now_text'."),
    finding('L10', 'assertion-evidence', 'The assertion is not correct.', "Change the assertion to self.assertEqual(_now_text(), '2026-10-14 15:42:47')."),
    finding('L8', 'mock-isolation', 'The mock is not isolated.', 'Add a new mock for the datetime.now() method.')
];

test('saved clock claims are checked against complete candidate AST syntax, not a model/target whitelist', async () => {
    const actual = await facts(clock, 'database', '_now_text');
    assert.deepEqual(actual.methods[0].standardAssertions, [{ line: 10, kind: 'assertEqual' }]);
    assert.deepEqual(actual.methods[0].assertions, [{ line: 10, kind: 'assertEqual', observationStatus: 'unknown' }],
        'patched clock syntax remains unknown and cannot become a return oracle');
    const expected = ['non-actionable-action', 'target-binding-contradiction', 'non-actionable-action', 'non-actionable-reason'];
    savedClockClaims.forEach((claim, index) => {
        const result = parseTestReviewDetailed(envelope(claim), clock, true, constraints(actual));
        assert.equal(result.review, undefined);
        assert.deepEqual(result.diagnostics, [expected[index]]);
    });
    const renamed = clock.replaceAll('test_now_text', 'test_value').replaceAll('database', 'other_module')
        .replaceAll('_now_text', 'render_label').replaceAll('clock_stub', 'dependency');
    const renamedFacts = await facts(renamed, 'other_module', 'render_label');
    const unchanged = finding('L10', 'assertion-evidence', 'The assertion is not correct.',
        "Update the assertion to self.assertEqual(render_label(), '2026-10-14 15:42:47').");
    assert.deepEqual(parseTestReviewDetailed(envelope(unchanged), renamed, true, constraints(renamedFacts)).diagnostics, ['non-actionable-action']);
});

test('changed literals, explicit patch configuration and different scenarios remain reviewable', async () => {
    const actual = await facts(clock, 'database', '_now_text');
    for (const claim of [
        finding('L10', 'assertion-quality', 'The documented business contract requires UTC text rather than the local timestamp.',
            "Change the assertion to self.assertEqual(_now_text(), '2026-10-14T15:42:47Z')."),
        finding('L8', 'mock-isolation', 'The dependency setup must model a clock error for the additional scenario.',
            "Add patch('database.datetime', spec=True) as clock_stub to the test case."),
        finding('L10', 'missing-scenario', 'No test covers a clock with a different date.', 'Add another case with a distinct controlled datetime value.')
    ]) { assert.equal(parseTestReviewDetailed(envelope(claim), clock, true, constraints(actual)).review?.issues.length, 1); }
});

test('complete spelling comparison preserves whitespace inside quoted and triple-quoted expected data', async () => {
    const code = clock.replace("'2026-10-14 15:42:47'", "\"\"\"first  line\nsecond  line\"\"\"");
    const actual = await facts(code, 'database', '_now_text');
    const unchanged = finding('L10', 'assertion-quality', 'The assertion is not correct.',
        'Change the assertion to self.assertEqual(_now_text(), """first  line\nsecond  line""").');
    assert.equal(parseTestReviewDetailed(envelope(unchanged), code, true, constraints(actual)).review, undefined);
    const changed = finding('L10', 'assertion-quality', 'The supplied business contract specifies a single space in each line.',
        'Change the assertion to self.assertEqual(_now_text(), """first line\nsecond line""").');
    assert.equal(parseTestReviewDetailed(envelope(changed), code, true, constraints(actual)).review?.issues.length, 1);
});

test('a patch in another method does not refute a missing patch claim for this method', async () => {
    const code = clock.replace("if __name__ == '__main__':\n    unittest.main()", '')
        + '    def test_other(self):\n        self.assertTrue(True)\n';
    const actual = await facts(code, 'database', '_now_text');
    const line = code.split('\n').findIndex(text => text.includes('self.assertTrue')) + 1;
    const claim = finding(`L${line}`, 'setup-error', 'The test_other dependency has no clock patch for its required error scenario.',
        "Add patch('database.datetime') as clock_stub to the test case.");
    assert.equal(parseTestReviewDetailed(envelope(claim), code, true, constraints(actual)).review?.issues.length, 1);
});

test('bounded contract repair keeps valid missing-scenario findings and never strips them into approval', async () => {
    const actual = await facts(clock, 'database', '_now_text');
    const replies = [envelope(...savedClockClaims), envelope(finding('L10', 'missing-scenario',
        'No test covers a clock with a different date.', 'Add another case with a distinct controlled datetime value.'))];
    const events: string[] = [];
    const result = await reviewWithContractRepair({ tests: clock, prompt: 'TEST_FILE and complete evidence',
        constraints: constraints(actual), deadlineAt: 1000, now: () => 10, checkCancelled: () => {},
        event: status => events.push(status), request: async prompt => {
            if (replies.length === 1) { assert.match(prompt, /proposal identical to the AST-owned/); }
            return replies.shift()!;
        } });
    assert.equal(result?.issues.length, 1);
    assert.equal(result?.issues[0].category, 'missing-scenario');
    assert.deepEqual(events, ['invalid-response', 'repair-requested', 'parsed']);
});

test('persistent generic assessments receive only one repair and stay unavailable', async () => {
    let calls = 0;
    const result = await reviewWithContractRepair({ tests: bmi, prompt: 'complete evidence', deadlineAt: 1000, now: () => 10,
        checkCancelled: () => {}, event: () => {}, request: async () => { calls++; return envelope(finding('L9', 'assertion-quality', echoedRule, echoedAction)); } });
    assert.equal(calls, 2);
    assert.equal(result, undefined);
});
