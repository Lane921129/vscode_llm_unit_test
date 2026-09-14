/**
 * Bug Fixer 專用提示詞與局部修復合併器。
 * Bug Fixer prompt and deterministic focused-repair merger.
 */

import { summarizeRepairOutput } from '../validation/repairFeedback';

interface TestMethodFragment {
    name: string;
    start: number;
    end: number;
    indent: string;
    code: string;
}

export interface BugFixReplacement {
    method: string;
    replacement: string;
    imports: string[];
}

export function getBugFixerSystemPrompt(): string {
    return `You are a Python unittest Bug Fixer. Repair one failing test method only.

CONTRACT:
- Use only the failure, target signature, permitted mock paths, focused target source, imports, and failing method supplied in BUG_FIX_REQUEST_V3.
- Preserve the test method name. Do not add tests, classes, helpers, source code, or unittest.main().
- A return_value does not raise; use side_effect inside the failing method for a mocked exception.
- Source code describes the branch under test, but exact expected values still require an explicit return/raise or same-test mock behavior.
- Return exactly one JSON object: {"method":"test_name","replacement":"complete def test_name(self): ... method","imports":["optional import line"]}.
- replacement must contain one method only, without a class wrapper or Markdown. imports may contain at most 3 valid Python import lines.`;
}

export function failedTestNamesFromOutput(output: string): string[] {
    const found = new Set<string>();
    for (const pattern of [
        /^(test_[A-Za-z0-9_]+)\s+\([^\n]+\)\s+\.\.\.\s+(?:FAIL|ERROR)\s*$/gm,
        /^(?:FAIL|ERROR):\s+(test_[A-Za-z0-9_]+)\b/gm,
        /\bin\s+(test_[A-Za-z0-9_]+)\b/g
    ]) {
        for (const match of output.matchAll(pattern)) { found.add(match[1]); }
    }
    return [...found].sort();
}

/** Locate test methods without sending the whole generated file back to the model. */
function testMethodFragments(code: string): TestMethodFragment[] {
    const lines = code.replace(/\r\n/g, '\n').split('\n');
    const fragments: TestMethodFragment[] = [];
    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(/^(\s*)(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/);
        if (!match) { continue; }
        const indent = match[1];
        let end = index + 1;
        while (end < lines.length) {
            const text = lines[end];
            if (text.trim()) {
                const nextIndent = text.match(/^\s*/)?.[0].length || 0;
                if (nextIndent <= indent.length) { break; }
            }
            end++;
        }
        fragments.push({
            name: match[2], start: index, end, indent,
            code: lines.slice(index, end).join('\n').trimEnd()
        });
        index = end - 1;
    }
    return fragments;
}

function selectedFailureMethod(code: string, output: string): TestMethodFragment | undefined {
    const fragments = testMethodFragments(code);
    const failed = failedTestNamesFromOutput(output);
    return fragments.find(fragment => fragment.name === failed[0])
        || fragments[0];
}

function importLines(code: string): string[] {
    return code.replace(/\r\n/g, '\n').split('\n')
        .map(line => line.trim())
        .filter(line => /^(?:from\s+\S+\s+import\s+|import\s+)/.test(line));
}

function focusedSource(sourceCode?: string): string {
    if (!sourceCode?.trim()) { return 'not available'; }
    const source = sourceCode.trim();
    return source.length <= 3000 ? source : `${source.slice(0, 3000)}\n# [runner truncated unrelated tail]`;
}

export function getBugFixerUserPrompt(
    brokenCode: string,
    errorOutput: string,
    funcName: string,
    funcArgs: string[],
    sourceCode?: string,
    astContext?: any,
    moduleName: string = 'module_name',
    semanticGuidance?: string,
    allowedMockTargets: string[] = []
): string {
    // These legacy parameters remain in the public signature for callers, but
    // deliberately do not enter the small-model repair prompt.
    void astContext;
    void semanticGuidance;
    const method = selectedFailureMethod(brokenCode, errorOutput);
    const signature = funcArgs.length ? `${funcName}(${funcArgs.join(', ')})` : `${funcName}()`;
    const imports = importLines(brokenCode);
    return `BUG_FIX_REQUEST_V3
=== REPAIR TARGET ===
- Failing method: ${method?.name || 'not identified; stop without guessing'}
- Target import: from ${moduleName} import ${funcName}
- Target signature: ${signature}
- Allowed mock use points: ${allowedMockTargets.length ? allowedMockTargets.join(', ') : 'none supplied; preserve existing patch paths'}

=== LATEST FAILURE ===
${summarizeRepairOutput(errorOutput)}

=== CURRENT IMPORTS ===
${imports.length ? imports.join('\n') : 'none'}

=== FAILING TEST METHOD ===
${method?.code || 'No unambiguous failing test method was found.'}

=== NECESSARY TARGET BRANCH ===
${focusedSource(sourceCode)}

RESPONSE:
Return the V3 JSON replacement object. Repair only the named method; request only truly missing imports.`;
}

/** Reviewer receives constraints only; source, AST, dependencies and traces stay outside its quoteable evidence. */
export function getReviewEvidence(
    _brokenCode: string,
    _errorOutput: string,
    funcName: string,
    funcArgs: string[],
    _sourceCode?: string,
    _astContext?: any,
    moduleName: string = 'module_name',
    _semanticGuidance?: string,
    allowedMockTargets: string[] = []
): string {
    const signature = funcArgs.length ? `${funcName}(${funcArgs.join(', ')})` : `${funcName}()`;
    return [
        `Target import: from ${moduleName} import ${funcName}`,
        `Target signature: ${signature}`,
        `Allowed mock use points: ${allowedMockTargets.length ? allowedMockTargets.join(', ') : 'none supplied'}`,
        'Every finding must quote TEST_FILE; these constraints cannot be quoted as evidence.'
    ].join('\n');
}

function parseReplacement(raw: string): BugFixReplacement | undefined {
    const fenced = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)```$/i)?.[1]?.trim();
    const text = fenced || raw.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) { return undefined; }
    try {
        const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        if (typeof value.method !== 'string' || typeof value.replacement !== 'string'
            || !Array.isArray(value.imports) || !value.imports.every(item => typeof item === 'string')) {
            return undefined;
        }
        return { method: value.method, replacement: value.replacement, imports: value.imports as string[] };
    } catch {
        return undefined;
    }
}

function normalizedReplacementMethod(replacement: string, method: TestMethodFragment): string | undefined {
    const clean = replacement.trim().replace(/^```(?:python|py)?\s*/i, '').replace(/```$/i, '').trim();
    if (/^\s*class\s+/m.test(clean) || /unittest\.main\s*\(/.test(clean)) { return undefined; }
    const lines = clean.replace(/\r\n/g, '\n').split('\n');
    const definition = lines.findIndex(line => new RegExp(`^\\s*(?:async\\s+)?def\\s+${method.name}\\s*\\(`).test(line));
    if (definition < 0 || lines.some((line, index) => index !== definition && /^\s*(?:async\s+)?def\s+test_/.test(line))) {
        return undefined;
    }
    const body = lines.slice(definition);
    const baseIndent = body[0].match(/^\s*/)?.[0].length || 0;
    const dedented = body.map(line => line.trim()
        ? line.slice(Math.min(baseIndent, line.match(/^\s*/)?.[0].length || 0))
        : '');
    return dedented.map(line => line ? method.indent + line : line).join('\n').trimEnd();
}

const SAFE_IMPORT = /^(?:import\s+[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s+as\s+[A-Za-z_]\w*)?|from\s+[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s+import\s+[A-Za-z_*][\w*]*(?:\s+as\s+[A-Za-z_]\w*)?(?:\s*,\s*[A-Za-z_*][\w*]*(?:\s+as\s+[A-Za-z_]\w*)?)*)$/;

/** Merge a one-method model response into the runner-owned complete test file. */
export function mergeBugFixReplacement(raw: string, originalCode: string, failure: string): string | undefined {
    const parsed = parseReplacement(raw);
    const selected = selectedFailureMethod(originalCode, failure);
    if (!parsed || !selected || parsed.method !== selected.name || parsed.imports.length > 3) { return undefined; }
    if (!parsed.imports.every(line => SAFE_IMPORT.test(line.trim()))) { return undefined; }
    const replacement = normalizedReplacementMethod(parsed.replacement, selected);
    if (!replacement) { return undefined; }

    const lines = originalCode.replace(/\r\n/g, '\n').split('\n');
    lines.splice(selected.start, selected.end - selected.start, ...replacement.split('\n'));
    const missingImports = parsed.imports.map(line => line.trim())
        .filter(line => !lines.some(existing => existing.trim() === line));
    if (missingImports.length) {
        let insertAt = 0;
        for (let index = 0; index < lines.length; index++) {
            if (/^(?:from\s+\S+\s+import\s+|import\s+)/.test(lines[index])) { insertAt = index + 1; }
        }
        lines.splice(insertAt, 0, ...missingImports);
    }
    return lines.join('\n').trimEnd();
}
