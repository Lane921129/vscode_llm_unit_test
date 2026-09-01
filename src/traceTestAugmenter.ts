export interface TraceMethodAugmentation {
    code: string;
    addedMethodCount: number;
}

function traceMethodName(method: string): string | undefined {
    return method.match(/^\s*def\s+(test_trace_case_\d+)\s*\(/m)?.[1];
}

/**
 * Add deterministic Trace methods to the existing unittest class without
 * rewriting any model-authored methods. The caller supplies already-indented
 * unittest methods; this module only chooses a safe insertion point before
 * the next top-level statement.
 */
export function appendTraceMethodsToUnittestClass(
    code: string,
    methods: string[]
): TraceMethodAugmentation {
    const renamed = methods.map(method => method.replace(
        /^(\s*)def\s+test_case_(\d+)\s*\(/m,
        '$1def test_trace_case_$2('
    ));
    const existingNames = new Set(
        [...code.matchAll(/^\s*def\s+(test_trace_case_\d+)\s*\(/gm)].map(match => match[1])
    );
    const missing = renamed.filter(method => {
        const name = traceMethodName(method);
        return Boolean(name && !existingNames.has(name));
    });
    if (missing.length === 0) {
        return { code, addedMethodCount: 0 };
    }

    const lines = code.split(/\r?\n/);
    const classIndex = lines.findIndex(line =>
        /^class\s+\w+\s*\(\s*unittest\.(?:TestCase|IsolatedAsyncioTestCase)\s*\)\s*:$/.test(line)
    );
    if (classIndex < 0) {
        return { code, addedMethodCount: 0 };
    }

    let insertAt = lines.length;
    for (let index = classIndex + 1; index < lines.length; index++) {
        const line = lines[index];
        if (line.trim() && !/^\s/.test(line) && !line.trimStart().startsWith('#')) {
            insertAt = index;
            break;
        }
    }
    const separator = insertAt > classIndex + 1 && lines[insertAt - 1].trim() ? ['', ''] : [''];
    lines.splice(insertAt, 0, ...separator, ...missing, '');
    return { code: lines.join('\n'), addedMethodCount: missing.length };
}
