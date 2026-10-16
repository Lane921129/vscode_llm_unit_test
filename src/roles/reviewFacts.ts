import { evidenceHash } from '../pipeline/analysisJournal';
import { containsCredential } from '../pipeline/artifactSafety';
import { parseBehaviorObservations } from '../pipeline/behaviorObservations';
import { BehaviorObservations, TraceValueSnapshot } from '../pipeline/evidenceContracts';
import { callerMatchesObservation, typedCallFields } from '../pipeline/probeInputs';
import { pythonToolPath } from '../pipeline/pythonTools';
import { validTraceValueSnapshot } from '../pipeline/traceValues';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { runSpawn } from '../utils/processRunner';
import { ROLE_CONTRACT_VERSIONS } from './roleContracts';

export interface ReviewFactIdentity { runId: string; sourceHash: string; target: string }
export type ReviewObservationStatus = 'verified' | 'contradicted' | 'unknown';
export interface ReviewAssertionFact {
    line: number; kind: string; targetResult?: boolean; expectedType?: string;
    expected?: TraceValueSnapshot; observationVerified?: boolean; observationStatus?: ReviewObservationStatus; targetCallLine?: number;
}

/** Missing legacy flags mean unknown, never a contradicted expected value. */
export function reviewAssertionObservationStatus(assertion: ReviewAssertionFact): ReviewObservationStatus | undefined {
    if (assertion.observationVerified !== undefined && typeof assertion.observationVerified !== 'boolean') { return undefined; }
    const status = assertion.observationStatus;
    if (status === undefined) { return assertion.observationVerified === true ? 'verified' : 'unknown'; }
    if (!['verified', 'contradicted', 'unknown'].includes(status)
        || status === 'verified' && assertion.observationVerified === false
        || status !== 'verified' && assertion.observationVerified === true) { return undefined; }
    return status;
}
export interface ReviewMethodFacts {
    line: number; endLine: number; name: string; assertions: ReviewAssertionFact[];
    calls: Array<{ line: number; call: TraceValueSnapshot; observationReturned?: true; spellings?: string[] }>;
    exceptionGuards: Array<{ line: number; exception: string; callLines: number[] }>;
    scalarBindings: Array<{ line: number; name: string; type: string }>;
    mockAssertions?: Array<{ line: number; kind: string; patchTarget: string; mockPath: string; targetCallLine: number }>;
    /** Tool-owned inherited unittest method syntax, not proof of execution or expected values. */
    standardAssertions?: Array<{ line: number; kind: string }>;
    /** Complete AST-owned call spellings; only recognize unchanged edit proposals. */
    standardAssertionCalls?: Array<{ line: number; kind: string; spellings: string[] }>;
    /** Syntax presence, not proof that a patch ran or implements a requirement. */
    dependencyPatchSyntax?: Array<{ line: number; origin: string; target: string; binding: string; spellings: string[] }>;
}
export interface ReviewFacts extends ReviewFactIdentity {
    schemaVersion: 'review-test-facts-v1'; module: string; testHash: string; executionVerified: boolean;
    imports: Array<{ line: number; binding: string; origin: string; harnessUseLines?: number[]; targetUseLines?: number[] }>;
    /** Syntax presence only, never proof of wildcard exports or the final binding. */
    importStatements?: Array<{ line: number; module: string; wildcard: boolean }>;
    classes: Array<{ line: number; name: string; kind: 'unittest-harness' }>;
    methods: ReviewMethodFacts[]; limitations: string;
}

const REVIEW_EVIDENCE_ASSERTION_LIMIT = 256;
const REVIEW_EVIDENCE_ASSERTION_KINDS = new Set([
    'assertEqual', 'assertNotEqual', 'assertAlmostEqual', 'assertNotAlmostEqual',
    'assertTrue', 'assertFalse', 'assertIs', 'assertIsNot', 'assertIsNone', 'assertIsNotNone',
    'assertIn', 'assertNotIn', 'assertGreater', 'assertGreaterEqual', 'assertLess', 'assertLessEqual',
    'assertIsInstance', 'assertNotIsInstance', 'assertCountEqual', 'assertSequenceEqual',
    'assertListEqual', 'assertTupleEqual', 'assertDictEqual', 'assertSetEqual', 'assertMultiLineEqual',
    'assertRaises', 'assertRaisesRegex'
]);

/** Safe event data only. This describes supplied implementation observations;
 * it neither approves a review nor proves independent product requirements. */
export interface ReviewerEvidenceDiagnostic {
    schemaVersion: 'reviewer-evidence-v1';
    contractVersion: typeof ROLE_CONTRACT_VERSIONS.reviewer;
    factsVersion: 'review-test-facts-v1';
    sourceHash: string;
    testHash: string;
    executionVerified: boolean;
    methodCount: number;
    assertionCount: number;
    targetAssertionCount: number;
    observationVerifiedCount: number;
    observationContradictedCount: number;
    observationUnknownCount: number;
    returnedCallCount: number;
    assertionDetailsComplete: boolean;
    assertions: Array<{ line: number; kind: string; targetResult: boolean; observationVerified: boolean; observationStatus: ReviewObservationStatus }>;
}

/** Do not spread facts here: target names, module paths, call arguments,
 * expected values, source spellings and provider text are artifact data. */
export function buildReviewerEvidenceDiagnostic(facts: ReviewFacts): ReviewerEvidenceDiagnostic {
    const fail = (): never => { throw new TypeError('Invalid reviewer evidence diagnostic input'); };
    if (facts.schemaVersion !== 'review-test-facts-v1' || typeof facts.sourceHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(facts.sourceHash) || typeof facts.testHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(facts.testHash) || !Array.isArray(facts.methods)) { fail(); }
    let assertionCount = 0;
    let targetAssertionCount = 0;
    let observationVerifiedCount = 0;
    let observationContradictedCount = 0;
    let observationUnknownCount = 0;
    let returnedCallCount = 0;
    const assertions: ReviewerEvidenceDiagnostic['assertions'] = [];
    for (const method of facts.methods) {
        if (!method || !Array.isArray(method.assertions) || !Array.isArray(method.calls)) { fail(); }
        returnedCallCount += method.calls.filter(call => call?.observationReturned === true).length;
        for (const assertion of method.assertions) {
            if (!assertion || !Number.isSafeInteger(assertion.line) || assertion.line < 1) { fail(); }
            const observationStatus = reviewAssertionObservationStatus(assertion) ?? fail();
            assertionCount++;
            if (assertion.targetResult === true) { targetAssertionCount++; }
            if (observationStatus === 'verified') { observationVerifiedCount++; }
            else if (observationStatus === 'contradicted') { observationContradictedCount++; }
            else { observationUnknownCount++; }
            if (assertions.length < REVIEW_EVIDENCE_ASSERTION_LIMIT) {
                assertions.push({ line: assertion.line,
                    kind: REVIEW_EVIDENCE_ASSERTION_KINDS.has(assertion.kind) ? assertion.kind : 'other',
                    targetResult: assertion.targetResult === true, observationVerified: observationStatus === 'verified', observationStatus });
            }
        }
    }
    return { schemaVersion: 'reviewer-evidence-v1', contractVersion: ROLE_CONTRACT_VERSIONS.reviewer,
        factsVersion: 'review-test-facts-v1', sourceHash: facts.sourceHash, testHash: facts.testHash,
        executionVerified: facts.executionVerified === true, methodCount: facts.methods.length,
        assertionCount, targetAssertionCount, observationVerifiedCount, observationContradictedCount, observationUnknownCount, returnedCallCount,
        assertionDetailsComplete: assertionCount === assertions.length, assertions };
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
    for (const method of value.methods) {
        if (object(method) && Array.isArray(method.calls) && method.calls.some((call: unknown) => !object(call)
            || call.observationReturned !== undefined && call.observationReturned !== true
            || call.spellings !== undefined && (!Array.isArray(call.spellings) || call.spellings.length < 1 || call.spellings.length > 2
                || call.spellings.some((text: unknown) => typeof text !== 'string' || !text || text.length > 200000)))) {
            invalid('ast-call-observation-shape');
        }
        if (object(method) && Array.isArray(method.assertions) && method.assertions.some((assertion: unknown) => !object(assertion)
            || assertion.targetCallLine !== undefined && (!Number.isSafeInteger(assertion.targetCallLine)
                || !Array.isArray(method.calls) || !method.calls.some((call: Record<string, unknown>) => call.line === assertion.targetCallLine)))) {
            invalid('ast-assertion-call-shape');
        }
        if (object(method) && Array.isArray(method.assertions) && method.assertions.some((assertion: ReviewAssertionFact) =>
            reviewAssertionObservationStatus(assertion) === undefined)) { invalid('ast-assertion-observation-shape'); }
        if (!object(method) || method.standardAssertions === undefined) { continue; }
        if (!Array.isArray(method.standardAssertions) || method.standardAssertions.length > 12000
            || !Number.isSafeInteger(method.line) || !Number.isSafeInteger(method.endLine)
            || method.line < 1 || method.endLine < method.line
            || method.standardAssertions.some((item: unknown) => !object(item)
                || Object.keys(item).some(key => !['line', 'kind'].includes(key))
                || !Number.isSafeInteger(item.line) || item.line < method.line || item.line > method.endLine
                || typeof item.kind !== 'string' || !/^assert[A-Za-z_]\w*$/.test(item.kind))) {
            invalid('ast-standard-assertion-shape');
        }
        for (const field of ['standardAssertionCalls', 'dependencyPatchSyntax'] as const) {
            const items = method[field];
            if (items === undefined) { continue; }
            const allowed = field === 'standardAssertionCalls' ? ['line', 'kind', 'spellings']
                : ['line', 'origin', 'target', 'binding', 'spellings'];
            if (!Array.isArray(items) || items.length > 12000 || items.some((item: unknown) => !object(item)
                || Object.keys(item).some(key => !allowed.includes(key))
                || !Number.isSafeInteger(item.line) || item.line < method.line || item.line > method.endLine
                || !Array.isArray(item.spellings) || item.spellings.length < 1 || item.spellings.length > 2
                || item.spellings.some((text: unknown) => typeof text !== 'string' || !text || text.length > 200000)
                || field === 'standardAssertionCalls' && (typeof item.kind !== 'string'
                    || !method.standardAssertions.some((assertion: Record<string, unknown>) => assertion.line === item.line && assertion.kind === item.kind))
                || field === 'dependencyPatchSyntax' && (item.origin !== 'unittest.mock.patch'
                    || typeof item.target !== 'string' || typeof item.binding !== 'string'))) {
                invalid('ast-review-syntax-shape');
            }
        }
    }
    return value as unknown as ReviewFacts;
}

/** Call spellings already appear in TEST_FILE; project their AST presence without duplicating code. */
export function reviewFactsForPrompt(facts: ReviewFacts): string {
    return 'HOST_VERIFIED_REVIEW_FACTS_V1\n' + JSON.stringify({ ...facts,
        methods: facts.methods.map(method => ({ ...method, calls: method.calls.map(({ line, observationReturned }) => ({ line, observationReturned })),
            assertions: method.assertions.map(({ observationVerified: _legacy, observationStatus: _status, ...assertion }) => {
                const observationStatus = reviewAssertionObservationStatus({ ...assertion, observationVerified: _legacy, observationStatus: _status });
                if (observationStatus === undefined) { invalid('ast-assertion-observation-shape'); }
                return { ...assertion, observationStatus };
            }),
            standardAssertionCalls: method.standardAssertionCalls?.map(({ line, kind }) => ({ line, kind })),
            dependencyPatchSyntax: method.dependencyPatchSyntax?.map(({ line, origin, target, binding }) => ({ line, origin, target, binding })) })) });
}
