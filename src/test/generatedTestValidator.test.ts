import * as assert from 'assert';
import { test } from 'node:test';
import { unwrapGeneratedCodeEnvelope, validateUnittestStructure } from '../generatedTestValidator';

test('rejects a Markdown test plan even when it mentions unittest', () => {
    const result = validateUnittestStructure('* Import unittest\n* Use unittest.TestCase');
    assert.strictEqual(result.valid, false);
    assert.match(result.reason || '', /Markdown/);
});

test('accepts a complete unittest file structure', () => {
    const result = validateUnittestStructure([
        'import unittest',
        '',
        'class TestExample(unittest.TestCase):',
        '    def test_value(self):',
        '        self.assertEqual(1, 1)',
    ].join('\n'));
    assert.strictEqual(result.valid, true);
});

test('accepts an async unittest structure produced for coroutine targets', () => {
    const result = validateUnittestStructure([
        'import unittest',
        '',
        'class TestAsyncExample(unittest.IsolatedAsyncioTestCase):',
        '    async def test_value(self):',
        '        self.assertEqual(await self._value(), 1)',
        '',
        '    async def _value(self):',
        '        return 1',
    ].join('\n'));
    assert.strictEqual(result.valid, true);
});

test('rejects an empty test method that has no behavioral assertion', () => {
    const result = validateUnittestStructure([
        'import unittest',
        '',
        'class TestEmpty(unittest.TestCase):',
        '    def test_placeholder(self):',
        '        pass',
    ].join('\n'));
    assert.strictEqual(result.valid, false);
    assert.match(result.reason || '', /assertion/);
});

test('requires generated tests to invoke the requested callable', () => {
    const code = [
        'import unittest',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_placeholder(self):',
        '        self.assertTrue(True)',
    ].join('\n');

    const result = validateUnittestStructure(code, 'add');
    assert.strictEqual(result.valid, false);
    assert.match(result.reason || '', /沒有呼叫被測函式/);
});

test('rejects a generated test that shadows the requested callable', () => {
    const code = [
        'import unittest',
        'from calculator import add',
        '',
        'def add(left, right):',
        '    return 999',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_add(self):',
        '        self.assertEqual(add(1, 1), 999)',
    ].join('\n');

    const result = validateUnittestStructure(code, 'add');
    assert.strictEqual(result.valid, false);
    assert.match(result.reason || '', /重新定義/);
});

test('unwraps a structured code response while preserving plain-code compatibility', () => {
    assert.strictEqual(unwrapGeneratedCodeEnvelope('{"code":"import unittest"}'), 'import unittest');
    assert.strictEqual(unwrapGeneratedCodeEnvelope('import unittest'), 'import unittest');
});
