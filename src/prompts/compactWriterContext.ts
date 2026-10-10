import { observationsForPrompt, summarizeObservationPhase, WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { formatTargetContract } from '../pipeline/targetContract';
import { estimatePromptTokens } from './promptBudget';
import { matchingWriterExamples } from './verifiedWriterExamples';
import { callerForPrompt } from '../pipeline/probeInputs';
import { DEPENDENCY_MOCK_SHAPE_GUIDANCE, formatDependencyMockContract, TEST_IMPORT_GUIDANCE } from './dependencyMockContract';

export const COMPACT_WRITER_VERSION = 'compact-writer-v1';

/** Required evidence is never sliced to fit; the caller refuses oversize requests. */
interface WriterContextInput {
    module: string; name: string; source: string; context?: any;
    evidence: WriterEvidenceBundleV3; focus?: string; budgetTokens: number;
    allowedMockTargets?: readonly string[];
}

/** Revision keeps all required facts, without generation examples or analyst proposals. */
export function buildWriterRevisionContext(input: Omit<WriterContextInput, 'focus' | 'budgetTokens'>): string {
    return buildWriterContext({ ...input, budgetTokens: 0 }, true);
}

export function buildCompactWriterContext(input: WriterContextInput): string {
    return buildWriterContext(input, false);
}

function buildWriterContext(input: WriterContextInput, revision: boolean): string {
    const context = input.context || {};
    const dependencies: any[] = context.dependencyContexts || [];
    const sections = [
        (revision ? 'writer-revision-context-v1' : COMPACT_WRITER_VERSION) + ' (metadata, never an import)',
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
            callers: (context.callerContexts || []).map(callerForPrompt), conditions: context.condition_facts || []
        }),
        'FIXTURE CHECK: Arrange constructor inputs and per-case state. ' + TEST_IMPORT_GUIDANCE + ' '
            + 'Keep the target real; patch dependencies at use points. ' + DEPENDENCY_MOCK_SHAPE_GUIDANCE + ' '
            + 'Dependency returns are not target returns. '
            + 'Exceptions require evidence; preserve passing tests.',
        formatDependencyMockContract(input.module, context, input.allowedMockTargets),
        // The caller-partitioned AST trace is authoritative here. Using the
        // bundle's merged trace would leak another caller's assertion oracle.
        'VERIFIED OBSERVATIONS (exact call/setup only; blocked or unassertable entries are diagnostics):\n'
            + JSON.stringify(observationsForPrompt(context.traceResult)),
        'uncontrolled-ambient-read observations cannot supply expected values or exceptions. Control clock/entropy at its use point before asserting.',
        'VERIFIED DEPENDENCY OBSERVATIONS (never substitute for target results):\n'
            + JSON.stringify(dependencies.filter(dep => dep.traceResult).map(dep => ({ name: dep.name, observations: observationsForPrompt(dep.traceResult) }))),
        'SELECTED RULES (construction constraints, not output facts):\n'
            + input.evidence.ruleSelection.selectedRules.map(rule => `[${rule.ruleId}] ${rule.title}\n${rule.guidance.join('\n')}`).join('\n\n'),
        ...(input.focus ? ['CURRENT TESTS AND NEXT TASK (preserve passing methods; proposed tasks are hypotheses):\n' + input.focus] : []),
        (revision ? 'Revise the complete current unittest file for the supplied findings; preserve passing methods and verified assertions. '
            : 'Write one complete unittest file in one Python fence. Initially choose 1–3 supported cases; later add focused cases while preserving all passing methods. ')
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
    const sourceReferences = new Map<string, string>([[input.source, 'TARGET SOURCE']]);
    for (const dep of dependencies) {
        // All revision dependency fields remain available. The raw trace is
        // represented once above with its safety/assertability flags intact.
        const { code, traceResult: _trace, ...facts } = dep;
        const dependencySource = typeof code === 'string' ? code : '';
        const previous = dependencySource ? sourceReferences.get(dependencySource) : undefined;
        const block = `RETRIEVED DEPENDENCY ${dep.name} (setup/path context only):\n`
            + JSON.stringify(revision ? facts : { sourceHash: dep.sourceHash, retrieval: dep.retrieval,
                imports: dep.file_imports || [], globals: dep.referenced_globals || [] })
            + (previous ? `\nComplete source is identical to ${previous} above; reuse that source, not its observations.`
                : `\n\`\`\`python\n${dependencySource}\n\`\`\``);
        if (revision) { sections.push(block); }
        else if (!append(block)) { omitted.push(dep.name); continue; }
        if (dependencySource && !previous) { sourceReferences.set(dependencySource, `RETRIEVED DEPENDENCY ${dep.name}`); }
    }
    if (omitted.length) { sections.push(`Dependency source omitted as whole units for budget: ${omitted.join(', ')}. Their behavior is unknown; do not infer it.`); }
    if (revision) { return sections.filter(Boolean).join('\n\n'); }
    for (const example of matchingWriterExamples({ ...context, selectedRuleIds: input.evidence.ruleSelection.ids })) {
        append(`VERIFIED PATTERN ${example.id} (unrelated neutral fixture; adapt setup only, never copy its target, inputs or expected values):\n`
            + `Example source:\n\`\`\`python\n${example.source}\n\`\`\`\nExample test:\n\`\`\`python\n${example.tests}\n\`\`\``);
    }
    if (input.evidence.semanticPlan) {
        append('OPTIONAL ANALYST HYPOTHESES (unverified; never an assertion oracle):\n' + JSON.stringify(input.evidence.semanticPlan.hypotheses));
    }
    return sections.join('\n\n');
}
