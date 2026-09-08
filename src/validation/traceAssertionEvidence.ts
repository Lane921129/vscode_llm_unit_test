export interface TraceAssertionExample {
    args?: string[];
    kwargs?: Record<string, string>;
    result?: string;
    call_assertable?: boolean;
    result_assertable?: boolean;
}

export interface TraceAssertionEvidence {
    examples?: TraceAssertionExample[];
}

function normalizePythonExpression(value: string): string {
    // This is intentionally not an evaluator. It only normalizes whitespace
    // and quote style for simple literal comparison against an existing Trace.
    return value
        .trim()
        .replace(/\s+/g, '')
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, content: string) => `"${content.replace(/"/g, '\\"')}"`);
}

function matchingClosingParenthesis(text: string, openIndex: number): number | undefined {
    let depth = 0;
    let quote: string | undefined;
    let escaped = false;
    for (let index = openIndex; index < text.length; index++) {
        const char = text[index];
        if (quote) {
            if (!escaped && char === quote) {quote = undefined;}
            escaped = !escaped && char === '\\';
            if (char !== '\\') {escaped = false;}
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth === 0) {return index;}
        }
    }
    return undefined;
}

function traceCallSignature(example: TraceAssertionExample): string | undefined {
    if (example.call_assertable === false || example.result_assertable === false || typeof example.result !== 'string') {
        return undefined;
    }
    const positional = example.args || [];
    const keywords = Object.entries(example.kwargs || {}).map(([name, value]) => `${name}=${value}`);
    return normalizePythonExpression([...positional, ...keywords].join(','));
}

/**
 * Detect only a direct assertEqual contradiction for the exact same call a
 * Dynamic Trace has already observed. It intentionally leaves untraced input
 * exploration and assertions over transformed results to the normal gates.
 */
export function findDirectTraceAssertionContradiction(
    code: string,
    callableName: string,
    trace: TraceAssertionEvidence | undefined
): string | undefined {
    const examples = (trace?.examples || [])
        .map(example => ({ example, signature: traceCallSignature(example) }))
        .filter((entry): entry is { example: TraceAssertionExample; signature: string } => Boolean(entry.signature));
    if (examples.length === 0) {return undefined;}

    const escapedName = callableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callPattern = new RegExp(`(?:\\b[A-Za-z_]\\w*\\s*\\.\\s*)?${escapedName}\\s*\\(`, 'g');
    for (const line of code.split(/\r?\n/)) {
        if (!line.includes('self.assertEqual')) {continue;}
        for (const match of line.matchAll(callPattern)) {
            const callStart = (match.index || 0) + match[0].length - 1;
            const closeIndex = matchingClosingParenthesis(line, callStart);
            if (closeIndex === undefined) {continue;}
            const traceMatch = examples.find(({ signature }) =>
                normalizePythonExpression(line.slice(callStart + 1, closeIndex)) === signature
            );
            if (!traceMatch) {continue;}
            const remainder = line.slice(closeIndex + 1);
            const expectedMatch = remainder.match(/^\s*,\s*(.*?)\s*\)\s*$/);
            if (!expectedMatch) {continue;}
            if (normalizePythonExpression(expectedMatch[1]) !== normalizePythonExpression(traceMatch.example.result || '')) {
                const callArgs = [
                    ...(traceMatch.example.args || []),
                    ...Object.entries(traceMatch.example.kwargs || {}).map(([name, value]) => `${name}=${value}`)
                ].join(', ');
                return `已驗證 Trace 顯示 ${callableName}(${callArgs}) 回傳 ${traceMatch.example.result}，但模型對相同呼叫斷言 ${expectedMatch[1]}。`;
            }
        }
    }
    return undefined;
}
