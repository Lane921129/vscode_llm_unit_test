import { BehaviorObservation, BehaviorObservations, ProbeCaseObservation, TraceValueSnapshot } from './evidenceContracts';
import { parseBehaviorObservations } from './behaviorObservations';
import { callerMatchesObservation, traceValuePythonLiteral, typedCallFields } from './probeInputs';
import { validTraceValueSnapshot } from './traceValues';
import { ReviewFactIdentity, ReviewFacts } from '../roles/reviewFacts';
import { observedTargetCallForPrompt } from './qualityTaskEvidence';

export interface WriterSeedEvidenceInput {
    identity: ReviewFactIdentity;
    observations?: ReviewFactIdentity & { value: BehaviorObservations };
    selectedCaseIds?: readonly string[];
    /** Host AST metadata for call display only; never changes validation or authorizes execution. */
    targetKind?: 'sync-top-level-function';
}
export type WriterSeedContractReason = 'writer-seed-identity-mismatch' | 'writer-seed-method-count'
    | 'writer-seed-call-count' | 'writer-seed-input-mismatch' | 'writer-seed-evidence-unavailable'
    | 'writer-seed-call-unknown';
export interface WriterSeedContractResult {
    /** Grounded confirms only one exact observed input, never execution, assertions, review or mutation. */
    status: 'grounded' | 'unknown' | 'rejected';
    reasonCode?: WriterSeedContractReason;
    methodCount: number;
    literalTargetCallCount: number;
    caseId?: string;
}
interface SelectedSeedCase {
    case: ProbeCaseObservation;
    fact: BehaviorObservation;
    result?: TraceValueSnapshot;
    exception?: { module: string; qualname: string };
}
const sameIdentity = (left: ReviewFactIdentity, right: ReviewFactIdentity) => left.runId === right.runId
    && left.sourceHash === right.sourceHash && left.target === right.target;
const validIdentity = (identity: ReviewFactIdentity) => !!identity.runId && !!identity.target && /^[a-f0-9]{64}$/.test(identity.sourceHash);
const assertable = (flag: unknown) => flag === undefined || flag === true;
const unmutated = (flag: unknown) => flag === undefined || flag === false;
const pythonPath = (value: unknown): value is string => typeof value === 'string'
    && /^[\p{L}_][\p{L}\p{N}\p{M}_]*(?:\.[\p{L}_][\p{L}\p{N}\p{M}_]*)*$/u.test(value);

/** No source execution, input derivation, expected-value calculation or model prose. */
function selectedSeedCase(input: WriterSeedEvidenceInput): SelectedSeedCase | undefined {
    if (!validIdentity(input.identity) || !input.observations || !sameIdentity(input.observations, input.identity)
        || input.selectedCaseIds?.length !== 1) { return undefined; }
    let trace: BehaviorObservations;
    try { trace = parseBehaviorObservations(structuredClone(input.observations.value), input.identity.target); }
    catch { return undefined; }
    if (!trace.complete || trace.load_error || trace.blocked_operations?.length) { return undefined; }
    const selected = trace.cases!.find(item => item.case_id === input.selectedCaseIds![0]);
    const call = selected?.input_before.call_graph;
    if (!selected || !typedCallFields(call)) { return undefined; }
    const sameCalls = trace.cases!.filter(item => callerMatchesObservation({ trace_input: call }, item.input_before));
    const usable = (item: ProbeCaseObservation): SelectedSeedCase | undefined => {
        const facts = [...trace.examples, ...trace.errors].filter(fact => fact.case_id === item.case_id);
        if (facts.length !== 1 || !unmutated(item.inputs_mutated) || !assertable(item.call_assertable)
            || !callerMatchesObservation({ trace_input: call }, item.input_after || undefined)) { return undefined; }
        const fact = facts[0];
        if (!unmutated(fact.inputs_mutated) || !assertable(fact.call_assertable) || !assertable(fact.result_assertable)
            || fact.oracle_reason || fact.non_deterministic_operations?.length || fact.result_truncated) { return undefined; }
        if (item.status === 'returned') {
            const result = (item as unknown as Record<string, unknown>).result_snapshot;
            return validTraceValueSnapshot(result) && result.replayable && typeof fact.result === 'string'
                ? { case: item, fact, result } : undefined;
        }
        if (item.status === 'raised' && pythonPath(fact.exception_module) && pythonPath(fact.exception_qualname)
            && pythonPath(fact.exception)) {
            return { case: item, fact, exception: { module: fact.exception_module, qualname: fact.exception_qualname } };
        }
        return undefined;
    };
    const result = usable(selected);
    if (!result || !sameCalls.length || sameCalls.some(item => {
        const other = usable(item);
        return !other || other.case.status !== result.case.status
            || JSON.stringify(other.result) !== JSON.stringify(result.result)
            || JSON.stringify(other.exception) !== JSON.stringify(result.exception);
    })) { return undefined; }
    return result;
}

/** Formal seed candidates only. The caller must not apply this to qualification probes.
 * Unknown mocks/state/dynamic bindings still require the normal execution and Reviewer gates. */
export function validateWriterSeedContract(input: WriterSeedEvidenceInput & { facts: ReviewFacts }): WriterSeedContractResult {
    const methodCount = input.facts.methods.length;
    const literalTargetCallCount = input.facts.methods.reduce((count, method) => count + method.calls.length, 0);
    const result = (status: WriterSeedContractResult['status'], reasonCode?: WriterSeedContractReason,
        caseId?: string): WriterSeedContractResult => ({ status, reasonCode, methodCount, literalTargetCallCount, caseId });
    if (!validIdentity(input.identity) || !sameIdentity(input.facts, input.identity)
        || input.observations && !sameIdentity(input.observations, input.identity)) {
        return result('rejected', 'writer-seed-identity-mismatch');
    }
    if (methodCount > 1) { return result('rejected', 'writer-seed-method-count'); }
    if (literalTargetCallCount > 1) { return result('rejected', 'writer-seed-call-count'); }
    if (methodCount !== 1 || literalTargetCallCount !== 1) { return result('unknown', 'writer-seed-call-unknown'); }
    const selected = selectedSeedCase(input);
    if (!selected) { return result('unknown', 'writer-seed-evidence-unavailable'); }
    const call = input.facts.methods[0].calls[0].call;
    if (!typedCallFields(call)) { return result('unknown', 'writer-seed-call-unknown'); }
    if (!callerMatchesObservation({ trace_input: call }, selected.case.input_before)) {
        return result('rejected', 'writer-seed-input-mismatch');
    }
    return result('grounded', undefined, selected.case.case_id);
}

/** Render the selected executed case once. Typed trees remain in artifacts. */
export function seedCaseFactsForPrompt(input: WriterSeedEvidenceInput): string {
    const selected = selectedSeedCase(input);
    if (!selected) { return ''; }
    const observedResult = selected.result && traceValuePythonLiteral(selected.result.value);
    if (selected.result && observedResult === undefined) { return ''; }
    const fact = selected.fact;
    const targetCall = input.targetKind === 'sync-top-level-function' && !input.identity.target.includes('.')
        ? observedTargetCallForPrompt(input.identity.target, selected.case.input_before) : undefined;
    return 'WRITER_SEED_CASE_FACTS_V1\n' + JSON.stringify({ ...input.identity, caseId: selected.case.case_id,
        args: fact.args, kwargs: fact.kwargs || {},
        ...(targetCall ? { targetCall } : {}),
        ...(fact.constructor_args?.length ? { constructorArgs: fact.constructor_args } : {}),
        ...(fact.constructor_kwargs && Object.keys(fact.constructor_kwargs).length ? { constructorKwargs: fact.constructor_kwargs } : {}),
        observedOutcome: selected.case.status,
        ...(selected.result ? { observedResult } : { exception: selected.exception }),
        instruction: 'Use this selected observed case only: one test method and one exact target call. '
            + 'If targetCall is provided, copy its Python literals exactly; do not swap arguments or choose another Analyst or model-suggested input. '
            + 'These are executed implementation observations, not independent requirements. Execution, assertion evidence and Reviewer approval remain required.' });
}
