export interface CallerTraceContext {
    /** Source literals, retained only when caller-finder also proved trace_args. */
    args?: string[];
    kwargs?: Record<string, string>;
    trace_args?: unknown[] | null;
    trace_kwargs?: Record<string, unknown> | null;
    trace_constructor_args?: unknown[] | null;
    trace_constructor_kwargs?: Record<string, unknown> | null;
    constructor_args?: string[] | null;
    constructor_kwargs?: Record<string, string> | null;
}

export interface CallerTraceExample {
    args: string[];
    kwargs?: Record<string, string>;
    constructor_args?: string[];
    constructor_kwargs?: Record<string, string>;
    result?: string;
    result_type?: string;
    result_assertable?: boolean;
    call_assertable?: boolean;
    exception?: string;
    message?: string;
}

export interface CallerTraceResult {
    func_name: string;
    args: string[];
    examples: CallerTraceExample[];
    errors: CallerTraceExample[];
    load_error: string | null;
    input_source?: string;
}

function sameRecord(left: Record<string, string> | undefined, right: Record<string, string> | undefined): boolean {
    const leftEntries = Object.entries(left || {}).sort(([a], [b]) => a.localeCompare(b));
    const rightEntries = Object.entries(right || {}).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

/**
 * A Tier 2 caller subtask may see only Trace calls that exactly match that
 * caller's source literals. Never approximate repr values or borrow a nearby
 * call: an empty subset is safer than leaking another caller's oracle.
 */
export function traceSubsetForCaller(
    trace: CallerTraceResult | undefined,
    caller: CallerTraceContext
): CallerTraceResult | undefined {
    if (!trace || trace.load_error || !Array.isArray(caller.trace_args) || caller.trace_kwargs === null) {
        return undefined;
    }
    const expectedArgs = caller.args || [];
    const expectedKwargs = caller.kwargs || {};
    const hasVerifiedConstructorContext = Array.isArray(caller.trace_constructor_args)
        && caller.trace_constructor_kwargs !== null
        && Array.isArray(caller.constructor_args)
        && caller.constructor_kwargs !== null;
    const matches = (example: CallerTraceExample) =>
        JSON.stringify(example.args || []) === JSON.stringify(expectedArgs)
        && sameRecord(example.kwargs, expectedKwargs)
        && (!hasVerifiedConstructorContext || (
            JSON.stringify(example.constructor_args || []) === JSON.stringify(caller.constructor_args || [])
            && sameRecord(example.constructor_kwargs, caller.constructor_kwargs || {})
        ));

    return {
        ...trace,
        examples: trace.examples.filter(matches),
        errors: trace.errors.filter(matches),
        input_source: 'caller_partition'
    };
}
