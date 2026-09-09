export interface CallerTraceContext {
    /** Source literals, retained only when caller-finder also proved trace_args. */
    args?: string[];
    kwargs?: Record<string, string>;
    trace_args?: unknown[] | null;
    trace_kwargs?: Record<string, unknown> | null;
}

export interface CallerTraceExample {
    args: string[];
    kwargs?: Record<string, string>;
    [key: string]: unknown;
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
    const matches = (example: CallerTraceExample) =>
        JSON.stringify(example.args || []) === JSON.stringify(expectedArgs)
        && sameRecord(example.kwargs, expectedKwargs);

    return {
        ...trace,
        examples: trace.examples.filter(matches),
        errors: trace.errors.filter(matches),
        input_source: 'caller_partition'
    };
}
