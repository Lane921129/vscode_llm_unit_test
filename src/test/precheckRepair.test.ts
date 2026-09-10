import * as assert from 'assert';
import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { test } from 'node:test';
import { RepairFeedback, passingTestIds, summarizeRepairOutput } from '../validation/repairFeedback';
import { extractPythonTestCode, validateUnittestStructure } from '../validation/generatedTestValidator';
import { buildTier1TestFile } from '../tier/tier1TestFileBuilder';
import { restoreVerifiedTraceTestFile } from '../tier/traceTestAugmenter';
import { generatedUnittestArguments, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { classifyExecutionFailure } from '../utils/executionFailureCategory';
import { getReviewerUserPrompt } from '../prompts/bugFixerPrompt';
import { getSkillCards, inferSkillIdsFromCode } from '../prompts/promptSkillLibrary';
import { formatEquivalentMutantsReport, getMutantTriageSystemPrompt } from '../prompts/mutantTriagePrompt';

const root = resolve(__dirname, '../..');
const python = resolvePythonExecutable(undefined, root);
const fixture = `
import types, sys
helper = types.ModuleType('helper')
exec("def read(value):\\n    if len(value) < 4: raise ValueError('short')\\n    return {'ready': True, 'kind': 'plain'}", helper.__dict__)
sys.modules['helper'] = helper
worker = types.ModuleType('worker')
exec("from helper import read\\ndef render(value):\\n    try:\\n        info = read(value)\\n        return 'ready' if info['ready'] else 'empty'\\n    except ValueError:\\n        return 'short'", worker.__dict__)
sys.modules['worker'] = worker
`;

function runSuite(code: string): { status: number | null; output: string } {
    const run = spawnSync(python, ['-B', '-c', fixture + '\nexec(compile(sys.stdin.read(), "<generated-test>", "exec"))'], {
        input: code + '\n\nif __name__ == "__main__":\n    unittest.main(verbosity=2)\n', encoding: 'utf8'
    });
    return { status: run.status, output: run.stdout + run.stderr };
}

const modelCode = `import unittest
from unittest.mock import patch
from worker import render

class TestModel(unittest.TestCase):
    def setUp(self):
        self.patcher = patch('worker.read', return_value={'ready': False})
        self.mock_read = self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_mock(self):
        self.assertEqual(render('abcd'), 'empty')
        self.mock_read.assert_called_once_with('abcd')
`;
const trace = buildTier1TestFile({ moduleName: 'worker', functionName: 'render',
    examples: [{ args: ["'abcd'"], result: "'ready'" }, { args: ["'a'"], result: "'short'" }], errors: [] });

test('real Trace cases execute outside model setUp mocks and survive repair unchanged', () => {
    const first = restoreVerifiedTraceTestFile(modelCode, trace.code!, trace.methodCount, 'render');
    const run = runSuite(first.code);
    assert.strictEqual(run.status, 0, run.output);
    assert.match(run.output, /Ran 3 tests/);
    assert.strictEqual(passingTestIds(run.output).size, 3);
    const repeated = restoreVerifiedTraceTestFile(first.code, trace.code!, trace.methodCount, 'render');
    assert.strictEqual(repeated.code, first.code, 'restoration must be idempotent');
    const corrupt = first.code.replace("result, 'ready'", "result, 'guessed'");
    const restored = restoreVerifiedTraceTestFile(corrupt, trace.code!, trace.methodCount, 'render');
    assert.strictEqual(restored.code, first.code);
    assert.strictEqual(runSuite(restored.code).status, 0);
});

test('repair feedback advances to the current failure, detects repeats, and rejects regressions', () => {
    const original = modelCode + `\n    def test_new(self):\n        self.assertEqual(render('abcd'), 'wrong')\n`;
    const firstRun = runSuite(original);
    const feedback = new RepairFeedback(original, firstRun.output);
    const next = original.replace("'wrong'", "'still wrong'");
    assert.strictEqual(feedback.consider(next), true);
    const nextRun = runSuite(next);
    assert.strictEqual(feedback.record(nextRun.output).accepted, true);
    assert.strictEqual(feedback.output, nextRun.output);
    assert.strictEqual(feedback.consider(next), false);
    assert.match(feedback.output, /NO CHANGE/);
    const regression = runSuite(next.replace("render('abcd'), 'empty'", "render('abcd'), 'broken'"));
    const progress = feedback.record(regression.output);
    assert.strictEqual(progress.accepted, false);
    assert.ok(progress.regressed.some(id => id.endsWith('.test_mock')));
    const removed = runSuite('import unittest\nclass TestEmpty(unittest.TestCase):\n    def test_other(self):\n        self.assertTrue(True)');
    assert.strictEqual(feedback.record(removed.output).accepted, false);
});

test('all failure types and actual/expected tails survive long error summaries', () => {
    const output = ['runner header', ...['alpha', 'beta', 'gamma'].map(name =>
        `FAIL: test_${name} (suite.Test.test_${name})\n${'  stack frame\n'.repeat(300)}AssertionError: actual_${name} != expected_${name}\n`)].join('\n');
    const summary = summarizeRepairOutput(output);
    const prompt = getReviewerUserPrompt(modelCode, output, 'render', ['value'], '', undefined, 'worker');
    for (const name of ['alpha', 'beta', 'gamma']) {
        assert.match(summary, new RegExp(`test_${name}`));
        assert.match(prompt, new RegExp(`actual_${name} != expected_${name}`));
    }
    const importError = 'Traceback (most recent call last):\n' + 'stack\n'.repeat(1500) + 'NameError: pytest is not defined';
    assert.match(summarizeRepairOutput(importError), /NameError: pytest is not defined/);
    assert.match(summarizeRepairOutput('CANDIDATE REJECTED: passing case regressed\n' + output), /CANDIDATE REJECTED/);
});

test('verbose outcomes preserve tests with docstrings and reject a skipped passing test', () => {
    const code = `import unittest
class TestDocs(unittest.TestCase):
    def test_doc(self):
        """A documented passing case."""
        self.assertTrue(True)
`;
    const executed = runSuite(code);
    assert.strictEqual(executed.status, 0);
    assert.strictEqual(passingTestIds(executed.output).size, 1, executed.output);
    const skipped = runSuite(code.replace('    def test_doc', '    @unittest.skip("skip")\n    def test_doc'));
    assert.strictEqual(new RepairFeedback(code, executed.output).record(skipped.output).accepted, false);
});

function bindingCheck(code: string, module = 'pkg.worker', dependencies: Record<string, string> = { read: 'helper.read' }): { valid: boolean; reason?: string } {
    const result = spawnSync(python, ['-B', resolve(root, 'python_scripts/validate_test_bindings.py'),
        JSON.stringify({ module, target: 'render', dependencies })], { input: code, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test('binding gate rejects duplicate module identities and patches at the definition', () => {
    assert.strictEqual(bindingCheck("from worker import render\n").valid, false);
    assert.strictEqual(bindingCheck("import worker as w\n").valid, false);
    const wrong = bindingCheck("from pkg.worker import render\nfrom unittest.mock import patch as p\np('helper.read')");
    assert.strictEqual(wrong.valid, false);
    assert.match(wrong.reason!, /pkg.worker.read/);
    assert.strictEqual(bindingCheck("from pkg.worker import render\nfrom unittest import mock\nmock.patch('pkg.worker.read')").valid, true);
    assert.strictEqual(bindingCheck("from pkg.worker import render\nimport unrelated\n").valid, true);
});

test('binding gate supports dependency aliases without using the origin binding', () => {
    const dependencies = { load: 'helper.read' };
    assert.strictEqual(bindingCheck("from unittest.mock import patch\npatch('helper.read')", 'pkg.worker', dependencies).valid, false);
    assert.strictEqual(bindingCheck("from unittest.mock import patch\npatch('pkg.worker.load')", 'pkg.worker', dependencies).valid, true);
});

test('complete legacy wrappers are extracted and incomplete wrappers fail before execution', () => {
    assert.strictEqual(extractPythonTestCode(`[pytest]\n${modelCode}\n[/pytest]`), modelCode.trim());
    assert.strictEqual(validateUnittestStructure(`[pytest]\n${modelCode}`).valid, false);
    assert.strictEqual(validateUnittestStructure(modelCode + '\n# [pytest]\n').valid, true);
});

test('dependency skills include mock isolation, caller constraints, and mixed boolean cases', () => {
    const ids = inferSkillIdsFromCode('def render(value):\n    return read(value)', { dependencies: ['helper.read'] });
    assert.ok(ids.includes('trace_mock_isolation'));
    assert.ok(ids.includes('caller_dependency_contract'));
    const rules = getSkillCards(ids).flatMap(card => card.rules).join('\n');
    assert.match(rules, /assert_called_once_with/);
    assert.match(rules, /mixed truth values/);
    const ordinary = inferSkillIdsFromCode('def render(value):\n    return value');
    assert.ok(!ordinary.includes('trace_mock_isolation'));
});

test('mixed mocked condition distinguishes And from Or; equivalence remains a hypothesis', () => {
    const run = spawnSync(python, ['-B', '-c', `
from unittest.mock import patch
def read(): return {'ready': True, 'kind': 'plain'}
def original():
    info = read()
    return bool(info['ready'] and info['kind'] == 'plain')
def mutant():
    info = read()
    return bool(info['ready'] or info['kind'] == 'plain')
with patch('__main__.read', return_value={'ready': True, 'kind': 'other'}):
    assert original() is False
    assert mutant() is True
`], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.match(getMutantTriageSystemPrompt(), /mixed truth values/);
    const report = formatEquivalentMutantsReport({ equivalent_count: 1, has_killable: false,
        verdicts: [{ mutant: 'And to Or', verdict: 'EQUIVALENT', reason: 'candidate', kill_test: null }] });
    assert.match(report, /hypotheses; retained in score denominator/);
});

test('precheck supports verbose outcomes and does not classify traceback last as AST', () => {
    assert.strictEqual(generatedUnittestArguments('suite', '/project', true, true).at(-1), '-v');
    assert.strictEqual(classifyExecutionFailure('測試檔預先驗證失敗: Traceback (most recent call last):'), 'validation');
});
