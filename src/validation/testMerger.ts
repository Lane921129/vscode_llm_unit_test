export interface MergeResult {
    mergedCode: string;
    totalMethodsCount: number;
}

interface ExtractedTestClass {
    lines: string[];
    testMethodCount: number;
}

function extractTopLevelTestClass(snippet: string): ExtractedTestClass | undefined {
    const lines = snippet.split(/\r?\n/);
    const classStart = lines.findIndex(line =>
        /^class\s+\w+\s*\(\s*unittest\.(?:TestCase|IsolatedAsyncioTestCase)\s*\)\s*:/.test(line)
    );
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
        for (const line of snippet.split(/\r?\n/)) {
            const trimmed = line.trim();
            if ((trimmed.startsWith('import ') || trimmed.startsWith('from ')) &&
                !trimmed.includes('module_name') && !trimmed.includes('MODULE_NAME')) {
                imports.add(trimmed);
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

    const mergedCode = [
        ...imports,
        '',
        ...(classes.length > 0 ? classes : [`class ${safeClassStem}(unittest.TestCase):\n    pass`]),
        '',
        `if __name__ == '__main__':`,
        `    unittest.main()`
    ].join('\n\n');

    return { mergedCode, totalMethodsCount };
}
