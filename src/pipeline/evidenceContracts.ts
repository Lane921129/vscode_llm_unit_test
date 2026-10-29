import type { InputPlanSummary } from './inputPlanning';
import type { TraceStartupBudget } from './traceStartupBudget';

export const EVIDENCE_CONTRACT_VERSIONS = {
    typeShape: 'type-shape-v1', inputPlan: 'input-plan-v1',
    behaviorObservations: 'behavior-observations-v2',
    analystEvidence: 'analysis-evidence-v2',
    semanticPlan: 'semantic-plan-v2',
    ruleSelection: 'rule-selection-v2',
    writerEvidence: 'writer-evidence-v3'
} as const;

export type TraceValue = { type: string; value?: string | boolean; items?: Array<TraceValue | { key: TraceValue; value: TraceValue }>;
    reason?: string; python_type?: string };
export interface TraceValueSnapshot { schema_version: 'trace-value-v1'; replayable: boolean; value: TraceValue }
export interface TraceInputSnapshot {
    args?: TraceValueSnapshot; kwargs?: TraceValueSnapshot;
    constructor_args?: TraceValueSnapshot; constructor_kwargs?: TraceValueSnapshot;
    call_graph?: TraceValueSnapshot; replayable?: boolean; unavailable_input?: TraceValueSnapshot;
}
export interface ObservationOrigin {
    kind: 'caller_literals' | 'source_guided' | 'semantic_guided' | 'unknown';
    file?: string; caller?: string; line?: number; detail?: string; requestId?: string;
    generator_version?: 'input-plan-v1'; parameter?: string; reason?: string; intent?: 'valid' | 'negative';
}
export interface ProbeCaseObservation {
    case_id: string;
    case_index?: number;
    status: 'returned' | 'raised' | 'blocked' | 'setup_error' | 'timeout' | 'not_started' | 'worker_error';
    source: ObservationOrigin;
    source_sites?: ObservationOrigin[];
    input_before: TraceInputSnapshot;
    input_after: TraceInputSnapshot | null;
    inputs_mutated?: boolean;
    duration_ms: number;
    reason?: string;
    diagnostic?: string;
    call_assertable?: boolean;
}

/** A single, bounded result from controlled Python execution. */
export interface BehaviorObservation {
    case_id?: string;
    source?: ObservationOrigin;
    source_sites?: ObservationOrigin[];
    input_before?: TraceInputSnapshot;
    input_after?: TraceInputSnapshot | null;
    inputs_mutated?: boolean;
    args: string[];
    kwargs?: Record<string, string>;
    constructor_args?: string[];
    constructor_kwargs?: Record<string, string>;
    result?: string;
    result_type?: string;
    result_assertable?: boolean;
    result_truncated?: boolean;
    call_assertable?: boolean;
    non_deterministic_operations?: string[];
    oracle_reason?: 'uncontrolled-ambient-read' | 'unreplayable-input' | 'conflicting-observations';
    exception?: string;
    exception_module?: string;
    exception_qualname?: string;
    message?: string;
}

/**
 * Controlled execution observations are input/output evidence, not a
 * line-by-line debugger trace. Blocked operations remain diagnostics only.
 */
export interface BehaviorObservations {
    schema_version?: 'behavior-observations-v2';
    run_id?: string;
    cases?: ProbeCaseObservation[];
    isolation?: 'fresh-process-per-case';
    complete?: boolean;
    duration_ms?: number;
    trace_timing?: TraceStartupBudget;
    planning?: { status: 'completed' | 'failed' | 'timeout' | 'worker_error'; duration_ms?: number };
    input_plan?: InputPlanSummary;
    input_deduplication?: { schema_version: 'probe-case-deduplication-v1'; planned_count: number;
        unique_count: number; duplicate_count: number; source_count: number };
    recovery_reason?: string;
    func_name: string;
    args: string[];
    examples: BehaviorObservation[];
    errors: BehaviorObservation[];
    load_error: string | null;
    load_diagnostic?: { stage: string; exception_type: string; message: string; missing_module: string | null; traceback: string };
    blocked_operations?: string[];
    input_source?: 'caller_literals' | 'source_guided' | 'source_guided_retry' | 'semantic_guided' | 'user_fixture';
}

export interface SelectedTestRule {
    skillVersion?: number;
    ruleId: string;
    title: string;
    triggerFacts: string[];
    relatedAnalystHints: string[];
    guidance: string[];
}

export interface RuleSelectionV2 {
    schemaVersion: 'rule-selection-v2';
    selectedRules: SelectedTestRule[];
    ids: string[];
    guidance: string;
    provenance: 'deterministic';
    sourceHash: string;
    dispatcherVersion: 'test-rule-dispatcher-v2';
}

/** Normalized Analyst output. It remains a hypothesis until execution validates it. */
export interface SemanticPlanV2 {
    schemaVersion: 'semantic-plan-v2';
    sourceHash: string;
    hypotheses: unknown;
    provenance: 'model-hypothesis';
}

/** Evidence package passed to Writer roles after analysis and rule selection. */
export interface WriterEvidenceBundleV3 {
    schemaVersion: 'writer-evidence-v3';
    sourceHash: string;
    semanticGuidance: string;
    semanticPlan?: SemanticPlanV2;
    ruleSelection: RuleSelectionV2;
    initialTargetObservations?: BehaviorObservations;
    supplementalTargetObservations?: BehaviorObservations;
    mergedTargetObservations?: BehaviorObservations;
    evidencePriority: readonly [
        'executed-observations',
        'explicit-source-paths',
        'ast-structure',
        'analyst-hypotheses-and-rule-guidance'
    ];
}

export function summarizeObservationPhase(observations?: BehaviorObservations): string {
    if (!observations) {return 'unavailable';}
    if (observations.load_error) {return `unavailable (${observations.load_error})`;}
    const blocked = observations.blocked_operations?.length || 0;
    return `${observations.examples.length} successful, ${observations.errors.length} exceptional, ${blocked} blocked`;
}

/** Keep assertion facts intact; unavailable return representations remain in the full artifacts. */
export function observationsForPrompt(observations?: BehaviorObservations): unknown {
    if (!observations) { return null; }
    const project = (items: BehaviorObservation[] = []) => {
        const facts = new Map<string, Record<string, unknown>>();
        for (const item of items) {
            const { case_id, source: _source, input_before: _before, input_after: _after, ...fact } = item;
            const key = JSON.stringify(fact);
            if (!facts.has(key)) {
                const projected: Record<string, unknown> = { ...fact, case_ids: [] };
                if (fact.result_assertable === false || fact.call_assertable === false || fact.result_truncated === true
                    || fact.oracle_reason || fact.non_deterministic_operations?.length
                    || fact.result_type === 'non_assertable' || projected.non_assertable === true) {
                    if (fact.result !== undefined || fact.result_type !== undefined) {
                        delete projected.result;
                        delete projected.result_type;
                        projected.resultDetails = 'artifact-only; non-assertable return';
                    }
                }
                facts.set(key, projected);
            }
            if (case_id) { (facts.get(key)!.case_ids as string[]).push(case_id); }
        }
        return [...facts.values()];
    };
    const caseStatuses: Record<string, number> = {};
    for (const item of observations.cases || []) { caseStatuses[item.status] = (caseStatuses[item.status] || 0) + 1; }
    return { func_name: observations.func_name, args: observations.args, examples: project(observations.examples),
        ...(observations.input_plan ? { inputPlanning: { status: observations.input_plan.status,
            diagnostics: observations.input_plan.diagnostics } } : {}),
        errors: project(observations.errors || []), load_error: observations.load_error,
        blocked_operations: observations.blocked_operations, complete: observations.complete,
        caseStatuses, snapshotDetails: 'artifact-only; not state assertions' };
}

export function dependencyContextsForPrompt(contexts: any[] = []): unknown[] {
    return contexts.map(({ traceResult, ...context }) => ({ ...context, traceResult: observationsForPrompt(traceResult) }));
}

export function formatWriterEvidenceBundleForPrompt(bundle: WriterEvidenceBundleV3): string {
    const ruleIds = bundle.ruleSelection.ids.join(', ') || 'none';
    return [
        '=== WRITER EVIDENCE BUNDLE V3 ===',
        `Source hash: ${bundle.sourceHash}`,
        `Initial controlled observations: ${summarizeObservationPhase(bundle.initialTargetObservations)}`,
        `Supplemental controlled observations: ${summarizeObservationPhase(bundle.supplementalTargetObservations)}`,
        `Merged controlled observations: ${summarizeObservationPhase(bundle.mergedTargetObservations)}`,
        `Deterministically selected test rules: ${ruleIds}`,
        'Evidence priority: executed observations > explicit source paths > AST structure > analyst hypotheses and rule guidance.',
        'Unassertable observations, including uncontrolled-ambient-read, are diagnostics only. Never copy their values or exceptions into assertions. Control clock/entropy at its target use point with an explicit mock or injected input.',
        'Test-generation rules constrain test construction. They are not evidence of a return value or exception.',
        '',
        bundle.semanticGuidance.trim(),
        ''
    ].join('\n');
}
