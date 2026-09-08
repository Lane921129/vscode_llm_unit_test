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

export interface TraceAssertionEvidenceValidation {
    valid: boolean;
    reason?: string;
}

interface DirectAssertionExpectation {
    value: string;
    isTruthinessAssertion: boolean;
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

function splitTopLevelArguments(value: string): string[] {
    const argumentsList: string[] = [];
    let start = 0;
    let depth = 0;
    let quote: string | undefined;
    let escaped = false;
    for (let index = 0; index < value.length; index++) {
        const char = value[index];
        if (quote) {
            if (!escaped && char === quote) {quote = undefined;}
            escaped = !escaped && char === '\\';
            if (char !== '\\') {escaped = false;}
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '(' || char === '[' || char === '{') {
            depth++;
        } else if (char === ')' || char === ']' || char === '}') {
            depth--;
        } else if (char === ',' && depth === 0) {
            argumentsList.push(value.slice(start, index));
            start = index + 1;
        }
    }
    argumentsList.push(value.slice(start));
    return argumentsList;
}

function expectedDirectAssertionValue(line: string, callStart: number, callEnd: number): DirectAssertionExpectation | undefined {
    const assertionMatch = /self\.(assertEqual|assertTrue|assertFalse|assertIsNone)\s*\(/.exec(line);
    if (!assertionMatch || assertionMatch.index > callStart) {return undefined;}
    const assertionOpen = assertionMatch.index + assertionMatch[0].length - 1;
    const assertionClose = matchingClosingParenthesis(line, assertionOpen);
    if (assertionClose === undefined || callEnd > assertionClose) {return undefined;}

    const argumentsList = splitTopLevelArguments(line.slice(assertionOpen + 1, assertionClose));
    const callExpression = normalizePythonExpression(line.slice(callStart, callEnd + 1));
    if (assertionMatch[1] === 'assertEqual') {
        if (argumentsList.length < 2) {return undefined;}
        if (normalizePythonExpression(argumentsList[0]) === callExpression) {
            return { value: argumentsList[1], isTruthinessAssertion: false };
        }
        if (normalizePythonExpression(argumentsList[1]) === callExpression) {
            return { value: argumentsList[0], isTruthinessAssertion: false };
        }
        return undefined;
    }
    if (argumentsList.length < 1 || normalizePythonExpression(argumentsList[0]) !== callExpression) {return undefined;}
    if (assertionMatch[1] === 'assertIsNone') {
        return { value: 'None', isTruthinessAssertion: false };
    }
    return {
        value: assertionMatch[1] === 'assertTrue' ? 'True' : 'False',
        isTruthinessAssertion: true
    };
}

/**
 * Detect only a direct assertion contradiction for the exact same call a
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
        if (!/self\.assert(?:Equal|True|False|IsNone)\s*\(/.test(line)) {continue;}
        for (const match of line.matchAll(callPattern)) {
            const callExpressionStart = match.index || 0;
            const callOpen = callExpressionStart + match[0].length - 1;
            const closeIndex = matchingClosingParenthesis(line, callOpen);
            if (closeIndex === undefined) {continue;}
            const traceMatch = examples.find(({ signature }) =>
                normalizePythonExpression(line.slice(callOpen + 1, closeIndex)) === signature
            );
            if (!traceMatch) {continue;}
            const expectation = expectedDirectAssertionValue(line, callExpressionStart, closeIndex);
            if (expectation === undefined) {continue;}
            const normalizedTraceResult = normalizePythonExpression(traceMatch.example.result || '');
            // assertTrue/assertFalse verify Python truthiness, not equality to
            // True/False. Only reject when Trace proves an exact Boolean;
            // None, 0, empty containers, and custom objects stay for Python's
            // isolated execution gate to evaluate without false rejection.
            if (expectation.isTruthinessAssertion && normalizedTraceResult !== 'True' && normalizedTraceResult !== 'False') {
                continue;
            }
            if (normalizePythonExpression(expectation.value) !== normalizedTraceResult) {
                const callArgs = [
                    ...(traceMatch.example.args || []),
                    ...Object.entries(traceMatch.example.kwargs || {}).map(([name, value]) => `${name}=${value}`)
                ].join(', ');
                return `已驗證 Trace 顯示 ${callableName}(${callArgs}) 回傳 ${traceMatch.example.result}，但模型對相同呼叫斷言 ${expectation.value}。`;
            }
        }
    }
    return undefined;
}

/**
 * A reusable gate for every model-authored write path. Structural validation
 * answers whether a test is runnable; this gate answers whether a direct
 * assertion contradicts a fact that Python has already observed.
 */
export function validateTraceAssertionEvidence(
    code: string,
    callableName: string,
    trace: TraceAssertionEvidence | undefined
): TraceAssertionEvidenceValidation {
    const reason = findDirectTraceAssertionContradiction(code, callableName, trace);
    return reason ? { valid: false, reason } : { valid: true };
}
