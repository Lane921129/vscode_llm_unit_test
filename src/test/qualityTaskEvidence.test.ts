import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { bindQualityTaskObservations, qualityFocusInputDiagnostic, qualityInputAlreadyTested,
    qualityFocusCasesForPrompt, qualityTasksForWriter, QualityTaskEvidence, resolveQualityTaskTraceCaseIds } from '../pipeline/qualityTaskEvidence';
import { BehaviorObservations } from '../pipeline/evidenceContracts';
import { mergeBehaviorObservations, parseBehaviorObservations } from '../pipeline/behaviorObservations';
import { evidenceHash } from '../pipeline/analysisJournal';
import { callerMatchesObservation, callerToProbeInput, ProbeInputCase, scalarProbeInput, traceValuePythonLiteral } from '../pipeline/probeInputs';
import { buildCompactWriterContext, selectWriterScenario } from '../prompts/compactWriterContext';
import { QualityAnalystSession, QualityFocus, parseFocusedQualityTask, requestFocusedQualityTask } from '../roles/qualityAnalyst';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';
import { runSpawn } from '../utils/processRunner';
import { buildReviewFacts } from '../roles/reviewFacts';

const source = 'def categorize(amount, scale):\n    value = round(amount / (scale / 10) ** 2, 2)\n'
    + '    if value < 7.5:\n        return value, "low"\n    return value, "middle"\n';
const target = 'categorize';
const focus: QualityFocus = { id: 'E0123456789abcdef', kind: 'survivor', evidence: '3:7 compare mutation from Lt to Eq' };
const inputs = [{ args: [7.49, 10], kwargs: {} }, { args: [7.5, 10], kwargs: {} }, { args: [7.51, 10], kwargs: {} }];
const zero = { args: [1, 0], kwargs: {} };
const identity = { runId: 'quality-task-evidence-test', sourceHash: evidenceHash(source), target, focus };
async function traceObservedCalls(cases: ProbeInputCase[], sourceCode = source, targetName = target): Promise<BehaviorObservations> {
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, 'quality-task-evidence-'));
    const file = path.join(root, 'sample.py');
    try {
        fs.writeFileSync(file, sourceCode, 'utf8');
        const sourceHash = evidenceHash(sourceCode);
        assert.equal(evidenceHash(fs.readFileSync(file, 'utf8')), sourceHash);
        const result = await runSpawn(resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')),
            ['-B', pythonToolPath('trace'), file, targetName, '-', JSON.stringify({
                case_timeout_seconds: 10, total_timeout_seconds: 45, planning_timeout_seconds: 10 })], {
                input: JSON.stringify({ schema_version: 'probe-inputs-v1', cases }),
                timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            });
        assert.equal(result.code, 0, result.stderr);
        const parsed = parseBehaviorObservations(result.stdout, targetName);
        assert.equal(parsed.complete, true);
        assert.equal(parsed.load_error, null);
        assert.equal(evidenceHash(fs.readFileSync(file, 'utf8')), sourceHash, 'Trace must not mutate the source');
        return parsed;
    } finally {
        const actual = fs.realpathSync(root);
        assert.equal(path.dirname(actual), parent, 'recursive cleanup remains inside this newly owned temporary directory');
        assert.equal(actual, path.resolve(root));
        fs.rmSync(actual, { recursive: true, force: true });
    }
}
let fresh: Promise<BehaviorObservations> | undefined;
const observations = () => fresh ||= traceObservedCalls([...inputs, zero].map(input => scalarProbeInput(input))).then(parsed => {
    assert.deepEqual(parsed.cases!.slice(0, 4).map(item => item.status), ['returned', 'returned', 'returned', 'raised']);
    assert.equal(parsed.errors[0].exception, 'ZeroDivisionError');
    return parsed;
});
const bound = async (): Promise<QualityTaskEvidence> => {
    const result = bindQualityTaskObservations({ ...identity, proposedInputs: inputs,
        observations: { ...identity, value: await observations() } });
    assert.ok(result, 'fresh completed boundary calls must bind to the selected measured focus');
    return result;
};
const response = (evidence: QualityTaskEvidence, overrides: Record<string, unknown> = {}) => JSON.stringify({ tasks: [{
    evidence_id: focus.id, hypothesis: 'WRONG_MODEL_OUTPUT: height zero returns expected 0.',
    scenario: evidence.scenarioId, verification: 'verify-observed-behavior', ...overrides }] });

test('fresh isolated Python below/at/above returns bind only the exact requested focus input family', async () => {
    const current = await bound();
    assert.equal(current.schemaVersion, 'quality-task-evidence-v1');
    assert.equal(current.runId, identity.runId);
    assert.equal(current.sourceHash, identity.sourceHash);
    assert.equal(current.target, target);
    assert.equal(current.focusId, focus.id);
    assert.equal(current.scenarioId, `observations:${focus.id}`);
    assert.equal(current.cases.length, 3);
    assert.deepEqual(current.cases.map(item => item.args), [['7.49', '10'], ['7.5', '10'], ['7.51', '10']]);
    assert.deepEqual(current.cases.map(item => item.result.value.type), ['tuple', 'tuple', 'tuple']);
    assert.equal(new Set(current.cases.map(item => item.caseId)).size, 3);
});

test('a height-zero exception is an actual raised outcome, never an expected-zero return oracle', async () => {
    const actual = await observations();
    assert.equal(bindQualityTaskObservations({ ...identity, proposedInputs: [zero], observations: { ...identity, value: actual } }), undefined);
    assert.equal(bindQualityTaskObservations({ ...identity, proposedInputs: [...inputs, zero], observations: { ...identity, value: actual } }), undefined);
    assert.ok(actual.examples.length >= 3, 'source-guided extra cases may coexist without replacing requested inputs');
    assert.equal(actual.errors[0].exception, 'ZeroDivisionError');
});

test('colliding local IDs from two real Python runs resolve to the merged typed call and outcome, not the old case', async () => {
    const initial = await traceObservedCalls([scalarProbeInput({ args: [1, 10], kwargs: {} })]);
    const additional = structuredClone(await observations());
    // Only transport IDs are normalized to reproduce worker-local names. Every
    // input, return snapshot, execution status and assertion flag remains real.
    const localIds = (trace: BehaviorObservations) => {
        const names = new Map(trace.cases!.map((item, index) => [item.case_id, `local-${index}`]));
        for (const item of trace.cases!) { item.case_id = names.get(item.case_id)!; }
        for (const item of [...trace.examples, ...trace.errors]) { item.case_id = names.get(item.case_id!)!; }
        return parseBehaviorObservations(trace, target);
    };
    localIds(initial); localIds(additional);
    const current = bindQualityTaskObservations({ ...identity, proposedInputs: inputs,
        observations: { ...identity, value: additional } });
    assert.ok(current);
    const oneCase = { ...current, cases: [current.cases[0]] };
    const merged = mergeBehaviorObservations(initial, additional);
    const oldSelection = selectWriterScenario(merged, [oneCase.cases[0].caseId]);
    assert.deepEqual(oldSelection.observations!.examples.map(item => item.args), [['1', '10']],
        'original local-0 incorrectly refers to the old completed input after merge');
    const before = JSON.stringify(merged);
    const resolved = resolveQualityTaskTraceCaseIds({ identity, evidence: oneCase, observations: { ...identity, value: merged } });
    assert.equal(resolved.status, 'resolved');
    if (resolved.status !== 'resolved') { return; }
    assert.notEqual(resolved.caseIds[0], oneCase.cases[0].caseId);
    const prompt = buildCompactWriterContext({ module: 'sample', name: target, source,
        context: { code: source, args: ['amount', 'scale'], class_name: null, method_kind: 'module',
            is_async: false, traceResult: merged }, scenarioCaseIds: resolved.caseIds, budgetTokens: 12000,
        evidence: { schemaVersion: 'writer-evidence-v3', sourceHash: identity.sourceHash, semanticGuidance: '',
            ruleSelection: { schemaVersion: 'rule-selection-v2', selectedRules: [], ids: [], guidance: '',
                sourceHash: identity.sourceHash, dispatcherVersion: 'test-rule-dispatcher-v2', provenance: 'deterministic' },
            initialTargetObservations: initial, supplementalTargetObservations: additional,
            mergedTargetObservations: merged,
            evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance'] } });
    const visible = JSON.parse(prompt.match(/VERIFIED OBSERVATIONS[^\n]*\n([^\n]+)/)![1]);
    assert.deepEqual(visible.examples.map((item: any) => item.args), [['7.49', '10']]);
    assert.equal(visible.examples[0].result, oneCase.cases[0].observedResult);
    assert.deepEqual(visible.examples[0].case_ids, resolved.caseIds);
    const selectedCase = merged.cases!.find(item => item.case_id === resolved.caseIds[0])!;
    assert.ok(callerMatchesObservation({ trace_input: oneCase.cases[0].input.call_graph }, selectedCase.input_before));
    const finalFocus = JSON.parse(qualityFocusCasesForPrompt(oneCase).split('\n')[1]);
    assert.equal(finalFocus.cases[0].observedResult,
        traceValuePythonLiteral((selectedCase as any).result_snapshot.value));
    assert.equal(finalFocus.cases[0].targetCall, 'categorize(7.49, 10)');
    assert.equal(JSON.stringify(merged), before, 'resolution cannot rewrite Trace or its execution proof');
});

test('Trace resolution accepts identical complete repetitions but rejects conflicting outcomes and host identity drift', async () => {
    const actual = await observations(), current = await bound();
    const repeated = mergeBehaviorObservations(actual, actual);
    const good = resolveQualityTaskTraceCaseIds({ identity, evidence: current, observations: { ...identity, value: repeated } });
    assert.equal(good.status, 'resolved');
    if (good.status === 'resolved') { assert.equal(good.caseIds.length, inputs.length * 2); }
    for (const replacement of [{ sourceHash: 'b'.repeat(64) }, { runId: 'other-run' }, { target: 'another_target' }]) {
        for (const side of ['evidence', 'observations'] as const) {
            const invalid = { identity, evidence: current, observations: { ...identity, value: actual } };
            Object.assign(invalid[side] = { ...invalid[side] } as any, replacement);
            assert.deepEqual(resolveQualityTaskTraceCaseIds(invalid),
                { status: 'rejected', reasonCode: 'quality-case-projection-identity-mismatch' });
        }
    }
    const conflict = structuredClone(repeated);
    (conflict.cases![actual.cases!.length] as any).result_snapshot = structuredClone(current.cases[1].result);
    assert.equal(resolveQualityTaskTraceCaseIds({ identity, evidence: current, observations: { ...identity, value: conflict } }).status, 'rejected');
});

test('Trace resolution rejects unknown flags, mutation, missing input and differently typed actual returns', async () => {
    const actual = await observations(), current = await bound();
    for (const malformed of [{ ...current, cases: null }, { ...current, cases: [null] }]) {
        assert.deepEqual(resolveQualityTaskTraceCaseIds({ identity, evidence: malformed as any,
            observations: { ...identity, value: actual } }),
        { status: 'rejected', reasonCode: 'quality-case-projection-invalid-evidence' });
    }
    const changes: Array<(value: BehaviorObservations) => void> = [
        value => { value.complete = false; }, value => { value.blocked_operations = ['file-write']; },
        value => { (value as any).blocked_operations = null; }, value => { value.load_error = ''; },
        value => { value.cases![0].status = 'timeout'; value.examples.shift(); },
        value => { value.cases![0].inputs_mutated = true; },
        value => { (value.cases![0] as any).result_snapshot.value.items[0].type = 'int'; },
        value => { value.examples[0].oracle_reason = 'conflicting-observations'; },
        value => { value.examples[0].non_deterministic_operations = ['clock']; },
        value => { value.examples[0].args = ['0', '0']; },
        value => { value.examples[0].result = '(0, "low")'; }
    ];
    for (const change of changes) {
        const invalid = structuredClone(actual); change(invalid);
        assert.equal(resolveQualityTaskTraceCaseIds({ identity, evidence: current, observations: { ...identity, value: invalid } }).status, 'rejected');
    }
    for (const collection of ['cases', 'examples'] as const) {
        for (const flag of ['call_assertable', 'result_assertable', 'inputs_mutated']) {
            for (const malformed of [null, 'false', 0, 1]) {
                const invalid = structuredClone(actual); (invalid[collection]![0] as any)[flag] = malformed;
                assert.equal(resolveQualityTaskTraceCaseIds({ identity, evidence: current,
                    observations: { ...identity, value: invalid } }).status, 'rejected', `${collection}.${flag}=${String(malformed)}`);
            }
        }
    }
    const wrong = structuredClone(current);
    const other = await traceObservedCalls([scalarProbeInput({ args: [100, 10], kwargs: {} })]);
    wrong.cases[0].input = other.cases![0].input_before;
    assert.equal(resolveQualityTaskTraceCaseIds({ identity, evidence: wrong, observations: { ...identity, value: actual } }).status, 'rejected');
});

test('focus binding refuses malformed assertion and mutation flags while retaining valid boolean or omitted flags', async () => {
    const actual = await observations();
    for (const collection of ['cases', 'examples'] as const) {
        for (const flag of ['call_assertable', 'result_assertable', 'inputs_mutated']) {
            for (const malformed of [null, 'false', 0, 1]) {
                const invalid = structuredClone(actual);
                (invalid[collection]![0] as unknown as Record<string, unknown>)[flag] = malformed;
                assert.equal(bindQualityTaskObservations({ ...identity, proposedInputs: inputs,
                    observations: { ...identity, value: invalid } }), undefined, `${collection}.${flag}=${String(malformed)}`);
            }
        }
    }
    for (const omitted of [false, true]) {
        const valid = structuredClone(actual);
        for (const collection of ['cases', 'examples'] as const) {
            for (const item of valid[collection]!) {
                const flags = item as unknown as Record<string, unknown>;
                if (omitted) { delete flags.call_assertable; delete flags.result_assertable; delete flags.inputs_mutated; }
                else { flags.call_assertable = true; flags.result_assertable = true; flags.inputs_mutated = false; }
            }
        }
        assert.ok(bindQualityTaskObservations({ ...identity, proposedInputs: inputs,
            observations: { ...identity, value: valid } }), 'typed real calls retain accepted boolean flag compatibility');
    }
});

test('unobserved, differently typed or repeated proposed calls cannot borrow another case', async () => {
    const actual = await observations();
    for (const proposedInputs of [[], [{ args: [true, 10], kwargs: {} }], [{ args: [123456.78, 987], kwargs: {} }],
        [{ args: [7.5], kwargs: { scale: 10 } }], [inputs[0], inputs[0]], Array.from({ length: 13 }, () => inputs[0])]) {
        assert.equal(bindQualityTaskObservations({ ...identity, proposedInputs, observations: { ...identity, value: actual } }), undefined);
    }
});

test('incomplete, blocked, mutated, truncated and conflicting observation evidence is refused', async () => {
    const actual = await observations();
    const changes: Array<(value: BehaviorObservations) => void> = [
        value => { value.complete = false; },
        value => { value.load_error = 'guarded import unavailable'; },
        value => { value.blocked_operations = ['open']; },
        value => { value.cases![0].inputs_mutated = true; },
        value => { value.examples[0].inputs_mutated = true; },
        value => { value.examples[0].result_assertable = false; },
        value => { value.examples[0].call_assertable = false; },
        value => { value.examples[0].result_truncated = true; },
        value => { value.examples[0].oracle_reason = 'uncontrolled-ambient-read'; },
        value => { value.examples[0].non_deterministic_operations = ['clock']; },
        value => { delete (value.cases![0] as any).result_snapshot; },
        value => { value.func_name = 'another_target'; },
        value => { value.cases![0].input_after = structuredClone(value.cases![1].input_before); },
        value => { const item = structuredClone(value.cases![0]); item.case_id += '-duplicate'; value.cases!.push(item);
            const fact = structuredClone(value.examples[0]); fact.case_id = item.case_id; value.examples.push(fact); }
    ];
    for (const change of changes) {
        const invalid = structuredClone(actual); change(invalid);
        assert.equal(bindQualityTaskObservations({ ...identity, proposedInputs: inputs, observations: { ...identity, value: invalid } }), undefined);
    }
    for (const replacement of [{ sourceHash: 'bad' }, { runId: '' }, { focus: { ...focus, id: 'bad-focus' } }]) {
        assert.equal(bindQualityTaskObservations({ ...identity, ...replacement, proposedInputs: inputs, observations: { ...identity, value: actual } }), undefined);
    }
});

test('controlled outcomes from another host run, source hash or target cannot be rebound to this focus', async () => {
    const actual = await observations();
    for (const replacement of [{ sourceHash: 'b'.repeat(64) }, { runId: 'another-host-run' }, { target: 'another_target' }]) {
        assert.equal(bindQualityTaskObservations({ ...identity, proposedInputs: inputs,
            observations: { ...identity, ...replacement, value: actual } }), undefined);
    }
});

test('focus, scenario identifier and observed-behavior verification must match before a task can reach Writer', async () => {
    const current = await bound();
    const valid = parseFocusedQualityTask(response(current), focus, current, identity);
    assert.equal(valid.tasks?.length, 1);
    assert.equal(valid.tasks![0].boundObservations, current);
    for (const [override, diagnostic] of [
        [{ evidence_id: 'E1111111111111111' }, 'unknown-evidence-id'],
        [{ scenario: 'use height zero and expect 0' }, 'quality-observation-mismatch'],
        [{ scenario: current.scenarioId + '-other' }, 'quality-observation-mismatch'],
        [{ verification: 'expect zero return' }, 'quality-observation-mismatch'],
        [{ verification: 'verify-observed-behavior ' }, 'quality-observation-mismatch']
    ] as const) {
        const rejected = parseFocusedQualityTask(response(current, override), focus, current, identity);
        assert.equal(rejected.tasks, undefined);
        assert.deepEqual(rejected.diagnostics, [diagnostic]);
    }
    assert.deepEqual(parseFocusedQualityTask(response(current), focus,
        { ...current, focusId: 'E1111111111111111' }, identity).diagnostics, ['quality-evidence-identity-mismatch']);
    assert.deepEqual(parseFocusedQualityTask(response(current), focus, current).diagnostics, ['quality-evidence-identity-mismatch']);
    for (const replacement of [{ sourceHash: 'b'.repeat(64) }, { runId: 'another-host-run' }, { target: 'another_target' }]) {
        assert.deepEqual(parseFocusedQualityTask(response(current), focus, { ...current, ...replacement }, identity).diagnostics,
            ['quality-evidence-identity-mismatch']);
    }
});

test('Writer receives the bound actual outcomes and identity while model expected-zero prose stays a hypothesis', async () => {
    const current = await bound();
    const tasks = parseFocusedQualityTask(response(current), focus, current, identity).tasks!;
    assert.match(tasks[0].hypothesis, /expected 0/);
    const prompt = qualityTasksForWriter(tasks);
    assert.doesNotMatch(prompt, /WRONG_MODEL_OUTPUT|height zero|expected 0/);
    const [projected] = JSON.parse(prompt);
    assert.equal(projected.origin, 'controlled-focus-observations');
    assert.equal(projected.evidence, focus.evidence);
    assert.deepEqual(projected.binding, { sourceHash: identity.sourceHash, target, runId: identity.runId, focusId: focus.id });
    assert.deepEqual(projected.observations.map((item: any) => ({ caseId: item.caseId, args: item.args, kwargs: item.kwargs })),
        current.cases.map(({ caseId, args, kwargs }) => ({ caseId, args, kwargs })));
    assert.ok(projected.observations.every((item: any) => item.observedOutcome === 'returned'
        && typeof item.observedResult === 'string' && item.input === undefined && item.result === undefined),
    'Writer projection retains complete literal calls/results without copying typed input trees');
    assert.match(projected.observations[1].observedResult, /7\.5.*middle/);
    assert.match(projected.instruction, /not independent requirements/);
    const ungrounded = qualityTasksForWriter([{ evidence: focus.evidence, hypothesis: 'experiment only',
        scenario: 'unknown object setup', verification: 'observe before asserting' }]);
    assert.equal(JSON.parse(ungrounded)[0].assertionOracle, false, 'historical ungrounded tasks remain non-oracles');
    assert.deepEqual(parseFocusedQualityTask('{"tasks":[]}', focus, current, identity).tasks, [],
        'empty model tasks leave the already bound host evidence available for the independent fallback');
});

test('the final focus reminder renders every exact typed call and observed outcome without copying trees or generating asserts', async () => {
    const current = await bound();
    const before = JSON.stringify(current);
    const prompt = qualityFocusCasesForPrompt(current);
    const projected = JSON.parse(prompt.split('\n')[1]);
    assert.deepEqual(projected.cases.map((item: any) => item.args), [['7.49', '10'], ['7.5', '10'], ['7.51', '10']]);
    assert.ok(projected.cases.every((item: any) => Object.keys(item).sort().join(',') === 'args,caseId,kwargs,observedResult,targetCall'));
    assert.deepEqual(projected.cases.map((item: any) => item.targetCall),
        ['categorize(7.49, 10)', 'categorize(7.5, 10)', 'categorize(7.51, 10)']);
    assert.match(projected.cases[0].observedResult, /7\.49.*low/);
    assert.match(projected.cases[1].observedResult, /7\.5.*middle/);
    assert.match(projected.cases[2].observedResult, /7\.51.*middle/);
    assert.equal(projected.sourceHash, identity.sourceHash);
    assert.equal(projected.runId, identity.runId);
    assert.equal(projected.focusId, focus.id);
    assert.match(projected.instruction, /one NEW test method.*EVERY/);
    assert.match(projected.instruction, /multiple target calls/);
    assert.match(projected.instruction, /Arguments are Python literals.*copy each targetCall exactly.*no swapped/);
    assert.match(projected.instruction, /never copy the old tests/);
    assert.match(projected.instruction, /do not calculate or invent/);
    assert.doesNotMatch(prompt, /self\.assert|def test_|trace-value-v1|input_before|call_graph|result_snapshot/);
    assert.equal(JSON.stringify(current), before);
    const misleading = structuredClone(current);
    misleading.cases[0].args = ['0', '0']; misleading.cases[0].observedResult = 'WRONG_EXPECTED_ZERO';
    assert.equal(qualityFocusCasesForPrompt(misleading), prompt, 'display/hypothesis strings never override the complete typed facts');
    assert.equal(qualityFocusCasesForPrompt(undefined), '');
    for (const replacement of [{ sourceHash: 'bad' }, { focusId: 'another-focus' }, { scenarioId: 'other-scenario' }, { cases: [] }]) {
        assert.equal(qualityFocusCasesForPrompt({ ...current, ...replacement }), '');
    }
    const invalid = structuredClone(current); invalid.cases[0].result.replayable = false;
    assert.equal(qualityFocusCasesForPrompt(invalid), '');
});

test('copyable focus calls preserve observed floats and keyword insertion order as data only', async () => {
    const proposedInputs = [{ args: [7.49], kwargs: { scale: 10 } }, { args: [], kwargs: { scale: 10, amount: 7.5 } }];
    const trace = await traceObservedCalls(proposedInputs.map(input => scalarProbeInput(input)));
    const current = bindQualityTaskObservations({ ...identity, proposedInputs, observations: { ...identity, value: trace } });
    assert.ok(current);
    assert.equal(resolveQualityTaskTraceCaseIds({ identity, evidence: current, observations: { ...identity, value: trace } }).status, 'resolved');
    const differentlyOrdered = await traceObservedCalls([scalarProbeInput({ args: [], kwargs: { amount: 7.5, scale: 10 } })]);
    assert.deepEqual(resolveQualityTaskTraceCaseIds({ identity, evidence: { ...current, cases: [current.cases[1]] },
        observations: { ...identity, value: differentlyOrdered } }),
    { status: 'rejected', reasonCode: 'quality-case-projection-missing' }, 'keyword order is part of the exact typed input');
    const projected = JSON.parse(qualityFocusCasesForPrompt(current).split('\n')[1]);
    assert.deepEqual(projected.cases.map((item: any) => item.targetCall),
        ['categorize(7.49, scale=10)', 'categorize(scale=10, amount=7.5)']);
    assert.deepEqual(projected.cases[0].args, ['7.49']);
    assert.deepEqual(Object.keys(projected.cases[1].kwargs), ['scale', 'amount']);
    assert.equal(projected.runId, identity.runId); assert.equal(projected.sourceHash, identity.sourceHash);
    assert.doesNotMatch(JSON.stringify(projected), /def test_|self\.assert|call_graph|result_snapshot/);
    const candidate = await candidateFacts('import unittest\nfrom sample import categorize\nclass Cases(unittest.TestCase):\n'
        + '    def test_keywords(self):\n        self.assertEqual(categorize(7.49, scale=10), (7.49, "low"))\n'
        + '        self.assertEqual(categorize(scale=10, amount=7.5), (7.5, "middle"))\n');
    assert.equal(qualityFocusInputDiagnostic(candidate, current, []), undefined);
    const reordered = await candidateFacts('import unittest\nfrom sample import categorize\nclass Cases(unittest.TestCase):\n'
        + '    def test_keywords(self):\n        self.assertEqual(categorize(7.49, scale=10), (7.49, "low"))\n'
        + '        self.assertEqual(categorize(amount=7.5, scale=10), (7.5, "middle"))\n');
    assert.equal(qualityFocusInputDiagnostic(reordered, current, []), 'quality-focus-input-mismatch');
    const typed = await candidateFacts('import unittest\nfrom sample import categorize\nclass Cases(unittest.TestCase):\n'
        + '    def test_keywords(self):\n        self.assertEqual(categorize(7.49, scale=10.0), (7.49, "low"))\n');
    assert.equal(qualityFocusInputDiagnostic(typed, current, []), 'quality-focus-input-mismatch');
});

test('a target-call payload cannot add code through the target or through quoted observed values', async () => {
    const current = await bound();
    for (const unsafe of ['', 'categorize(); print("payload")', 'categorize\nprint', 'lambda', 'sample.None', 'sample..categorize']) {
        assert.equal(qualityFocusCasesForPrompt({ ...current, target: unsafe }), '');
    }
    const qualified = JSON.parse(qualityFocusCasesForPrompt({ ...current, target: 'Sample.categorize' }).split('\n')[1]);
    assert.equal(qualified.cases[0].targetCall, 'Sample.categorize(7.49, 10)');
    const echoSource = 'def echo(value, **options):\n    return value, options\n';
    const echoIdentity = { runId: 'quality-payload-test', sourceHash: evidenceHash(echoSource), target: 'echo', focus };
    const proposedInputs = [{ args: ['\"); print(\"payload\"); #'], kwargs: { 'bad-key': 'quoted\"value', for: 1 } }];
    const trace = await traceObservedCalls(proposedInputs.map(input => scalarProbeInput(input)), echoSource, 'echo');
    const echoed = bindQualityTaskObservations({ ...echoIdentity, proposedInputs,
        observations: { ...echoIdentity, value: trace } });
    assert.ok(echoed);
    const prompt = qualityFocusCasesForPrompt(echoed);
    const envelope = JSON.parse(prompt.split('\n')[1]);
    assert.equal(prompt.split('\n').length, 2, 'Python text remains inside one complete JSON data envelope');
    const expression = envelope.cases[0].targetCall;
    assert.match(expression, /\*\*\{/);
    const inspected = await runSpawn(resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')),
        ['-B', '-c', 'import ast, json, sys; node = ast.parse(sys.stdin.read(), mode="eval"); '
            + 'print(json.dumps({"node": type(node.body).__name__, "calls": sum(isinstance(item, ast.Call) for item in ast.walk(node)), '
            + '"target": node.body.func.id}))'], { input: expression, timeout: 5000, env: process.env });
    assert.equal(inspected.code, 0, inspected.stderr);
    assert.deepEqual(JSON.parse(inspected.stdout), { node: 'Call', calls: 1, target: 'echo' },
        'static parsing verifies one target call; the host never executes it or generates an assertion');
});

const baseline = 'import unittest\nfrom sample import categorize\nclass Cases(unittest.TestCase):\n'
    + '    def test_seed(self):\n        self.assertEqual(categorize(1, 10), (1.0, "low"))\n';
const candidateFacts = (code: string) => buildReviewFacts({ runId: identity.runId, sourceHash: identity.sourceHash,
    target, module: 'sample', code, executionVerified: false, env: process.env,
    python: resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')) });

test('new-method literal calls may use only the bound focus family without rejecting other baseline inputs', async () => {
    const current = await bound();
    const retained = await candidateFacts(baseline);
    const added = await candidateFacts(baseline + '    def test_boundary(self):\n'
        + '        self.assertEqual(categorize(7.49, 10), (7.49, "low"))\n'
        + '        self.assertEqual(categorize(7.5, 10), (7.5, "middle"))\n'
        + '        self.assertEqual(categorize(7.51, 10), (7.51, "middle"))\n');
    const baselineMethods = retained.methods.map(method => method.name);
    assert.equal(qualityFocusInputDiagnostic(added, current, baselineMethods), undefined);
    assert.equal(added.executionVerified, false, 'the input gate never upgrades pre-execution AST facts');
    assert.equal(added.methods[0].calls.length, 1, 'the off-focus seed is a real known call');
    assert.equal(added.methods[1].calls.length, 3);
    assert.equal(qualityFocusInputDiagnostic(added, current, []), 'quality-focus-input-mismatch',
        'only explicitly retained method identities are exempt from the focus input check');
});

test('one literal case or a mixed literal/dynamic addition cannot claim the complete bound family', async () => {
    const current = await bound();
    const retained = await candidateFacts(baseline);
    const baselineMethods = retained.methods.map(method => method.name);
    for (const addition of [
        '    def test_boundary(self):\n        self.assertEqual(categorize(7.49, 10), (7.49, "low"))\n',
        '    def test_boundary(self):\n        self.assertEqual(categorize(7.49, 10), (7.49, "low"))\n'
            + '        self.assertEqual(categorize(self.dynamic_amount, 10), (7.5, "middle"))\n'
    ]) {
        const candidate = await candidateFacts(baseline + addition);
        assert.equal(candidate.methods[1].calls.length, 1, 'only the literal case has a complete AST call snapshot');
        assert.equal(qualityFocusInputDiagnostic(candidate, current, baselineMethods), 'quality-focus-case-family-incomplete');
        assert.equal(candidate.executionVerified, false);
        assert.equal((candidate as any).focusResolved, undefined);
    }
    const alreadyInBaseline = await candidateFacts(baseline + '    def test_boundary_seed(self):\n'
        + '        self.assertEqual(categorize(7.5, 10), (7.5, "middle"))\n'
        + '        self.assertEqual(categorize(7.51, 10), (7.51, "middle"))\n');
    const candidate = await candidateFacts(baseline + '    def test_boundary_seed(self):\n'
        + '        self.assertEqual(categorize(7.5, 10), (7.5, "middle"))\n'
        + '        self.assertEqual(categorize(7.51, 10), (7.51, "middle"))\n'
        + '    def test_new(self):\n        self.assertEqual(categorize(7.49, 10), (7.49, "low"))\n');
    assert.equal(qualityFocusInputDiagnostic(candidate, current, alreadyInBaseline.methods.map(method => method.name)),
        'quality-focus-case-family-incomplete', 'baseline calls cannot substitute for missing calls in the new focused addition');
});

test('new zero-height and differently typed inputs cannot substitute for the selected returned boundary family', async () => {
    const current = await bound();
    const retained = await candidateFacts(baseline);
    for (const addition of [
        '    def test_boundary(self):\n        with self.assertRaises(ZeroDivisionError):\n            categorize(1, 0)\n',
        '    def test_boundary(self):\n        self.assertEqual(categorize(True, 10), (1.0, "low"))\n',
        '    def test_boundary(self):\n        self.assertEqual(categorize(7.5, 10), (7.5, "middle"))\n'
            + '        self.assertEqual(categorize(1, 0), (0.0, "low"))\n'
    ]) {
        const candidate = await candidateFacts(baseline + addition);
        assert.ok(candidate.methods[1].calls.length > 0, 'rejection is based on tool-owned literal target calls');
        assert.equal(qualityFocusInputDiagnostic(candidate, current, retained.methods.map(method => method.name)),
            'quality-focus-input-mismatch');
    }
});

test('focus call facts from another run, source or target are rejected before checking input membership', async () => {
    const current = await bound();
    const candidate = await candidateFacts(baseline + '    def test_boundary(self):\n'
        + '        self.assertEqual(categorize(7.5, 10), (7.5, "middle"))\n');
    for (const replacement of [{ runId: 'other-run' }, { sourceHash: 'f'.repeat(64) }, { target: 'other_target' }]) {
        assert.equal(qualityFocusInputDiagnostic({ ...candidate, ...replacement }, current, ['Cases.test_seed']),
            'quality-focus-identity-mismatch');
    }
});

test('dynamic calls remain unknown rather than borrowing baseline calls or certifying focus completion', async () => {
    const current = await bound();
    const retained = await candidateFacts(baseline);
    const candidate = await candidateFacts(baseline + '    def test_boundary(self):\n'
        + '        self.assertEqual(categorize(self.dynamic_amount, 10), (7.5, "middle"))\n');
    assert.equal(candidate.methods[0].calls.length, 1);
    assert.deepEqual(candidate.methods[1].calls, []);
    assert.equal(qualityFocusInputDiagnostic(candidate, current, retained.methods.map(method => method.name)), undefined,
        'absence of a known off-focus call leaves the result unknown for execution and Reviewer gates');
    assert.equal(candidate.executionVerified, false);
    assert.equal(candidate.methods[1].assertions[0].observationVerified, undefined);
    assert.equal((candidate as any).focusResolved, undefined);
    assert.equal((candidate as any).reviewApproval, undefined);
});

test('only an exact literal baseline call excludes an already tested input, preserving type and setup distinctions', async () => {
    const facts = await candidateFacts(baseline);
    const calls = facts.methods.flatMap(method => method.calls.map(call => call.call));
    assert.equal(qualityInputAlreadyTested({ args: [1, 10], kwargs: {} }, calls), true);
    for (const input of [{ args: [true, 10], kwargs: {} }, { args: ['1', 10], kwargs: {} },
        { args: [1, 11], kwargs: {} }, { args: [1], kwargs: { scale: 10 } }]) {
        assert.equal(qualityInputAlreadyTested(input, calls), false, 'unknown or different calls remain eligible for observation');
    }
    const constructorCall = callerToProbeInput({ args: ['1', '10'], kwargs: {}, trace_args: [1, 10], trace_kwargs: {},
        constructor_args: ['2'], constructor_kwargs: {}, trace_constructor_args: [2], trace_constructor_kwargs: {} });
    assert.ok(constructorCall?.input.replayable);
    assert.equal(qualityInputAlreadyTested({ args: [1, 10], kwargs: {} }, [constructorCall!.input]), false,
        'a nonempty constructor context is not the same setup as a top-level literal call');
});

test('dynamic baseline inputs are not silently removed from experiments or certified as quality progress', async () => {
    const facts = await candidateFacts('import unittest\nfrom sample import categorize\nclass Cases(unittest.TestCase):\n'
        + '    def test_seed(self):\n        self.assertEqual(categorize(self.dynamic_amount, 10), (1.0, "low"))\n');
    assert.equal(facts.methods[0].calls.length, 0);
    assert.equal(qualityInputAlreadyTested({ args: [1, 10], kwargs: {} }, facts.methods[0].calls.map(call => call.call)), false);
    assert.equal(facts.executionVerified, false);
    assert.equal((facts as any).focusResolved, undefined);
    assert.equal((facts as any).mutationScore, undefined);
});

test('one grounded task correction retains the original deadline, case facts and request counts', async () => {
    const current = await bound();
    const requests: Array<{ prompt: string; deadline: number }> = [];
    const events: Array<{ status: string; detail: any }> = [];
    const tasks = await requestFocusedQualityTask({ focus, context: 'same selected source and executed baseline',
        deadlineAt: 1000, now: () => 1, observations: current, identity, checkCancelled: () => {},
        event: (status, detail) => events.push({ status, detail }), request: async (prompt, deadline) => {
            requests.push({ prompt, deadline });
            return requests.length === 1 ? response(current, { scenario: 'wrong inputs' }) : response(current);
        } });
    assert.equal(tasks?.length, 1);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(item => item.deadline), [1000, 1000]);
    assert.match(requests[0].prompt, /QUALITY_TASK_V4/);
    assert.match(requests[1].prompt, /quality-observation-mismatch/);
    assert.match(requests[1].prompt, new RegExp(current.scenarioId));
    assert.deepEqual(events.map(item => item.status), ['invalid-response', 'parsed-hypotheses']);
    assert.equal(events[1].detail.contractVersion, 'quality-task-v4');
    const session = new QualityAnalystSession(); let calls = 0;
    const input = { focus, context: 'same facts', deadlineAt: 1000, now: () => 1, observations: current, identity,
        checkCancelled: () => {}, event: () => {}, request: async () => { calls++; return response(current, { verification: 'guess output' }); } };
    assert.equal(await session.request(input), undefined);
    assert.equal(calls, 2);
    assert.equal(await session.request(input), undefined);
    assert.equal(calls, 2, 'persistent invalid responses do not trigger a third request');
});

test('a reply arriving after the original task deadline cannot be accepted or sent to Writer', async () => {
    const current = await bound(); let now = 1; let calls = 0;
    const tasks = await requestFocusedQualityTask({ focus, context: 'same bound evidence', deadlineAt: 10, now: () => now,
        observations: current, identity, checkCancelled: () => {}, event: () => {},
        request: async () => { calls++; now = 11; return response(current); } });
    assert.equal(tasks, undefined);
    assert.equal(calls, 1);
    calls = 0;
    const expired = await requestFocusedQualityTask({ focus, context: 'same bound evidence', deadlineAt: 10, now: () => 11,
        observations: current, identity, checkCancelled: () => {}, event: () => {},
        request: async () => { calls++; return response(current); } });
    assert.equal(expired, undefined);
    assert.equal(calls, 0, 'an exhausted deadline must not create the first request');
});

test('cancellation and transport errors do not become format repairs or successful hypotheses', async () => {
    const current = await bound(); let calls = 0;
    const input = { focus, context: 'same evidence', deadlineAt: 1000, now: () => 1,
        observations: current, identity, checkCancelled: () => {}, event: () => {},
        request: async () => { calls++; throw new Error('transport unavailable'); } };
    await assert.rejects(requestFocusedQualityTask(input), /transport unavailable/);
    assert.equal(calls, 1);
    calls = 0; let cancelled = false;
    await assert.rejects(requestFocusedQualityTask({ ...input,
        checkCancelled: () => { if (cancelled) { throw new Error('cancelled'); } },
        request: async () => { calls++; cancelled = true; return response(current); } }), /cancelled/);
    assert.equal(calls, 1);
});
