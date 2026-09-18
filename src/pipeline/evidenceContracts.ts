export const EVIDENCE_CONTRACT_VERSIONS = {
    analystEvidence: 'analysis-evidence-v2',
    semanticPlan: 'semantic-plan-v2',
    ruleSelection: 'rule-selection-v2',
    writerEvidence: 'writer-evidence-v3'
} as const;

/** A single, bounded result from controlled Python execution. */
export interface BehaviorObservation {
    args: string[];
    kwargs?: Record<string, string>;
    constructor_args?: string[];
    constructor_kwargs?: Record<string, string>;
    result?: string;
    result_type?: string;
    result_assertable?: boolean;
    call_assertable?: boolean;
    non_deterministic_operations?: string[];
    oracle_reason?: 'uncontrolled-ambient-read';
    exception?: string;
    message?: string;
}

/**
 * Controlled execution observations are input/output evidence, not a
 * line-by-line debugger trace. Blocked operations remain diagnostics only.
 */
export interface BehaviorObservations {
    func_name: string;
    args: string[];
    examples: BehaviorObservation[];
    errors: BehaviorObservation[];
    load_error: string | null;
    load_diagnostic?: { stage: string; exception_type: string; message: string; missing_module: string | null; traceback: string };
    blocked_operations?: string[];
    input_source?: 'caller_literals' | 'source_guided' | 'source_guided_retry' | 'semantic_guided';
}

export interface SelectedTestRule {
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
