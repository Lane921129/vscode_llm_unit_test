export interface MergeResult {
    mergedCode: string;
    totalMethodsCount: number;
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
