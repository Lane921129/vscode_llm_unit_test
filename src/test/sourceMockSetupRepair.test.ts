import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repairSourceMockSetup, LiteralArgumentRepairOptions } from '../pipeline/sourceLiteralArgumentRepair';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { runExecutionVerification } from '../pipeline/executionVerification';
import { verifyExecutionEvidence } from '../pipeline/executionEvidence';
import { pythonToolPath } from '../pipeline/pythonTools';
import { runSpawn } from '../utils/processRunner';
import { buildGeneratedTestEnvironment, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { sourceLiteralRepairGuidance } from '../prompts/dependencyMockContract';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const source = 'def target():\n    return moment.now()\n';
const moduleSource = 'from datetime import datetime as moment\n' + source;
const code = '# 保留 UTF-8 與原斷言\nimport unittest\nfrom unittest.mock import patch\nfrom sample import target\n'
    + 'class Cases(unittest.TestCase):\n    def test_seed(self):\n'
    + '        with patch("sample.moment.now") as stub:\n'
    + '            frozen = object()\n            stub.return_value = frozen\n'
    + '            actual = target()\n            self.assertIs(actual, frozen)\n'
    + '            stub.assert_called_once_with()\n            self.assertEqual(stub.call_count, 1)\n';

async function checkedFailure(testCode = code, fullSource = moduleSource, targetSource = source): Promise<string> {
    const run = await runSpawn(python, ['-B', pythonToolPath('bindings'), '--payload'], {
        input: JSON.stringify({ code: testCode, context: { module: 'sample', target: 'target', source: targetSource,
            moduleSource: fullSource, requireMockBehavior: true, requireTargetBehavior: true } }), timeout: 5000
    });
    assert.equal(run.code, 0, run.stderr);
    return JSON.parse(run.stdout).reason || '';
}

async function options(extra: Partial<LiteralArgumentRepairOptions> = {}): Promise<LiteralArgumentRepairOptions> {
    return { source, code, failure: await checkedFailure(), target: 'target', python, module: 'sample',
        moduleSource, moduleSourceHash: evidenceHash(moduleSource), checkCurrent: () => {},
        request: async () => 'REPLACE setup-1 WITH source-1', ...extra };
}

async function cli(payload: unknown): Promise<any> {
    const run = await runSpawn(python, ['-I', '-B', pythonToolPath('sourceMockSetupRepair')], {
        input: JSON.stringify(payload), timeout: 5000
    });
    assert.equal(run.code, 0, run.stderr);
    return JSON.parse(run.stdout);
}

test('AI selects a source-bound clock setup while preserving literal values, assertion methods and UTF-8 bytes', async () => {
    const crlf = code.replace(/\n/g, '\r\n');
    const events: { status: string; detail: Record<string, unknown> }[] = [];
    let requests = 0;
    const candidate = await repairSourceMockSetup(await options({ code: crlf, failure: await checkedFailure(crlf),
        event: (status, detail) => events.push({ status, detail }),
        request: async (system, prompt) => {
            requests++; assert.match(system, /assertion method, call count and arguments/);
            assert.ok(prompt.includes(source)); assert.ok(prompt.includes('self.assertIs(actual, frozen)'));
            assert.match(prompt, /SOURCE_MOCK_SETUP_SELECTION_V1/); assert.doesNotMatch(prompt, /HOST_ISOLATED_RESOURCE_CONTEXT/);
            return 'REPLACE setup-1 WITH source-1';
        } }));
    assert.equal(requests, 1);
    const expected = crlf.replace('"sample.moment.now"', "'sample.moment'")
        .replace('stub.return_value', 'stub.now.return_value').replace('stub.assert_called_once_with()', 'stub.now.assert_called_once_with()')
        .replace('stub.call_count', 'stub.now.call_count');
    assert.equal(candidate, expected);
    assert.equal(events.at(-1)?.status, 'setup-selection-applied');
    assert.equal(events.at(-1)?.detail.executionApproved, false);
    assert.match(await checkedFailure(candidate), /^$/);
});

test('planning does not execute application imports and independently reproduces the current checker failure', async () => {
    const poisoned = 'raise RuntimeError("application must not execute")\n' + moduleSource;
    assert.ok(await repairSourceMockSetup(await options({ moduleSource: poisoned, moduleSourceHash: evidenceHash(poisoned),
        failure: await checkedFailure(code, poisoned) })));
    let requested = false;
    assert.equal(await repairSourceMockSetup(await options({ failure: (await checkedFailure()).replace('sample.moment.now', 'sample.other.now'),
        request: async () => { requested = true; return ''; } })), undefined);
    assert.equal(requested, false);
    await assert.rejects(repairSourceMockSetup(await options({ moduleSourceHash: '0'.repeat(64) })), /Source module changed/);
});

test('ambiguous methods, alias rebinding, escape, reflection and unknown patch factories never reach AI selection', async () => {
    const cases = [code + '    def test_other(self):\n        self.assertEqual(1, 1)\n',
        code + '        stub.assert_not_called()\n',
        code.replace('            actual = target()', '            stub = object()\n            actual = target()'),
        code.replace('            actual = target()', '            consume(stub)\n            actual = target()'),
        code.replace('            actual = target()', '            import other as stub\n            actual = target()'),
        code.replace('        with patch', '        patch = unknown\n        with patch'),
        code.replace('            frozen = object()', '            frozen = (lambda: object())()'),
        code.replace('stub.return_value = frozen', 'stub.now.return_value = frozen'),
        code.replace('patch("sample.moment.now")', 'patch("sample.moment.now", autospec=True)')];
    for (const candidate of cases) {
        let requested = false;
        assert.equal(await repairSourceMockSetup(await options({ code: candidate,
            request: async () => { requested = true; return ''; } })), undefined);
        assert.equal(requested, false);
    }
});

test('test-side source mutation, alias replacement and reflective changes revoke the setup proof', async () => {
    const candidates = [code.replace('        with patch', '        import sample\n        sample.moment = object()\n        with patch'),
        code.replace('        with patch', '        import sample\n        a = sample\n        b = a\n        c = b\n        d = c\n        d.moment = object()\n        with patch'),
        code.replace('        with patch', '        with patch("sample.moment"):\n            pass\n        with patch'),
        code.replace('        with patch', '        import sample\n        with patch.object(sample, "moment"):\n            pass\n        with patch'),
        code.replace('            frozen = object()', '            globals()\n            frozen = object()'),
        code.replace('class Cases(unittest.TestCase)', 'class Cases(object)')];
    for (const candidate of candidates) {
        let requested = false;
        assert.equal(await repairSourceMockSetup(await options({ code: candidate,
            request: async () => { requested = true; return ''; } })), undefined);
        assert.equal(requested, false);
    }
});

test('source rebinding, wildcard namespaces and other class uses cannot borrow clock replacement proof', async () => {
    const variants = [moduleSource + '\nmoment = object()\n', 'from external import *\n' + moduleSource,
        moduleSource.replace('return moment.now()', 'moment(2020, 1, 1)\n    return moment.now()'),
        moduleSource.replace('return moment.now()', 'moment.strptime("value", "format")\n    return moment.now()')];
    for (const fullSource of variants) {
        const targetSource = fullSource.slice(fullSource.indexOf('def target():')).split('\nmoment =')[0];
        let requested = false;
        assert.equal(await repairSourceMockSetup(await options({ source: targetSource, moduleSource: fullSource,
            moduleSourceHash: evidenceHash(fullSource), request: async () => { requested = true; return ''; } })), undefined);
        assert.equal(requested, false);
    }
});

test('closed directives, stale plans and cancellation never adopt a partial or unselected replacement', async () => {
    const value = await options();
    const plan = await cli(value);
    assert.equal(plan.status, 'eligible');
    assert.equal((await cli({ ...value, operation: 'apply', planHash: '0'.repeat(64), directive: 'REPLACE setup-1 WITH source-1' })).status, 'rejected');
    assert.equal((await cli({ ...value, operation: 'apply', planHash: plan.planHash, directive: 42 })).status, 'rejected');
    const events: string[] = [];
    assert.equal(await repairSourceMockSetup({ ...value, request: async () => 'ABSTAIN',
        event: status => events.push(status) }), undefined);
    assert.equal(events.at(-1), 'setup-selection-abstained');
    for (const directive of ['REPLACE setup-1 WITH source-2', 'REPLACE setup-1 WITH source-1\nextra']) {
        await assert.rejects(repairSourceMockSetup({ ...value, request: async () => directive }), /no edit was applied/);
    }
    let replied = false;
    await assert.rejects(repairSourceMockSetup({ ...value,
        request: async () => { replied = true; return 'REPLACE setup-1 WITH source-1'; },
        checkCurrent: () => { if (replied) { throw Error('cancelled before apply'); } }
    }), /cancelled before apply/);
});

test('the selected setup still needs real native invocation and complete isolation evidence', async () => {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(tempRoot, 'clock-setup-proof-'));
    const file = path.join(root, 'sample.py'), directory = path.join(root, 'result');
    fs.writeFileSync(file, moduleSource);
    const journal = new AnalysisJournal(directory, moduleSource, 'target', 'scripted-clock-selection', undefined, 'execution');
    let selections = 0;
    try {
        const baseline = await runExecutionVerification({ directory, file, target: 'target', targetModule: 'sample', python,
            env: buildGeneratedTestEnvironment(process.env, [root]), dependencies: [], journal, generate: async () => code,
            hooks: {
                validate: checkedCode => checkedFailure(checkedCode).then(reason => reason || undefined),
                revise: async (draft, failure, role) => {
                    assert.equal(role, 'writer');
                    const candidate = await repairSourceMockSetup(await options({ code: draft, failure,
                        request: async () => { selections++; return 'REPLACE setup-1 WITH source-1'; } }));
                    assert.ok(candidate); return candidate;
                },
                event: (stage, status, detail) => { journal.record(1, stage, status, detail); }
            }
        });
        assert.equal(selections, 1);
        assert.equal(verifyExecutionEvidence(directory, file, baseline,
            { runId: journal.runId, sourceHash: journal.sourceHash, target: 'target' }), true);
        assert.equal(fs.readFileSync(file, 'utf8'), moduleSource);
        assert.equal(fs.readdirSync(directory).filter(name => /^exec\d+_test\.py$/.test(name)).length, 1);
    } finally {
        const actual = fs.realpathSync(root);
        assert.equal(path.dirname(actual), tempRoot);
        assert.ok(path.basename(actual).startsWith('clock-setup-proof-'));
        assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
        fs.rmSync(actual, { recursive: true, force: true });
    }
});

test('a count mismatch highlights only hash-bound source calls for the failed member without prescribing a runtime count', () => {
    const text = "def target(cursor):\n    cursor.execute('first')\n    cursor.execute('second')\n    cursor.other('unrelated')\n";
    const context = { name: 'target', code: text, signature: [{ name: 'cursor' }], source_setup_call_contract: {
        schemaVersion: 'source-setup-call-contract-v1', status: 'complete', authority: 'source-spelling-only',
        sourceHashKind: 'normalized-target-source', targetSourceHash: evidenceHash(text), target: 'target',
        assertionOracle: false, patchAuthorization: false, calls: [], optionalLookups: [], sourceLocations: [],
        literalCallArguments: [
            { callee: 'cursor.execute', source: "'first'", line: 2, position: 1 },
            { callee: 'cursor.execute', source: "'second'", line: 3, position: 1 },
            { callee: 'cursor.other', source: "'unrelated'", line: 4, position: 1 }
        ]
    } };
    const failure = "AssertionError: Expected 'execute' to be called once. Called 2 times.\n";
    const hint = sourceLiteralRepairGuidance(failure, 'sample', context);
    assert.match(hint, /SOURCE_CALL_COUNT_REPAIR_V1/);
    assert.match(hint, /'first'/); assert.match(hint, /'second'/); assert.doesNotMatch(hint, /unrelated/);
    assert.match(hint, /static call sites do not determine runtime count/);
    assert.match(hint, /Exact call_args_list equality/);
    assert.match(hint, /no target return-value oracle/);
    assert.equal(sourceLiteralRepairGuidance(failure.replace('2 times', '0 times'), 'sample', context), '');
    assert.equal(sourceLiteralRepairGuidance(failure.replace("'execute'", "'absent'"), 'sample', context), '');
    const multiline = "'''first\nsecond line'''";
    context.code = text.replace("'first'", multiline);
    context.source_setup_call_contract.targetSourceHash = evidenceHash(context.code);
    context.source_setup_call_contract.literalCallArguments[0].source = multiline;
    assert.ok(sourceLiteralRepairGuidance(failure, 'sample', context).includes(multiline), 'repeat complete literals rather than splitting their lines');
    context.source_setup_call_contract.targetSourceHash = '0'.repeat(64);
    assert.equal(sourceLiteralRepairGuidance(failure, 'sample', context), '');
});
