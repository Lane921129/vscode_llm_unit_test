import { BehaviorObservations, observationsForPrompt, summarizeObservationPhase, TraceInputSnapshot, TraceValueSnapshot, WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { formatTargetContract, formatWriterSeedPackaging } from '../pipeline/targetContract';
import { estimatePromptTokens } from './promptBudget';
import { formatWriterPatternGuide, matchingWriterExamples } from './verifiedWriterExamples';
import { callerForPrompt, callerMatchesObservation, typedCallFields } from '../pipeline/probeInputs';
import { validTraceInputSnapshot, validTraceValueSnapshot } from '../pipeline/traceValues';
import { formatDependencyMockContract, formatDependencyTopology, formatSourceImport, relevantSourceImports } from './dependencyMockContract';

export const COMPACT_WRITER_VERSION = 'compact-writer-v2';

/** Request-local references only replace complete, byte-identical source/setup
 * fields. They never share observations, identities, unknown fields or tests.
 * Call only for sections that will actually be included in this request.
 */
export function createPromptContextReferences() {
    const setups = new Map<string, string>();
    const sources = new Map<string, string>();
    const kinds: Record<string, string> = { constructor: 'constructor', class_context: 'constructor',
        property: 'property', property_context: 'property', globals: 'globals', referenced_globals: 'globals',
        imports: 'imports', file_imports: 'imports' };
    let reused = false;
    return {
        setup(fields: Record<string, unknown>, location: string): Record<string, unknown> {
            return Object.fromEntries(Object.entries(fields).map(([field, value]) => {
                const kind = Object.hasOwn(kinds, field) ? kinds[field] : undefined;
                if (!kind || !value || typeof value !== 'object') { return [field, value]; }
                const serialized = JSON.stringify(value);
                if (serialized.length < 256) { return [field, value]; }
                const key = kind + '\n' + serialized;
                const earlier = setups.get(key);
                if (earlier) { reused = true; return [field, { same_complete_setup_as: earlier }]; }
                setups.set(key, `${location}.${field}`);
                return [field, value];
            }));
        },
        source(value: string, location: string): string | { same_complete_source_as: string } {
            if (value.length < 256) { return value; }
            const earlier = sources.get(value);
            if (earlier) { reused = true; return { same_complete_source_as: earlier }; }
            sources.set(value, location);
            return value;
        },
        note(): string {
            return reused ? 'same_complete_setup_as / same_complete_source_as reuse the complete identical field at the named earlier location in this request. Only source/setup is shared; keep each identity and observation separate. These references grant no patch permission or output oracle.' : '';
        }
    };
}

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
    const references = createPromptContextReferences();
    const callers = groupCallerSetupsForPrompt(context.callerContexts);
    const callerNote = callers.some(caller => Array.isArray(caller.call_sites))
        ? '; call_sites share identical projected setup, not execution results' : '';
    const sourceReferences = new Map<string, string>([[input.source, 'TARGET SOURCE']]);
    const fragments: string[] = [];
    const sourceCode = (code: unknown, location: string): unknown => {
        if (typeof code !== 'string' || !code.trim()) { return code; }
        const previous = sourceReferences.get(code);
        if (previous) { return { same_complete_source_as: previous }; }
        const label = `SOURCE FRAGMENT ${fragments.length + 1}`;
        sourceReferences.set(code, label);
        fragments.push(`${label} (${location}; complete supplied source snippet, scope unchanged):\n\`\`\`python\n${code}\n\`\`\``);
        return { same_complete_source_as: label };
    };
    const setup = references.setup(projectSourceSetup({
        imports: relevantSourceImports(context).map(item => ({ ...item,
            ...(formatSourceImport(item) ? { sourceSpelling: formatSourceImport(item) } : {}) })),
        constructor: context.class_context || null, property: context.property_context || null,
        globals: context.referenced_globals || [], callers, conditions: context.condition_facts || []
    }, 'SOURCE SETUP', sourceCode), 'SOURCE SETUP');
    const dependencyBlocks = dependencies.map((dep, index) => {
        const location = `RETRIEVED DEPENDENCY ${dep.name} [${index + 1}]`;
        const facts = references.setup(projectSourceSetup(dependencySetupFacts(dep), location, sourceCode), location);
        const dependencySource = typeof dep.code === 'string' ? dep.code : '';
        const previous = dependencySource ? sourceReferences.get(dependencySource) : undefined;
        const block = `${location} (setup/path context only):\n` + JSON.stringify(facts)
            + (previous ? `\nComplete source is identical to ${previous} above; reuse that source, not its observations.`
                : `\n\`\`\`python\n${dependencySource}\n\`\`\``);
        if (dependencySource && !previous) { sourceReferences.set(dependencySource, location); }
        return block;
    });
    const targetObservations = partitionWriterObservations(scenario.observations);
    const dependencyObservations = dependencies.flatMap((dep, index) => dep.traceResult ? [{
        dependencyIndex: index + 1, name: dep.name, sourceHash: dep.sourceHash,
        ...partitionWriterObservations(dep.traceResult)
    }] : []);
    if (!revision && context.writerGenerationPhase === 'seed') {
        // Keep the complete source/setup and selected observation data. The
        // standalone seed system already owns the general safety/oracle rules;
        // repeating the full generation tutorial here obscures the one task.
        return [
            COMPACT_WRITER_VERSION + ' (metadata, never an import)',
            formatTargetContract(input.module, input.name, context.args || [], context),
            `Source hash: ${input.evidence.sourceHash}`,
            `TARGET SOURCE (read-only):\n\`\`\`python\n${input.source}\n\`\`\``,
            'SOURCE SETUP (declarations, not runtime values):\n' + JSON.stringify(setup),
            ...fragments, ...dependencyBlocks,
            formatDependencyMockContract(input.module, context, input.allowedMockTargets, false, { sourceImportsListed: true }),
            'VERIFIED OBSERVATIONS (exact call/setup only; not independent requirements):\n'
                + JSON.stringify(targetObservations.observations),
            ...(scenario.note ? [scenario.note] : []),
            'DEPENDENCY OBSERVATIONS (not target results):\n'
                + JSON.stringify(dependencyObservations.map(({ diagnostics: _diagnostics, ...entry }) => entry)),
            'DIAGNOSTICS (never fixtures or expected values):\n' + JSON.stringify({ target: targetObservations.diagnostics,
                dependencies: dependencyObservations.map(({ observations: _observations, ...entry }) => entry) }),
            'SELECTED RULES (construction constraints, not output facts):\n' + formatUniqueRules(input.evidence),
            ...(input.focus ? ['CURRENT REQUEST:\n' + input.focus] : []),
            references.note(), formatWriterSeedPackaging(input.module, input.name, context)
        ].filter(Boolean).join('\n\n');
    }
    const sections = [
        (revision ? 'writer-revision-context-v2' : COMPACT_WRITER_VERSION) + ' (metadata, never an import)',
        '=== WRITER EVIDENCE BUNDLE V3 ===',
        formatTargetContract(input.module, input.name, context.args || [], context),
        `Source hash: ${input.evidence.sourceHash}`,
        `Initial controlled observations: ${summarizeObservationPhase(input.evidence.initialTargetObservations)}\n`
            + `Supplemental controlled observations: ${summarizeObservationPhase(input.evidence.supplementalTargetObservations)}\n`
            + `Deterministically selected test rules: ${input.evidence.ruleSelection.ids.join(', ') || 'none'}\n`
            + 'Test-generation rules constrain test construction. They are not evidence of a return value or exception.',
        `TARGET SOURCE (read-only, not an output oracle):\n\`\`\`python\n${input.source}\n\`\`\``,
        'SOURCE SETUP (read-only declarations, not evaluated values or expected outputs):\n'
            + `SETUP FACTS (source only; caller values are input candidates, not expected outputs${callerNote}):\n` + JSON.stringify(setup)
            + '\nsourceSpelling reproduces AST import syntax, not original formatting. Module globals belong to the canonical target module; do not rename or evaluate their expressions. '
            + 'same_complete_source_as points to the complete source block named in this request. Constructor snippets are declared assignments/accessors, not proof of a complete constructor body or executed state.\n'
            + [...fragments, ...dependencyBlocks].join('\n\n'),
        'FIXTURE CHECK: Import unittest and test helpers explicitly in test scope; never use wildcard target imports. '
            + 'Arrange constructor inputs and per-case state. Dependency returns are not target returns.',
        formatDependencyMockContract(input.module, context, input.allowedMockTargets, revision, { sourceImportsListed: true }),
        // The caller-partitioned AST trace is authoritative here. Using the
        // bundle's merged trace would leak another caller's assertion oracle.
        'VERIFIED OBSERVATIONS (current controlled behavior for exact call/setup only; not independent requirements):\n'
            + JSON.stringify(targetObservations.observations),
        ...(scenario.note ? [scenario.note] : []),
        'VERIFIED DEPENDENCY OBSERVATIONS (never substitute for target results):\n'
            + JSON.stringify(dependencyObservations.map(({ diagnostics: _diagnostics, ...entry }) => entry)),
        'DIAGNOSTICS (never expected values, expected exceptions, fixture returns or fixture types):\n'
            + JSON.stringify({ target: targetObservations.diagnostics,
                dependencies: dependencyObservations.map(({ observations: _observations, ...entry }) => entry) })
            + '\nBlocked, non_assertable, incomplete and uncontrolled-ambient-read records are retained only to explain unavailable evidence. '
            + 'Control clock/entropy at its use point before asserting; private tool representations describe diagnostics, not application return objects.',
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
    if (references.note()) { sections.push(references.note()); }
    if (revision) { return sections.filter(Boolean).join('\n\n'); }
    // Complete dependency source/setup is required in both full Writer sizes.
    // Only derived topology, neutral examples and hypotheses are optional.
    const requiredTokens = estimatePromptTokens(sections.filter(Boolean).join('\n\n'));
    const optionalBudget = Math.max(0, Math.min(input.budgetTokens - 1200,
        requiredTokens + Math.min(600, Math.floor(input.budgetTokens / 8))));
    const append = (section: string): boolean => {
        if (estimatePromptTokens([...sections, section].join('\n\n')) > optionalBudget) { return false; }
        sections.push(section); return true;
    };
    const topology = formatDependencyTopology(context);
    if (topology && !append(topology)) {
        sections.push('Topology/legend omitted whole for budget, not absence of dependencies. '
            + 'Use complete TARGET SOURCE; unknown stays unknown.');
    }
    for (const example of matchingWriterExamples({ ...context, selectedRuleIds: input.evidence.ruleSelection.ids })) {
        append(formatWriterPatternGuide(example));
    }
    if (input.evidence.semanticPlan) {
        append('OPTIONAL ANALYST HYPOTHESES (unverified; never an assertion oracle):\n' + JSON.stringify(input.evidence.semanticPlan.hypotheses));
    }
    return sections.join('\n\n');
}

/** Share identical projected input/setup facts, retaining every source site.
 * This is transport grouping, not proof of equivalent calls or an oracle. */
export function groupCallerSetupsForPrompt(callers: any[] = []): Record<string, unknown>[] {
    const projected = callers.map(callerForPrompt);
    const groups = new Map<string, { facts: Record<string, unknown>; sites: Record<string, unknown>[] }>();
    for (const caller of projected) {
        const { caller_file, caller_func, line, ...facts } = caller;
        const site = Object.fromEntries(Object.entries({ caller_file, caller_func, line })
            .filter(([, value]) => value !== undefined));
        const key = JSON.stringify(facts);
        const group = groups.get(key);
        if (group) { group.sites.push(site); }
        else { groups.set(key, { facts, sites: [site] }); }
    }
    if (groups.size === projected.length) { return projected; }
    return [...groups.values()].map(({ facts, sites }) => ({ ...facts, call_sites: sites }));
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

/** Move only extractor-owned source fields out of JSON escaping; all metadata and unknown fields remain. */
function projectSourceSetup(fields: Record<string, unknown>, location: string,
    sourceCode: (code: unknown, location: string) => unknown): Record<string, unknown> {
    const record = (value: unknown, label: string): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { return value; }
        const item = value as Record<string, unknown>;
        return Object.hasOwn(item, 'code') ? { ...item, code: sourceCode(item.code, label + '.code') } : item;
    };
    const records = (value: unknown, label: string): unknown => Array.isArray(value)
        ? value.map((item, index) => record(item, `${label}[${index}]`)) : value;
    const init = (value: unknown, label: string): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { return value; }
        const item = record(value, label) as Record<string, unknown>;
        return { ...item, ...(Object.hasOwn(item, 'assigns') ? { assigns: records(item.assigns, label + '.assigns') } : {}) };
    };
    const constructor = (value: unknown, label: string): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { return value; }
        const item = value as Record<string, unknown>;
        return { ...item,
            ...(Object.hasOwn(item, 'class_attrs') ? { class_attrs: records(item.class_attrs, label + '.class_attrs') } : {}),
            ...(Object.hasOwn(item, 'init') ? { init: init(item.init, label + '.init') } : {}),
            ...(Object.hasOwn(item, 'effective_init') ? { effective_init: init(item.effective_init, label + '.effective_init') } : {}),
            ...(Array.isArray(item.inherited_context) ? { inherited_context: item.inherited_context.map((parent, index) =>
                constructor(parent, `${label}.inherited_context[${index}]`)) } : {}) };
    };
    const property = (value: unknown, label: string): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { return value; }
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
            ['getter', 'setter', 'deleter'].includes(key) ? record(item, `${label}.${key}`) : item]));
    };
    return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key,
        ['globals', 'referenced_globals'].includes(key) ? records(value, `${location}.${key}`)
            : ['constructor', 'class_context'].includes(key) ? constructor(value, `${location}.${key}`)
                : ['property', 'property_context'].includes(key) ? property(value, `${location}.${key}`) : value]));
}

/** Lossless placement only. A diagnostic is never upgraded into an assertion or a test-owned return object. */
export function partitionWriterObservations(observations?: BehaviorObservations): {
    observations: Record<string, unknown> | null; diagnostics: Record<string, unknown> | null;
} {
    const projected = observationsForPrompt(observations) as Record<string, unknown> | null;
    if (!projected) { return { observations: null, diagnostics: null }; }
    const { examples = [], errors = [], ...metadata } = projected;
    const optionalTrue = (flag: unknown) => flag === undefined || flag === true;
    const optionalFalse = (flag: unknown) => flag === undefined || flag === false;
    const usable = (fact: Record<string, unknown>, expectedStatus: 'returned' | 'raised') => {
        if (observations?.complete !== true || observations.load_error || !optionalTrue(fact.call_assertable)
            || !optionalTrue(fact.result_assertable) || !optionalFalse(fact.result_truncated) || fact.oracle_reason
            || !optionalFalse(fact.non_assertable) || fact.result_type === 'non_assertable'
            || fact.non_deterministic_operations !== undefined && (!Array.isArray(fact.non_deterministic_operations)
                || fact.non_deterministic_operations.length > 0)) { return false; }
        if (expectedStatus === 'returned' ? typeof fact.result !== 'string' : typeof fact.exception !== 'string') { return false; }
        if (observations.cases?.length) {
            const ids = fact.case_ids;
            if (!Array.isArray(ids) || !ids.length || ids.some(id => {
                const matches = observations.cases!.filter(item => item.case_id === id);
                return matches.length !== 1 || matches[0].status !== expectedStatus || !optionalTrue(matches[0].call_assertable);
            })) { return false; }
        }
        return true;
    };
    const split = (items: unknown, status: 'returned' | 'raised') => {
        const available: Record<string, unknown>[] = [], diagnostics: Record<string, unknown>[] = [];
        for (const item of items as Record<string, unknown>[]) { (usable(item, status) ? available : diagnostics).push(item); }
        return { available, diagnostics };
    };
    const returned = split(examples, 'returned'), raised = split(errors, 'raised');
    const identity = { func_name: metadata.func_name, args: metadata.args,
        ...(observations?.run_id ? { observationRunId: observations.run_id } : {}) };
    return { observations: { ...identity, examples: returned.available, errors: raised.available },
        diagnostics: { ...metadata, ...identity, examples: returned.diagnostics, errors: raised.diagnostics } };
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

/** Select one complete observed call for initial generation only. Unknown or
 * conflicting same-call evidence retains the full context; this is no oracle
 * inference and does not change the original Trace, later revisions or gates.
 */
export function selectWriterSeedCaseIds(observations?: BehaviorObservations): string[] | undefined {
    if (observations?.complete !== true || observations.load_error || observations.blocked_operations?.length
        || !observations.run_id || !observations.cases?.length) { return undefined; }
    const cases = observations.cases;
    const ids = new Set(cases.map(item => item.case_id));
    if (ids.size !== cases.length || [...ids].some(id => !id)) { return undefined; }
    const facts = [...observations.examples, ...observations.errors];
    if (facts.some(item => !item.case_id || !ids.has(item.case_id))
        || new Set(facts.map(item => item.case_id)).size !== facts.length) { return undefined; }
    const call = (input?: TraceInputSnapshot | null): TraceValueSnapshot | undefined => {
        if (!validTraceInputSnapshot(input) || !input.replayable) { return undefined; }
        return typedCallFields(input.call_graph) ? input.call_graph : undefined;
    };
    const calls = cases.map(item => call(item.input_before));
    if (calls.some(item => !item)) { return undefined; }
    // The live v2 producer omits these optional flags for safe observations.
    // Their omission is accepted only with the complete typed proof below.
    const assertable = (value: unknown) => value === undefined || value === true;
    for (const observed of observations.examples) {
        const index = cases.findIndex(item => item.case_id === observed.case_id);
        const candidate = cases[index];
        const result = (candidate as unknown as Record<string, unknown>).result_snapshot;
        if (candidate.status !== 'returned' || candidate.inputs_mutated || observed.inputs_mutated
            || !assertable(candidate.call_assertable) || !assertable(observed.call_assertable) || !assertable(observed.result_assertable)
            || typeof observed.result !== 'string' || observed.result_truncated || observed.oracle_reason || observed.non_deterministic_operations?.length
            || !validTraceValueSnapshot(result) || !result.replayable
            || !callerMatchesObservation({ trace_input: calls[index] }, candidate.input_before)
            || !call(candidate.input_after) || !callerMatchesObservation({ trace_input: calls[index] }, candidate.input_after!)) { continue; }
        const sameCall = cases.filter(item => callerMatchesObservation({ trace_input: calls[index] }, item.input_before));
        if (sameCall.some(item => item.status !== 'returned' || item.inputs_mutated || !assertable(item.call_assertable)
            || !call(item.input_after) || !callerMatchesObservation({ trace_input: calls[index] }, item.input_after!)
            || JSON.stringify((item as unknown as Record<string, unknown>).result_snapshot) !== JSON.stringify(result)
            || !observations.examples.some(example => example.case_id === item.case_id && assertable(example.call_assertable)
                && assertable(example.result_assertable) && !example.inputs_mutated && !example.result_truncated
                && !example.oracle_reason && !example.non_deterministic_operations?.length))) { return undefined; }
        return [candidate.case_id];
    }
    return undefined;
}
