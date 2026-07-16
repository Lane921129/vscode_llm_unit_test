import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ============================================================================
// Copied function implementations from extension.ts (non-exported internals)
// ============================================================================

function sanitizeLlmResponse(rawCode: string): string {
    let cleanCode = rawCode.trim();
    const blocks: string[] = [];

    const pyRegex = /```python([\s\S]*?)```/g;
    let match;
    while ((match = pyRegex.exec(cleanCode)) !== null) {
        blocks.push(match[1].trim());
    }

    if (blocks.length === 0) {
        const genericRegex = /```([\s\S]*?)```/g;
        while ((match = genericRegex.exec(cleanCode)) !== null) {
            blocks.push(match[1].trim());
        }
    }

    if (blocks.length > 0) {
        // Find the block that contains unittest
        for (const block of blocks) {
            if (block.includes('unittest') || block.includes('TestCase')) {
                return block;
            }
        }
        // Fallback to the last block
        return blocks[blocks.length - 1];
    }

    return cleanCode;
}

function rescueToUnittest(rawCode: string, srcFilePath: string, funcName: string): string {
    const moduleName = path.basename(srcFilePath, '.py');
    const targetFunc = funcName || moduleName;

    // 去除 >>> 前綴，逐行整理
    const lines = rawCode
        .split('\n')
        .map(l => l.replace(/^>>>\s?/, '').trim())
        .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('...'));

    const testMethods: string[] = [];
    let methodIndex = 1;

    for (const line of lines) {
        let testBody = '';

        if (line.startsWith('assert ')) {
            const assertBody = line.substring(7).trim();
            const eqMatch = assertBody.match(/^(.+?)\s*==\s*(.+)$/);
            const neqMatch = assertBody.match(/^(.+?)\s*!=\s*(.+)$/);
            if (eqMatch) {
                testBody = `self.assertEqual(${eqMatch[1].trim()}, ${eqMatch[2].trim()})`;
            } else if (neqMatch) {
                testBody = `self.assertNotEqual(${neqMatch[1].trim()}, ${neqMatch[2].trim()})`;
            } else {
                testBody = `self.assertTrue(${assertBody})`;
            }
        } else if (line.startsWith('print(') || line.startsWith('import ') || line.startsWith('from ')) {
            continue;
        } else if (line.includes('==') && !line.startsWith('def ') && !line.startsWith('class ')) {
            const eqMatch = line.match(/^(.+?)\s*==\s*(.+)$/);
            if (eqMatch && eqMatch[1].includes('(')) {
                testBody = `self.assertEqual(${eqMatch[1].trim()}, ${eqMatch[2].trim()})`;
            }
        }

        if (testBody) {
            testMethods.push(`    def test_case_${methodIndex}(self):\n        ${testBody}`);
            methodIndex++;
        }
    }

    // 先對受測原始檔案讀取函式簽名
    let srcArgCount = 0;
    try {
        const srcContent = fs.readFileSync(srcFilePath, 'utf8');
        const srcDefMatch = srcContent.match(/def\s+(?:${targetFunc}|\w+)\s*\(([^)]*)\)/);
        if (srcDefMatch) {
            srcArgCount = srcDefMatch[1].split(',').filter((a: string) => a.trim() && !a.includes('self')).length;
        }
    } catch { /* 讀取失敗就用預設字元 */ }

    // 嘗試從 AI 輸出中解析函式名稱
    const defMatchGlobal = rawCode.match(/def\s+(\w+)\s*\(/);
    const resolvedFunc = defMatchGlobal ? defMatchGlobal[1] : targetFunc;

    if (testMethods.length === 0) { return ''; }

    return [
        `import unittest`,
        `from ${moduleName} import *`,
        ``,
        `class TestAuto(unittest.TestCase):`,
        testMethods.join('\n\n'),
        ``,
        `if __name__ == '__main__':`,
        `    unittest.main()`,
    ].join('\n');
}

function parseMutatestSurvived(mutatestResult: string): string {
    const lines = mutatestResult.split('\n');
    let isSurvivedSection = false;
    const survivedList: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        // 移除 ANSI 色碼（如 [91m, [0m）
        line = line.replace(/\x1B\[\d+m/g, '');
        // 移除有些情況下沒有 \x1B 但只有 [0m 的殘留字元
        line = line.replace(/\[\d+m/g, '');

        if (line === 'SURVIVED' && lines[i + 1]?.replace(/\[\d+m/g, '').trim() === '--------') {
            isSurvivedSection = true;
            i++; continue;
        }
        if (isSurvivedSection) {
            if (line === '' || line.startsWith('2026-') || line.match(/^\d{4}-\d{2}-\d{2}/)) { break; }
            if (line.startsWith('- ')) { survivedList.push(line); }
        }
    }
    return survivedList.join('\n');
}

function parseMutmutSurvived(mutatestResult: string): string {
    const lines = mutatestResult.split('\n');
    const survivedList: string[] = [];
    let capture = false;
    for (const line of lines) {
        if (line.includes('FAILED:') || line.includes('Survived:') || line.includes('survived')) { capture = true; }
        if (capture && line.trim() !== '') { survivedList.push(line.trim()); }
    }
    return survivedList.join('\n');
}

// ============================================================================
// Tests
// ============================================================================

suite('Core Functions Test Suite', () => {

    // ========================================================================
    // sanitizeLlmResponse
    // ========================================================================
    suite('sanitizeLlmResponse', () => {

        test('should extract a single python code block', () => {
            const input = 'Here is the test:\n```python\nimport unittest\nclass Test(unittest.TestCase):\n    pass\n```';
            const result = sanitizeLlmResponse(input);
            assert.ok(result.includes('import unittest'));
            assert.ok(result.includes('class Test'));
        });

        test('should prefer the block containing unittest among multiple python blocks', () => {
            const input = [
                '```python',
                'print("hello")',
                '```',
                '```python',
                'import unittest',
                'class MyTest(unittest.TestCase):',
                '    def test_a(self): pass',
                '```',
            ].join('\n');
            const result = sanitizeLlmResponse(input);
            assert.ok(result.includes('import unittest'));
            assert.ok(result.includes('class MyTest'));
        });

        test('should prefer the block containing TestCase among multiple python blocks', () => {
            const input = [
                '```python',
                'x = 1',
                '```',
                '```python',
                'class FooTestCase:',
                '    pass',
                '```',
                '```python',
                'y = 2',
                '```',
            ].join('\n');
            const result = sanitizeLlmResponse(input);
            assert.ok(result.includes('TestCase'));
        });

        test('should fall back to last block when none contain unittest/TestCase', () => {
            const input = [
                '```python',
                'x = 1',
                '```',
                '```python',
                'y = 2',
                '```',
            ].join('\n');
            const result = sanitizeLlmResponse(input);
            assert.strictEqual(result, 'y = 2');
        });

        test('should extract generic code blocks when no python blocks exist', () => {
            const input = 'Some text\n```\ngeneric code\n```\nmore text';
            const result = sanitizeLlmResponse(input);
            assert.strictEqual(result, 'generic code');
        });

        test('should prefer generic block with unittest when multiple generic blocks exist', () => {
            const input = [
                '```',
                'foo bar',
                '```',
                '```',
                'import unittest',
                '```',
            ].join('\n');
            const result = sanitizeLlmResponse(input);
            assert.ok(result.includes('import unittest'));
        });

        test('should return trimmed raw string when no code blocks found', () => {
            const input = '  just some text with no code blocks  ';
            const result = sanitizeLlmResponse(input);
            assert.strictEqual(result, 'just some text with no code blocks');
        });

        test('should handle empty string', () => {
            const result = sanitizeLlmResponse('');
            assert.strictEqual(result, '');
        });

        test('should handle code block with thinking text before it', () => {
            const input = [
                '<think>',
                'Let me think about this problem...',
                'I need to write tests for the add function.',
                '</think>',
                '',
                '```python',
                'import unittest',
                'class TestAdd(unittest.TestCase):',
                '    def test_add(self):',
                '        self.assertEqual(add(1, 2), 3)',
                '```',
            ].join('\n');
            const result = sanitizeLlmResponse(input);
            assert.ok(result.includes('import unittest'));
            assert.ok(result.includes('TestAdd'));
            assert.ok(!result.includes('<think>'));
        });

        test('should handle nested-looking code blocks (triple backticks inside)', () => {
            // The regex is non-greedy, so the first ``` pair closes first
            const input = '```python\ncode_part_1\n```\nSome text\n```python\ncode_part_2\n```';
            const result = sanitizeLlmResponse(input);
            // Neither block has unittest, so it should return the last one
            assert.strictEqual(result, 'code_part_2');
        });

        test('should prefer python blocks over generic blocks', () => {
            const input = [
                '```',
                'import unittest',
                '```',
                '```python',
                'plain code',
                '```',
            ].join('\n');
            const result = sanitizeLlmResponse(input);
            // Python blocks are checked first; since there's a python block, generic blocks are ignored
            assert.strictEqual(result, 'plain code');
        });
    });

    // ========================================================================
    // rescueToUnittest
    // ========================================================================
    suite('rescueToUnittest', () => {

        let tmpDir: string;
        let srcFilePath: string;

        setup(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
            srcFilePath = path.join(tmpDir, 'my_module.py');
            fs.writeFileSync(srcFilePath, 'def add(a, b):\n    return a + b\n', 'utf8');
        });

        teardown(() => {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        });

        test('should convert REPL format with >>> prefixes', () => {
            const input = '>>> assert add(1, 2) == 3\n>>> assert add(0, 0) == 0';
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.ok(result.includes('self.assertEqual(add(1, 2), 3)'));
            assert.ok(result.includes('self.assertEqual(add(0, 0), 0)'));
            assert.ok(result.includes('import unittest'));
            assert.ok(result.includes('from my_module import *'));
        });

        test('should convert assert x == y to self.assertEqual', () => {
            const input = 'assert add(1, 2) == 3';
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.ok(result.includes('self.assertEqual(add(1, 2), 3)'));
        });

        test('should convert assert x != y to self.assertNotEqual', () => {
            const input = 'assert add(1, 2) != 4';
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.ok(result.includes('self.assertNotEqual(add(1, 2), 4)'));
        });

        test('should convert bare assert expr to self.assertTrue', () => {
            const input = 'assert add(1, 2)';
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.ok(result.includes('self.assertTrue(add(1, 2))'));
        });

        test('should skip print(), import, and from lines', () => {
            const input = [
                'print("hello")',
                'import os',
                'from sys import argv',
                'assert add(1, 2) == 3',
            ].join('\n');
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.ok(!result.includes('print'));
            assert.ok(!result.includes('import os'));
            assert.ok(!result.includes('from sys'));
            assert.ok(result.includes('self.assertEqual'));
        });

        test('should detect bare == expressions with function calls', () => {
            const input = 'add(1, 2) == 3';
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.ok(result.includes('self.assertEqual(add(1, 2), 3)'));
        });

        test('should return empty string when no test methods can be extracted', () => {
            const input = 'print("no tests here")\nimport os\nfrom sys import argv';
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.strictEqual(result, '');
        });

        test('should handle empty input', () => {
            const result = rescueToUnittest('', srcFilePath, 'add');
            assert.strictEqual(result, '');
        });

        test('should handle input with only comments', () => {
            const input = '# this is a comment\n# another comment';
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.strictEqual(result, '');
        });

        test('should handle input with only print statements', () => {
            const input = 'print(add(1, 2))\nprint("done")';
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.strictEqual(result, '');
        });

        test('should handle mixed valid and invalid lines', () => {
            const input = [
                '# comment',
                'print("debug")',
                'import os',
                '>>> assert add(3, 4) == 7',
                '... continuation',
                'assert add(0, 1) != 0',
            ].join('\n');
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.ok(result.includes('self.assertEqual(add(3, 4), 7)'));
            assert.ok(result.includes('self.assertNotEqual(add(0, 1), 0)'));
            // continuation lines (starting with ...) should be filtered
            assert.ok(!result.includes('continuation'));
        });

        test('should produce correct overall structure', () => {
            const input = 'assert add(1, 1) == 2';
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.ok(result.startsWith('import unittest'));
            assert.ok(result.includes('class TestAuto(unittest.TestCase):'));
            assert.ok(result.includes("if __name__ == '__main__':"));
            assert.ok(result.includes('unittest.main()'));
        });

        test('should number test methods incrementally', () => {
            const input = 'assert add(1, 2) == 3\nassert add(3, 4) == 7';
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.ok(result.includes('test_case_1'));
            assert.ok(result.includes('test_case_2'));
        });

        test('should not convert bare == without function call on left side', () => {
            // "x == 3" where x has no parens — should NOT be converted
            const input = 'x == 3';
            const result = rescueToUnittest(input, srcFilePath, 'add');
            assert.strictEqual(result, '');
        });

        test('should handle non-existent source file gracefully', () => {
            const fakePath = path.join(tmpDir, 'nonexistent.py');
            const input = 'assert add(1, 2) == 3';
            // Should not throw; fs.readFileSync failure is caught
            const result = rescueToUnittest(input, fakePath, 'add');
            assert.ok(result.includes('self.assertEqual'));
            assert.ok(result.includes('from nonexistent import *'));
        });
    });

    // ========================================================================
    // parseMutatestSurvived
    // ========================================================================
    suite('parseMutatestSurvived', () => {

        test('should parse normal output with survived mutants', () => {
            const input = [
                'TOTAL RUNS: 10',
                'SURVIVED',
                '--------',
                '- mutation: BinOp_Add_Sub (l: 5, c: 11)',
                '- mutation: CompareIs_IsNot (l: 10, c: 4)',
                '',
                'DETECTED',
                '--------',
            ].join('\n');
            const result = parseMutatestSurvived(input);
            assert.ok(result.includes('BinOp_Add_Sub'));
            assert.ok(result.includes('CompareIs_IsNot'));
            const lines = result.split('\n');
            assert.strictEqual(lines.length, 2);
        });

        test('should strip ANSI color codes', () => {
            const input = [
                '\x1B[91mSURVIVED\x1B[0m',
                '\x1B[91m--------\x1B[0m',
                '\x1B[91m- mutation: BinOp_Add_Sub (l: 5, c: 11)\x1B[0m',
                '',
            ].join('\n');
            const result = parseMutatestSurvived(input);
            assert.ok(result.includes('- mutation: BinOp_Add_Sub'));
            assert.ok(!result.includes('\x1B'));
        });

        test('should strip residual color code markers without ESC prefix', () => {
            const input = [
                '[91mSURVIVED[0m',
                '[91m--------[0m',
                '[91m- mutation: BinOp_Sub_Add (l: 3, c: 7)[0m',
                '',
            ].join('\n');
            const result = parseMutatestSurvived(input);
            assert.ok(result.includes('- mutation: BinOp_Sub_Add'));
        });

        test('should return empty string when no survived mutants', () => {
            const input = [
                'TOTAL RUNS: 5',
                'DETECTED',
                '--------',
                '- mutation: BinOp_Add_Sub (l: 5, c: 11)',
                '',
            ].join('\n');
            const result = parseMutatestSurvived(input);
            assert.strictEqual(result, '');
        });

        test('should handle empty string', () => {
            const result = parseMutatestSurvived('');
            assert.strictEqual(result, '');
        });

        test('should stop collecting at date-prefixed line', () => {
            const input = [
                'SURVIVED',
                '--------',
                '- mutation: BinOp_Add_Sub (l: 5, c: 11)',
                '2026-07-15 some log line',
            ].join('\n');
            const result = parseMutatestSurvived(input);
            assert.ok(result.includes('BinOp_Add_Sub'));
            assert.ok(!result.includes('2026-07-15'));
            assert.strictEqual(result.split('\n').length, 1);
        });

        test('should stop collecting at empty line', () => {
            const input = [
                'SURVIVED',
                '--------',
                '- mutation: BinOp_Add_Sub (l: 5, c: 11)',
                '- mutation: BinOp_Mul_Div (l: 8, c: 3)',
                '',
                '- mutation: should_not_be_captured (l: 20, c: 1)',
            ].join('\n');
            const result = parseMutatestSurvived(input);
            assert.ok(result.includes('BinOp_Add_Sub'));
            assert.ok(result.includes('BinOp_Mul_Div'));
            assert.ok(!result.includes('should_not_be_captured'));
        });

        test('should only capture lines starting with "- "', () => {
            const input = [
                'SURVIVED',
                '--------',
                '- mutation: BinOp_Add_Sub (l: 5, c: 11)',
                'some random line without dash prefix',
                '- mutation: CompareIs (l: 7, c: 2)',
                '',
            ].join('\n');
            const result = parseMutatestSurvived(input);
            assert.ok(result.includes('BinOp_Add_Sub'));
            assert.ok(result.includes('CompareIs'));
            assert.ok(!result.includes('some random line'));
        });

        test('should handle output with multiple sections (SURVIVED then DETECTED)', () => {
            const input = [
                'Summary',
                'TOTAL RUNS: 8',
                'SURVIVED',
                '--------',
                '- mutation: BinOp_Add_Sub (l: 5, c: 11)',
                '',
                'DETECTED',
                '--------',
                '- mutation: BinOp_Sub_Add (l: 3, c: 7)',
                '',
            ].join('\n');
            const result = parseMutatestSurvived(input);
            // Should only capture from SURVIVED section, stopping at empty line
            assert.ok(result.includes('BinOp_Add_Sub'));
            assert.ok(!result.includes('BinOp_Sub_Add'));
        });
    });

    // ========================================================================
    // parseMutmutSurvived
    // ========================================================================
    suite('parseMutmutSurvived', () => {

        test('should capture lines after FAILED: trigger', () => {
            const input = [
                'Running tests...',
                'FAILED: mutant 1',
                'mutant 1 detail',
                'mutant 2 detail',
            ].join('\n');
            const result = parseMutmutSurvived(input);
            assert.ok(result.includes('FAILED: mutant 1'));
            assert.ok(result.includes('mutant 1 detail'));
            assert.ok(result.includes('mutant 2 detail'));
        });

        test('should capture lines after Survived: trigger', () => {
            const input = [
                'Total: 10',
                'Survived: 3 mutants',
                'mutant a',
                'mutant b',
            ].join('\n');
            const result = parseMutmutSurvived(input);
            assert.ok(result.includes('Survived: 3 mutants'));
            assert.ok(result.includes('mutant a'));
            assert.ok(result.includes('mutant b'));
        });

        test('should capture lines after lowercase survived trigger', () => {
            const input = [
                'some header',
                '2 survived',
                'detail line 1',
            ].join('\n');
            const result = parseMutmutSurvived(input);
            assert.ok(result.includes('2 survived'));
            assert.ok(result.includes('detail line 1'));
        });

        test('should skip empty lines after capture starts', () => {
            const input = [
                'FAILED: mutant 1',
                '',
                'next line',
            ].join('\n');
            const result = parseMutmutSurvived(input);
            // Empty lines are skipped (trim !== '')
            assert.ok(result.includes('FAILED: mutant 1'));
            assert.ok(result.includes('next line'));
            assert.ok(!result.includes('\n\n'));
        });

        test('should return empty string when no triggers found', () => {
            const input = 'All mutants killed\nDone.\n';
            const result = parseMutmutSurvived(input);
            assert.strictEqual(result, '');
        });

        test('should handle empty string', () => {
            const result = parseMutmutSurvived('');
            assert.strictEqual(result, '');
        });

        test('should not capture lines before the trigger', () => {
            const input = [
                'line before 1',
                'line before 2',
                'FAILED: mutant 1',
                'after line',
            ].join('\n');
            const result = parseMutmutSurvived(input);
            assert.ok(!result.includes('line before 1'));
            assert.ok(!result.includes('line before 2'));
            assert.ok(result.includes('FAILED: mutant 1'));
            assert.ok(result.includes('after line'));
        });
    });
});
