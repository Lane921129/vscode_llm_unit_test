import * as assert from 'assert';
import { test } from 'node:test';
import { appendTraceMethodsToUnittestClass, appendVerifiedTraceTestFile } from '../tier/traceTestAugmenter';

const traceMethod = [
    '    def test_case_1(self):',
    '        result = target(1)',
    '        self.assertEqual(result, 2)',
].join('\n');

test('adds verified Trace methods inside the existing unittest class', () => {
    const code = [
        'import unittest',
        'from target import target',
        '',
        'class TestTarget(unittest.TestCase):',
        '    def test_model_case(self):',
        '        self.assertEqual(target(2), 3)',
        '',
        "if __name__ == '__main__':",
        '    unittest.main()',
    ].join('\n');

    const augmented = appendTraceMethodsToUnittestClass(code, [traceMethod]);
    assert.strictEqual(augmented.addedMethodCount, 1);
    assert.ok(augmented.code.includes('def test_trace_case_1(self):'));
    assert.ok(augmented.code.indexOf('def test_trace_case_1') < augmented.code.indexOf("if __name__"));
});

test('does not duplicate previously appended Trace methods', () => {
    const code = [
        'import unittest',
        '',
        'class TestTarget(unittest.TestCase):',
        '    def test_trace_case_1(self):',
        '        self.assertEqual(1, 1)',
    ].join('\n');

    const augmented = appendTraceMethodsToUnittestClass(code, [traceMethod]);
    assert.strictEqual(augmented.addedMethodCount, 0);
    assert.strictEqual(augmented.code, code);
});

test('leaves snippets without a supported unittest class unchanged', () => {
    const code = 'def helper():\n    return 1\n';
    const augmented = appendTraceMethodsToUnittestClass(code, [traceMethod]);
    assert.strictEqual(augmented.addedMethodCount, 0);
    assert.strictEqual(augmented.code, code);
});

test('adds verified class trace tests as a separate TestCase without replacing model setUp', () => {
    const modelCode = [
        'import unittest',
        'from worker import Service',
        '',
        'class TestModelService(unittest.TestCase):',
        '    def setUp(self):',
        "        self.service = Service('model:')",
        '    def test_model_case(self):',
        "        self.assertEqual(self.service.render('x'), 'model:x')",
        '',
        "if __name__ == '__main__':",
        '    unittest.main()',
    ].join('\n');
    const deterministicFile = [
        'import unittest',
        'from worker import Service',
        '',
        'class TestTier1render(unittest.TestCase):',
        '    def setUp(self):',
        "        self._instance = Service('trace:')",
        '',
        '    def test_case_1(self):',
        "        self.assertEqual(self._instance.render('x'), 'trace:x')",
        '',
        "if __name__ == '__main__':",
        '    unittest.main()',
    ].join('\n');

    const augmented = appendVerifiedTraceTestFile(modelCode, deterministicFile, 1, 'render');

    assert.strictEqual(augmented.addedMethodCount, 1);
    assert.strictEqual(augmented.addedClassName, 'TestVerifiedTrace_render');
    assert.match(augmented.code, /class TestModelService[\s\S]*self\.service = Service\('model:'\)/);
    assert.match(augmented.code, /class TestVerifiedTrace_render[\s\S]*self\._instance = Service\('trace:'\)/);
    assert.ok(augmented.code.indexOf('class TestVerifiedTrace_render') < augmented.code.indexOf("if __name__"));
});
