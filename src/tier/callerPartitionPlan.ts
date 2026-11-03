import { CallerProbeContext, callerToProbeInput, hasVerifiedConstructorInput, sameTraceValue } from '../pipeline/probeInputs';
import { TraceValueSnapshot } from '../pipeline/evidenceContracts';

/** Keep all context in the standard prompt when splitting cannot reduce work. */
export function planCallerPartitions<T extends CallerProbeContext>(callers: T[]) {
    const distinct: Array<{ caller: T; input: TraceValueSnapshot }> = [];
    let unknown = 0;
    for (const caller of callers) {
        const input = callerToProbeInput(caller)?.input;
        const hasConstructorContext = [caller.constructor_args, caller.constructor_kwargs]
            .some(value => value !== undefined && value !== null);
        const unknownConstructor = caller.trace_constructor_diagnostic
            || hasConstructorContext && !hasVerifiedConstructorInput(caller);
        if (!input?.replayable || caller.trace_input_diagnostic || unknownConstructor) { unknown++; continue; }
        if (!distinct.some(item => sameTraceValue(item.input.value, input.value))) {
            distinct.push({ caller, input });
        }
    }
    const reason = unknown ? 'unresolved-inputs' : distinct.length <= 1 ? 'one-input-group'
        : distinct.length > 4 ? 'partition-limit' : 'distinct-verified-inputs';
    return {
        mode: reason === 'distinct-verified-inputs' ? 'partitioned' as const : 'single-pass' as const,
        reason, totalCallers: callers.length, distinctInputs: distinct.length, unresolvedInputs: unknown,
        // Only these representatives drive subtask requests. The original AST
        // context and all verified Trace facts remain available to the pipeline.
        callers: distinct.map(item => item.caller)
    };
}
