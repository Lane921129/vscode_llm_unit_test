import * as assert from 'assert';
import { test } from 'node:test';
import { extractPythonTestCode, unwrapGeneratedCodeEnvelope, validateUnittestStructure } from '../validation/generatedTestValidator';

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

test('requires a single test method to both invoke the target and assert behavior', () => {
    const code = [
        'import unittest',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_invokes_only(self):',
        '        add(1, 1)',
        '',
        '    def test_asserts_only(self):',
        '        self.assertTrue(True)',
    ].join('\n');

    const result = validateUnittestStructure(code, 'add');
    assert.strictEqual(result.valid, false);
    assert.match(result.reason || '', /同時呼叫被測函式/);
});

test('accepts a target invocation and assertion in the same test method', () => {
    const code = [
        'import unittest',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_adds_numbers(self):',
        '        self.assertEqual(add(1, 2), 3)',
    ].join('\n');

    assert.strictEqual(validateUnittestStructure(code, 'add').valid, true);
});

test('accepts an imported target alias while rejecting an alias redefinition', () => {
    const aliasedCode = [
        'import unittest',
        'from calculator import add as subject',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_adds_numbers(self):',
        '        self.assertEqual(subject(1, 2), 3)',
    ].join('\n');
    const shadowedAliasCode = aliasedCode.replace(
        'class TestAdd(unittest.TestCase):',
        'def subject(left, right):\n    return 999\n\nclass TestAdd(unittest.TestCase):'
    );

    assert.strictEqual(validateUnittestStructure(aliasedCode, 'add', 'calculator').valid, true);
    const shadowed = validateUnittestStructure(shadowedAliasCode, 'add', 'calculator');
    assert.strictEqual(shadowed.valid, false);
    assert.match(shadowed.reason || '', /匯入別名/);
});

test('accepts a module import alias for the selected callable', () => {
    const code = [
        'import unittest',
        'import calculator as calc',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_adds_numbers(self):',
        '        self.assertEqual(calc.add(1, 2), 3)',
    ].join('\n');

    assert.strictEqual(validateUnittestStructure(code, 'add', 'calculator').valid, true);
});

test('rejects an unrelated assertion after a detached target call', () => {
    const code = [
        'import unittest',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_adds_numbers(self):',
        '        add(1, 2)',
        '        self.assertTrue(True)',
    ].join('\n');

    const result = validateUnittestStructure(code, 'add');
    assert.strictEqual(result.valid, false);
    assert.match(result.reason || '', /同時呼叫被測函式/);
});

test('does not accept a commented-out target call and assertion as executable behavior', () => {
    const code = [
        'import unittest',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_adds_numbers(self):',
        '        # result = add(1, 2)',
        '        # self.assertEqual(result, 3)',
        '        self.assertTrue(True)',
    ].join('\n');

    const result = validateUnittestStructure(code, 'add', 'calculator');
    assert.strictEqual(result.valid, false);
    assert.match(result.reason || '', /沒有呼叫被測函式/);
});

test('does not accept target-looking text inside a string literal as behavior', () => {
    const code = [
        'import unittest',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_adds_numbers(self):',
        '        note = "self.assertEqual(add(1, 2), 3)"',
        '        self.assertTrue(True)',
    ].join('\n');

    const result = validateUnittestStructure(code, 'add', 'calculator');
    assert.strictEqual(result.valid, false);
    assert.match(result.reason || '', /沒有呼叫被測函式/);
});

test('accepts an assertion over a value returned by the target', () => {
    const code = [
        'import unittest',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_adds_numbers(self):',
        '        result = add(1, 2)',
        '        self.assertEqual(result, 3)',
    ].join('\n');

    assert.strictEqual(validateUnittestStructure(code, 'add').valid, true);
});

test('accepts a target invocation nested under assertRaises', () => {
    const code = [
        'import unittest',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_rejects_invalid_values(self):',
        '        with self.assertRaises(ValueError):',
        '            add(1, "invalid")',
    ].join('\n');

    assert.strictEqual(validateUnittestStructure(code, 'add').valid, true);
});

test('requires evidence before accepting a model-invented exception assertion', () => {
    const code = [
        'import unittest',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_invalid(self):',
        '        with self.assertRaises(ValueError):',
        '            add(1, 2)',
    ].join('\n');

    const rejected = validateUnittestStructure(code, 'add', 'calculator', 'call', []);
    assert.strictEqual(rejected.valid, false);
    assert.match(rejected.reason || '', /沒有目標原始碼.*例外事實/);
    assert.strictEqual(validateUnittestStructure(code, 'add', 'calculator', 'call', ['ValueError']).valid, true);
});

test('allows a mock side effect to define an explicit propagated exception', () => {
    const code = [
        'import unittest',
        'from unittest.mock import patch',
        'from service import process',
        '',
        'class TestProcess(unittest.TestCase):',
        '    @patch("service.client.fetch")',
        '    def test_dependency_error(self, mock_fetch):',
        '        mock_fetch.side_effect = ConnectionError',
        '        with self.assertRaises(ConnectionError):',
        '            process()',
    ].join('\n');

    assert.strictEqual(validateUnittestStructure(code, 'process', 'service', 'call', []).valid, true);
});

test('accepts a property read when the selected target is a descriptor', () => {
    const code = [
        'import unittest',
        'from feature import Feature',
        '',
        'class TestFeature(unittest.TestCase):',
        '    def test_enabled(self):',
        '        self.assertTrue(Feature().enabled)',
    ].join('\n');
    assert.strictEqual(validateUnittestStructure(code, 'enabled', 'feature', 'property').valid, true);
});

test('accepts an instance-method assertion only when the instance comes from the selected class', () => {
    const code = [
        'import unittest',
        'from worker import Service',
        '',
        'class TestService(unittest.TestCase):',
        '    def setUp(self):',
        "        self._instance = Service('prefix:')",
        '',
        '    def test_render(self):',
        "        result = self._instance.render('value')",
        "        self.assertEqual(result, 'prefix:value')",
    ].join('\n');

    assert.strictEqual(validateUnittestStructure(code, 'render', 'worker', 'call', undefined, 'Service').valid, true);
});

test('rejects a same-named method on an unrelated instance for a selected class method', () => {
    const code = [
        'import unittest',
        'from worker import Service',
        'from unrelated import Other',
        '',
        'class TestService(unittest.TestCase):',
        '    def setUp(self):',
        '        self._other = Other()',
        '',
        '    def test_render(self):',
        "        self.assertEqual(self._other.render('value'), 'value')",
    ].join('\n');

    const result = validateUnittestStructure(code, 'render', 'worker', 'call', undefined, 'Service');
    assert.strictEqual(result.valid, false);
    assert.match(result.reason || '', /沒有呼叫被測函式/);
});

test('accepts a selected static or class method through a target module alias', () => {
    const code = [
        'import unittest',
        'import worker as subject_module',
        '',
        'class TestService(unittest.TestCase):',
        '    def test_render(self):',
        "        self.assertEqual(subject_module.Service.render('value'), 'value')",
    ].join('\n');

    assert.strictEqual(validateUnittestStructure(code, 'render', 'worker', 'call', undefined, 'Service').valid, true);
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

test('rejects a generated test that replaces the target module dynamically', () => {
    const code = [
        'import sys',
        'import types',
        'import unittest',
        '',
        'fake = types.ModuleType("calculator")',
        'fake.add = lambda left, right: 2',
        'sys.modules["calculator"] = fake',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_add(self):',
        '        self.assertEqual(add(1, 1), 2)',
    ].join('\n');

    const result = validateUnittestStructure(code, 'add', 'calculator');
    assert.strictEqual(result.valid, false);
    assert.match(result.reason || '', /動態模組替換/);
});

test('allows a dynamic replacement for an external dependency, not the target module', () => {
    const code = [
        'import sys',
        'import types',
        'import unittest',
        'from calculator import add',
        '',
        'sys.modules["external_service"] = types.ModuleType("external_service")',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_add(self):',
        '        self.assertEqual(add(1, 1), 2)',
    ].join('\n');

    const result = validateUnittestStructure(code, 'add', 'calculator');
    assert.strictEqual(result.valid, true);
});

test('rejects a local dependency value mutation that cannot affect the target call', () => {
    const code = [
        'import unittest',
        'from order_service import checkout',
        'from auth import decode_credential',
        '',
        'class TestCheckout(unittest.TestCase):',
        '    def test_invalid_partner(self):',
        '        credential = decode_credential("abc")',
        '        credential["partner"] = "wrong"',
        '        self.assertFalse(checkout("order-1", "abc"))',
    ].join('\n');

    const result = validateUnittestStructure(code, 'checkout', 'order_service');
    assert.strictEqual(result.valid, false);
    assert.match(result.reason || '', /本地相依物件/);
});

test('allows a dependency value when it is injected through a standard mock', () => {
    const code = [
        'import unittest',
        'from unittest.mock import patch',
        'from order_service import checkout',
        '',
        'class TestCheckout(unittest.TestCase):',
        '    @patch("order_service.decode_credential")',
        '    def test_invalid_partner(self, mock_decode):',
        '        credential = build_credential()',
        '        credential["partner"] = "wrong"',
        '        mock_decode.return_value = credential',
        '        self.assertFalse(checkout("order-1", "abc"))',
    ].join('\n');

    assert.strictEqual(validateUnittestStructure(code, 'checkout', 'order_service').valid, true);
});

test('rejects generated tests that execute external commands or dynamic code', () => {
    const commandCode = [
        'import os',
        'import unittest',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_add(self):',
        '        os.system("echo unsafe")',
        '        self.assertEqual(add(1, 1), 2)',
    ].join('\n');
    const dynamicCode = commandCode.replace('os.system("echo unsafe")', 'exec("value = 1")');

    assert.match(validateUnittestStructure(commandCode, 'add').reason || '', /shell/);
    assert.match(validateUnittestStructure(dynamicCode, 'add').reason || '', /動態執行/);
});

test('allows mock.patch for an external operation without executing it', () => {
    const code = [
        'import unittest',
        'from unittest.mock import patch',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    @patch("os.system")',
        '    def test_add(self, mock_system):',
        '        self.assertEqual(add(1, 1), 2)',
    ].join('\n');

    assert.strictEqual(validateUnittestStructure(code, 'add').valid, true);
});

test('rejects direct file access while allowing mock_open patches', () => {
    const directFileCode = [
        'import unittest',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    def test_add(self):',
        '        with open("project-data.txt", "w") as handle:',
        '            handle.write("unsafe")',
        '        self.assertEqual(add(1, 1), 2)',
    ].join('\n');
    const pathMethodCode = directFileCode
        .replace('with open("project-data.txt", "w") as handle:', 'file_path = Path("project-data.txt")')
        .replace('            handle.write("unsafe")', '        file_path.write_text("unsafe")');
    const mockedFileCode = [
        'import unittest',
        'from unittest.mock import mock_open, patch',
        'from calculator import add',
        '',
        'class TestAdd(unittest.TestCase):',
        '    @patch("builtins.open", new_callable=mock_open, read_data="safe")',
        '    def test_add(self, mocked_open):',
        '        self.assertEqual(add(1, 1), 2)',
    ].join('\n');

    assert.match(validateUnittestStructure(directFileCode, 'add').reason || '', /直接檔案存取/);
    assert.match(validateUnittestStructure(pathMethodCode, 'add').reason || '', /直接檔案存取/);
    assert.strictEqual(validateUnittestStructure(mockedFileCode, 'add').valid, true);
});

test('rejects shared SQLite connections while allowing an explicitly isolated memory database', () => {
    const sharedDatabase = [
        'import sqlite3',
        'import unittest',
        'from repository import save',
        '',
        'class TestSave(unittest.TestCase):',
        '    def test_save(self):',
        '        sqlite3.connect("application.db")',
        '        self.assertIsNone(save("value"))',
    ].join('\n');
    const memoryDatabase = sharedDatabase.replace('"application.db"', '":memory:"');

    assert.match(validateUnittestStructure(sharedDatabase, 'save', 'repository').reason || '', /SQLite/);
    assert.strictEqual(validateUnittestStructure(memoryDatabase, 'save', 'repository').valid, true);
});

test('rejects bare or direct module private helper calls used to manipulate test state', () => {
    const bareHelper = [
        'import unittest',
        'from repository import save',
        '',
        'class TestSave(unittest.TestCase):',
        '    def test_save(self):',
        '        conn = _connect()',
        '        self.assertIsNone(save("value"))',
    ].join('\n');
    const moduleHelper = bareHelper
        .replace('from repository import save', 'import repository')
        .replace('_connect()', 'repository._connect()')
        .replace('save("value")', 'repository.save("value")');

    assert.match(validateUnittestStructure(bareHelper, 'save', 'repository').reason || '', /未匯入的私有 helper/);
    assert.match(validateUnittestStructure(moduleHelper, 'save', 'repository').reason || '', /私有 helper/);
});

test('unwraps a structured code response while preserving plain-code compatibility', () => {
    assert.strictEqual(unwrapGeneratedCodeEnvelope('{"code":"import unittest"}'), 'import unittest');
    assert.strictEqual(unwrapGeneratedCodeEnvelope('import unittest'), 'import unittest');
});

test('extracts a labeled or unlabeled unittest code fence without preserving model prose', () => {
    const pythonFence = 'Analysis first.\n```Python\nimport unittest\nclass TestValue(unittest.TestCase):\n    pass\n```\nDone.';
    const multipleFences = '```text\nexplanation\n```\n```py\nimport unittest\nclass TestValue(unittest.TestCase):\n    pass\n```';

    assert.ok(extractPythonTestCode(pythonFence).startsWith('import unittest'));
    assert.ok(extractPythonTestCode(multipleFences).startsWith('import unittest'));
    assert.strictEqual(extractPythonTestCode('plain response'), 'plain response');
});

test('unwraps a structured code envelope placed inside a JSON code fence', () => {
    const code = 'import unittest\nclass TestValue(unittest.TestCase):\n    pass';
    const fencedEnvelope = `Provider preface\n\`\`\`json\n${JSON.stringify({ code })}\n\`\`\`\nProvider suffix`;

    assert.strictEqual(extractPythonTestCode(fencedEnvelope), code);
});
