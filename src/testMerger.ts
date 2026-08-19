export interface MergeResult {
    mergedCode: string;
    totalMethodsCount: number;
}

export function mergeTestSnippets(snippets: string[], className: string = 'TestMergedSuite'): MergeResult {
    const allImportsSet = new Set<string>();
    allImportsSet.add('import unittest');

    const setupBodies: string[] = [];
    const teardownBodies: string[] = [];
    const testMethods: string[] = [];
    const helperMethods: string[] = [];
    const seenMethodNames = new Map<string, number>();

    for (let sIdx = 0; sIdx < snippets.length; sIdx++) {
        const snippet = snippets[sIdx];
        const lines = snippet.split('\n');
        let currentMethodName = '';
        let currentMethodLines: string[] = [];

        const flushCurrentMethod = () => {
            if (!currentMethodName || currentMethodLines.length === 0) return;
            const body = currentMethodLines.join('\n');

            if (currentMethodName === 'setUp') {
                setupBodies.push(body);
            } else if (currentMethodName === 'tearDown') {
                teardownBodies.push(body);
            } else if (currentMethodName.startsWith('test_')) {
                let finalName = currentMethodName;
                const count = seenMethodNames.get(currentMethodName) || 0;
                seenMethodNames.set(currentMethodName, count + 1);

                if (count > 0) {
                    finalName = `${currentMethodName}_site${sIdx + 1}`;
                }
                const renamedBody = body.replace(new RegExp(`def\\s+${currentMethodName}\\s*\\(`), `def ${finalName}(`);
                testMethods.push(renamedBody);
            } else {
                helperMethods.push(body);
            }
            currentMethodName = '';
            currentMethodLines = [];
        };

        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
                if (!trimmed.includes('module_name') && !trimmed.includes('MODULE_NAME')) {
                    allImportsSet.add(trimmed);
                }
                continue;
            }

            const methodMatch = line.match(/^(\s*)def\s+([a-zA-Z0-9_]+)\s*\(/);
            if (methodMatch) {
                flushCurrentMethod();
                currentMethodName = methodMatch[2];
                currentMethodLines = [line];
                continue;
            }

            if (currentMethodName) {
                if (line.match(/^class\s+/) || line.match(/^if\s+__name__/)) {
                    flushCurrentMethod();
                    continue;
                }
                if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('#')) {
                    flushCurrentMethod();
                    continue;
                }
                currentMethodLines.push(line);
            }
        }
        flushCurrentMethod();
    }

    // 整合 setUp 與 tearDown
    const mergedClassLines: string[] = [];
    if (setupBodies.length > 0) {
        mergedClassLines.push(`    def setUp(self):`);
        for (const s of setupBodies) {
            const inner = s.split('\n').slice(1).map(l => '    ' + l).join('\n');
            if (inner.trim()) mergedClassLines.push(inner);
        }
    }

    if (teardownBodies.length > 0) {
        mergedClassLines.push(`    def tearDown(self):`);
        for (const t of teardownBodies) {
            const inner = t.split('\n').slice(1).map(l => '    ' + l).join('\n');
            if (inner.trim()) mergedClassLines.push(inner);
        }
    }

    const allMethods = [...mergedClassLines, ...helperMethods, ...testMethods];

    const mergedCode = [
        Array.from(allImportsSet).join('\n'),
        '',
        `class ${className}(unittest.TestCase):`,
        allMethods.length > 0 ? allMethods.join('\n\n') : '    pass',
        '',
        `if __name__ == '__main__':`,
        `    unittest.main()`
    ].join('\n');

    return {
        mergedCode,
        totalMethodsCount: testMethods.length
    };
}