import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { repairSourceLiteralArgument, repairSourceMockReceiver, repairSourceTestBinding } from '../pipeline/sourceLiteralArgumentRepair';
import { evidenceHash } from '../pipeline/analysisJournal';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const source = 'def target(provider):\n    cursor = provider.cursor()\n    cursor.execute("\\n  first\\n  second\\n")\n';
const code = '# 保留 UTF-8 與其他測試\nimport unittest\n'
    + 'class Cases(unittest.TestCase):\n    def test_seed(self):\n'
    + '        dependency.execute.assert_called_once_with("first second", (7,))\n'
    + '    def test_kept(self):\n        self.assertEqual(3, 3)\n';
const failure = 'FAIL: test_seed (generated.Cases.test_seed)\nAssertionError: expected call not found.\n';

test('AI directive copies a source literal byte-for-byte while all other test code remains locked', async () => {
    let requests = 0;
    const events: string[] = [];
    const candidate = await repairSourceLiteralArgument({ source, code, failure, target: 'target', python,
        checkCurrent() {}, event(status) { events.push(status); }, request: async (system, prompt) => {
            requests++;
            assert.ok(prompt.includes(source));
            assert.match(prompt, /COMPLETE FAILING METHOD/);
            assert.match(prompt, /argument-1/);
            assert.match(system, /All other code, inputs, setup and assertions are locked/);
            assert.doesNotMatch(prompt, /HOST_ISOLATED_RESOURCE_CONTEXT/);
            return 'REPLACE argument-1 WITH source-1';
        } });
    assert.equal(requests, 1);
    assert.equal(candidate, code.replace('"first second"', "'\\n  first\\n  second\\n'"));
    assert.deepEqual(events, ['literal-selection-planned', 'literal-selection-applied']);
});

test('ambiguous assertions or unrelated string content do not ask the model or edit a first method', async () => {
    for (const candidate of [code.replace('    def test_kept',
        '        other.execute.assert_called_once_with("first second")\n    def test_kept'),
        code.replace('first second', 'different content')]) {
        let requested = false;
        assert.equal(await repairSourceLiteralArgument({ source, code: candidate, failure, target: 'target', python,
            checkCurrent() {}, request: async () => { requested = true; return 'REPLACE argument-1 WITH source-1'; } }), undefined);
        assert.equal(requested, false);
    }
});

test('invalid AI instructions and cancellation never apply a source edit', async () => {
    await assert.rejects(repairSourceLiteralArgument({ source, code, failure, target: 'target', python,
        checkCurrent() {}, request: async () => 'REPLACE argument-1 WITH source-9\nimport os' }),
    /did not return an applicable source literal edit directive/);
    let checks = 0, requested = false;
    await assert.rejects(repairSourceLiteralArgument({ source, code, failure, target: 'target', python,
        checkCurrent() { if (++checks === 2) { throw new Error('cancelled'); } },
        request: async () => { requested = true; return 'REPLACE argument-1 WITH source-1'; } }), /cancelled/);
    assert.equal(requested, false);
});

const receiverSource = 'def target():\n    connection = factory()\n    cursor = connection.cursor()\n'
    + '    cursor.execute("query")\n    connection.commit()\n    connection.close()\n';
const receiverCode = 'import unittest\nfrom unittest.mock import patch\nfrom sample import target\n'
    + 'class Cases(unittest.TestCase):\n    def test_seed(self):\n'
    + '        with patch("sample.factory") as controlled:\n'
    + '            target()\n'
    + '            controlled.return_value.cursor.return_value.commit.assert_called_once()\n'
    + '            controlled.return_value.close.assert_called_once()\n';
const receiverFailure = 'FAIL: test_seed (generated.Cases.test_seed)\n'
    + "AssertionError: Expected 'commit' to be called once. Called 0 times.\n";

test('source receiver selection corrects only the observed Mock path and preserves exact call expectations', async () => {
    const events: string[] = [];
    const candidate = await repairSourceMockReceiver({ source: receiverSource, code: receiverCode,
        failure: receiverFailure, target: 'target', module: 'sample', python, checkCurrent() {},
        event(status) { events.push(status); }, request: async (system, prompt) => {
            assert.match(system, /Keep the same assertion method, call count and arguments/);
            assert.ok(prompt.includes(receiverSource));
            assert.match(prompt, /controlled\.return_value\.commit/);
            return 'REPLACE receiver-1 WITH source-1';
        } });
    assert.equal(candidate, receiverCode.replace('controlled.return_value.cursor.return_value.commit', 'controlled.return_value.commit'));
    assert.deepEqual(events, ['receiver-selection-planned', 'receiver-selection-applied']);
});

test('receiver selection refuses shadowed patches, ambiguous assertions and source rebinding', async () => {
    const cases = [
        { code: receiverCode.replace('        with patch', '        patch = custom_patch\n        with patch'), source: receiverSource },
        { code: receiverCode.replace('            controlled.return_value.close',
            '            other.commit.assert_called_once()\n            controlled.return_value.close'), source: receiverSource },
        { code: receiverCode, source: receiverSource.replace('    connection.commit()', '    connection = other()\n    connection.commit()') },
        { code: receiverCode.replace('patch("sample.factory")', 'patch("sample.factory", new=replacement)'), source: receiverSource },
        { code: receiverCode, source: receiverSource, target: 'Owner.target' }
    ];
    for (const value of cases) {
        let requested = false;
        assert.equal(await repairSourceMockReceiver({ ...value, failure: receiverFailure, target: value.target || 'target', module: 'sample', python,
            checkCurrent() {}, request: async () => { requested = true; return 'REPLACE receiver-1 WITH source-1'; } }), undefined);
        assert.equal(requested, false);
    }
});

test('a native AttributeError on the exact assertion line permits only its source receiver correction', async () => {
    const candidate = receiverCode.replace('cursor.return_value.commit', 'cursor.return_value.connection.commit');
    const statement = 'controlled.return_value.cursor.return_value.connection.commit.assert_called_once()';
    const line = candidate.split('\n').findIndex(value => value.trim() === statement) + 1;
    const error = 'ERROR: test_seed (generated.Cases.test_seed)\nTraceback (most recent call last):\n'
        + `  File "generated_test.py", line ${line}, in test_seed\n    ${statement}\n`
        + "AttributeError: 'types.SimpleNamespace' object has no attribute 'connection'\n";
    let requests = 0;
    const repaired = await repairSourceMockReceiver({ source: receiverSource, code: candidate, failure: error,
        target: 'target', module: 'sample', python, checkCurrent() {}, request: async () => {
            requests++; return 'REPLACE receiver-1 WITH source-1';
        } });
    assert.equal(requests, 1);
    assert.equal(repaired, candidate.replace('controlled.return_value.cursor.return_value.connection.commit', 'controlled.return_value.commit'));
    for (const failure of [error.replace(`line ${line}`, `line ${line - 1}`),
        error.replace('in test_seed', 'in target'), error.replace(statement, 'target()')]) {
        assert.equal(await repairSourceMockReceiver({ source: receiverSource, code: candidate, failure,
            target: 'target', module: 'sample', python, checkCurrent() {}, request: async () => {
                throw new Error('A target/setup failure must not ask for an assertion edit');
            } }), undefined);
    }
});

const bindingSource = 'def target(value):\n    return value.year\n';
const moduleSource = 'from datetime import datetime\nraise RuntimeError("must never import application during planning")\n' + bindingSource;
const bindingCode = '# 保留其他內容\nimport unittest\nfrom sample import target\n'
    + 'class Cases(unittest.TestCase):\n    def test_seed(self):\n'
    + '        value = datetime(2026, 1, 2)\n        self.assertEqual(target(value), 2026)\n';
const bindingFailure = 'Writer binding repair: datetime is undefined or read before its local binding in test_seed.';

test('Writer binding directive adds only a method-local source import without executing the application', async () => {
    let requested = 0;
    const candidate = await repairSourceTestBinding({ source: bindingSource, code: bindingCode, failure: bindingFailure,
        target: 'target', module: 'sample', moduleSource, moduleSourceHash: evidenceHash(moduleSource), python,
        checkCurrent() {}, request: async (system, prompt) => {
            requested++;
            assert.match(system, /one explicit method-local import/);
            assert.match(prompt, /from sample import datetime/);
            assert.doesNotMatch(prompt, /must never import application during planning/);
            return 'INSERT import-1 FROM source-1';
        } });
    assert.equal(requested, 1);
    assert.equal(candidate, bindingCode.replace('        value = datetime', '        from sample import datetime\n        value = datetime'));
});

test('binding repair does not guess source helper imports or select among duplicate methods', async () => {
    for (const value of [
        { code: bindingCode.replaceAll('datetime', '_helper'),
            failure: bindingFailure.replaceAll('datetime', '_helper'), module: 'def _helper():\n    return 1\n' + bindingSource },
        { code: bindingCode.replaceAll('datetime', 'compute_expected'),
            failure: bindingFailure.replaceAll('datetime', 'compute_expected'), module: 'from other import compute_expected\n' + bindingSource },
        { code: bindingCode + 'class Other(unittest.TestCase):\n    def test_seed(self):\n        self.assertTrue(datetime)\n',
            failure: bindingFailure, module: moduleSource }
    ]) {
        let requested = false;
        assert.equal(await repairSourceTestBinding({ source: bindingSource, code: value.code, failure: value.failure,
            target: 'target', module: 'sample', moduleSource: value.module, moduleSourceHash: evidenceHash(value.module), python,
            checkCurrent() {}, request: async () => { requested = true; return 'INSERT import-1 FROM source-1'; } }), undefined);
        assert.equal(requested, false);
    }
});

test('module source drift stops binding repair before asking a model', async () => {
    let requested = false;
    await assert.rejects(repairSourceTestBinding({ source: bindingSource, code: bindingCode, failure: bindingFailure,
        target: 'target', module: 'sample', moduleSource, moduleSourceHash: evidenceHash('different'), python,
        checkCurrent() {}, request: async () => { requested = true; return 'INSERT import-1 FROM source-1'; } }), /Source module changed/);
    assert.equal(requested, false);
});

test('two unresolved standard test helpers are repaired atomically instead of alternating lost imports', async () => {
    const source = 'def target():\n    return factory()\n';
    const moduleSource = 'from elsewhere import factory\n' + source;
    const code = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
        + '    def test_seed(self):\n        with patch("sample.factory", new=MagicMock(return_value=7)):\n'
        + '            self.assertEqual(target(), 7)\n';
    const failure = 'Writer binding repair: patch is undefined or read before its local binding in test_seed. '
        + 'Additional statically unresolved bindings (bounded scan): MagicMock in test_seed.';
    let requests = 0;
    const candidate = await repairSourceTestBinding({ source, code, failure, target: 'target', module: 'sample',
        moduleSource, moduleSourceHash: evidenceHash(moduleSource), python, checkCurrent() {},
        request: async (_system, prompt) => {
            requests++;
            assert.match(prompt, /from unittest\.mock import patch, MagicMock/);
            return 'INSERT import-1 FROM source-1';
        } });
    assert.equal(requests, 1);
    assert.equal(candidate, code.replace('        with patch', '        from unittest.mock import patch, MagicMock\n        with patch'));
});

const mockBindingCode = 'import unittest\nfrom unittest.mock import patch, MagicMock\nfrom sample import target\n'
    + 'class Cases(unittest.TestCase):\n    def test_seed(self):\n'
    + '        with patch("sample.factory") as controlled:\n'
    + '            owned = MagicMock()\n            controlled.return_value = owned\n'
    + '            target()\n            owned.execute.assert_called_once_with("query")\n'
    + '            owned.commit.assert_called_once()\n';
const mockBindingFailure = 'Mock assertion is not proven to observe an explicit target use-point patch or a mock passed to the target. Direct target use points in target: sample.factory.';

test('Writer receiver repair preserves a separately configured Mock identity and claims no native failure', async () => {
    let requested = 0;
    const candidate = await repairSourceMockReceiver({ source: receiverSource, code: mockBindingCode, failure: mockBindingFailure,
        target: 'target', module: 'sample', python, checkCurrent() {}, request: async (_system, prompt) => {
            requested++;
            assert.match(prompt, /No runtime call failure is claimed/);
            assert.match(prompt, /owned\.cursor\.return_value\.execute/);
            return 'REPLACE receiver-1 WITH source-1';
        } });
    assert.equal(requested, 1);
    assert.equal(candidate, mockBindingCode.replace('owned.execute.assert_called_once_with', 'owned.cursor.return_value.execute.assert_called_once_with'));
});

test('Writer receiver proof refuses late/replaced Mock bindings, shadow constructors and multiple test methods', async () => {
    for (const code of [
        mockBindingCode.replace('            target()\n', '            controlled.return_value = MagicMock()\n            target()\n'),
        mockBindingCode.replace('            controlled.return_value = owned\n            target()', '            target()\n            controlled.return_value = owned'),
        mockBindingCode.replace('from sample import target', 'from sample import target\nfrom other import MagicMock'),
        mockBindingCode + '    def test_other(self):\n        self.assertEqual(1, 1)\n'
    ]) {
        assert.equal(await repairSourceMockReceiver({ source: receiverSource, code, failure: mockBindingFailure,
            target: 'target', module: 'sample', python, checkCurrent() {}, request: async () => {
                throw new Error('Unknown Mock identity must not reach the model');
            } }), undefined);
    }
});

test('unrelated clock receivers require source-bound module declarations without supplying the module to the model', async () => {
    const source = receiverSource.replace('    cursor.execute', '    stamp = datetime.now()\n    cursor.execute');
    const moduleSource = 'from datetime import datetime\ndef factory():\n    raise RuntimeError("do not load module")\n' + source;
    const options = { source, code: mockBindingCode, failure: mockBindingFailure, target: 'target', module: 'sample', python,
        checkCurrent() {}, request: async (_system: string, prompt: string) => {
            assert.doesNotMatch(prompt, /do not load module/);
            return 'REPLACE receiver-1 WITH source-1';
        } };
    assert.equal(await repairSourceMockReceiver({ ...options, request: async () => {
        throw new Error('Unknown clock binding must not be guessed');
    } }), undefined);
    const candidate = await repairSourceMockReceiver({ ...options, moduleSource, moduleSourceHash: evidenceHash(moduleSource) });
    assert.equal(candidate, mockBindingCode.replace('owned.execute.assert_called_once_with', 'owned.cursor.return_value.execute.assert_called_once_with'));
});
