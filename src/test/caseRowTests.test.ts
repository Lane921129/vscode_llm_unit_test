import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaseRow } from '../pipeline/caseTable/caseTable';
import { buildCaseTableTestFile, buildRowTestMethod, RowTestContext, rowTestMethodName } from '../pipeline/caseTable/rowToTest';
import { observedExpectation } from '../pipeline/caseTable/runRowStage';
import { getRowSetupPrompt, parseRowSetupResponse, ROW_SETUP_MAX_LINES } from '../roles/unittestWriter';
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
