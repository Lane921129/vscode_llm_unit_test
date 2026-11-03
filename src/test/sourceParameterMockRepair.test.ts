import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repairSourceParameterMock, LiteralArgumentRepairOptions } from '../pipeline/sourceLiteralArgumentRepair';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { runExecutionVerification } from '../pipeline/executionVerification';
import { verifyExecutionEvidence } from '../pipeline/executionEvidence';
import { pythonToolPath } from '../pipeline/pythonTools';
import { runSpawn } from '../utils/processRunner';
import { buildGeneratedTestEnvironment, resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const source = 'def target(cursor, label):\n    cursor.write(label)\n';
const code = '# 保留模型測值及斷言\nimport unittest\nimport unittest.mock\nfrom sample import target\n'
    + 'class Cases(unittest.TestCase):\n    def test_seed(self):\n'
    + '        with unittest.mock.patch("sample.cursor.write") as stub:\n'
    + '            stub.return_value = None\n            target(stub, "測值")\n'
    + '            stub.assert_called_once_with("測值")\n            self.assertEqual(stub.call_count, 1)\n';

async function failure(testCode = code, fullSource = source, targetSource = source): Promise<string> {
    const result = await runSpawn(python, ['-B', pythonToolPath('bindings'), '--payload'], {
        input: JSON.stringify({ code: testCode, context: { module: 'sample', target: 'target', source: targetSource,
            moduleSource: fullSource, requireMockBehavior: true, requireTargetBehavior: true } }), timeout: 5000 });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout).reason || '';
}

async function options(extra: Partial<LiteralArgumentRepairOptions> = {}): Promise<LiteralArgumentRepairOptions> {
    return { source, code, failure: await failure(), target: 'target', module: 'sample', python,
        moduleSource: source, moduleSourceHash: evidenceHash(source), checkCurrent: () => {},
        request: async () => 'REPLACE setup-1 WITH source-1', ...extra };
}

async function cli(payload: unknown): Promise<any> {
    const result = await runSpawn(python, ['-I', '-B', pythonToolPath('sourceParameterMockRepair')], {
        input: JSON.stringify(payload), timeout: 5000 });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test('parameter adapter locks values/assertions and makes the source-used method observe the real target', async () => {
    const crlf = code.replace(/\n/g, '\r\n');
    const events: { status: string; detail: Record<string, unknown> }[] = [];
    const candidate = await repairSourceParameterMock(await options({ code: crlf, failure: await failure(crlf),
        event: (status, detail) => events.push({ status, detail }),
        request: async (system, prompt) => {
            assert.match(system, /caller-owned standard MagicMock/); assert.match(system, /assertion method, call count and arguments/);
            assert.ok(prompt.includes(source)); assert.ok(prompt.includes('SOURCE_PARAMETER_MOCK_SELECTION_V1'));
            assert.doesNotMatch(prompt, /HOST_ISOLATED_RESOURCE_CONTEXT/);
            return 'REPLACE setup-1 WITH source-1';
        } }));
    assert.equal(candidate, crlf.replace('with unittest.mock.patch("sample.cursor.write") as stub:', 'stub = unittest.mock.MagicMock()')
        .replace(/^ {12}/gm, '        ')
        .replace('stub.return_value', 'stub.write.return_value').replace('stub.assert_called_once_with', 'stub.write.assert_called_once_with')
        .replace('stub.call_count', 'stub.write.call_count'));
    assert.equal(await failure(candidate), '');
    assert.equal(events.at(-1)?.status, 'parameter-selection-applied');
    assert.equal(events.at(-1)?.detail.executionApproved, false);
    const keyword = code.replace('target(stub, "測值")', 'target(label="測值", cursor=stub)');
    assert.ok(await repairSourceParameterMock(await options({ code: keyword, failure: await failure(keyword) })));
});

test('module hashes and the original checker verdict are required without importing application code', async () => {
    const poisoned = 'raise RuntimeError("must not execute")\n' + source;
    assert.ok(await repairSourceParameterMock(await options({ moduleSource: poisoned,
        moduleSourceHash: evidenceHash(poisoned), failure: await failure(code, poisoned) })));
    await assert.rejects(repairSourceParameterMock(await options({ moduleSourceHash: '0'.repeat(64) })), /Source module changed/);
    let requested = false;
    assert.equal(await repairSourceParameterMock(await options({ failure: (await failure()).replace('cursor is', 'other is'),
        request: async () => { requested = true; return ''; } })), undefined);
    assert.equal(requested, false);
});

test('scope adaptation preserves header comments, blank lines and multiline string bytes', async () => {
    const literal = '"""first\n            keep this indentation\n            last"""';
    const draft = code.replace(' as stub:\n', ' as stub: # 原註解\n\n')
        .replaceAll('"測值"', literal);
    const candidate = await repairSourceParameterMock(await options({ code: draft, failure: await failure(draft) }));
    assert.ok(candidate?.includes('stub = unittest.mock.MagicMock() # 原註解\n\n'));
    assert.equal(candidate?.split(literal).length, 3);
    assert.equal(await failure(candidate), '');
});

test('ambiguous parameter binding, alias escapes, fixture hooks and helper mutations never receive an adapter', async () => {
    const cases = [code.replace('target(stub, "測值")', 'target(*[stub, "測值"])'),
        code.replace('target(stub, "測值")', 'target(other, "測值")'),
        code.replace('target(stub, "測值")', 'target(stub, "測值")\n            target(stub, "測值")'),
        code.replace('            target(', '            consume(stub)\n            target('),
        code.replace('            target(', '            stub = object()\n            target('),
        code.replace('    def test_seed', '    def setUp(self):\n        pass\n    def test_seed'),
        code + '    def test_other(self):\n        pass\n',
        code.replace('        with ', '        unittest.mock.MagicMock = custom\n        with '),
        code.replace('        with ', '        alias = unittest\n        with '),
        code.replace('        with ', '        globals()\n        with '),
        code.replace('        with ', '        from other import unittest\n        with '),
        code.replace('class Cases(', 'class unittest('),
        code.replace('unittest.mock.patch("sample.cursor.write")', 'unittest.mock.patch("sample.cursor.write", autospec=True)'),
        code.replace('stub.return_value', 'stub.write.return_value')];
    for (const candidate of cases) {
        let requested = false;
        assert.equal(await repairSourceParameterMock(await options({ code: candidate,
            request: async () => { requested = true; return ''; } })), undefined, candidate);
        assert.equal(requested, false);
    }
    const rebound = source.replace('    cursor.write(label)', '    cursor = other\n    cursor.write(label)');
    assert.equal(await repairSourceParameterMock(await options({ source: rebound, moduleSource: rebound,
        moduleSourceHash: evidenceHash(rebound), failure: await failure(code, rebound, rebound) })), undefined);
});

test('closed selections, cancellation and stale plans do not apply or approve candidates', async () => {
    const value = await options(), plan = await cli(value);
    assert.equal(plan.status, 'eligible');
    assert.equal((await cli({ ...value, operation: 'apply', planHash: '0'.repeat(64), directive: 'REPLACE setup-1 WITH source-1' })).status, 'rejected');
    assert.equal(await repairSourceParameterMock({ ...value, request: async () => 'ABSTAIN' }), undefined);
    await assert.rejects(repairSourceParameterMock({ ...value, request: async () => 'REPLACE setup-1 WITH source-2' }), /no edit was applied/);
    let replied = false;
    await assert.rejects(repairSourceParameterMock({ ...value, request: async () => {
        replied = true; return 'REPLACE setup-1 WITH source-1';
    }, checkCurrent: () => { if (replied) { throw Error('cancelled'); } } }), /cancelled/);
});

test('adapted fixtures require fresh native target and isolation proof; wrong expected values stay wrong', async () => {
    const temp = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temp, 'parameter-mock-proof-'));
    const file = path.join(root, 'sample.py'), directory = path.join(root, 'result');
    fs.writeFileSync(file, source);
    const journal = new AnalysisJournal(directory, source, 'target', 'scripted-parameter-selection', undefined, 'execution');
    try {
        const baseline = await runExecutionVerification({ directory, file, target: 'target', targetModule: 'sample', python,
            env: buildGeneratedTestEnvironment(process.env, [root]), dependencies: [], journal, generate: async () => code,
            hooks: { validate: draft => failure(draft).then(reason => reason || undefined),
                revise: async (draft, reason, role) => {
                    assert.equal(role, 'writer');
                    const candidate = await repairSourceParameterMock(await options({ code: draft, failure: reason }));
                    assert.ok(candidate); return candidate;
                }, event: (stage, status, detail) => { journal.record(1, stage, status, detail); } } });
        assert.equal(verifyExecutionEvidence(directory, file, baseline,
            { runId: journal.runId, sourceHash: journal.sourceHash, target: 'target' }), true);
        const wrong = code.replace('stub.assert_called_once_with("測值")', 'stub.assert_called_once_with("wrong")');
        const adapted = await repairSourceParameterMock(await options({ code: wrong, failure: await failure(wrong) }));
        assert.ok(adapted?.includes('stub.write.assert_called_once_with("wrong")'));
        fs.writeFileSync(path.join(root, 'wrong_test.py'), adapted!);
        const run = await runSpawn(python, ['-B', '-m', 'unittest', 'wrong_test'], { cwd: root,
            env: buildGeneratedTestEnvironment(process.env, [root]), timeout: 5000 });
        assert.notEqual(run.code, 0); assert.match(run.stderr, /expected call not found/);
    } finally {
        const resolved = fs.realpathSync(root);
        assert.equal(path.dirname(resolved), temp); assert.ok(path.basename(resolved).startsWith('parameter-mock-proof-'));
        assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
        fs.rmSync(resolved, { recursive: true });
    }
});
