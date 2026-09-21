import { observationsForPrompt, summarizeObservationPhase, WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { formatTargetContract } from '../pipeline/targetContract';
import { estimatePromptTokens } from './promptBudget';
import { matchingWriterExamples } from './verifiedWriterExamples';

export const COMPACT_WRITER_VERSION = 'compact-writer-v1';

/** Required evidence is never sliced to fit; the caller refuses oversize requests. */
export function buildCompactWriterContext(input: {
    module: string; name: string; source: string; context?: any;
    evidence: WriterEvidenceBundleV3; focus?: string; budgetTokens: number;
}): string {
    const context = input.context || {};
    const dependencies: any[] = context.dependencyContexts || [];
    const sections = [
        COMPACT_WRITER_VERSION,
        '=== WRITER EVIDENCE BUNDLE V3 ===',
        formatTargetContract(input.module, input.name, context.args || [], context),
        `Source hash: ${input.evidence.sourceHash}`,
        `Initial controlled observations: ${summarizeObservationPhase(input.evidence.initialTargetObservations)}\n`
            + `Supplemental controlled observations: ${summarizeObservationPhase(input.evidence.supplementalTargetObservations)}\n`
            + `Deterministically selected test rules: ${input.evidence.ruleSelection.ids.join(', ') || 'none'}\n`
            + 'Test-generation rules constrain test construction. They are not evidence of a return value or exception.',
        `TARGET SOURCE (read-only, not an output oracle):\n\`\`\`python\n${input.source}\n\`\`\``,
        'SETUP FACTS (source only; caller values are input candidates, not expected outputs):\n' + JSON.stringify({
            constructor: context.class_context || null, property: context.property_context || null,
            imports: context.file_imports || [], globals: context.referenced_globals || [],
            callers: context.callerContexts || [], conditions: context.condition_facts || []
        }),
        'FIXTURE CHECK: Arrange required constructor inputs and per-case state. '
            + 'Keep the target real. Patch proven dependencies at use points and configure each consumed return layer; a bare MagicMock is not a concrete row, string, number, or timestamp. '
            + 'Declare all test imports. Invalid-input exceptions require evidence. '
            + 'Later tasks add one input/state/mock configuration, verify its behavior, and preserve passing tests.',
        // The caller-partitioned AST trace is authoritative here. Using the
        // bundle's merged trace would leak another caller's assertion oracle.
        'VERIFIED OBSERVATIONS (exact call/setup only; blocked or unassertable entries are diagnostics):\n'
            + JSON.stringify(observationsForPrompt(context.traceResult)),
        'Observations marked uncontrolled-ambient-read are diagnostic values, never fixed expected values or exception facts. '
            + 'Control the clock/entropy at the target use point with an explicit mock, or inject a fixed dependency/input before asserting. '
            + 'Do not copy the observed timestamp/random value into assertions.',
        'VERIFIED DEPENDENCY OBSERVATIONS (never substitute for target results):\n'
            + JSON.stringify(dependencies.filter(dep => dep.traceResult).map(dep => ({ name: dep.name, observations: observationsForPrompt(dep.traceResult) }))),
        'SELECTED RULES (construction constraints, not output facts):\n'
            + input.evidence.ruleSelection.selectedRules.map(rule => `[${rule.ruleId}] ${rule.title}\n${rule.guidance.join('\n')}`).join('\n\n'),
        ...(input.focus ? ['CURRENT TESTS AND NEXT TASK (preserve passing methods; proposed tasks are hypotheses):\n' + input.focus] : []),
        'Write one complete unittest file in one Python fence. Initially choose 1–3 supported cases; later add focused cases while preserving all passing methods. '
            + 'Use the exact target binding. Never copy source into tests. Assertions need exact executed observations, a provable source path, or behavior explicitly controlled by this test. '
            + 'Source, annotations, retrieved helpers and examples alone do not prove outputs. '
            + 'External boundaries require explicit unittest.mock use-point patches or isolated resources; no direct network, file I/O, shell, dynamic execution or shared SQLite. '
            + 'Use IsolatedAsyncioTestCase and await for async targets. No evidence means omit that assertion, never guess.'
    ];
    // Reserve space for the system contract and one concrete validation retry.
    const optionalBudget = Math.max(0, input.budgetTokens - 650);
    const append = (section: string): boolean => {
        if (estimatePromptTokens([...sections, section].join('\n\n')) > optionalBudget) { return false; }
        sections.push(section); return true;
    };
    const omitted: string[] = [];
    for (const dep of dependencies) {
        const block = `RETRIEVED DEPENDENCY ${dep.name} (setup/path context only):\n`
            + JSON.stringify({ sourceHash: dep.sourceHash, retrieval: dep.retrieval,
                imports: dep.file_imports || [], globals: dep.referenced_globals || [] })
            + `\n\`\`\`python\n${dep.code || ''}\n\`\`\``;
        if (!append(block)) { omitted.push(dep.name); }
    }
    if (omitted.length) { sections.push(`Dependency source omitted as whole units for budget: ${omitted.join(', ')}. Their behavior is unknown; do not infer it.`); }
    for (const example of matchingWriterExamples({ ...context, selectedRuleIds: input.evidence.ruleSelection.ids })) {
        append(`VERIFIED PATTERN ${example.id} (unrelated neutral fixture; adapt setup only, never copy its target, inputs or expected values):\n`
            + `Example source:\n\`\`\`python\n${example.source}\n\`\`\`\nExample test:\n\`\`\`python\n${example.tests}\n\`\`\``);
    }
    if (input.evidence.semanticPlan) {
        append('OPTIONAL ANALYST HYPOTHESES (unverified; never an assertion oracle):\n' + JSON.stringify(input.evidence.semanticPlan.hypotheses));
    }
    return sections.join('\n\n');
}
