export interface ExceptionEvidenceContext {
    raised_exceptions?: string[];
    traceResult?: {
        errors?: Array<{ exception?: string; exception_qualname?: string; call_assertable?: boolean }>;
    };
}

function normalizedExceptionName(value: string): string | undefined {
    // Python exception classes need no Error/Exception suffix. Only accept an
    // exact identifier path from AST/Trace, never a name embedded in diagnostics.
    return /^[\p{L}_][\p{L}\p{N}\p{M}_]*(?:\.[\p{L}_][\p{L}\p{N}\p{M}_]*)*$/u.test(value)
        ? value.split('.').pop() : undefined;
}

/** Build the exception facts that LLM-authored tests may assert for a target. */
export function exceptionNamesFromEvidence(context?: ExceptionEvidenceContext | null): string[] {
    const names = new Set<string>();
    for (const exception of context?.raised_exceptions || []) {
        const name = normalizedExceptionName(exception);
        if (name) {
            names.add(name);
        }
    }
    for (const error of context?.traceResult?.errors || []) {
        if (error.call_assertable === false) {
            continue;
        }
        const name = normalizedExceptionName(error.exception_qualname || error.exception || '');
        if (name) {
            names.add(name);
        }
    }
    return [...names].sort();
}
