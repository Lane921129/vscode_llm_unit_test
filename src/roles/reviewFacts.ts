import { evidenceHash } from '../pipeline/analysisJournal';
import { containsCredential } from '../pipeline/artifactSafety';
import { parseBehaviorObservations } from '../pipeline/behaviorObservations';
import { BehaviorObservations, TraceValueSnapshot } from '../pipeline/evidenceContracts';
import { callerMatchesObservation, typedCallFields } from '../pipeline/probeInputs';
import { pythonToolPath } from '../pipeline/pythonTools';
import { validTraceValueSnapshot } from '../pipeline/traceValues';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { runSpawn } from '../utils/processRunner';

export interface ReviewFactIdentity { runId: string; sourceHash: string; target: string }
export interface ReviewAssertionFact {
    line: number; kind: string; targetResult?: boolean; expectedType?: string;
    expected?: TraceValueSnapshot; observationVerified?: boolean;
}
export interface ReviewMethodFacts {
    line: number; endLine: number; name: string; assertions: ReviewAssertionFact[];
    calls: Array<{ line: number; call: TraceValueSnapshot }>;
    exceptionGuards: Array<{ line: number; exception: string; callLines: number[] }>;
    scalarBindings: Array<{ line: number; name: string; type: string }>;
}
export interface ReviewFacts extends ReviewFactIdentity {
    schemaVersion: 'review-test-facts-v1'; module: string; testHash: string; executionVerified: boolean;
    imports: Array<{ line: number; binding: string; origin: string }>;
    classes: Array<{ line: number; name: string; kind: 'unittest-harness' }>;
    methods: ReviewMethodFacts[]; limitations: string;
}
interface Observation { call: TraceValueSnapshot; result_snapshot: TraceValueSnapshot }
export interface BuildReviewFactsOptions extends ReviewFactIdentity {
    code: string; module: string; python: string; env: NodeJS.ProcessEnv; executionVerified: boolean;
    numericEvidencePrompt?: string;
    /** Only the host may associate already checked Trace with its source identity. */
    observations?: ReviewFactIdentity & { value: BehaviorObservations };
    knownSecrets?: readonly string[];
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(reason: string): never {
    throw new AnalysisStageError('validation', 'reviewer-facts', 'Reviewer facts could not be bound to this candidate.', { reasonCode: reason });
}
const sameIdentity = (left: ReviewFactIdentity, right: ReviewFactIdentity) => left.runId === right.runId
    && left.sourceHash === right.sourceHash && left.target === right.target;

function numericObservations(options: BuildReviewFactsOptions): Observation[] {
    const prompt = options.numericEvidencePrompt;
    if (!prompt) { return []; }
    const start = prompt.indexOf('{');
    let value: unknown;
    try { value = JSON.parse(prompt.slice(start)); } catch { return invalid('numeric-envelope'); }
    if (!prompt.startsWith('VERIFIED_NUMERIC_EVIDENCE_LEDGER_V1\n') || !object(value)
        || value.schemaVersion !== 'numeric-evidence-ledger-v1' || !sameIdentity(value as unknown as ReviewFactIdentity, options)
        || !Array.isArray(value.segments)) { return invalid('numeric-identity'); }
    const result: Observation[] = [];
    for (const segment of value.segments) {
        if (!object(segment) || !Array.isArray(segment.observations)) { return invalid('numeric-segment'); }
        for (const item of segment.observations) {
            if (!object(item) || !typedCallFields(item.call)) { return invalid('numeric-call'); }
            if (item.exception !== undefined) { continue; }
            if (!validTraceValueSnapshot(item.result_snapshot) || !item.result_snapshot.replayable) { return invalid('numeric-result'); }
            result.push({ call: item.call, result_snapshot: item.result_snapshot });
        }
    }
    return result;
}

function controlledObservations(options: BuildReviewFactsOptions): Observation[] {
    const wrapped = options.observations;
    if (!wrapped) { return []; }
    if (!sameIdentity(wrapped, options)) { return invalid('trace-identity'); }
    let trace: BehaviorObservations;
    try { trace = parseBehaviorObservations(structuredClone(wrapped.value), options.target); } catch { return []; }
    if (!trace.complete || trace.load_error || trace.blocked_operations?.length) { return []; }
    return (trace.cases || []).flatMap(item => {
        const observed = trace.examples.find(example => example.case_id === item.case_id);
        const result = (item as unknown as Record<string, unknown>).result_snapshot;
        const input = item.input_before;
        const call = input.call_graph || { schema_version: 'trace-value-v1' as const, replayable: true,
            value: { type: 'dict', items: (['args', 'kwargs', 'constructor_args', 'constructor_kwargs'] as const)
                .filter(field => input[field] !== undefined).map(field => ({ key: { type: 'str', value: field }, value: input[field]!.value })) } };
        if (item.status !== 'returned' || item.inputs_mutated || item.call_assertable === false || !observed
            || observed.call_assertable === false || observed.result_assertable === false || observed.result_truncated
            || observed.non_deterministic_operations?.length || observed.oracle_reason
            || !typedCallFields(call) || !callerMatchesObservation({ trace_input: call }, input)
            || !callerMatchesObservation({ trace_input: call }, item.input_after || undefined)
            || !validTraceValueSnapshot(result) || !result.replayable) { return []; }
        return [{ call, result_snapshot: result }];
    });
}

/** No model request and no submitted source/test execution. A failure is not permission to approve. */
export async function buildReviewFacts(options: BuildReviewFactsOptions): Promise<ReviewFacts> {
    if (!/^[a-f0-9]{64}$/.test(options.sourceHash) || !options.runId || !options.target) { invalid('identity'); }
    const observations = [...numericObservations(options), ...controlledObservations(options)];
    const input = JSON.stringify({ ...options, python: undefined, env: undefined, knownSecrets: undefined,
        numericEvidencePrompt: undefined, observations });
    if (containsCredential(input, options.knownSecrets)) { invalid('sensitive-evidence'); }
    const run = await runSpawn(options.python, ['-B', pythonToolPath('reviewFacts')],
        { env: options.env, input, timeout: 5000 });
    if (run.code !== 0 || run.stdout.length > 200000) { invalid('ast-unavailable'); }
    let value: unknown;
    try { value = JSON.parse(run.stdout); } catch { invalid('invalid-ast-result'); }
    if (!object(value) || value.schemaVersion !== 'review-test-facts-v1' || !sameIdentity(value as unknown as ReviewFactIdentity, options)
        || value.module !== options.module || value.testHash !== evidenceHash(options.code)
        || !Array.isArray(value.imports) || !Array.isArray(value.classes) || !Array.isArray(value.methods)
        || containsCredential(run.stdout, options.knownSecrets)) { invalid('ast-identity'); }
    return value as unknown as ReviewFacts;
}

/** The prompt includes every fact used by the guard, with bulky typed call snapshots omitted. */
export function reviewFactsForPrompt(facts: ReviewFacts): string {
    return 'HOST_VERIFIED_REVIEW_FACTS_V1\n' + JSON.stringify({ ...facts,
        methods: facts.methods.map(method => ({ ...method, calls: method.calls.map(call => ({ line: call.line })) })) });
}
