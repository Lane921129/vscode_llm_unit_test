import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { extractPythonTestCode, validateUnittestStructure } from '../validation/generatedTestValidator';

const code = ['import unittest', 'from subject import compute', 'class Cases(unittest.TestCase):',
    '    def test_compute(self):', '        self.assertEqual(compute(), 7)'].join('\n');
const indent = (value: string, prefix: string) => value.split('\n').map(line => prefix + line).join('\n');

test('uniformly indented Python transport is normalized before first-line whitespace is removed', () => {
    for (const prefix of ['  ', '    ', '\t']) {
        const body = indent(code, prefix);
        const responses = [`\`\`\`python\n${body}\n\`\`\``, body, JSON.stringify({ code: body }),
            `\`\`\`json\n${JSON.stringify({ code: body })}\n\`\`\``, `[python]\n${body}\n[/python]`];
        for (const response of responses) {
            const extracted = extractPythonTestCode(response);
            assert.equal(extracted, code);
            assert.equal(validateUnittestStructure(extracted, 'compute', 'subject').valid, true);
        }
    }
});

test('normalization preserves multiline literal bytes and the Python AST', () => {
    const body = indent('import unittest\nTEXT = """first\n  meaningful indent\nlast"""\nclass Cases(unittest.TestCase):\n    def test_text(self):\n        self.assertTrue(TEXT)', '    ');
    const extracted = extractPythonTestCode(`\`\`\`python\n${body}\n\`\`\``);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const script = 'import ast,json,sys; value=json.load(sys.stdin); before=ast.parse("if True:\\n"+value["before"]).body[0].body; after=ast.parse(value["after"]).body; assert [ast.dump(n) for n in before] == [ast.dump(n) for n in after]';
    const parsed = spawnSync(python, ['-I', '-B', '-c', script], { input: JSON.stringify({ before: body, after: extracted }), encoding: 'utf8', timeout: 10000 });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.ok(extracted.includes('      meaningful indent\n    last'));
});

test('ambiguous multiple complete candidate fences are retained for rejection', () => {
    const response = `\`\`\`python\n${code}\n\`\`\`\n\`\`\`python\n${code.replace('7', '9')}\n\`\`\``;
    assert.equal(extractPythonTestCode(response), response);
    assert.equal(validateUnittestStructure(extractPythonTestCode(response)).valid, false);
});

test('inconsistent indentation and prose are not rewritten into a guessed test', () => {
    const malformed = code.replace('from subject', '  from subject');
    assert.equal(extractPythonTestCode(`\`\`\`python\n${malformed}\n\`\`\``), malformed);
    const prose = `Please run the following test.\n${code}`;
    assert.equal(extractPythonTestCode(prose), prose);
    const continuation = indent(code + '\nTEXT = "first\\\nsecond"', '  ');
    assert.equal(extractPythonTestCode(`\`\`\`python\n${continuation}\n\`\`\``), continuation);
});

test('Python literal markup and fenced text cannot impersonate an output wrapper', () => {
    const markers = code + '\nTEXT = "[PYTHON]unittest[/PYTHON]"';
    assert.equal(extractPythonTestCode(markers), markers);
    const embedded = code + '\nTEXT = """\n```python\nimport unittest\nclass Fake(unittest.TestCase):\n    pass\n```\n"""';
    assert.equal(extractPythonTestCode(embedded), embedded);
    assert.equal(extractPythonTestCode('```python\n' + embedded + '\n```'), embedded);
    assert.equal(extractPythonTestCode('[PYTHON]' + code + '[/PYTHON]'), code);
});
