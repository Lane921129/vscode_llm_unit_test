/**
 * Identifies only structurally inert Python functions for the fast path.
 *
 * A function explicitly named with a `dummy` token is an opt-in marker for
 * generated noise/placeholder code. Otherwise, a short function that performs
 * an expression, assignment, or calculation still has observable behaviour
 * and must receive normal generated tests and mutation scoring.
 */
export function isStructurallyInertStub(sourceCode: string | undefined): boolean {
    if (!sourceCode) {
        return false;
    }

    const allLines = sourceCode.trim().split(/\r?\n/);
    let defIndex = 0;
    while (defIndex < allLines.length && /^\s*(@|#)/.test(allLines[defIndex])) {
        defIndex++;
    }
    if (defIndex >= allLines.length || !/^\s*(?:async\s+)?def\s+/.test(allLines[defIndex])) {
        return false;
    }
    if (hasDummyNameMarker(allLines[defIndex])) {
        return true;
    }

    const bodyLines = allLines.slice(defIndex + 1)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    const executableLines = removeLeadingDocstring(bodyLines);

    if (executableLines.length === 0) {
        return true;
    }
    if (executableLines.length === 1 && executableLines[0] === 'pass') {
        return true;
    }

    return executableLines.length === 1 && isSafeLiteralReturn(executableLines[0]);
}

/** Returns whether a function name explicitly opts into the dummy fast path. */
export function hasDummyFunctionNameMarker(functionName: string | undefined): boolean {
    return Boolean(functionName && /(?:^|_)dummy(?:_|$)/i.test(functionName));
}

function hasDummyNameMarker(definitionLine: string): boolean {
    const functionName = definitionLine.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)?.[1];
    return hasDummyFunctionNameMarker(functionName);
}

function removeLeadingDocstring(lines: string[]): string[] {
    if (lines.length === 0) {
        return lines;
    }
    const first = lines[0];
    const quote = first.startsWith('\"\"\"') ? '\"\"\"' : first.startsWith("'''") ? "'''" : null;
    if (!quote) {
        return lines;
    }

    if (first.indexOf(quote, quote.length) !== -1) {
        return lines.slice(1);
    }
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index].includes(quote)) {
            return lines.slice(index + 1);
        }
    }
    // Unterminated text is not an executable stub and should be handled by
    // normal syntax validation rather than being silently skipped.
    return lines;
}

function isSafeLiteralReturn(line: string): boolean {
    return /^return\s+(None|True|False|-?\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")$/.test(line);
}
