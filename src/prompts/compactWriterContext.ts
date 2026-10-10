import { BehaviorObservations, observationsForPrompt, summarizeObservationPhase, WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { formatTargetContract } from '../pipeline/targetContract';
import { estimatePromptTokens } from './promptBudget';
import { matchingWriterExamples } from './verifiedWriterExamples';
import { callerForPrompt } from '../pipeline/probeInputs';
import { formatDependencyMockContract, formatDependencyTopology, relevantSourceImports } from './dependencyMockContract';

export const COMPACT_WRITER_VERSION = 'compact-writer-v1';

/** Required evidence is never sliced to fit; the caller refuses oversize requests. */
interface WriterContextInput {
    module: string; name: string; source: string; context?: any;
    evidence: WriterEvidenceBundleV3; focus?: string; budgetTokens: number;
    allowedMockTargets?: readonly string[];
    /** An explicit host-selected scenario, never selected by truncating facts to fit. */
    scenarioCaseIds?: readonly string[];
}

/** Revision keeps all required facts, without generation examples or analyst proposals. */
export function buildWriterRevisionContext(input: Omit<WriterContextInput, 'focus' | 'budgetTokens'>): string {
    return buildWriterContext({ ...input, scenarioCaseIds: undefined, budgetTokens: 0 }, true);
}

export function buildCompactWriterContext(input: WriterContextInput): string {
    return buildWriterContext(input, false);
}

function buildWriterContext(input: WriterContextInput, revision: boolean): string {
    const context = { ...input.context, code: input.source };
    const dependencies: any[] = context.dependencyContexts || [];
    const scenario = selectWriterScenario(context.traceResult, input.scenarioCaseIds);
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
            globals: context.referenced_globals || [],
            callers: (context.callerContexts || []).map(callerForPrompt), conditions: context.condition_facts || []
        }),
        'FIXTURE CHECK: Import unittest and test helpers explicitly in test scope; never use wildcard target imports. '
            + 'Arrange constructor inputs and per-case state. Dependency returns are not target returns.',
        formatDependencyMockContract(input.module, context, input.allowedMockTargets, revision),
        // The caller-partitioned AST trace is authoritative here. Using the
        // bundle's merged trace would leak another caller's assertion oracle.
        'VERIFIED OBSERVATIONS (exact call/setup only; blocked or unassertable entries are diagnostics):\n'
            + JSON.stringify(observationsForPrompt(scenario.observations)),
        ...(scenario.note ? [scenario.note] : []),
        'uncontrolled-ambient-read observations cannot supply expected values or exceptions. Control clock/entropy at its use point before asserting.',
        'VERIFIED DEPENDENCY OBSERVATIONS (never substitute for target results):\n'
            + JSON.stringify(dependencies.filter(dep => dep.traceResult).map(dep => ({ name: dep.name, observations: observationsForPrompt(dep.traceResult) }))),
        'SELECTED RULES (construction constraints, not output facts):\n'
            + formatUniqueRules(input.evidence),
        ...(input.focus ? ['CURRENT TESTS AND NEXT TASK (preserve passing methods; proposed tasks are hypotheses):\n' + input.focus] : []),
        (revision ? 'Revise the complete current unittest file for the supplied findings; preserve passing methods and verified assertions. '
            : 'Write one complete unittest file in one Python fence for the requested case. ')
            + 'Source, annotations, retrieved helpers and examples alone do not prove outputs. '
            + 'No direct network, file I/O, shell, dynamic execution or shared SQLite; use explicit boundary mocks or host-declared resources. '
            + (context.is_async ? 'Use IsolatedAsyncioTestCase and await. ' : '')
            + 'No evidence means omit that assertion, never guess.'
    ];
    // Optional retrieval must not expand a small target to the entire context.
    // Reserve space for host contracts and a concrete repair; required evidence
    // above remains complete even when it exceeds the final request budget.
    const requiredTokens = estimatePromptTokens(sections.filter(Boolean).join('\n\n'));
    const optionalBudget = Math.max(0, Math.min(input.budgetTokens - 1200,
        requiredTokens + Math.min(600, Math.floor(input.budgetTokens / 8))));
    const append = (section: string): boolean => {
        if (estimatePromptTokens([...sections, section].join('\n\n')) > optionalBudget) { return false; }
        sections.push(section); return true;
    };
    // This AST projection duplicates full target-source structure, not executed
    // evidence. Prefer its complete bound graph over optional helpers/examples;
    // generation may omit it as one unit. Repairs retain it as required above.
    const topology = revision ? '' : formatDependencyTopology(context);
    if (topology && !append(topology)) {
        sections.push('Topology/legend omitted whole for budget, not absence of dependencies. '
            + 'Use complete TARGET SOURCE; unknown stays unknown.');
    }
    const omitted: string[] = [];
    const sourceReferences = new Map<string, string>([[input.source, 'TARGET SOURCE']]);
    for (const dep of dependencies) {
        // All revision dependency fields remain available. The raw trace is
        // represented once above with its safety/assertability flags intact.
        const { code } = dep;
        const facts = dependencySetupFacts(dep);
        const dependencySource = typeof code === 'string' ? code : '';
        const previous = dependencySource ? sourceReferences.get(dependencySource) : undefined;
        const block = `RETRIEVED DEPENDENCY ${dep.name} (setup/path context only):\n`
            + JSON.stringify(facts)
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

/** Preserve every selected constraint, but do not repeat identical guidance. */
function formatUniqueRules(evidence: WriterEvidenceBundleV3): string {
    const owner = new Map<string, string>();
    return evidence.ruleSelection.selectedRules.map(rule => {
        const unique: string[] = [], repeated = new Set<string>();
        for (const guidance of rule.guidance) {
            const previous = owner.get(guidance);
            if (previous) { repeated.add(previous); }
            else { owner.set(guidance, rule.ruleId); unique.push(guidance); }
        }
        return `[${rule.ruleId}] ${rule.title}\n${unique.join('\n')}`
            + (repeated.size ? `\nIdentical guidance above: ${[...repeated].join(', ')}` : '');
    }).join('\n\n');
}

/** Keep setup and source identity, not recursive copies of the retrieval graph. */
function dependencySetupFacts(dep: any): Record<string, unknown> {
    const facts: Record<string, unknown> = {};
    for (const key of ['name', 'sourceHash', 'sourceVersions', 'retrieval', 'args', 'signature', 'required_args',
        'class_name', 'method_kind', 'class_context', 'property_context', 'is_async', 'is_generator',
        'referenced_globals', 'condition_facts', 'dependencyResolution', 'dependency_fixture_contract']) {
        if (dep[key] !== undefined) { facts[key] = dep[key]; }
    }
    const imports = relevantSourceImports(dep);
    if (imports.length) { facts.imports = imports; }
    return facts;
}

/** Select whole exact cases; a stale/missing identifier fails open to full evidence. */
export function selectWriterScenario(observations?: BehaviorObservations, caseIds?: readonly string[]): {
    observations?: BehaviorObservations; note?: string;
} {
    if (!observations || !caseIds?.length) { return { observations }; }
    const wanted = new Set(caseIds);
    const known = new Set([...observations.examples || [], ...observations.errors || []]
        .flatMap(item => item.case_id ? [item.case_id] : []));
    if ([...wanted].some(id => !known.has(id))) {
        return { observations, note: 'SCENARIO SELECTION unresolved: retained all observations; do not borrow another case oracle.' };
    }
    const selected = <T extends { case_id?: string }>(items: T[] = []) => items.filter(item => item.case_id && wanted.has(item.case_id));
    return { observations: { ...observations, examples: selected(observations.examples), errors: selected(observations.errors),
        cases: selected(observations.cases) },
    note: `SCENARIO SELECTION: exact case IDs ${[...wanted].join(', ')}. Other cases remain in the artifact, not this request; make no claims about them.` };
}
