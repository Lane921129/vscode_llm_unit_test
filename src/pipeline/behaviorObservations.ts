import { BehaviorObservation, BehaviorObservations, ProbeCaseObservation } from './evidenceContracts';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const statuses = new Set(['returned', 'raised', 'blocked', 'setup_error', 'timeout', 'not_started', 'worker_error']);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
const callFields = ['args', 'kwargs', 'constructor_args', 'constructor_kwargs'] as const;
const unavailableReasons = new Set(['snapshot-budget', 'integer-budget', 'non-finite-float', 'text-budget',
    'unsupported-type', 'cycle', 'shared-reference', 'collection-budget']);

/** Validate the actual trace_value_codec format, including bounded diagnostic sentinels. */
function validSnapshot(snapshot: unknown): boolean {
    if (!object(snapshot) || snapshot.schema_version !== 'trace-value-v1' || typeof snapshot.replayable !== 'boolean') { return false; }
    let nodes = 0;
    let unavailable = false;
    const hashable = (node: any): boolean => ['none', 'bool', 'int', 'float', 'str', 'bytes', 'unavailable'].includes(node.type)
        || ['tuple', 'frozenset'].includes(node.type) && node.items.every(hashable);
    const visit = (node: unknown, depth: number): boolean => {
        // The encoder may append one budget sentinel at each open collection after
        // exhausting its 512 normal nodes, and a sentinel at depth 9.
        if (!object(node) || ++nodes > 532 || depth > 9) { return false; }
        if (node.type === 'unavailable') {
            unavailable = true;
            return unavailableReasons.has(node.reason) && (node.python_type === undefined
                || typeof node.python_type === 'string' && node.python_type.length <= 4096);
        }
        if (depth > 8 || nodes > 512) { return false; }
        const value = node.value;
        switch (node.type) {
            case 'none': return value === undefined && node.items === undefined;
            case 'bool': return typeof value === 'boolean';
            case 'int': return typeof value === 'string' && value.length <= 4096 && /^-?(?:0|[1-9]\d*)$/.test(value)
                && BigInt(value).toString(2).replace('-', '').length <= 4096;
            case 'float': return typeof value === 'string' && value.length <= 40
                && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value));
            case 'str': return typeof value === 'string' && value.length <= 8192 && [...value].length <= 4096;
            case 'bytes': return typeof value === 'string' && value.length <= 8192 && /^(?:[0-9a-f]{2})*$/.test(value);
            case 'list': case 'tuple': case 'set': case 'frozenset': case 'dict': {
                if (!Array.isArray(node.items) || node.items.length > 101) { return false; }
                return node.items.every((child: unknown, index: number) => {
                    if (object(child) && child.type === 'unavailable') {
                        return (index < 100 || child.reason === 'collection-budget') && visit(child, depth + 1);
                    }
                    if (index >= 100) { return false; }
                    return node.type === 'dict' ? object(child) && visit(child.key, depth + 1) && hashable(child.key) && visit(child.value, depth + 1)
                        : visit(child, depth + 1) && (!['set', 'frozenset'].includes(node.type) || hashable(child));
                });
            }
            default: return false;
        }
    };
    return visit(snapshot.value, 0) && snapshot.replayable === !unavailable;
}

function validInput(value: unknown, diagnostic = false): boolean {
    if (!object(value)) { return false; }
    if (diagnostic && validSnapshot(value.unavailable_input) && value.unavailable_input.replayable === false) { return true; }
    if (typeof value.replayable !== 'boolean' || !validSnapshot(value.call_graph)
        || value.replayable !== value.call_graph.replayable || !callFields.every(key => validSnapshot(value[key]))) { return false; }
    const graph = value.call_graph.value;
    if (graph.type !== 'dict') { return false; }
    // Diagnostic call graphs may end in a collection-budget sentinel before
    // all four fields; retain those snapshots but never use them as inputs.
    if (!value.replayable) { return true; }
    if (graph.items.length !== 4) { return false; }
    const fields = new Map<string, unknown>();
    for (const pair of graph.items) {
        if (!object(pair) || pair.key?.type !== 'str' || !callFields.includes(pair.key.value)) { return false; }
        fields.set(pair.key.value, pair.value);
    }
    if (fields.size !== 4) { return false; }
    if (callFields.some(key => !value[key].replayable
        || JSON.stringify(fields.get(key)) !== JSON.stringify(value[key].value))) { return false; }
    return ['args', 'constructor_args'].every(key => ['list', 'tuple'].includes(value[key].value.type))
        && ['kwargs', 'constructor_kwargs'].every(key => value[key].value.type === 'dict');
}

function validCase(value: unknown): value is ProbeCaseObservation {
    return object(value) && identifier(value.case_id) && statuses.has(value.status)
        && object(value.source) && ['caller_literals', 'source_guided', 'semantic_guided', 'unknown'].includes(value.source.kind)
        && validInput(value.input_before, !['returned', 'raised'].includes(value.status))
        && (value.input_after === null ? !['returned', 'raised'].includes(value.status) : validInput(value.input_after))
        && typeof value.duration_ms === 'number' && Number.isFinite(value.duration_ms) && value.duration_ms >= 0;
}

function validObservation(value: unknown): value is BehaviorObservation {
    return object(value) && identifier(value.case_id) && strings(value.args)
        && (value.kwargs === undefined || object(value.kwargs) && Object.values(value.kwargs).every(item => typeof item === 'string'))
        && (value.constructor_args === undefined || strings(value.constructor_args))
        && (value.constructor_kwargs === undefined || object(value.constructor_kwargs)
            && Object.values(value.constructor_kwargs).every(item => typeof item === 'string'))
        && ['result', 'result_type', 'exception', 'exception_module', 'exception_qualname', 'message'].every(key => value[key] === undefined || typeof value[key] === 'string')
        && ['call_assertable', 'result_assertable', 'result_truncated'].every(key => value[key] === undefined || typeof value[key] === 'boolean');
}

/** Runtime boundary for live v2 results. Historical v1 reports are not silently upgraded. */
export function parseBehaviorObservations(raw: string | unknown, target: string): BehaviorObservations {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!object(value) || value.schema_version !== 'behavior-observations-v2' || value.func_name !== target || !identifier(value.run_id)
        || !strings(value.args) || !Array.isArray(value.examples) || !value.examples.every(validObservation)
        || !Array.isArray(value.errors) || !value.errors.every(validObservation)
        || !Array.isArray(value.cases) || !value.cases.every(validCase)
        || !(value.load_error === null || typeof value.load_error === 'string')
        || value.isolation !== 'fresh-process-per-case' || typeof value.complete !== 'boolean') {
        throw new Error('Invalid controlled observation contract');
    }
    const cases = new Map(value.cases.map((item: ProbeCaseObservation) => [item.case_id, item]));
    if (cases.size !== value.cases.length) { throw new Error('Duplicate controlled observation case identity'); }
    const observed = new Set<string>();
    for (const [observation, expected] of [
        ...value.examples.map((item: BehaviorObservation) => [item, 'returned'] as const),
        ...value.errors.map((item: BehaviorObservation) => [item, 'raised'] as const)
    ]) {
        const item = cases.get(observation.case_id || '') as ProbeCaseObservation | undefined;
        if (!item || item.status !== expected || observed.has(item.case_id)) {
            throw new Error('Observation has no completed target execution');
        }
        observed.add(item.case_id);
        if (expected === 'returned' ? typeof observation.result !== 'string' || observation.exception !== undefined
            : !identifier(observation.exception) || observation.result !== undefined) {
            throw new Error('Observation outcome does not match completed target execution');
        }
        if (observation.input_before !== undefined && (!validInput(observation.input_before)
            || JSON.stringify(observation.input_before) !== JSON.stringify(item.input_before))
            || observation.input_after !== undefined && (!validInput(observation.input_after)
                || JSON.stringify(observation.input_after) !== JSON.stringify(item.input_after))) {
            throw new Error('Observation input snapshot does not match completed target execution');
        }
        if (item.input_before.replayable === false) {
            observation.call_assertable = false;
            observation.oracle_reason = 'unreplayable-input';
        }
    }
    return value as unknown as BehaviorObservations;
}

/** Recover only complete host-written events; a torn final line is not evidence. */
export function recoverBehaviorProgress(text: string, target: string, reason: string): BehaviorObservations | undefined {
    const result: BehaviorObservations = { schema_version: 'behavior-observations-v2', func_name: target,
        args: [], examples: [], errors: [], cases: [], load_error: null, blocked_operations: [],
        isolation: 'fresh-process-per-case', complete: false, recovery_reason: reason };
    let started = false;
    const pending = new Map<string, ProbeCaseObservation>();
    let active: string | undefined;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) { continue; }
        let event: any;
        try { event = JSON.parse(lines[index]); }
        catch { if (index === lines.length - 1) { break; } return undefined; }
        if (!object(event)) { return undefined; }
        if (event.event === 'run_started') {
            if (started || event.func_name !== target || event.schema_version !== result.schema_version || !identifier(event.run_id)) { return undefined; }
            started = true; result.run_id = event.run_id;
        } else {
            if (!started || event.run_id !== result.run_id) { return undefined; }
            if (event.event === 'planning_completed') {
                if (!strings(event.args) || !(event.load_error === null || typeof event.load_error === 'string')) { return undefined; }
                result.args = event.args; result.load_error = event.load_error; result.planning = event.planning;
                if (strings(event.blocked_operations)) { result.blocked_operations = event.blocked_operations; }
                if (Array.isArray(event.planned_cases)) {
                    for (const item of event.planned_cases) {
                        const planned = { ...item, status: 'not_started', reason: 'host-interrupted' };
                        if (!validCase(planned) || pending.has(planned.case_id)) { return undefined; }
                        pending.set(planned.case_id, planned);
                    }
                }
            } else if (event.event === 'case_started') {
                active = event.case?.case_id || event.case_id;
            } else if (event.event === 'case_completed') {
                if (!validCase(event.case) || !Array.isArray(event.examples) || !event.examples.every(validObservation)
                    || !Array.isArray(event.errors) || !event.errors.every(validObservation)
                    || [...event.examples, ...event.errors].some(item => item.case_id !== event.case.case_id)) { return undefined; }
                result.cases!.push(event.case); result.examples.push(...event.examples); result.errors.push(...event.errors);
                pending.delete(event.case.case_id);
                if (active === event.case.case_id) { active = undefined; }
                if (strings(event.blocked_operations)) { result.blocked_operations!.push(...event.blocked_operations); }
            }
        }
    }
    if (!started) { return undefined; }
    result.cases!.push(...[...pending.values()].map(item => item.case_id === active
        ? { ...item, status: 'worker_error' as const, reason: 'host-interrupted-during-case' } : item));
    try { return parseBehaviorObservations(result, target); } catch { return undefined; }
}

// Python preserves keyword insertion order, including inside **kwargs and constructors.
const callIdentity = (item: BehaviorObservation) => JSON.stringify([item.args, Object.entries(item.kwargs || {}),
    item.constructor_args || [], Object.entries(item.constructor_kwargs || {})]);

/** Preserve both phases, and demote contradictory observations instead of inventing an oracle. */
export function mergeBehaviorObservations(initial: BehaviorObservations | undefined, additional: BehaviorObservations): BehaviorObservations {
    if (!initial) { return additional; }
    const cases = (initial.cases || []).map(item => ({ ...item }));
    const usedIds = new Set(cases.map(item => item.case_id));
    const additionalIds = new Map<string, string>();
    for (const item of additional.cases || []) {
        let id = item.case_id;
        if (usedIds.has(id)) {
            const qualified = `${additional.run_id || 'supplemental'}:${id}`;
            id = qualified;
            for (let suffix = 2; usedIds.has(id); suffix++) { id = `${qualified}:${suffix}`; }
        }
        usedIds.add(id);
        additionalIds.set(item.case_id, id);
        cases.push({ ...item, case_id: id });
    }
    const observations = [
        ...[...initial.examples, ...initial.errors].map(item => ({ ...item })),
        ...[...additional.examples, ...additional.errors].map(item => ({ ...item,
            case_id: item.case_id ? additionalIds.get(item.case_id) || item.case_id : undefined }))
    ];
    const outcomes = new Map<string, Set<string>>();
    for (const item of observations) {
        if (item.call_assertable === false || item.result_assertable === false) { continue; }
        const key = callIdentity(item);
        const values = outcomes.get(key) || new Set();
        values.add(JSON.stringify([item.result, item.exception_module, item.exception_qualname || item.exception]));
        outcomes.set(key, values);
    }
    for (const item of observations) {
        if ((outcomes.get(callIdentity(item))?.size || 0) > 1) {
            item.call_assertable = false; item.oracle_reason = 'conflicting-observations';
        }
    }
    const unique = <T>(items: T[]) => [...new Map(items.map(item => [JSON.stringify(item), item])).values()];
    return { ...additional, load_error: initial.load_error && additional.load_error ? additional.load_error : null,
        complete: initial.complete !== false && additional.complete !== false,
        examples: unique(observations.filter(item => item.exception === undefined)),
        errors: unique(observations.filter(item => item.exception !== undefined)),
        cases,
        blocked_operations: unique([...(initial.blocked_operations || []), ...(additional.blocked_operations || [])]),
        input_source: 'semantic_guided' };
}
