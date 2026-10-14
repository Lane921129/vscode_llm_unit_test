import { BehaviorObservations, TraceInputSnapshot, TraceValue, TraceValueSnapshot } from './evidenceContracts';
import { parseBehaviorObservations } from './behaviorObservations';
import { callerMatchesObservation, ScalarProbeInput, scalarProbeInput, traceValuePythonLiteral,
    sameTraceValue, typedCallFields } from './probeInputs';
import { validTraceInputSnapshot, validTraceValueSnapshot } from './traceValues';
import type { QualityFocus, QualityTask } from '../roles/qualityAnalyst';
import type { ReviewFacts } from '../roles/reviewFacts';

/** A source-bound input experiment with an actual outcome. It does not prove
 * that a mutant is killed or that the implementation meets its requirements. */
export interface QualityTaskEvidence {
    schemaVersion: 'quality-task-evidence-v1';
    runId: string; sourceHash: string; target: string; focusId: string;
    scenarioId: string;
    cases: Array<{ caseId: string; input: TraceInputSnapshot; result: TraceValueSnapshot;
        args: string[]; kwargs: Record<string, string>; observedResult: string }>;
}
export interface QualityTaskIdentity { runId: string; sourceHash: string; target: string }
export type QualityTaskTraceCaseResolution = { status: 'resolved'; caseIds: string[] }
    | { status: 'rejected'; reasonCode: 'quality-case-projection-identity-mismatch' | 'quality-case-projection-invalid-evidence'
        | 'quality-case-projection-unavailable' | 'quality-case-projection-missing' | 'quality-case-projection-conflict' };
const assertableFlag = (flag: unknown) => flag === undefined || flag === true;
const unmutatedFlag = (flag: unknown) => flag === undefined || flag === false;
const pythonKeywords = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
    'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
    'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
const pythonIdentifier = (value: unknown): value is string => typeof value === 'string'
    && /^[\p{ID_Start}_][\p{ID_Continue}]*$/u.test(value) && !pythonKeywords.has(value);
const qualifiedTarget = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024
    && value.split('.').every(pythonIdentifier);

/** Render only a checked literal call as prompt data, without evaluating it or writing an assertion. */
export function observedTargetCallForPrompt(target: string, input: TraceInputSnapshot): string | undefined {
    if (!qualifiedTarget(target) || !validTraceInputSnapshot(input) || !input.replayable) { return undefined; }
    const fields = typedCallFields(input.call_graph);
    if (!fields || fields.constructor_args?.items?.length || fields.constructor_kwargs?.items?.length) { return undefined; }
    const args = (fields.args.items || []).map(value => traceValuePythonLiteral(value as TraceValue));
    const entries = (fields.kwargs.items || []) as Array<{ key: TraceValue; value: TraceValue }>;
    const kwargs = entries.map(({ key, value }) => [key.value, traceValuePythonLiteral(value)] as const);
    if (args.some(value => value === undefined) || kwargs.some(([key, value]) => typeof key !== 'string' || value === undefined)) {
        return undefined;
    }
    const keywordArguments = kwargs.every(([key]) => pythonIdentifier(key))
        ? kwargs.map(([key, value]) => `${key}=${value}`)
        : [`**{${kwargs.map(([key, value]) => `${JSON.stringify(key)}: ${value}`).join(', ')}}`];
    return `${target}(${[...args, ...keywordArguments].join(', ')})`;
}

export function bindQualityTaskObservations(input: {
    runId: string; sourceHash: string; target: string; focus: QualityFocus;
    proposedInputs: readonly ScalarProbeInput[];
    observations?: QualityTaskIdentity & { value: BehaviorObservations };
}): QualityTaskEvidence | undefined {
    if (!input.runId || !/^[a-f0-9]{64}$/.test(input.sourceHash)
        || !/^E[a-f0-9]{16}$/.test(input.focus.id) || !input.proposedInputs.length
        || input.proposedInputs.length > 12 || !input.observations
        || input.observations.runId !== input.runId || input.observations.sourceHash !== input.sourceHash
        || input.observations.target !== input.target) { return undefined; }
    let observed: BehaviorObservations;
    try { observed = parseBehaviorObservations(structuredClone(input.observations.value), input.target); }
    catch { return undefined; }
    if (!observed.complete || !observed.run_id || observed.load_error || observed.blocked_operations?.length) { return undefined; }
    const cases: QualityTaskEvidence['cases'] = [];
    for (const proposed of input.proposedInputs) {
        const expected = scalarProbeInput(proposed).input;
        if (!expected.replayable) { return undefined; }
        const matches = (observed.cases || []).filter(item => callerMatchesObservation({ trace_input: expected }, item.input_before));
        // No case is borrowed from another input or selected out of contradictory outcomes.
        if (matches.length !== 1) { return undefined; }
        const item = matches[0];
        const facts = observed.examples.filter(example => example.case_id === item.case_id);
        const result = (item as unknown as Record<string, unknown>).result_snapshot;
        if (item.status !== 'returned' || !assertableFlag(item.call_assertable)
            || !assertableFlag((item as unknown as Record<string, unknown>).result_assertable)
            || !unmutatedFlag(item.inputs_mutated) || facts.length !== 1
            || !callerMatchesObservation({ trace_input: expected }, item.input_after || undefined)
            || !validTraceValueSnapshot(result) || !result.replayable) { return undefined; }
        const fact = facts[0];
        if (!assertableFlag(fact.call_assertable) || !assertableFlag(fact.result_assertable) || !unmutatedFlag(fact.inputs_mutated)
            || fact.result_truncated || fact.oracle_reason || fact.non_deterministic_operations?.length
            || typeof fact.result !== 'string') { return undefined; }
        cases.push({ caseId: item.case_id, input: item.input_before, result,
            args: [...fact.args], kwargs: { ...fact.kwargs }, observedResult: fact.result });
    }
    if (new Set(cases.map(item => item.caseId)).size !== cases.length) { return undefined; }
    return { schemaVersion: 'quality-task-evidence-v1', runId: input.runId,
        sourceHash: input.sourceHash, target: input.target, focusId: input.focus.id,
        scenarioId: `observations:${input.focus.id}`, cases };
}

/** Worker case IDs are local names. Resolve the merged Trace by the complete
 * typed call and actual outcome; an old case with the same ID is not evidence. */
export function resolveQualityTaskTraceCaseIds(input: {
    identity: QualityTaskIdentity; evidence: QualityTaskEvidence;
    observations?: QualityTaskIdentity & { value: BehaviorObservations };
}): QualityTaskTraceCaseResolution {
    const reject = (reasonCode: Extract<QualityTaskTraceCaseResolution, { status: 'rejected' }>['reasonCode']): QualityTaskTraceCaseResolution =>
        ({ status: 'rejected', reasonCode });
    const { identity, evidence, observations } = input;
    if (typeof identity.runId !== 'string' || !identity.runId || typeof identity.sourceHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(identity.sourceHash) || typeof identity.target !== 'string' || !identity.target || !evidence || !observations
        || [evidence, observations].some(value => value.runId !== identity.runId
            || value.sourceHash !== identity.sourceHash || value.target !== identity.target)) {
        return reject('quality-case-projection-identity-mismatch');
    }
    try { if (!qualityFocusCasesForPrompt(evidence)) { return reject('quality-case-projection-invalid-evidence'); } }
    catch { return reject('quality-case-projection-invalid-evidence'); }
    let observed: BehaviorObservations;
    try { observed = parseBehaviorObservations(structuredClone(observations.value), identity.target); }
    catch { return reject('quality-case-projection-unavailable'); }
    if (!observed.complete || observed.load_error !== null
        || observed.blocked_operations !== undefined && (!Array.isArray(observed.blocked_operations) || observed.blocked_operations.length > 0)) {
        return reject('quality-case-projection-unavailable');
    }
    const caseIds = new Set<string>();
    for (const expected of evidence.cases) {
        const caller = { trace_input: expected.input.call_graph };
        const matches = (observed.cases || []).filter(item => callerMatchesObservation(caller, item.input_before));
        if (!matches.length) { return reject('quality-case-projection-missing'); }
        for (const item of matches) {
            const facts = observed.examples.filter(fact => fact.case_id === item.case_id);
            const result = (item as unknown as Record<string, unknown>).result_snapshot;
            if (item.status !== 'returned' || !assertableFlag(item.call_assertable)
                || !assertableFlag((item as unknown as Record<string, unknown>).result_assertable)
                || !unmutatedFlag(item.inputs_mutated) || !callerMatchesObservation(caller, item.input_after || undefined)
                || !validTraceValueSnapshot(result) || !result.replayable
                || !sameTraceValue(result.value, expected.result.value) || facts.length !== 1) {
                return reject('quality-case-projection-conflict');
            }
            const fact = facts[0];
            if (!assertableFlag(fact.call_assertable) || !assertableFlag(fact.result_assertable)
                || !unmutatedFlag(fact.inputs_mutated) || !unmutatedFlag(fact.result_truncated)
                || fact.oracle_reason !== undefined
                || fact.non_deterministic_operations !== undefined && (!Array.isArray(fact.non_deterministic_operations)
                    || fact.non_deterministic_operations.length > 0)
                || fact.result !== expected.observedResult || JSON.stringify(fact.args) !== JSON.stringify(expected.args)
                || JSON.stringify(Object.entries(fact.kwargs || {})) !== JSON.stringify(Object.entries(expected.kwargs))) {
                return reject('quality-case-projection-conflict');
            }
            caseIds.add(item.case_id);
        }
    }
    return { status: 'resolved', caseIds: [...caseIds] };
}

/** Model prose is retained as a hypothesis in the journal, never substituted
 * for the exact input/outcome facts in a grounded Writer task. */
export function qualityTasksForWriter(tasks: readonly QualityTask[]): string {
    return JSON.stringify(tasks.map(task => task.boundObservations ? {
        evidence: task.evidence, origin: 'controlled-focus-observations',
        instruction: 'Add one focused test method exercising the supplied observed cases; preserve the executed baseline. '
            + 'Use only these exact calls and outcomes. These are current implementation observations, not independent requirements.',
        observations: task.boundObservations.cases.map(item => ({ caseId: item.caseId,
            args: item.args, kwargs: item.kwargs, observedOutcome: 'returned',
            observedResult: traceValuePythonLiteral(item.result.value) })),
        binding: { sourceHash: task.boundObservations.sourceHash, target: task.boundObservations.target,
            runId: task.boundObservations.runId, focusId: task.boundObservations.focusId }
    } : { ...task, assertionOracle: false }));
}

/** This checks only AST-proven literal target calls of newly added methods.
 * A literal addition must explicitly represent the complete supplied family;
 * dynamic calls mixed into an incomplete literal family do not prove its presence.
 * Unknown dynamic calls stay unknown and must still pass execution/review;
 * neither an input match nor this gate claims the chosen mutant is killed. */
export function qualityFocusInputDiagnostic(facts: ReviewFacts, evidence: QualityTaskEvidence,
    baselineMethodIds: readonly string[]): string | undefined {
    if (facts.runId !== evidence.runId || facts.sourceHash !== evidence.sourceHash || facts.target !== evidence.target) {
        return 'quality-focus-identity-mismatch';
    }
    const baseline = new Set(baselineMethodIds);
    const calls = facts.methods.filter(item => !baseline.has(item.name)).flatMap(method => method.calls);
    if (calls.some(call => !evidence.cases.some(item =>
        callerMatchesObservation({ trace_input: call.call }, item.input)))) { return 'quality-focus-input-mismatch'; }
    if (calls.length && evidence.cases.some(item => !calls.some(call =>
        callerMatchesObservation({ trace_input: call.call }, item.input)))) { return 'quality-focus-case-family-incomplete'; }
    return undefined;
}

/** Only exclude inputs already spelled as the same complete literal call in
 * passed tests. Unknown calls remain eligible; survivors are never removed. */
export function qualityInputAlreadyTested(input: ScalarProbeInput, calls: readonly TraceValueSnapshot[]): boolean {
    const proposed = typedCallFields(scalarProbeInput(input).input);
    if (!proposed) { return false; }
    return calls.some(call => {
        const known = typedCallFields(call);
        return Boolean(known && (!known.constructor_args || !known.constructor_args.items?.length)
            && (!known.constructor_kwargs || !known.constructor_kwargs.items?.length)
            && sameTraceValue(proposed.args, known.args) && sameTraceValue(proposed.kwargs, known.kwargs));
    });
}

/** Complete exact calls and outcomes for this focus, never Python assertions or guessed values. */
export function qualityFocusCasesForPrompt(evidence?: QualityTaskEvidence): string {
    if (!evidence || evidence.schemaVersion !== 'quality-task-evidence-v1' || !evidence.runId || !qualifiedTarget(evidence.target)
        || !/^[a-f0-9]{64}$/.test(evidence.sourceHash) || !/^E[a-f0-9]{16}$/.test(evidence.focusId)
        || evidence.scenarioId !== `observations:${evidence.focusId}` || !evidence.cases.length || evidence.cases.length > 12
        || new Set(evidence.cases.map(item => item.caseId)).size !== evidence.cases.length) { return ''; }
    const cases: Array<{ caseId: string; args: string[]; kwargs: Record<string, string>; targetCall: string; observedResult: string }> = [];
    for (const item of evidence.cases) {
        if (!item.caseId || !validTraceInputSnapshot(item.input) || !item.input.replayable
            || !validTraceValueSnapshot(item.result) || !item.result.replayable) { return ''; }
        const fields = typedCallFields(item.input.call_graph);
        if (!fields || fields.constructor_args?.items?.length || fields.constructor_kwargs?.items?.length) { return ''; }
        const args = (fields.args.items || []).map(value => traceValuePythonLiteral(value as TraceValue));
        const entries = (fields.kwargs.items || []) as Array<{ key: TraceValue; value: TraceValue }>;
        const kwargs = entries.map(({ key, value }) => [key.value, traceValuePythonLiteral(value)] as const);
        const observedResult = traceValuePythonLiteral(item.result.value);
        if (args.some(value => value === undefined) || kwargs.some(([key, value]) => typeof key !== 'string' || value === undefined)
            || observedResult === undefined) { return ''; }
        const targetCall = observedTargetCallForPrompt(evidence.target, item.input);
        if (!targetCall) { return ''; }
        cases.push({ caseId: item.caseId, args: args as string[],
            kwargs: Object.fromEntries(kwargs) as Record<string, string>, targetCall, observedResult });
    }
    return 'WRITER_FOCUS_CASE_FACTS_V1\n' + JSON.stringify({ runId: evidence.runId, sourceHash: evidence.sourceHash,
        target: evidence.target, focusId: evidence.focusId, scenarioId: evidence.scenarioId, cases,
        instruction: 'Write one NEW test method that exercises EVERY supplied exact call and its observed result. '
            + 'One method may contain multiple target calls; do not stop after the first case. '
            + 'Arguments are Python literals: copy each targetCall exactly, with no swapped, rounded or replaced arguments. Every case is required. '
            + 'Preserve the baseline: return only the new addition, never copy the old tests or return the unchanged baseline. '
            + 'Copy these observed outcomes as evidence; do not calculate or invent expected answers. '
            + 'These implementation observations do not certify independent requirements, execution, review or mutation quality.' });
}
