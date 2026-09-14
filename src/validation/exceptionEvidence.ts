export interface ExceptionEvidenceContext {
    raised_exceptions?: string[];
    traceResult?: {
        errors?: Array<{ exception?: string; call_assertable?: boolean }>;
    };
}

function normalizedExceptionName(value: string): string | undefined {
    const match = value.match(/(?:^|[.\s])([A-Za-z_]\w*(?:Error|Exception|Exit|Interrupt|Warning))\b/);
    return match?.[1];
}

/** Build the exception facts that LLM-authored tests may assert for a target. */
export function exceptionNamesFromEvidence(context?: ExceptionEvidenceContext | null): string[] {
    const names = new Set<string>();
    for (const exception of context?.raised_exceptions || []) {
        const name = normalizedExceptionName(exception) || exception.split('.').pop();
        if (name) {
            names.add(name);
        }
    }
    for (const error of context?.traceResult?.errors || []) {
        if (error.call_assertable === false || !error.exception) {
            continue;
        }
        const candidate = normalizedExceptionName(error.exception)
            || (error.exception.includes('.') ? error.exception.split('.').pop()?.trim() : undefined);
        const name = candidate && /^[A-Za-z_]\w*$/.test(candidate) ? candidate : undefined;
        if (name) {
            names.add(name);
        }
    }
    return [...names].sort();
}
