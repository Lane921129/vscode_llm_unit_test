import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildReviewFacts, ReviewFacts } from '../roles/reviewFacts';
import { parseTestReviewDetailed, ReviewConstraints } from '../roles/testReviewer';
import { reviewWithContractRepair } from '../roles/reviewContractRepair';
import { NumericEvidenceLedger } from '../pipeline/numericEvidenceLedger';
import { scalarProbeInput, typedCallFields } from '../pipeline/probeInputs';
import { BehaviorObservations, TraceValueSnapshot } from '../pipeline/evidenceContracts';

const identity = { runId: 'review-facts-test', sourceHash: 'a'.repeat(64), target: 'score' };
const code = 'import unittest\nfrom sample import score\nclass Cases(unittest.TestCase):\n'
    + '    def test_value(self):\n        value = 100\n        expected = 30.86\n'
    + '        number, label = score(value, 180)\n        self.assertEqual(number, expected)\n'
    + '        self.assertEqual(label, "high")\n'
    + '    def test_zero(self):\n        with self.assertRaises(ZeroDivisionError):\n            score(1, 0)\n';
const result: TraceValueSnapshot = { schema_version: 'trace-value-v1', replayable: true,
    value: { type: 'tuple', items: [{ type: 'float', value: '30.86' }, { type: 'str', value: 'high' }] } };
const ledger = new NumericEvidenceLedger(identity);
ledger.add('VERIFIED NUMERIC OBSERVATIONS (evidence only; the AI must revise the test):\n' + JSON.stringify({
    schemaVersion: 'numeric-observation-handoff-v1', ...identity, testHash: 'b'.repeat(64),
    corrections: [{ method: 'test_value', line: 8, basis: { call: scalarProbeInput({ args: [100, 180], kwargs: {} }).input, result_snapshot: result } }]
}));
let cached: Promise<ReviewFacts> | undefined;
const facts = () => cached ||= buildReviewFacts({ ...identity, code, module: 'sample',
    python: path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    env: process.env, executionVerified: true, numericEvidencePrompt: ledger.prompt(10000) });
const constraints = (value: ReviewFacts): ReviewConstraints => ({ target: identity.target, methodKind: 'module', module: 'sample', identity, facts: value });
const response = (line: number, category: string, reason: string, action: string) => JSON.stringify({ findings: [{ category,
    test_line: `L${line}`, reason, action }] });

test('AST and exact observation facts reject the actual hallucination shapes without changing code', async () => {
    const current = await facts();
    assert.equal(current.methods[0].assertions[0].observationVerified, true);
    const cases: Array<[number, string, string, string, string]> = [
        [3, 'target-binding', 'The target is bound to the class, but it should be bound to the module.', 'Change target binding to module.', 'target-binding-contradiction'],
        [8, 'assertion-quality', 'Expected number should be 30.857, not 30.86.', 'Change the expected value to 30.857.', 'observed-outcome-contradiction'],
        [9, 'assertion-quality', 'The expected classification should be low.', 'Change the expected label to "low".', 'observed-outcome-contradiction'],
        [9, 'assertion-quality', 'A specific string is too strict.', 'Use self.assertGreaterEqual() or self.assertIn() instead.', 'assertion-weakening'],
        [8, 'assertion-evidence', 'The value is not directly asserted in the test.', 'Add an assertion for the expected value.', 'existing-assertion-contradiction'],
        [12, 'assertion-evidence', 'assertRaises should be used to assert an exception.', 'Replace assertRaises with assertRaisesRegex.', 'expected-exception-contradiction'],
        [10, 'setup-error', 'The input will cause a division by zero error.', 'Use valid values instead.', 'expected-exception-contradiction'],
        [5, 'mock-isolation', 'The dependent input should be mocked.', 'Mock the value object.', 'scalar-mock-contradiction'],
        [1, 'setup-error', 'import unittest should be the first statement in the test file.', 'Move import unittest to the first line.', 'existing-import-contradiction'],
        [2, 'target-binding', 'Target binding should be module.', 'Change target binding to module.', 'target-binding-contradiction']
    ];
    for (const [line, category, reason, action, rejection] of cases) {
        const parsed = parseTestReviewDetailed(response(line, category, reason, action), code, true, constraints(current));
        assert.equal(parsed.review, undefined, reason);
        assert.ok(parsed.diagnostics.includes(rejection as any), `${reason}: ${parsed.diagnostics}`);
    }
});

test('genuine gaps, stronger assertions and unknown result claims remain reviewable', async () => {
    const current = await facts();
    for (const [line, category, reason, action] of [
        [8, 'missing-scenario', 'A measured branch still has no scenario.', 'Add a new input for the measured branch.'],
        [9, 'assertion-quality', 'The test lacks the neighboring category boundary.', 'Add the boundary input and verify its observed label.'],
        [12, 'assertion-quality', 'Only the exception type is checked; the supplied contract requires its message.', 'Add assertRaisesRegex for the documented message.'],
        [5, 'mock-isolation', 'The external dependency clock is uncontrolled.', 'Patch sample.clock at its use point.']
    ] as const) {
        assert.ok(parseTestReviewDetailed(response(line, category, reason, action), code, true, constraints(current)).review, reason);
    }
    for (const [line, category, reason, action] of [
        [3, 'target-binding', 'The class fixture imports a different target from the selected one.', 'Use the selected target in this fixture.'],
        [8, 'assertion-evidence', 'The documented requirement specifies 31 even though current implementation returns 30.86.', 'Change the expected value to 31.'],
        [8, 'missing-scenario', 'The other input path has no test.', 'Add a different input and update its expected value to 12.']
    ] as const) {
        assert.ok(parseTestReviewDetailed(response(line, category, reason, action), code, true, constraints(current)).review, reason);
    }
    const unknown = structuredClone(current);
    unknown.methods[0].assertions[0].observationVerified = undefined;
    assert.ok(parseTestReviewDetailed(response(8, 'assertion-evidence', 'The expected value has no controlled observation.',
        'Replace the expected value with a verified observation.'), code, true, constraints(unknown)).review);
});

test('same-source/run/target and exact test hash are mandatory even for an empty approval', async () => {
    const original = await facts();
    for (const changed of [{ runId: 'other' }, { sourceHash: 'c'.repeat(64) }, { target: 'other' }, { testHash: 'd'.repeat(64) }]) {
        const parsed = parseTestReviewDetailed('{"findings":[]}', code, true, constraints({ ...original, ...changed }));
        assert.deepEqual(parsed.diagnostics, ['review-facts-identity-mismatch']);
    }
    const parsed = parseTestReviewDetailed('{"findings":[]}', code + '# changed\n', true, constraints(original));
    assert.equal(parsed.review, undefined);
});

test('a contradicted review gets one bounded reassessment and cannot silently approve', async () => {
    const current = await facts();
    const bad = response(8, 'assertion-quality', 'Expected number should be different.', 'Change the expected value to 50.');
    let calls = 0;
    const prompts: string[] = [];
    const assessed = await reviewWithContractRepair({ tests: code, prompt: 'same complete facts', constraints: constraints(current),
        deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: () => {},
        request: async prompt => { calls++; prompts.push(prompt); return bad; } });
    assert.equal(assessed, undefined);
    assert.equal(calls, 2);
    assert.match(prompts[1], /observed-outcome-contradiction/);
    assert.match(prompts[1], /guessed calculations/);
    const ambiguous = parseTestReviewDetailed(bad + '\n{"findings":[]}', code, true, constraints(current));
    assert.deepEqual(ambiguous.diagnostics, ['invalid-envelope'], 'a second empty object cannot erase rejected findings');
    calls = 0;
    const corrected = await reviewWithContractRepair({ tests: code, prompt: 'same complete facts', constraints: constraints(current),
        deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: () => {},
        request: async () => ++calls === 1 ? bad : '{"findings":[]}' });
    assert.deepEqual(corrected, { issues: [] });
    assert.equal(calls, 2);
});

test('wrong numeric evidence identity and credentials are rejected before the AST tool', async () => {
    const options = { ...identity, code, module: 'sample', python: 'must-not-run', env: process.env, executionVerified: true };
    await assert.rejects(buildReviewFacts({ ...options, numericEvidencePrompt: ledger.prompt(10000).replace(identity.runId, 'other') }), /bound to this candidate/);
    await assert.rejects(buildReviewFacts({ ...options, code: code + '\n# confidential-test-value', knownSecrets: ['confidential-test-value'] }), /bound to this candidate/);
});

test('only completed same-identity assertable Trace outcomes protect an expected value', async () => {
    const call = scalarProbeInput({ args: [100, 180], kwargs: {} }).input;
    const fields = typedCallFields(call)!;
    const input = { replayable: true, args: { schema_version: 'trace-value-v1' as const, replayable: true, value: fields.args },
        kwargs: { schema_version: 'trace-value-v1' as const, replayable: true, value: fields.kwargs },
        constructor_args: { schema_version: 'trace-value-v1' as const, replayable: true, value: { type: 'list', items: [] } },
        constructor_kwargs: { schema_version: 'trace-value-v1' as const, replayable: true, value: { type: 'dict', items: [] } },
        call_graph: {} as TraceValueSnapshot };
    input.call_graph = { schema_version: 'trace-value-v1', replayable: true, value: { type: 'dict',
        items: (['args', 'kwargs', 'constructor_args', 'constructor_kwargs'] as const).map(key => ({ key: { type: 'str', value: key }, value: input[key].value })) } };
    const trace: BehaviorObservations = { schema_version: 'behavior-observations-v2', run_id: 'trace-worker', func_name: 'score',
        args: ['value', 'height'], complete: true, isolation: 'fresh-process-per-case', load_error: null, errors: [],
        examples: [{ case_id: 'c1', args: ['100', '180'], result: '(30.86, "high")', call_assertable: true, result_assertable: true }],
        cases: [{ case_id: 'c1', source: { kind: 'caller_literals' }, status: 'returned', duration_ms: 1,
            input_before: input, input_after: structuredClone(input), result_snapshot: result } as any] };
    const options = { ...identity, code, module: 'sample', executionVerified: true,
        python: path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), env: process.env };
    const actual = await buildReviewFacts({ ...options, observations: { ...identity, value: trace } });
    assert.equal(actual.methods[0].assertions[0].observationVerified, true);
    for (const change of [(value: BehaviorObservations) => { value.complete = false; },
        (value: BehaviorObservations) => { value.examples[0].result_assertable = false; },
        (value: BehaviorObservations) => { value.cases![0].inputs_mutated = true; },
        (value: BehaviorObservations) => { value.examples[0].oracle_reason = 'uncontrolled-ambient-read'; }]) {
        const invalid = structuredClone(trace); change(invalid);
        const rejected = await buildReviewFacts({ ...options, observations: { ...identity, value: invalid } });
        assert.equal(rejected.methods[0].assertions[0].observationVerified, undefined);
    }
    await assert.rejects(buildReviewFacts({ ...options, observations: { ...identity, sourceHash: 'f'.repeat(64), value: trace } }), /bound to this candidate/);
});

const mechanicalCode = 'import unittest\nfrom unittest.mock import patch\nfrom sample import score\n'
    + 'class Cases(unittest.TestCase):\n    @patch("sample.channel")\n    def test_value(self, channel):\n'
    + '        worker = channel.return_value\n        score("item", 2)\n'
    + '        channel.assert_called_once()\n        worker.send.assert_called_once_with("item")\n';
const mechanicalFacts = (tests = mechanicalCode, executionVerified = true) => buildReviewFacts({ ...identity,
    code: tests, module: 'sample', executionVerified, env: process.env,
    python: path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') });

test('executed bindings and interactions contradict unbound and already-present claims without approving the review', async () => {
    const current = await mechanicalFacts();
    const bound = { ...constraints(current), dependencyUsePoints: ['sample.channel'] };
    for (const [line, category, reason, action, diagnostic] of [
        [1, 'setup-error', "Unbound import 'unittest'", "Add 'import unittest'", 'existing-import-contradiction'],
        [3, 'target-binding', "Unbound name 'score'", "Add 'from sample import score'", 'target-binding-contradiction'],
        [9, 'missing-scenario', "Missing assertion on mock 'channel'", "Add 'channel.assert_called_once()'", 'existing-assertion-contradiction'],
        [10, 'missing-scenario', "Missing assertion on mock 'worker.send'", "Add 'worker.send.assert_called_once_with(\"item\")'", 'existing-assertion-contradiction'],
    ] as const) {
        const parsed = parseTestReviewDetailed(response(line, category, reason, action), mechanicalCode, true, bound);
        assert.equal(parsed.review, undefined, reason);
        assert.deepEqual(parsed.diagnostics, [diagnostic]);
        assert.ok(parseTestReviewDetailed(response(line, category, reason, action), mechanicalCode, true,
            { ...bound, facts: { ...current, executionVerified: false } }).review);
    }
    for (const reason of ["Unbound name 'score' in the new callback scope", "Unbound name 'other'", "Unbound name 'score' because the setup reassigns it"]) {
        assert.ok(parseTestReviewDetailed(response(3, 'target-binding', reason, 'Check the binding inside that scope.'), mechanicalCode, true, bound).review);
    }
    const malformed = response(1, 'setup-error', "Unbound import 'unittest'", "Add 'import unittest'");
    let calls = 0;
    assert.equal(await reviewWithContractRepair({ tests: mechanicalCode, prompt: 'same candidate', constraints: bound,
        deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: () => {},
        request: async () => { calls++; return malformed; } }), undefined);
    assert.equal(calls, 2);
});

test('replacing a proven assertion with itself is not an actionable revision', async () => {
    const current = await facts();
    const excerpt = code.split('\n')[7].trim();
    const unchanged = response(8, 'assertion-quality', 'Weak equality assertion on numbers', `Replace with '${excerpt}'`);
    assert.deepEqual(parseTestReviewDetailed(unchanged, code, true, constraints(current)).diagnostics, ['non-actionable-action']);
    const additional = response(8, 'missing-scenario', 'An additional boundary needs the same comparison.', `Add '${excerpt}' in a new boundary test.`);
    assert.ok(parseTestReviewDetailed(additional, code, true, constraints(current)).review);
});

test('executed import and AST identifiers contradict complete installation claims, never unknown semantic claims', async () => {
    const current = await mechanicalFacts();
    for (const [line, category, reason, action, diagnostic] of [
        [1, 'setup-error', "The import statement at line L1 is not valid. The module 'unittest' is not available in the current Python environment.", 'Install unittest using pip.', 'existing-import-contradiction'],
        [3, 'setup-error', "The import statement at line L3 is not valid. The module 'sample' is not available in the current Python environment.", 'Install sample using pip.', 'existing-import-contradiction'],
        [4, 'setup-error', "The class definition at line L4 is not valid. The class name 'Cases' is not valid.", 'Change the class name to a valid Python identifier.', 'existing-definition-contradiction'],
        [1, 'setup-error', 'Import of unittest is unnecessary', 'Remove unused import statement.', 'existing-import-contradiction'],
        [3, 'target-binding', 'The target binding is incorrect.', 'Change the target binding to the correct type.', 'target-binding-contradiction'],
        [3, 'target-binding', 'Target module is not properly bound', 'Bind target module as sample.', 'target-binding-contradiction'],
        [3, 'target-binding', 'The target function `score` is not bound to a module.', 'Change the import to a wildcard import.', 'target-binding-contradiction'],
    ] as const) {
        const parsed = parseTestReviewDetailed(response(line, category, reason, action), mechanicalCode, true, constraints(current));
        assert.equal(parsed.review, undefined, reason);
        assert.deepEqual(parsed.diagnostics, [diagnostic], reason);
        assert.ok(parseTestReviewDetailed(response(line, category, reason, action), mechanicalCode, true,
            constraints({ ...current, executionVerified: false })).review, 'no execution fact means no installation contradiction');
    }
    for (const reason of [
        "The module 'other' is not available in the current Python environment.",
        "The module 'Unittest' is not available in the current Python environment.",
        "The module 'unittest' is not available in the current Python environment because the fixture replaces sys.modules.",
        'Import of unittest is unnecessary in this separate helper scope.',
    ]) {
        assert.ok(parseTestReviewDetailed(response(1, 'setup-error', reason, 'Check the supplied dependency contract.'), mechanicalCode, true, constraints(current)).review);
    }
    const targetUse = code;
    const targetFacts = await mechanicalFacts(targetUse);
    assert.deepEqual(parseTestReviewDetailed(response(2, 'target-binding', 'Unnecessary from-module import',
        'Remove unnecessary import statement.'), targetUse, true, constraints(targetFacts)).diagnostics, ['target-binding-contradiction']);
    const unused = code.replace('number, label = score(value, 180)', 'number, label = (30.86, "high")').replace('score(1, 0)', 'int("invalid")');
    assert.ok(parseTestReviewDetailed(response(2, 'target-binding', 'Unnecessary from-module import',
        'Remove unnecessary import statement.'), unused, true, constraints(await mechanicalFacts(unused))).review);
});

test('wildcard syntax is not an export oracle and contradicting findings still require a fresh bounded review', async () => {
    const tests = code.replace('from sample import score', 'from sample import *');
    const current = await mechanicalFacts(tests);
    const bad = response(2, 'setup-error', "The module 'sample' is not available in the current Python environment.", 'Install the sample module.');
    assert.deepEqual(parseTestReviewDetailed(bad, tests, true, constraints(current)).diagnostics, ['existing-import-contradiction']);
    assert.ok(parseTestReviewDetailed(response(2, 'target-binding', 'The wildcard may export a different target binding.',
        'Use the explicit selected function import.'), tests, true, constraints(current)).review);
    let calls = 0;
    assert.equal(await reviewWithContractRepair({ tests, prompt: 'same exact tests and evidence', constraints: constraints(current),
        deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: () => {}, request: async () => { calls++; return bad; } }), undefined);
    assert.equal(calls, 2, 'a repeated contradiction cannot become an approval');
});

test('passed exact imports reject only unsupported mechanical import and binding claims', async () => {
    const current = await mechanicalFacts();
    const examples = [
        [1, 'setup-error', 'The test harness is not imported correctly.', 'Import unittest correctly.', 'existing-import-contradiction'],
        [1, 'setup-error', 'unittest is imported incorrectly.', 'Correct the unittest import.', 'existing-import-contradiction'],
        [1, 'setup-error', 'unittest is not imported correctly.', 'Correct the unittest import.', 'existing-import-contradiction'],
        [3, 'target-binding', 'The target is not bound correctly.', 'Bind the target correctly.', 'target-binding-contradiction']
    ] as const;
    for (const [line, category, reason, action, diagnostic] of examples) {
        const parsed = parseTestReviewDetailed(response(line, category, reason, action), mechanicalCode, true, constraints(current));
        assert.equal(parsed.review, undefined);
        assert.deepEqual(parsed.diagnostics, [diagnostic]);
        assert.ok(parseTestReviewDetailed(response(line, category, reason, action), mechanicalCode, true,
            constraints({ ...current, executionVerified: false })).review, 'unverified execution remains actionable');
    }
    for (const [line, category, reason, action] of [
        [1, 'setup-error', 'The test harness is not imported correctly because the project shadows the standard library.', 'Resolve the documented shadowing before executing.'],
        [1, 'setup-error', 'unittest is not imported correctly because the project shadows the standard library.', 'Resolve the documented shadowing before executing.'],
        [1, 'setup-error', 'The dependency helper is not imported correctly.', 'Use the helper import specified by the source.'],
        [3, 'target-binding', 'The target is not bound correctly because this alias is reassigned by the fixture.', 'Remove the fixture reassignment.'],
        [3, 'target-binding', 'The separate callback calls another function.', 'Call the selected target from the callback.']
    ] as const) {
        assert.ok(parseTestReviewDetailed(response(line, category, reason, action), mechanicalCode, true, constraints(current)).review);
    }
    const unrelated = mechanicalCode.replace('from sample import score', 'from other_sample import score');
    assert.ok(parseTestReviewDetailed(response(3, 'target-binding', 'The target is not bound correctly.',
        'Bind the target correctly.'), unrelated, true, constraints(await mechanicalFacts(unrelated))).review);
    const rebound = mechanicalCode.replace('class Cases', 'score = other\nclass Cases');
    assert.ok(parseTestReviewDetailed(response(3, 'target-binding', 'The target is not bound correctly.',
        'Bind the target correctly.'), rebound, true, constraints(await mechanicalFacts(rebound))).review);
    const aliased = mechanicalCode.replace('import unittest', 'import unittest as ut').replace('unittest.TestCase', 'ut.TestCase')
        .replace('from sample import score', 'import sample as subject').replace('        score(', '        subject.score(');
    const aliasedFacts = await mechanicalFacts(aliased);
    assert.deepEqual(parseTestReviewDetailed(response(1, 'setup-error', 'ut is not imported correctly.', 'Import the harness correctly.'),
        aliased, true, constraints(aliasedFacts)).diagnostics, ['existing-import-contradiction']);
    assert.deepEqual(parseTestReviewDetailed(response(3, 'target-binding', 'The target is not bound correctly.', 'Bind the target correctly.'),
        aliased, true, constraints(aliasedFacts)).diagnostics, ['target-binding-contradiction']);
});

test('proven dependency call assertions reject replacement-only return judgments, preserving unknown quality findings', async () => {
    const current = await mechanicalFacts();
    const bound = { ...constraints(current), dependencyUsePoints: ['sample.channel'] };
    const bad = response(9, 'assertion-quality', 'Assertion for function call, not return value', 'Change assertion to check return value');
    assert.deepEqual(parseTestReviewDetailed(bad, mechanicalCode, true, bound).diagnostics, ['assertion-weakening']);
    const child = response(10, 'assertion-quality', 'The assertion checks a call rather than the return value.',
        'Replace the assertion with an assertion for the return value.');
    assert.deepEqual(parseTestReviewDetailed(child, mechanicalCode, true, bound).diagnostics, ['assertion-weakening']);
    assert.ok(parseTestReviewDetailed(bad, mechanicalCode, true, constraints(current)).review, 'unknown dependency remains actionable');
    assert.ok(parseTestReviewDetailed(bad, mechanicalCode, true, { ...bound, dependencyUsePoints: ['sample.other'] }).review);
    assert.ok(parseTestReviewDetailed(bad, mechanicalCode, true, { ...bound, facts: { ...current, executionVerified: false } }).review);
    for (const [reason, action] of [
        ['The documented contract requires a return status as well as the interaction.', 'Add an assertion for the documented return status.'],
        ['Assertion for function call, not return value', 'Add an assertion for the observed return value.'],
        ['The call assertion does not verify the dependency arguments.', 'Strengthen it with assert_called_once_with for the supplied arguments.'],
        ['The current call assertion uses the wrong arguments.', 'Correct the arguments to match the supplied requirement.'],
        ['Another branch has no interaction assertion.', 'Add a separate scenario for the uncovered branch.']
    ]) {
        assert.ok(parseTestReviewDetailed(response(9, 'assertion-quality', reason, action), mechanicalCode, true, bound).review, reason);
    }
    const fake = mechanicalCode.replace('@patch("sample.channel")', '@unknown("sample.channel")');
    assert.ok(parseTestReviewDetailed(bad, fake, true, { ...constraints(await mechanicalFacts(fake)), dependencyUsePoints: ['sample.channel'] }).review);
});

test('new mechanical contradictions use the existing bounded reassessment and never erase valid findings', async () => {
    const current = await mechanicalFacts();
    const bad = JSON.stringify({ findings: [
        { category: 'setup-error', test_line: 'L1', reason: 'The test harness is not imported correctly.', action: 'Import unittest correctly.' },
        { category: 'missing-scenario', test_line: 'L8', reason: 'A measured branch has no scenario.', action: 'Add a case for the measured branch.' }
    ] });
    let requests = 0;
    const result = await reviewWithContractRepair({ tests: mechanicalCode, prompt: 'complete same-candidate evidence',
        constraints: constraints(current), deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: () => {},
        request: async prompt => { requests++; if (requests === 2) { assert.match(prompt, /existing-import-contradiction/); } return bad; } });
    assert.equal(result, undefined);
    assert.equal(requests, 2, 'repeated contradiction cannot become approval or extend the budget');
    requests = 0;
    const valid = response(8, 'missing-scenario', 'A measured branch has no scenario.', 'Add a case for the measured branch.');
    const reassessed = await reviewWithContractRepair({ tests: mechanicalCode, prompt: 'complete same-candidate evidence',
        constraints: constraints(current), deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: () => {},
        request: async () => ++requests === 1 ? bad : valid });
    assert.equal(reassessed?.issues.length, 1, 'only the Reviewer can revise its findings');
    assert.equal(reassessed?.issues[0].category, 'missing-scenario');
});
