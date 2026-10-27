import { createHash } from 'node:crypto';
import { runSpawn } from '../utils/processRunner';
import { pythonToolPath } from '../pipeline/pythonTools';
import { currentExecution } from '../pipeline/executionContext';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { extractPythonTestCode } from './generatedTestValidator';

export interface MergeResult {
    mergedCode: string;
    totalMethodsCount: number;
}

export type BaselineMergeResult = ({ ok: true } & MergeResult) | { ok: false; reasonCode: string };

export interface AddedTestMethod { className: string; name: string }
export type WriterAdditionMergeResult = ({ ok: true; addedMethodsCount: number; addedMethods: AddedTestMethod[] } & MergeResult)
    | { ok: false; reasonCode: string };

export type WriterAdditionContext = { ok: true; contextCode: string; methodIds: string[]; baselineHash: string }
    | { ok: false; reasonCode: string };

/** Prompt-only AST view for fixture-free suites. The original baseline remains
 * the sole executed/preserved artifact; this projection grants no approval. */
export async function projectWriterAdditionContext(options: {
    baseline: string; python: string; env?: NodeJS.ProcessEnv;
}): Promise<WriterAdditionContext> {
    if (!options.baseline.trim() || Buffer.byteLength(options.baseline, 'utf8') > 1024 * 1024) {
        return { ok: false, reasonCode: 'invalid-baseline-input' };
    }
    let run: Awaited<ReturnType<typeof runSpawn>>;
    try {
        run = await runSpawn(options.python, ['-B', pythonToolPath('testMerge')], {
            input: JSON.stringify({ mode: 'writer-addition-context-v1', baseline: options.baseline }),
            env: options.env, timeout: 5000
        });
    } catch (error) {
        currentExecution()?.throwIfCancelled();
        if (error instanceof AnalysisStageError || (error instanceof Error && error.name === 'AbortError')) { throw error; }
        return { ok: false, reasonCode: 'projection-tool-error' };
    }
    if (run.code === 0) {
        try {
            const value = JSON.parse(run.stdout);
            if (value?.schemaVersion === 'writer-addition-context-v1') {
                const rejections = new Set(['invalid-baseline-input', 'invalid-python-structure', 'addition-context-unsupported']);
                if (value.ok === false && rejections.has(value.reasonCode)) {
                    return { ok: false, reasonCode: value.reasonCode };
                }
                const methodId = /^[\p{ID_Start}_][\p{ID_Continue}]*\.test_[\p{ID_Continue}]+$/u;
                const baselineHash = createHash('sha256').update(options.baseline, 'utf8').digest('hex');
                const classNames = new Set<string>(Array.isArray(value.methodIds)
                    ? value.methodIds.filter((id: unknown): id is string => typeof id === 'string').map((id: string) => id.split('.')[0])
                    : []);
                const contextClasses = new Set<string>(
                    typeof value.contextCode === 'string'
                        ? Array.from((value.contextCode as string).matchAll(/^class\s+([\p{ID_Start}_][\p{ID_Continue}]*)\s*\(/gmu)).map(m => m[1])
                        : []
                );
                if (value.ok === true && typeof value.contextCode === 'string' && value.contextCode.trim()
                    && Buffer.byteLength(value.contextCode, 'utf8') <= 1024 * 1024 && value.baselineHash === baselineHash
                    && Array.isArray(value.methodIds) && value.methodIds.length > 0 && value.methodIds.length <= 256
                    && value.methodIds.every((id: unknown) => typeof id === 'string' && methodId.test(id))
                    && new Set(value.methodIds).size === value.methodIds.length
                    && classNames.size >= 1 && classNames.size <= 32
                    && contextClasses.size === classNames.size
                    && Array.from(classNames).every(name => contextClasses.has(name))) {
                    return { ok: true, contextCode: value.contextCode, methodIds: value.methodIds, baselineHash };
                }
            }
        } catch { /* An incomplete or malformed projection is never setup evidence. */ }
    }
    return { ok: false, reasonCode: 'projection-tool-error' };
}

/** Remove only a complete, unambiguous transport wrapper around the addition. */
export function extractWriterAdditionCode(response: string): string {
    return extractPythonTestCode(response, 'addition');
}

/** AST composition only. This result still requires every normal candidate gate. */
export async function mergeWriterTestAddition(options: {
    baseline: string; addition: string; python: string; env?: NodeJS.ProcessEnv;
}): Promise<WriterAdditionMergeResult> {
    const run = await runSpawn(options.python, ['-B', pythonToolPath('testMerge')], {
        input: JSON.stringify({ mode: 'writer-addition-v1', baseline: options.baseline, addition: extractWriterAdditionCode(options.addition) }),
        env: options.env, timeout: 5000
    });
    if (run.code === 0) {
        try {
            const value = JSON.parse(run.stdout);
            if (value?.schemaVersion === 'writer-test-addition-v1') {
                if (value.ok === false && typeof value.reasonCode === 'string' && /^[a-z-]+$/.test(value.reasonCode)) {
                    return { ok: false, reasonCode: value.reasonCode };
                }
                const identifier = /^[\p{ID_Start}_][\p{ID_Continue}]*$/u;
                if (value.ok === true && typeof value.mergedCode === 'string' && value.mergedCode.trim()
                    && Number.isSafeInteger(value.totalMethodsCount) && value.totalMethodsCount > 0
                    && Number.isSafeInteger(value.addedMethodsCount) && value.addedMethodsCount >= 0 && value.addedMethodsCount <= 32
                    && value.addedMethodsCount <= value.totalMethodsCount && Array.isArray(value.addedMethods)
                    && value.addedMethods.length === value.addedMethodsCount && value.addedMethods.every((method: AddedTestMethod) =>
                        method && typeof method.className === 'string' && identifier.test(method.className)
                        && typeof method.name === 'string' && identifier.test(method.name) && method.name.startsWith('test'))) {
                    return { ok: true, mergedCode: value.mergedCode, totalMethodsCount: value.totalMethodsCount,
                        addedMethodsCount: value.addedMethodsCount, addedMethods: value.addedMethods };
                }
            }
        } catch { /* No complete valid tool result means no candidate. */ }
    }
    return { ok: false, reasonCode: 'merge-tool-error' };
}

/** Preserve the actual executed baseline; AST composition is never approval to
 * execute or an exemption from the existing preservation/structure gates. */
export async function mergeTestSnippetsPreservingBaseline(options: {
    baseline: string; snippets: string[]; className: string; python: string; env?: NodeJS.ProcessEnv;
}): Promise<BaselineMergeResult> {
    const run = await runSpawn(options.python, ['-B', pythonToolPath('testMerge')], {
        input: JSON.stringify({ baseline: options.baseline, snippets: options.snippets, className: options.className }),
        env: options.env, timeout: 5000
    });
    if (run.code === 0) {
        try {
            const result = JSON.parse(run.stdout);
            if (result.schemaVersion === 'baseline-test-merge-v1') {
                if (result.ok === true && typeof result.mergedCode === 'string' && result.mergedCode.trim()
                    && Number.isSafeInteger(result.totalMethodsCount) && result.totalMethodsCount > 0) {
                    return { ok: true, mergedCode: result.mergedCode, totalMethodsCount: result.totalMethodsCount };
                }
                if (result.ok === false && typeof result.reasonCode === 'string' && /^[a-z-]+$/.test(result.reasonCode)) {
                    return { ok: false, reasonCode: result.reasonCode };
                }
            }
        } catch { /* Invalid tool output is never a merged candidate. */ }
    }
    return { ok: false, reasonCode: 'merge-tool-error' };
}

interface ExtractedTestClass {
    lines: string[];
    testMethodCount: number;
}

/** Resolve only standard-library unittest TestCase spellings imported by a snippet. */
function unittestTestCaseBases(lines: string[]): Set<string> {
    const bases = new Set<string>();
    for (const line of lines) {
        const importMatch = line.match(/^\s*import\s+unittest(?:\s+as\s+([A-Za-z_]\w*))?\s*$/);
        if (importMatch) {
            const moduleName = importMatch[1] || 'unittest';
            bases.add(`${moduleName}.TestCase`);
            bases.add(`${moduleName}.IsolatedAsyncioTestCase`);
            continue;
        }
        const fromMatch = line.match(/^\s*from\s+unittest\s+import\s+(.+?)\s*$/);
        if (!fromMatch) {continue;}
        for (const imported of fromMatch[1].split(',')) {
            const aliasMatch = imported.trim().match(/^(TestCase|IsolatedAsyncioTestCase)(?:\s+as\s+([A-Za-z_]\w*))?$/);
            if (aliasMatch) {
                bases.add(aliasMatch[2] || aliasMatch[1]);
            }
        }
    }
    return bases;
}

function extractTopLevelTestClass(snippet: string): ExtractedTestClass | undefined {
    const lines = snippet.split(/\r?\n/);
    const allowedBases = unittestTestCaseBases(lines);
    const classStart = lines.findIndex(line => {
        const match = line.match(/^class\s+\w+\s*\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\)\s*:/);
        return Boolean(match && allowedBases.has(match[1]));
    });
    if (classStart < 0) {return undefined;}

    let classEnd = lines.length;
    for (let index = classStart + 1; index < lines.length; index++) {
        if (/^(?:class\s+|if\s+__name__\s*==)/.test(lines[index])) {
            classEnd = index;
            break;
        }
    }
    const classLines = lines.slice(classStart, classEnd);
    return {
        lines: classLines,
        testMethodCount: classLines.filter(line => /^\s+(?:async\s+)?def\s+test_\w*\s*\(/.test(line)).length
    };
}

/**
 * Tier 2 subtasks are complete, independently validated unittest files. Keep
 * their TestCase classes separate when combining them: merging setUp/tearDown
 * bodies makes one caller-context's mocks or fixtures overwrite another's.
 */
export function mergeTestSnippets(snippets: string[], className: string = 'TestMergedSuite'): MergeResult {
    const imports = new Set<string>(['import unittest']);
    const classes: string[] = [];
    let totalMethodsCount = 0;
    const safeClassStem = className.replace(/\W/g, '_') || 'TestMergedSuite';

    for (let index = 0; index < snippets.length; index++) {
        const snippet = snippets[index];
        const snippetLines = snippet.split(/\r?\n/);
        for (let i = 0; i < snippetLines.length; i++) {
            const trimmed = snippetLines[i].trim();
            if ((trimmed.startsWith('import ') || trimmed.startsWith('from ')) &&
                !trimmed.includes('module_name') && !trimmed.includes('MODULE_NAME')) {
                let importStmt = trimmed;
                let openParens = (importStmt.match(/\(/g) || []).length - (importStmt.match(/\)/g) || []).length;
                while (openParens > 0 && i + 1 < snippetLines.length) {
                    i++;
                    const nextLine = snippetLines[i];
                    importStmt += '\n' + nextLine;
                    openParens += (nextLine.match(/\(/g) || []).length - (nextLine.match(/\)/g) || []).length;
                }
                imports.add(importStmt);
            }
        }

        const extracted = extractTopLevelTestClass(snippet);
        if (!extracted || extracted.testMethodCount === 0) {continue;}
        const classLines = [...extracted.lines];
        const mergedClassName = `${safeClassStem}_Site${index + 1}`;
        classLines[0] = classLines[0].replace(/^class\s+\w+/, `class ${mergedClassName}`);
        classes.push(classLines.join('\n').trimEnd());
        totalMethodsCount += extracted.testMethodCount;
    }

    const importsBlock = Array.from(imports).join('\n');
    const classesBlock = (classes.length > 0 ? classes : [`class ${safeClassStem}(unittest.TestCase):\n    pass`]).join('\n\n');
    const mainBlock = `if __name__ == '__main__':\n    unittest.main()`;

    const mergedCode = `${importsBlock}\n\n${classesBlock}\n\n${mainBlock}\n`;

    return { mergedCode, totalMethodsCount };
}
