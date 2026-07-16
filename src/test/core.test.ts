import * as assert from 'assert';
import * as path from 'path';

// --- Functions to test (copied from extension.ts since they are internal) ---

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
        line = line.replace(/\x1B\[\d+m/g, '');
        line = line.replace(/\[\d+m/g, '');

        if (line === 'SURVIVED' && lines[i+1]?.replace(/\[\d+m/g, '').trim() === '--------') {
            isSurvivedSection = true;
            i++; continue;
        }
        if (isSurvivedSection) {
            if (line === '' || line.startsWith('2026-') || line.match(/^\d{4}-\d{2}-\d{2}/)) {break;}
            if (line.startsWith('- ')) {survivedList.push(line);}
        }
    }
    return survivedList.join('\n');
}

function parseMutmutSurvived(mutatestResult: string): string {
    const lines = mutatestResult.split('\n');
    const survivedList: string[] = [];
    let capture = false;
    for (const line of lines) {
        if (line.includes('FAILED:') || line.includes('Survived:') || line.includes('survived')) {capture = true;}
        if (capture && line.trim() !== '') {survivedList.push(line.trim());}
    }
    return survivedList.join('\n');
}

// --- Test Suite ---

suite('Core Functions Test Suite', () => {
    suite('sanitizeLlmResponse', () => {
        test('should extract python code block containing unittest', () => {
            const raw = "Here is your code:\n```python\nimport unittest\nclass Test(unittest.TestCase): pass\n```\nDone.";
            assert.strictEqual(sanitizeLlmResponse(raw), "import unittest\nclass Test(unittest.TestCase): pass");
        });

        test('should extract the block with unittest if multiple exist', () => {
            const raw = "Block 1:\n```python\nprint('hello')\n```\nBlock 2:\n```python\nimport unittest\n```";
            assert.strictEqual(sanitizeLlmResponse(raw), "import unittest");
        });

        test('should fallback to generic code blocks if no python blocks', () => {
            const raw = "```\nimport unittest\n```";
            assert.strictEqual(sanitizeLlmResponse(raw), "import unittest");
        });

        test('should fallback to last block if no block has unittest', () => {
            const raw = "```python\nprint('A')\n```\n```python\nprint('B')\n```";
            assert.strictEqual(sanitizeLlmResponse(raw), "print('B')");
        });

        test('should return raw trimmed string if no code blocks', () => {
            const raw = "  import unittest\nclass Test(unittest.TestCase): pass  ";
            assert.strictEqual(sanitizeLlmResponse(raw), raw.trim());
        });
        
        test('should handle empty strings', () => {
            assert.strictEqual(sanitizeLlmResponse(""), "");
            assert.strictEqual(sanitizeLlmResponse("   "), "");
        });
    });

    suite('rescueToUnittest', () => {
        test('should convert bare assert == statements', () => {
            const raw = "assert add(1, 2) == 3\nassert sub(5, 2) == 3";
            const expected = "import unittest\nfrom math import *\n\nclass TestAuto(unittest.TestCase):\n    def test_case_1(self):\n        self.assertEqual(add(1, 2), 3)\n\n    def test_case_2(self):\n        self.assertEqual(sub(5, 2), 3)\n\nif __name__ == '__main__':\n    unittest.main()";
            assert.strictEqual(rescueToUnittest(raw, "math.py", "add"), expected);
        });

        test('should convert REPL >>> format', () => {
            const raw = ">>> assert add(1, 2) == 3\n>>> assert add(0, 0) != 1";
            const expected = "import unittest\nfrom math import *\n\nclass TestAuto(unittest.TestCase):\n    def test_case_1(self):\n        self.assertEqual(add(1, 2), 3)\n\n    def test_case_2(self):\n        self.assertNotEqual(add(0, 0), 1)\n\nif __name__ == '__main__':\n    unittest.main()";
            assert.strictEqual(rescueToUnittest(raw, "math.py", "add"), expected);
        });

        test('should return empty string if no valid tests extracted', () => {
            const raw = "import os\nprint('hello')\n# just a comment";
            assert.strictEqual(rescueToUnittest(raw, "test.py", "func"), "");
        });

        test('should convert implicit function calls with ==', () => {
            const raw = "add(1, 2) == 3\nadd(-1, 1) == 0";
            const expected = "import unittest\nfrom calc import *\n\nclass TestAuto(unittest.TestCase):\n    def test_case_1(self):\n        self.assertEqual(add(1, 2), 3)\n\n    def test_case_2(self):\n        self.assertEqual(add(-1, 1), 0)\n\nif __name__ == '__main__':\n    unittest.main()";
            assert.strictEqual(rescueToUnittest(raw, "calc.py", "add"), expected);
        });
    });

    suite('parseMutatestSurvived', () => {
        test('should parse normal survived output', () => {
            const raw = "Some log\nSURVIVED\n--------\n- (l: 10, c: 5) - mutation\n- (l: 12, c: 8) - mutation2\n\nNext section";
            assert.strictEqual(parseMutatestSurvived(raw), "- (l: 10, c: 5) - mutation\n- (l: 12, c: 8) - mutation2");
        });

        test('should handle ANSI color codes', () => {
            const raw = "\x1B[91mSURVIVED\x1B[0m\n[0m--------\x1B[0m\n\x1B[91m- (l: 1, c: 2)\x1B[0m\n";
            assert.strictEqual(parseMutatestSurvived(raw), "- (l: 1, c: 2)");
        });

        test('should return empty if no SURVIVED section', () => {
            const raw = "Some log\nDETECTED\n--------\nEverything killed";
            assert.strictEqual(parseMutatestSurvived(raw), "");
        });
    });

    suite('parseMutmutSurvived', () => {
        test('should capture lines after FAILED:', () => {
            const raw = "Test run\nFAILED:\n- mutmut run 1\n- mutmut run 2";
            assert.strictEqual(parseMutmutSurvived(raw), "FAILED:\n- mutmut run 1\n- mutmut run 2");
        });

        test('should capture lines after Survived:', () => {
            const raw = "Output\nSurvived:\nmutant 1\nmutant 2";
            assert.strictEqual(parseMutmutSurvived(raw), "Survived:\nmutant 1\nmutant 2");
        });
    });
});
