import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaseRow } from '../pipeline/caseTable/caseTable';
import { buildCaseTableTestFile, buildRowTestMethod, RowTestContext, rowTestMethodName } from '../pipeline/caseTable/rowToTest';
import { observedExpectation } from '../pipeline/caseTable/runRowStage';
import { getRowSetupPrompt, parseRowSetupResponse, ROW_SETUP_CLASS_CONTEXT_MAX_LINES, ROW_SETUP_MAX_LINES } from '../roles/unittestWriter';
import { getRowFixPrompt, parseRowFixResponse, ROW_FIX_MAX_ATTEMPTS } from '../roles/bugFixer';

const forbiddenDomainTerms = /\b(?:token|jwt|bmi|payment_gateway|login_user|claims|partner)\b/i;
const context: RowTestContext = { moduleName: 'store', target: 'find', methodKind: 'module', isAsync: false, dependencies: [
    { name: '_connect', patch: '_connect', chain: [] },
    { name: 'cur.fetchone', patch: '_connect', chain: ['()', 'cursor', '()', 'fetchone'] },
    { name: 'os.path.exists', patch: 'os.path.exists', chain: [] },
    { name: 'open', patch: 'open', chain: [], create: true }
] };
const row = (overrides: Partial<CaseRow> = {}): CaseRow => ({ id: 'C2', origin: 'analyst', scenario: 'missing "row" \\ here', category: 'dependency-failure',
    call: { args: "('a',)", kwargs: "{'strict': True}" }, mocks: [], status: 'captured', ...overrides });

test('a return row becomes one method with exact call text and an equality assertion', () => {
    const method = buildRowTestMethod(row(), context, { kind: 'return', value: "{'id': 1}" });
    assert.equal(method, [
        '    def test_c2(self):',
        '        """C2 dependency-failure: missing "row" \\\\ here"""',
        "        result = target_module.find(*('a',), **{'strict': True})",
        "        self.assertEqual(result, {'id': 1})"
    ].join('\n'));
    assert.equal(rowTestMethodName({ id: 'C12' }), 'test_c12');
});

test('mocks share one patch per root, follow chains, and patch builtins with create=True', () => {
    const method = buildRowTestMethod(row({ mocks: [
        { dependency: 'cur.fetchone', behavior: 'return', value: 'None' },
        { dependency: 'os.path.exists', behavior: 'raise', value: 'PermissionError' },
        { dependency: 'open', behavior: 'raise', value: 'sqlite3.Error' }
    ] }), context, { kind: 'raise', value: 'LookupError', exceptionReference: { kind: 'builtin', path: 'LookupError' } });
    assert.match(method, /with mock\.patch\.object\(target_module, '_connect'\) as mock_0, mock\.patch\.object\(target_module\.os\.path, 'exists'\) as mock_1, mock\.patch\.object\(target_module, 'open', create=True\) as mock_2:/);
    assert.match(method, /mock_0\.return_value\.cursor\.return_value\.fetchone\.return_value = None/);
    assert.match(method, /mock_1\.side_effect = PermissionError/);
    assert.match(method, /mock_2\.side_effect = target_module\.sqlite3\.Error/);
    assert.match(method, /with self\.assertRaises\(LookupError\):\n {16}target_module\.find\(/);
});

test('exceptions without an importable reference fall back to Exception plus a class-name check', () => {
    const method = buildRowTestMethod(row(), context, { kind: 'raise', value: 'HiddenError', exceptionReference: null });
    assert.match(method, /with self\.assertRaises\(Exception\) as raised:/);
    assert.match(method, /self\.assertEqual\(type\(raised\.exception\)\.__name__, "HiddenError"\)/);
    assert.match(buildRowTestMethod(row(), context, { kind: 'raise', value: 'X', exceptionReference: { kind: 'module', path: 'errors.X' } }),
        /assertRaises\(target_module\.errors\.X\)/);
});

test('setup rows, instance methods and async targets use the setup names and asyncio.run', () => {
    const setup = 'item = target_module.Item(1)\nargs = (item,)\nkwargs = {}';
    const setupRow = row({ call: { needsSetup: 'an item' } });
    assert.match(buildRowTestMethod(setupRow, context, { kind: 'return', value: '1' }, setup), /item = target_module\.Item\(1\)\n {8}args = \(item,\)\n {8}kwargs = \{\}\n {8}result = target_module\.find\(\*args, \*\*kwargs\)/);
    assert.throws(() => buildRowTestMethod(setupRow, context, { kind: 'return', value: '1' }), /row-test-setup-required/);
    const instance = { ...context, target: 'Box.size', methodKind: 'instance' as const };
    assert.match(buildRowTestMethod(row(), instance, { kind: 'return', value: '1' }, 'instance = target_module.Box()\nargs = ()\nkwargs = {}'),
        /result = instance\.size\(\*\('a',\), \*\*\{'strict': True\}\)/);
    assert.throws(() => buildRowTestMethod(row(), instance, { kind: 'return', value: '1' }), /row-test-instance-required/);
    const file = buildCaseTableTestFile({ ...context, isAsync: true }, [buildRowTestMethod(row(), { ...context, isAsync: true }, { kind: 'return', value: '1' })]);
    assert.match(file, /^import unittest\nfrom unittest import mock\nimport asyncio\nimport store as target_module\n/);
    assert.match(file, /result = asyncio\.run\(target_module\.find\(/);
    assert.throws(() => buildCaseTableTestFile({ ...context, moduleName: 'pkg.mod' }, []), /row-test-invalid-module/);
});

test('observed expectations mark the row as observed-unconfirmed', () => {
    const decided = observedExpectation(row(), { id: 'C2', status: 'captured', actual: { kind: 'raise', value: 'KeyError' },
        exception: { name: 'KeyError', mro: ['KeyError'], reference: { kind: 'builtin', path: 'KeyError' } } });
    assert.deepEqual(decided.row.expected, { kind: 'raise', value: 'KeyError', source: 'observed', confirmedBySpec: false });
    assert.equal(decided.row.oracleStatus, 'observed-unconfirmed');
    assert.deepEqual(decided.expectation.exceptionReference, { kind: 'builtin', path: 'KeyError' });
});

test('setup and fix prompts state one task, a size limit and one example; replies are parsed strictly', () => {
    const setup = getRowSetupPrompt({ signature: 'size(self, n)', className: 'Box', methodKind: 'instance', targetName: 'Box.size',
        source: 'def size(self, n): ...', scenario: 'empty box', setupDescription: 'an empty Box' });
    assert.match(setup.user, /Write 3 to 10 lines/);
    assert.match(setup.user, /- instance: the Box object/);
    assert.ok(setup.user.trim().endsWith('Output only one ```python block containing the setup lines.'));
    assert.doesNotMatch(setup.system + setup.user, forbiddenDomainTerms);
    assert.equal(ROW_SETUP_MAX_LINES, 10);
    assert.equal(parseRowSetupResponse('```python\nitem = 1\nargs = (item,)\nkwargs = {}\n```'), 'item = 1\nargs = (item,)\nkwargs = {}');
    assert.equal(parseRowSetupResponse('```python\nitem = 1\n```'), null, 'args must be defined');
    assert.equal(parseRowSetupResponse('```python\n' + 'x = 1\n'.repeat(11) + 'args = ()\n```'), null, 'more than ten lines');

    const fix = getRowFixPrompt({ signature: 'find(key)', scenario: 'missing key', methodName: 'test_c2', method: '    def test_c2(self):\n        pass', error: 'E'.repeat(2000) });
    assert.match(fix.system, /keep every expected value in the assertions exactly as it is/);
    assert.ok(fix.user.includes('E'.repeat(1500)) && !fix.user.includes('E'.repeat(1501)), 'error is truncated to 1500 characters');
    assert.equal(ROW_FIX_MAX_ATTEMPTS, 2);
    assert.equal(parseRowFixResponse('```python\ndef test_c2(self):\n    x = 1\n    self.assertEqual(x, 1)\n```', 'test_c2'),
        '    def test_c2(self):\n        x = 1\n        self.assertEqual(x, 1)');
    assert.equal(parseRowFixResponse('```python\ndef test_other(self):\n    pass\n```', 'test_c2'), null);
});

test('a row fix keeps imports written outside the method and drops whatever follows the method', () => {
    const outside = '```python\nfrom decimal import Decimal\nimport math\n\ndef test_c2(self):\n    x = Decimal("1.5")\n    self.assertEqual(x, 1)\n```';
    assert.equal(parseRowFixResponse(outside, 'test_c2'),
        '    def test_c2(self):\n        from decimal import Decimal\n        import math\n        x = Decimal("1.5")\n        self.assertEqual(x, 1)');
    const wrapped = [
        '```python', 'import unittest', 'from fractions import (', '    Fraction,', ')', '', 'class T(unittest.TestCase):',
        '    import os', '    def test_c2(self):', '        text = """first', 'column zero inside a string', '"""',
        '# a column-zero comment inside the method', '        self.assertEqual(text, Fraction(1))', '', '    def helper(self):', '        return 1',
        '', "if __name__ == '__main__':", '    unittest.main()', 'This explains the fix.', '```'].join('\n');
    assert.equal(parseRowFixResponse(wrapped, 'test_c2'), [
        '    def test_c2(self):', '        import unittest', '        from fractions import (', '            Fraction,', '            )', '        import os',
        '        text = """first', '    column zero inside a string', '    """', '    # a column-zero comment inside the method',
        '        self.assertEqual(text, Fraction(1))'].join('\n'));
    assert.equal(parseRowFixResponse('```python\ndef test_c2(self):\n    y = 2\n    self.assertEqual(y, 2)\n# trailing note\n```', 'test_c2'),
        '    def test_c2(self):\n        y = 2\n        self.assertEqual(y, 2)', 'a trailing comment after the method is dropped');
});

test('an instance-method setup must build instance before it can be captured', () => {
    const reply = (lines: string[]) => '```python\n' + lines.join('\n') + '\n```';
    assert.equal(parseRowSetupResponse(reply(['box = target_module.Box(2)', 'args = (3,)', 'kwargs = {}']), { requireInstance: true }), null);
    assert.equal(parseRowSetupResponse(reply(['instance == target_module.Box(2)', 'args = (3,)', 'kwargs = {}']), { requireInstance: true }), null);
    for (const binding of ['instance = target_module.Box(2)', 'instance: target_module.Box = target_module.Box(2)',
        'instance, other = target_module.Box(2), 1', 'with target_module.make() as instance:\n    pass']) {
        const code = [binding, 'args = (3,)', 'kwargs = {}'].join('\n');
        assert.equal(parseRowSetupResponse(reply([code]), { requireInstance: true }), code, binding);
    }
    const plain = reply(['box = target_module.Box(2)', 'args = (box,)', 'kwargs = {}']);
    assert.equal(parseRowSetupResponse(plain), 'box = target_module.Box(2)\nargs = (box,)\nkwargs = {}', 'other targets are unchanged');
});

test('a plain-function setup prompt is word for word the same as before PR #18', () => {
    const prompt = getRowSetupPrompt({ signature: 'total(items)', className: null, methodKind: 'module', targetName: 'total',
        source: 'def total(items):\n    return sum(i.size for i in items)', scenario: 'two items', setupDescription: 'a list of two Item objects',
        classContext: null, needsSetup: true, mockedDependencies: [] });
    // Generated from lane_edition 06e3e85 (before PR #18).
    assert.equal(prompt.user, 'Target: total(items)\nSource:\n```python\ndef total(items):\n    return sum(i.size for i in items)\n```\n\n'
        + 'Scenario: two items\nInputs to build: a list of two Item objects\n\nThe module under test is available as target_module, and unittest.mock as mock.\n'
        + 'Write 3 to 10 lines of Python that define:\n- args: a tuple of positional arguments\n- kwargs: a dict of keyword arguments ({} when there are none)\n'
        + 'Do not call total, do not open files or use the network, and do not write assertions.\nExample:\n```python\n'
        + 'item = target_module.Item(name="a", size=2)\nargs = (item, 3)\nkwargs = {}\n```\nOutput only one ```python block containing the setup lines.');
});

test('an instance-method setup prompt shows the class context, the instance example and the mocked dependencies', () => {
    const classContext = 'class Box:\n    def __init__(self, size, label="box"):\n        self.size = size';
    const prompt = getRowSetupPrompt({ signature: 'grow(extra)', className: 'Box', methodKind: 'instance', targetName: 'Box.grow',
        source: 'def grow(self, extra):\n    return self.size + extra', scenario: 'grow a small box',
        setupDescription: 'a list of two sizes; also build instance (the Box object whose method is tested)', classContext,
        needsSetup: true, mockedDependencies: ['store.read'] }).user;
    assert.ok(prompt.includes('```\n\nClass context:\n```python\n' + classContext + '\n```\n\nScenario: grow a small box'));
    assert.ok(prompt.includes('Inputs to build: a list of two sizes; also build instance (the Box object whose method is tested)'));
    assert.ok(prompt.includes('These dependencies are replaced from outside the setup: store.read. Do not call mock.patch in the setup.'));
    assert.ok(prompt.includes('Example:\n```python\ninstance = target_module.Item(name="a", size=2)\nargs = (3,)\nkwargs = {}\n```'));
    assert.equal((prompt.match(/Example:/g) || []).length, 1, 'still exactly one example');
    const long = getRowSetupPrompt({ signature: 'grow(extra)', className: 'Box', methodKind: 'instance', targetName: 'Box.grow', source: 'def grow(self, extra): ...',
        scenario: 's', setupDescription: 'd', classContext: Array.from({ length: 75 }, (_value, index) => `    field_${index} = ${index}`).join('\n') }).user;
    assert.ok(long.includes(`    field_${ROW_SETUP_CLASS_CONTEXT_MAX_LINES - 1} = ${ROW_SETUP_CLASS_CONTEXT_MAX_LINES - 1}\n# ... truncated: 15 more lines not shown\n\`\`\``));
    assert.ok(!long.includes(`field_${ROW_SETUP_CLASS_CONTEXT_MAX_LINES} =`));
    assert.equal(ROW_SETUP_CLASS_CONTEXT_MAX_LINES, 60);
});
