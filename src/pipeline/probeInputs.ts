import { ObservationOrigin, TraceInputSnapshot, TraceValue, TraceValueSnapshot } from './evidenceContracts';
import { validTraceInputSnapshot, validTraceValueSnapshot } from './traceValues';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const fields = ['args', 'kwargs', 'constructor_args', 'constructor_kwargs'] as const;
export interface CallerProbeContext {
    trace_input?: unknown;
    trace_input_diagnostic?: unknown; trace_constructor_diagnostic?: unknown;
    caller_file?: string; caller_func?: string; line?: number;
    args?: string[]; kwargs?: Record<string, string>;
    trace_args?: unknown[] | null; trace_kwargs?: Record<string, unknown> | null;
    constructor_args?: string[] | null; constructor_kwargs?: Record<string, string> | null;
    trace_constructor_args?: unknown[] | null; trace_constructor_kwargs?: Record<string, unknown> | null;
}
export interface ProbeInputCase { input: TraceValueSnapshot; source: ObservationOrigin }
export interface TypedProbeInputsV1 { schema_version: 'probe-inputs-v1'; cases: ProbeInputCase[] }
export interface ScalarProbeInput { args: unknown[]; kwargs: Record<string, unknown> }
export interface TypedCallFields {
    args: TraceValue; kwargs: TraceValue;
    constructor_args?: TraceValue; constructor_kwargs?: TraceValue;
}

export function typedDictionaryEntries(value: TraceValue): Array<{ key: TraceValue; value: TraceValue }> | undefined {
    if (value.type !== 'dict' || !Array.isArray(value.items)
        || value.items.some((item: unknown) => !object(item) || !object(item.key) || !object(item.value))) { return undefined; }
    return value.items as Array<{ key: TraceValue; value: TraceValue }>;
}

/** Compare tagged values, never converting large integers or float spellings to JS numbers. */
export function sameTraceValue(left: TraceValue, right: TraceValue): boolean {
    if (left.type !== right.type || left.value !== right.value || left.reason !== right.reason || left.python_type !== right.python_type) { return false; }
    if (left.items === undefined || right.items === undefined) { return left.items === right.items; }
    if (left.items.length !== right.items.length) { return false; }
    if (left.type === 'dict') {
        const a = typedDictionaryEntries(left), b = typedDictionaryEntries(right);
        return !!a && !!b && a.every((item, index) => sameTraceValue(item.key, b[index].key) && sameTraceValue(item.value, b[index].value));
    }
    return (left.items as TraceValue[]).every((item, index) => sameTraceValue(item, right.items![index] as TraceValue));
}

function keywordDictionary(value: TraceValue): boolean {
    const entries = typedDictionaryEntries(value);
    return !!entries && entries.every(item => item.key.type === 'str' && typeof item.key.value === 'string')
        && new Set(entries.map(item => item.key.value)).size === entries.length;
}

/** Only a complete, replayable call dictionary can become executable input. */
export function typedCallFields(input: unknown): TypedCallFields | undefined {
    if (!validTraceValueSnapshot(input) || !input.replayable) { return undefined; }
    const entries = typedDictionaryEntries(input.value);
    if (!entries || entries.some(item => item.key.type !== 'str' || !fields.includes(item.key.value as typeof fields[number]))) { return undefined; }
    const values = new Map(entries.map(item => [item.key.value as string, item.value]));
    if (values.size !== entries.length || !values.has('args') || !values.has('kwargs')
        || values.has('constructor_args') !== values.has('constructor_kwargs')) { return undefined; }
    const result = Object.fromEntries(values) as unknown as TypedCallFields;
    if (!['list', 'tuple'].includes(result.args.type) || !keywordDictionary(result.kwargs)
        || result.constructor_args && (!['list', 'tuple'].includes(result.constructor_args.type) || !keywordDictionary(result.constructor_kwargs!))) { return undefined; }
    return result;
}

export function diagnosticProbeInput(source: ObservationOrigin): ProbeInputCase {
    return { input: { schema_version: 'trace-value-v1', replayable: false,
        value: { type: 'unavailable', reason: 'unsupported-type', python_type: 'invalid-input-envelope' } }, source };
}

const snapshot = (value: TraceValue): TraceValueSnapshot => ({ schema_version: 'trace-value-v1', replayable: true, value });
const dictionary = (entries: Array<[string, TraceValue]>): TraceValue => ({ type: 'dict',
    items: entries.map(([key, value]) => ({ key: { type: 'str', value: key }, value })) });

function scalar(value: unknown, spelling?: string): TraceValue | undefined {
    if (value === null) { return { type: 'none' }; }
    if (typeof value === 'boolean') { return { type: 'bool', value }; }
    if (typeof value === 'string') { return { type: 'str', value }; }
    if (typeof value !== 'number' || !Number.isFinite(value)) { return undefined; }
    if (spelling !== undefined) {
        if (/^-?(?:0|[1-9]\d*)$/.test(spelling) && Number.isSafeInteger(value) && Number(spelling) === value) {
            return { type: 'int', value: spelling };
        }
        if (/^-?(?:\d+\.\d*|\.\d+|\d+e[+-]?\d+)(?:e[+-]?\d+)?$/i.test(spelling)
            && Object.is(Number(spelling), value)) { return { type: 'float', value: spelling }; }
        return undefined;
    }
    if (Object.is(value, -0)) { return { type: 'float', value: '-0.0' }; }
    if (Number.isInteger(value)) { return Number.isSafeInteger(value) ? { type: 'int', value: String(value) } : undefined; }
    return { type: 'float', value: String(value) };
}

function scalarFields(args: unknown, kwargs: unknown, spellings?: { args: unknown; kwargs: unknown }): { args: TraceValue; kwargs: TraceValue } | undefined {
    if (!Array.isArray(args) || !object(kwargs) || spellings && (!Array.isArray(spellings.args)
        || spellings.args.length !== args.length || spellings.args.some(item => typeof item !== 'string')
        || !object(spellings.kwargs) || Object.values(spellings.kwargs).some(item => typeof item !== 'string')
        || JSON.stringify(Object.keys(spellings.kwargs)) !== JSON.stringify(Object.keys(kwargs)))) { return undefined; }
    const positional = args.map((value, index) => scalar(value, spellings ? (spellings.args as string[])[index] : undefined));
    const keywords = Object.entries(kwargs).map(([key, value]) => [key, scalar(value, spellings ? (spellings.kwargs as Record<string, string>)[key] : undefined)] as const);
    if (positional.some(value => !value) || keywords.some(([, value]) => !value)) { return undefined; }
    return { args: { type: 'list', items: positional as TraceValue[] }, kwargs: dictionary(keywords as Array<[string, TraceValue]>) };
}

/** Semantic inputs are explicitly JS-owned safe scalars, separate from typed caller transport. */
export function scalarProbeInput(input: ScalarProbeInput, source: ObservationOrigin = { kind: 'semantic_guided' }): ProbeInputCase {
    const values = scalarFields(input?.args, input?.kwargs);
    const encoded = values && snapshot(dictionary(Object.entries(values)));
    return encoded && typedCallFields(encoded) ? { input: encoded, source } : diagnosticProbeInput(source);
}

function callerOrigin(caller: CallerProbeContext): ObservationOrigin {
    return { kind: 'caller_literals',
        ...(typeof caller.caller_file === 'string' ? { file: caller.caller_file } : {}),
        ...(typeof caller.caller_func === 'string' ? { caller: caller.caller_func } : {}),
        ...(Number.isSafeInteger(caller.line) && caller.line! > 0 ? { line: caller.line } : {}) };
}

/** Explicit typed failures stay diagnostic; legacy fields never override them. */
export function callerToProbeInput(caller: CallerProbeContext): ProbeInputCase | undefined {
    const source = callerOrigin(caller);
    if (owns(caller, 'trace_input')) {
        if (validTraceValueSnapshot(caller.trace_input) && (!caller.trace_input.replayable || typedCallFields(caller.trace_input))) {
            return { input: caller.trace_input, source };
        }
        return diagnosticProbeInput(source);
    }
    // Historical callers can supply only proven, losslessly represented scalar
    // values. Containers need the typed producer: JSON cannot prove their type.
    const values = scalarFields(caller.trace_args, caller.trace_kwargs, { args: caller.args, kwargs: caller.kwargs });
    if (!values) { return undefined; }
    const entries: Array<[string, TraceValue]> = Object.entries(values);
    if (hasVerifiedConstructorInput(caller)) {
        const constructor = scalarFields(caller.trace_constructor_args, caller.trace_constructor_kwargs,
            { args: caller.constructor_args, kwargs: caller.constructor_kwargs })!;
        entries.push(['constructor_args', constructor.args], ['constructor_kwargs', constructor.kwargs]);
    }
    const input = snapshot(dictionary(entries));
    return typedCallFields(input) ? { input, source } : undefined;
}

export function hasVerifiedConstructorInput(caller: CallerProbeContext): boolean {
    if (owns(caller, 'trace_input')) { return !!typedCallFields(caller.trace_input)?.constructor_args; }
    return !!scalarFields(caller.trace_constructor_args, caller.trace_constructor_kwargs,
        { args: caller.constructor_args, kwargs: caller.constructor_kwargs });
}

export function buildProbeInputs(callers: CallerProbeContext[] = [], supplementalInputs: ScalarProbeInput[] = []): TypedProbeInputsV1 | null {
    const cases = [...callers.map(callerToProbeInput).filter((item): item is ProbeInputCase => !!item),
        ...supplementalInputs.map(input => scalarProbeInput(input))];
    const unique = [...new Map(cases.map(item => [JSON.stringify(item), item])).values()];
    return unique.length ? { schema_version: 'probe-inputs-v1', cases: unique } : null;
}

/** The caller's exact call values must match the pre-execution snapshot, including constructor identity. */
export function callerMatchesObservation(caller: CallerProbeContext, before: TraceInputSnapshot | undefined): boolean {
    const expected = typedCallFields(caller.trace_input);
    if (!expected || !validTraceInputSnapshot(before) || !before.replayable) { return false; }
    if (!sameTraceValue(expected.args, before.args!.value) || !sameTraceValue(expected.kwargs, before.kwargs!.value)) { return false; }
    return expected.constructor_args
        ? sameTraceValue(expected.constructor_args, before.constructor_args!.value) && sameTraceValue(expected.constructor_kwargs!, before.constructor_kwargs!.value)
        : before.constructor_args!.value.items?.length === 0 && before.constructor_kwargs!.value.items?.length === 0;
}

/** Render validated builtin data as Python literals; never evaluate a spelling or coerce numeric values. */
export function traceValuePythonLiteral(value: TraceValue): string | undefined {
    if (!validTraceValueSnapshot(snapshot(value))) { return undefined; }
    const render = (node: TraceValue): string => {
        if (node.type === 'none') { return 'None'; }
        if (node.type === 'bool') { return node.value ? 'True' : 'False'; }
        if (node.type === 'str') { return JSON.stringify(node.value); }
        if (node.type === 'int') { return node.value as string; }
        if (node.type === 'float') {
            const spelling = node.value as string;
            return /[.e]/i.test(spelling) ? spelling : `${spelling}.0`;
        }
        if (node.type === 'bytes') { return "b'" + (node.value as string).replace(/../g, pair => `\\x${pair}`) + "'"; }
        if (node.type === 'dict') { return '{' + typedDictionaryEntries(node)!.map(pair => `${render(pair.key)}: ${render(pair.value)}`).join(', ') + '}'; }
        const items = (node.items as TraceValue[]).map(render);
        if (node.type === 'list') { return '[' + items.join(', ') + ']'; }
        if (node.type === 'tuple') { return '(' + items.join(', ') + (items.length === 1 ? ',' : '') + ')'; }
        if (node.type === 'set') { return items.length ? '{' + items.join(', ') + '}' : 'set()'; }
        return 'frozenset(' + (items.length ? '{' + items.join(', ') + '}' : '') + ')';
    };
    return render(value);
}

/** Keep source spellings and a short status, not duplicate serialized input trees, in prompts. */
export function callerForPrompt(caller: CallerProbeContext): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of ['caller_file', 'caller_func', 'line', 'args', 'kwargs', 'constructor_args', 'constructor_kwargs'] as const) {
        if (caller[key] !== undefined && caller[key] !== null) { result[key] = caller[key]; }
    }
    if (owns(caller, 'trace_input')) {
        result.input_status = typedCallFields(caller.trace_input) ? 'replayable' : 'diagnostic';
        result.constructor_verified = hasVerifiedConstructorInput(caller);
    }
    for (const key of ['trace_input_diagnostic', 'trace_constructor_diagnostic'] as const) {
        const diagnostic = caller[key];
        if (object(diagnostic) && ['non-literal-arguments', 'unreplayable-input', 'non-literal-constructor'].includes(diagnostic.reason)) {
            result[key] = { reason: diagnostic.reason };
        }
    }
    return result;
}
