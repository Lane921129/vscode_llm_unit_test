/**
 * Bug Fixer 專用提示詞與局部修復合併器。
 * Bug Fixer prompt and deterministic focused-repair merger.
 */

import { summarizeRepairOutput } from '../validation/repairFeedback';
import { formatTargetContract } from '../pipeline/targetContract';

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
- Use only the failure, target binding, permitted mock paths, complete target source, imports, setup, verified observations, and failing method supplied in BUG_FIX_REQUEST_V4.
- Preserve the test method name. Do not add tests, classes, helpers, source code, or unittest.main().
- A return_value does not raise; use side_effect inside the failing method for a mocked exception.
- For async with client.method(...), use MagicMock for the unawaited method returning a context manager, and AsyncMock for __aenter__/__aexit__ or awaited resource methods. Configuring __aenter__ on an AsyncMock return_value does not fix calling that AsyncMock: the call still returns a coroutine.
- Source code describes the branch under test, but exact expected values still require an explicit return/raise or same-test mock behavior.
- Observations marked uncontrolled-ambient-read cannot supply expected values or exceptions. Control clock/entropy at its use point instead of copying a captured value.
- Return one Python code fence containing at most 3 missing import statements followed by exactly the complete named test method. Use real Python newlines and indentation, never JSON strings or escaped newline text.
- Keep the original method signature and decorators already owned by the host. Do not repeat decorators or wrap the method in a class. Every unchanged test and fixture is preserved by the host.`;
}

export function failedTestNamesFromOutput(output: string): string[] {
    const found = new Set<string>();
    for (const pattern of [
        /^(test_[A-Za-z0-9_]+)\s+\([^\n]+\)\s+\.\.\.\s+(?:FAIL|ERROR)\s*$/gm,
        /^(?:FAIL|ERROR):\s+(test_[A-Za-z0-9_]+)\s+\(/gm
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
    if (output.includes('TEST_ISOLATION_BLOCKED')) { return undefined; }
    if (/(?:_FailedTest|ImportError:|ModuleNotFoundError:|\bin (?:setUp|tearDown|asyncSetUp|asyncTearDown)(?:Class|Module)?\b)/.test(output)) {
        return undefined;
    }
    const fragments = testMethodFragments(code);
    const failed = failedTestNamesFromOutput(output);
    if (failed.length !== 1) { return undefined; }
    const matches = fragments.filter(fragment => fragment.name === failed[0]);
    return matches.length === 1 ? matches[0] : undefined;
}

export function canRepairTestMethod(code: string, output: string): boolean {
    return Boolean(selectedFailureMethod(code, output));
}

function importLines(code: string): string[] {
    return code.replace(/\r\n/g, '\n').split('\n')
        .map(line => line.trim())
        .filter(line => /^(?:from\s+\S+\s+import\s+|import\s+)/.test(line));
}

function focusedSource(sourceCode?: string): string {
    if (!sourceCode?.trim()) { return 'not available'; }
    const source = sourceCode.trim();
    return source;
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
    // Analyst hypotheses are not a repair oracle. Preserve the verified setup.
    void semanticGuidance;
    const method = selectedFailureMethod(brokenCode, errorOutput);
    const imports = importLines(brokenCode);
    return `BUG_FIX_REQUEST_V4
=== REPAIR TARGET ===
- Failing method: ${method?.name || 'not identified; stop without guessing'}
${formatTargetContract(moduleName, funcName, funcArgs, astContext)}
- Allowed mock use points: ${allowedMockTargets.length ? allowedMockTargets.join(', ') : 'none supplied; preserve existing patch paths'}

=== LATEST FAILURE ===
${summarizeRepairOutput(errorOutput)}

=== CURRENT IMPORTS ===
${imports.length ? imports.join('\n') : 'none'}

=== FAILING TEST METHOD ===
${method?.code || 'No unambiguous failing test method was found.'}

=== TEST SETUP AND VERIFIED OBSERVATIONS ===
${formatRepairSetup(brokenCode, astContext, method)}

=== NECESSARY TARGET BRANCH ===
${focusedSource(sourceCode)}

RESPONSE:
Return one Python fence with only truly missing imports and the complete named method. Repair only that method. Preserve its signature. The host merges this fragment into the existing tests.`;
}

/** Target context is read-only; every finding still quotes the test file. */
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
    return [
        formatTargetContract(moduleName, funcName, funcArgs, _astContext),
        `Allowed mock use points: ${allowedMockTargets.length ? allowedMockTargets.join(', ') : 'none supplied'}`,
        `Target source (read-only):\n${focusedSource(_sourceCode)}`,
        `Source setup and verified observations (read-only; same setup only):\n${JSON.stringify({
            constructor: _astContext?.class_context || null, imports: _astContext?.file_imports || [],
            globals: _astContext?.referenced_globals || [], dependencies: dependencyContextsForPrompt(_astContext?.dependencyContexts),
            observations: observationsForPrompt(_astContext?.traceResult)
        })}`,
        'Every finding must quote TEST_FILE; these constraints cannot be quoted as evidence.'
    ].join('\n');
}

function formatRepairSetup(code: string, astContext?: any, method?: TestMethodFragment): string {
    const allLines = code.split(/\r?\n/);
    let classStart = -1;
    for (let index = 0; method && index < method.start; index++) {
        if (/^class\s+/.test(allLines[index])) { classStart = index; }
    }
    let classEnd = method?.end || 0;
    while (classEnd < allLines.length && !/^class\s+/.test(allLines[classEnd])) { classEnd++; }
    const lines = classStart >= 0 ? allLines.slice(classStart, classEnd) : [];
    const fixtures: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(\s+)(?:async\s+)?def\s+(?:setUp|tearDown|asyncSetUp|asyncTearDown|setUpClass|tearDownClass)\s*\(/);
        if (!match) { continue; }
        const start = i;
        while (i + 1 < lines.length && (!lines[i + 1].trim() || (lines[i + 1].match(/^\s*/)?.[0].length || 0) > match[1].length)) { i++; }
        fixtures.push(lines.slice(start, i + 1).join('\n'));
    }
    return JSON.stringify({ testClass: lines[0] || null, fixtures, constructor: astContext?.class_context || null,
        imports: astContext?.file_imports || [], globals: astContext?.referenced_globals || [],
        dependencies: dependencyContextsForPrompt(astContext?.dependencyContexts), observations: observationsForPrompt(astContext?.traceResult) });
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
    const selected = selectedFailureMethod(originalCode, failure);
    if (!selected) { return undefined; }
    const parsed = parsePythonReplacement(raw, selected.name) || parseReplacement(raw);
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

/** Native Python avoids asking small models to JSON-escape a method body. */
function parsePythonReplacement(raw: string, method: string): BugFixReplacement | undefined {
    const block = raw.trim().match(/^```(?:python|py)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
    if (!block || block[1].includes('```')) { return undefined; }
    const lines = block[1].replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex(line => /^\s*(?:async\s+)?def\s+test_\w*\s*\(/.test(line));
    if (start < 0) { return undefined; }
    const imports = lines.slice(0, start).map(line => line.trim()).filter(Boolean);
    if (imports.length > 3 || !imports.every(line => SAFE_IMPORT.test(line))) { return undefined; }
    return { method, replacement: lines.slice(start).join('\n'), imports };
}
import { dependencyContextsForPrompt, observationsForPrompt } from '../pipeline/evidenceContracts';
