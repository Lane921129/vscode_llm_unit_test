import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { seedCaseFactsForPrompt, validateWriterSeedContract } from '../pipeline/writerSeedContract';
import { buildReviewFacts } from '../roles/reviewFacts';
import { BehaviorObservations } from '../pipeline/evidenceContracts';
import { evidenceHash } from '../pipeline/analysisJournal';
import { parseBehaviorObservations } from '../pipeline/behaviorObservations';
import { callerToProbeInput, ProbeInputCase, scalarProbeInput } from '../pipeline/probeInputs';
import { selectWriterSeedCaseIds } from '../prompts/compactWriterContext';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';
import { runSpawn } from '../utils/processRunner';
import { describeStageEvent } from '../pipeline/resultPresentation';
import { getLanguage, setLanguage } from '../i18n/core';

const source = 'def scale_ratio(amount, distance):\n    ratio = round(amount / (distance / 100) ** 2, 2)\n'
    + '    return ratio, "measured"\n';
const identity = { runId: 'writer-seed-contract-test', sourceHash: evidenceHash(source), target: 'scale_ratio' };
const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const seed = 'import unittest\nfrom sample import scale_ratio\nclass Cases(unittest.TestCase):\n'
    + '    def test_seed(self):\n        amount = 70\n        result = scale_ratio(amount, 170)\n'
    + '        self.assertEqual(result, (24.22, "measured"))\n';
const facts = (code = seed) => buildReviewFacts({ ...identity, module: 'sample', code, python,
    env: process.env, executionVerified: false });
async function traceObservedSeed(cases: ProbeInputCase[], sourceCode = source, targetName = identity.target): Promise<BehaviorObservations> {
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, 'writer-seed-contract-'));
    const file = path.join(root, 'sample.py');
    try {
        fs.writeFileSync(file, sourceCode, 'utf8');
        const run = await runSpawn(python, ['-B', pythonToolPath('trace'), file, targetName, '-',
            JSON.stringify({ case_timeout_seconds: 10, planning_timeout_seconds: 10, total_timeout_seconds: 45 })], {
            input: JSON.stringify({ schema_version: 'probe-inputs-v1', cases }),
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 60000
        });
        assert.equal(run.code, 0, run.stderr);
        const trace = parseBehaviorObservations(run.stdout, targetName);
        assert.equal(trace.complete, true);
        assert.equal(evidenceHash(fs.readFileSync(file, 'utf8')), evidenceHash(sourceCode));
        return trace;
    } finally {
        const actual = fs.realpathSync(root);
        assert.equal(path.dirname(actual), parent, 'cleanup remains within the newly owned directory');
        assert.equal(actual, path.resolve(root));
        fs.rmSync(actual, { recursive: true, force: true });
    }
}
let fresh: Promise<BehaviorObservations> | undefined;
const observations = () => fresh ||= traceObservedSeed([
    scalarProbeInput({ args: [70, 170], kwargs: {} }), scalarProbeInput({ args: [1, 0], kwargs: {} })
]).then(trace => {
    assert.equal(trace.cases![0].status, 'returned');
    assert.equal(trace.cases![1].status, 'raised');
    return trace;
});

test('one real observed return or exception binds a formal seed input, without approving its expected value', async () => {
    const trace = await observations();
    const selectedCaseIds = selectWriterSeedCaseIds(trace);
    assert.deepEqual(selectedCaseIds, [trace.cases![0].case_id]);
    const context = { identity, observations: { ...identity, value: trace }, selectedCaseIds,
        targetKind: 'sync-top-level-function' as const };
    const actual = await facts();
    const valid = validateWriterSeedContract({ ...context, facts: actual });
    assert.deepEqual(valid, { status: 'grounded', methodCount: 1, literalTargetCallCount: 1,
        reasonCode: undefined, caseId: trace.cases![0].case_id });
    assert.equal(actual.executionVerified, false);
    assert.equal(actual.methods[0].assertions[0].observationVerified, undefined);
    assert.equal((valid as any).approved, undefined);
    const before = JSON.stringify(trace);
    const prompt = seedCaseFactsForPrompt(context);
    const projection = JSON.parse(prompt.split('\n')[1]);
    assert.deepEqual(projection.args, ['70', '170']);
    assert.equal(projection.targetCall, 'scale_ratio(70, 170)');
    assert.match(projection.observedResult, /24\.22.*measured/);
    assert.equal(projection.observedOutcome, 'returned');
    assert.equal(projection.sourceHash, identity.sourceHash);
    assert.equal(projection.target, identity.target);
    assert.equal(projection.runId, identity.runId);
    assert.doesNotMatch(prompt, /input_before|call_graph|result_snapshot|trace-value-v1/);
    assert.equal(JSON.stringify(trace), before);
    const unknownKind = JSON.parse(seedCaseFactsForPrompt({ ...context, targetKind: undefined }).split('\n')[1]);
    assert.equal(unknownKind.targetCall, undefined, 'unknown AST kind never guesses a plain-call invocation');
    assert.deepEqual(unknownKind.args, projection.args);
    assert.deepEqual(validateWriterSeedContract({ ...context, targetKind: undefined, facts: actual }), valid,
        'call-display metadata cannot change validation identity, grounding or approval');
    const guessed = await facts(seed.replace('24.22', '22.86'));
    assert.equal(validateWriterSeedContract({ ...context, facts: guessed }).status, 'grounded',
        'input binding does not certify an assertion; numeric/execution/Reviewer gates must reject a guessed expected value');
    const raisedId = trace.cases![1].case_id;
    const raisedContext = { ...context, selectedCaseIds: [raisedId] };
    const exceptionSeed = 'import unittest\nfrom sample import scale_ratio\nclass Cases(unittest.TestCase):\n'
        + '    def test_seed(self):\n        with self.assertRaises(ZeroDivisionError):\n            scale_ratio(1, 0)\n';
    assert.equal(validateWriterSeedContract({ ...raisedContext, facts: await facts(exceptionSeed) }).status, 'grounded');
    const raised = JSON.parse(seedCaseFactsForPrompt(raisedContext).split('\n')[1]);
    assert.equal(raised.observedOutcome, 'raised');
    assert.deepEqual(raised.exception, { module: 'builtins', qualname: 'ZeroDivisionError' });
    assert.equal(raised.observedResult, undefined);
    assert.equal(raised.targetCall, 'scale_ratio(1, 0)');
});

test('seed call text preserves typed keyword order and floats, with payload strings remaining JSON literal data', async () => {
    const probes = [
        scalarProbeInput({ args: [7.5], kwargs: { distance: 100 } }),
        scalarProbeInput({ args: [], kwargs: { distance: 170, amount: 70 } }),
        scalarProbeInput({ args: ['\"); print(\"payload\"); #'], kwargs: { distance: 170 } })
    ];
    const trace = await traceObservedSeed(probes);
    const calls: string[] = [];
    for (const item of trace.cases!.slice(0, 3)) {
        const prompt = seedCaseFactsForPrompt({ identity, observations: { ...identity, value: trace },
            selectedCaseIds: [item.case_id], targetKind: 'sync-top-level-function' });
        assert.equal(prompt.split('\n').length, 2, 'the call is contained in one JSON envelope');
        const projected = JSON.parse(prompt.split('\n')[1]);
        calls.push(projected.targetCall);
        assert.equal(projected.sourceHash, identity.sourceHash); assert.equal(projected.runId, identity.runId);
        assert.doesNotMatch(prompt, /def test_|self\.assert|call_graph|result_snapshot/);
    }
    assert.deepEqual(calls.slice(0, 2), ['scale_ratio(7.5, distance=100)', 'scale_ratio(distance=170, amount=70)']);
    const inspected = await runSpawn(python, ['-B', '-c',
        'import ast, json, sys; node = ast.parse(sys.stdin.read(), mode="eval"); '
        + 'print(json.dumps({"node": type(node.body).__name__, "calls": sum(isinstance(item, ast.Call) for item in ast.walk(node)), '
        + '"target": node.body.func.id}))'], { input: calls[2], env: process.env, timeout: 5000 });
    assert.equal(inspected.code, 0, inspected.stderr);
    assert.deepEqual(JSON.parse(inspected.stdout), { node: 'Call', calls: 1, target: identity.target });
});

test('member and asynchronous seed facts retain setup parameters without guessing receiver or await packaging', async () => {
    const memberSource = 'class Factor:\n    def __init__(self, factor):\n        self.factor = factor\n'
        + '    def scale(self, amount):\n        return amount * self.factor\n';
    const memberIdentity = { ...identity, sourceHash: evidenceHash(memberSource), target: 'Factor.scale' };
    const input = callerToProbeInput({ args: ['3'], kwargs: {}, trace_args: [3], trace_kwargs: {},
        constructor_args: ['2'], constructor_kwargs: {}, trace_constructor_args: [2], trace_constructor_kwargs: {} });
    assert.ok(input?.input.replayable);
    const memberTrace = await traceObservedSeed([input!], memberSource, memberIdentity.target);
    const member = JSON.parse(seedCaseFactsForPrompt({ identity: memberIdentity,
        observations: { ...memberIdentity, value: memberTrace }, selectedCaseIds: [memberTrace.cases![0].case_id],
        targetKind: 'sync-top-level-function' }).split('\n')[1]);
    assert.equal(member.targetCall, undefined, 'a dotted member must not be rendered as an unbound function');
    assert.deepEqual(member.args, ['3']); assert.deepEqual(member.constructorArgs, ['2']);
    const asyncSource = 'async ' + source;
    const asyncIdentity = { ...identity, sourceHash: evidenceHash(asyncSource) };
    const asyncTrace = await traceObservedSeed([scalarProbeInput({ args: [70, 170], kwargs: {} })], asyncSource);
    const asynchronous = JSON.parse(seedCaseFactsForPrompt({ identity: asyncIdentity,
        observations: { ...asyncIdentity, value: asyncTrace }, selectedCaseIds: [asyncTrace.cases![0].case_id] }).split('\n')[1]);
    assert.equal(asynchronous.targetCall, undefined, 'without synchronous AST metadata the async call remains unformatted');
    assert.deepEqual(asynchronous.args, ['70', '170']);
});

test('seed shape and identities reject proven mismatches while unavailable Trace and dynamic/mock calls stay unknown', async () => {
    const trace = await observations();
    const context = { identity, observations: { ...identity, value: trace }, selectedCaseIds: selectWriterSeedCaseIds(trace) };
    const actual = await facts();
    const multiCall = seed.replace('        self.assertEqual(result,', '        second = scale_ratio(1, 1)\n        self.assertEqual(result,');
    assert.equal(validateWriterSeedContract({ ...context, facts: await facts(multiCall) }).reasonCode, 'writer-seed-call-count');
    const multiMethod = seed + '    def test_other(self):\n        self.assertEqual(scale_ratio(1, 1), (10000.0, "measured"))\n';
    assert.equal(validateWriterSeedContract({ ...context, facts: await facts(multiMethod) }).reasonCode, 'writer-seed-method-count');
    const wrongInput = await facts(seed.replace('scale_ratio(amount, 170)', 'scale_ratio(1, 0)'));
    assert.equal(validateWriterSeedContract({ ...context, facts: wrongInput }).reasonCode, 'writer-seed-input-mismatch');
    const typed = await facts(seed.replace('scale_ratio(amount, 170)', 'scale_ratio(True, 170)'));
    assert.equal(validateWriterSeedContract({ ...context, facts: typed }).reasonCode, 'writer-seed-input-mismatch');
    for (const replacement of [{ runId: 'other-run' }, { sourceHash: 'f'.repeat(64) }, { target: 'other_target' }]) {
        assert.equal(validateWriterSeedContract({ ...context, facts: { ...actual, ...replacement } }).reasonCode,
            'writer-seed-identity-mismatch');
        const moved = { ...context, observations: { ...context.observations, ...replacement } };
        assert.equal(validateWriterSeedContract({ ...moved, facts: actual }).reasonCode, 'writer-seed-identity-mismatch');
        assert.equal(seedCaseFactsForPrompt(moved), '');
    }
    for (const unavailable of [
        { ...context, selectedCaseIds: ['unknown-case'] },
        { ...context, selectedCaseIds: undefined },
        { ...context, observations: undefined },
        { ...context, observations: { ...identity, value: { ...trace, complete: false } } },
        { ...context, observations: { ...identity, value: { ...trace, blocked_operations: ['open'] } } }
    ]) {
        assert.equal(validateWriterSeedContract({ ...unavailable, facts: actual }).status, 'unknown');
        assert.equal(seedCaseFactsForPrompt(unavailable), '');
    }
    for (const code of [seed.replace('scale_ratio(amount, 170)', 'scale_ratio(self.value, 170)'),
        'import unittest\nfrom unittest.mock import patch\nfrom sample import scale_ratio\nclass Cases(unittest.TestCase):\n'
        + '    def test_seed(self):\n        with patch("sample.external_input") as dependency:\n'
        + '            self.assertEqual(scale_ratio(dependency.return_value, 170), (24.22, "measured"))\n']) {
        const unknown = validateWriterSeedContract({ ...context, facts: await facts(code) });
        assert.equal(unknown.status, 'unknown');
        assert.equal((unknown as any).approved, undefined);
    }
    const conflicting = structuredClone(trace);
    const otherCase = structuredClone(conflicting.cases![0]); otherCase.case_id += '-conflict';
    (otherCase as any).result_snapshot = { schema_version: 'trace-value-v1', replayable: true, value: { type: 'int', value: '0' } };
    const otherFact = structuredClone(conflicting.examples[0]); otherFact.case_id = otherCase.case_id; otherFact.result = '0';
    conflicting.cases!.push(otherCase); conflicting.examples.push(otherFact);
    const conflict = { ...context, observations: { ...identity, value: conflicting } };
    assert.equal(validateWriterSeedContract({ ...conflict, facts: actual }).status, 'unknown');
    assert.equal(seedCaseFactsForPrompt(conflict), '', 'conflicting same-input outcomes cannot become an oracle');
});

test('malformed seed mutation flags cannot ground a case or enter its prompt', async () => {
    const trace = await observations();
    const actual = await facts();
    const selectedCaseIds = selectWriterSeedCaseIds(trace);
    for (const collection of ['cases', 'examples'] as const) {
        for (const malformed of [null, 'false', 0, 1]) {
            const invalid = structuredClone(trace);
            (invalid[collection]![0] as unknown as Record<string, unknown>).inputs_mutated = malformed;
            const context = { identity, selectedCaseIds, observations: { ...identity, value: invalid } };
            assert.equal(validateWriterSeedContract({ ...context, facts: actual }).status, 'unknown',
                `${collection}.inputs_mutated=${String(malformed)}`);
            assert.equal(seedCaseFactsForPrompt(context), '');
        }
    }
    for (const omitted of [false, true]) {
        const valid = structuredClone(trace);
        for (const collection of ['cases', 'examples'] as const) {
            const flags = valid[collection]![0] as unknown as Record<string, unknown>;
            if (omitted) { delete flags.inputs_mutated; } else { flags.inputs_mutated = false; }
        }
        const context = { identity, selectedCaseIds, observations: { ...identity, value: valid } };
        assert.equal(validateWriterSeedContract({ ...context, facts: actual }).status, 'grounded');
        assert.match(seedCaseFactsForPrompt(context), /WRITER_SEED_CASE_FACTS_V1/);
    }
});

test('seed progress and rejection reasons are localized without certifying a pass or echoing provider content', () => {
    const original = getLanguage();
    const detail = { raw: 'UNTRUSTED_PROVIDER_PROSE', reason: '夾帶的模型說明 UNTRUSTED_PROVIDER_PROSE',
        methodCount: 9, literalTargetCallCount: 9 };
    try {
        for (const language of ['zh-tw', 'en']) {
            setLanguage(language);
            const grounded = describeStageEvent('writer-seed-input', 'grounded', detail);
            const unknown = describeStageEvent('writer-seed-input', 'unknown', detail);
            assert.match(grounded, language === 'en' ? /execution and review are still required/i : /仍須執行與審查，尚非通過/);
            assert.match(unknown, language === 'en' ? /execution and review remain required/i : /繼續執行與審查，不推定通過/);
            for (const [reasonCode, english, chinese] of [
                ['writer-seed-method-count', /one test method/, /一個測試方法/],
                ['writer-seed-call-count', /one identifiable target call/, /一個可定位的目標呼叫/],
                ['writer-seed-input-mismatch', /does not match the selected controlled case/, /未對應選定受控案例/],
                ['writer-seed-identity-mismatch', /Source, run and target identities do not match/, /來源、執行與目標身分不一致/]
            ] as const) {
                const rejected = describeStageEvent('writer-seed-input', 'rejected', { ...detail, reasonCode });
                assert.match(rejected, language === 'en' ? english : chinese);
                assert.match(rejected, /Writer/);
                assert.doesNotMatch(rejected, /UNTRUSTED_PROVIDER_PROSE/);
                if (language === 'en') { assert.doesNotMatch(rejected, /\p{Script=Han}/u); }
            }
            assert.doesNotMatch(grounded + unknown, /UNTRUSTED_PROVIDER_PROSE/);
            if (language === 'en') {
                assert.doesNotMatch(grounded + unknown, /\p{Script=Han}|\bpassed\b|\bapproved\b/iu);
            }
        }
    } finally { setLanguage(original); }
});
