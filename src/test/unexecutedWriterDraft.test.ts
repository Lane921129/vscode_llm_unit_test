import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CandidatePipelineHooks, validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { runExecutionVerification } from '../pipeline/executionVerification';
import { verifyExecutionEvidence } from '../pipeline/executionEvidence';
import { pythonToolPath } from '../pipeline/pythonTools';
import { runSpawn } from '../utils/processRunner';
import { buildGeneratedTestEnvironment, resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const passed = 'test_value (Cases.test_value) ... ok\nRan 1 test\nOK';
const failure = 'FAIL: test_value (Cases.test_value)\nAssertionError: expected\nRan 1 test\nFAILED (failures=1)';

for (const policy of ['execution-opt-in', 'legacy', 'review-required', 'baseline'] as const) {
    test(`initial structure draft continuity preserves policy boundaries: ${policy}`, async () => {
        const revisions: string[] = [], executed: string[] = [], events: any[] = [];
        const keepDraft = policy === 'execution-opt-in';
        const hooks: CandidatePipelineHooks = {
            reviewRequired: policy === 'review-required',
            continueUnexecutedWriterDraft: policy !== 'legacy',
            validate: async code => code === 'complete' ? undefined : code === 'import-fixed' ? 'clock setup invalid' : 'patch undefined',
            revise: async (code, _feedback, role, attempt) => {
                revisions.push(code); assert.equal(role, 'writer');
                return attempt === 1 ? 'import-fixed' : 'complete';
            },
            execute: async code => { executed.push(code); return { ok: true, out: passed, qualityGaps: [] }; },
            review: async () => ({ issues: [] }), event: (stage, status, detail) => events.push({ stage, status, detail }),
            checkCancelled: () => {}
        };
        const baseline = policy === 'baseline' ? { code: 'baseline', output: '' } : undefined;
        const result = await validateTestCandidate('initial', hooks, 2, baseline);
        assert.equal(result.code, 'complete');
        assert.deepEqual(revisions, [baseline?.code || 'initial', keepDraft ? 'import-fixed' : baseline?.code || 'initial']);
        assert.deepEqual(executed, ['complete'], 'no invalid draft reaches native execution');
        const continued = events.filter(event => event.stage === 'writer-draft');
        assert.equal(continued.length, keepDraft ? 1 : 0);
        if (keepDraft) {
            assert.equal(continued[0].detail.codeHash, evidenceHash('import-fixed'));
            assert.equal(continued[0].detail.executable, false);
            assert.equal(continued[0].detail.approved, false);
        }
    });
}

test('after a native attempt a structurally invalid repair still restores the retained candidate', async () => {
    const revisions: string[] = [], executed: string[] = [];
    await validateTestCandidate('native-failed', {
        reviewRequired: false, continueUnexecutedWriterDraft: true,
        validate: async code => code === 'broken-repair' ? 'broken import' : undefined,
        revise: async (code, _feedback, _role, attempt) => { revisions.push(code); return attempt === 1 ? 'broken-repair' : 'complete'; },
        repairRole: () => 'writer', review: async () => undefined,
        execute: async code => { executed.push(code); return { ok: code === 'complete', out: code === 'complete' ? passed : failure, qualityGaps: [] }; },
        event: stage => assert.notEqual(stage, 'writer-draft'), checkCancelled: () => {}
    }, 2);
    assert.deepEqual(revisions, ['native-failed', 'native-failed']);
    assert.deepEqual(executed, ['native-failed', 'complete']);
});

test('scope-rejected drafts never enter the unexecuted Writer continuation', async () => {
    const revisions: string[] = [];
    await validateTestCandidate('initial', {
        reviewRequired: false, continueUnexecutedWriterDraft: true,
        validate: async code => code === 'complete' ? undefined : 'initial binding failure',
        revise: async (code, _failure, _role, attempt) => { revisions.push(code); return attempt === 1 ? 'scope-violation' : 'complete'; },
        validateRevision: async (_previous, candidate) => candidate === 'scope-violation' ? 'changed protected content' : undefined,
        repairRole: () => 'writer', review: async () => undefined,
        execute: async () => ({ ok: true, out: passed, qualityGaps: [] }),
        event: stage => assert.notEqual(stage, 'writer-draft'), checkCancelled: () => {}
    }, 2);
    assert.deepEqual(revisions, ['initial', 'initial']);
});

test('execution path keeps an import repair for the next clock repair and obtains fresh native proof', async () => {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(tempRoot, 'writer-draft-continuity-'));
    const source = 'from datetime import datetime\ndef target():\n    return datetime.now()\n';
    const file = path.join(root, 'sample.py'), directory = path.join(root, 'result');
    fs.writeFileSync(file, source);
    const initial = 'import unittest\nimport sample\nclass Cases(unittest.TestCase):\n    def test_value(self):\n'
        + '        with patch("sample.datetime.now") as clock:\n'
        + '            controlled = object()\n            clock.return_value = controlled\n'
        + '            self.assertIs(sample.target(), controlled)\n            clock.assert_called_once_with()\n';
    const importFixed = initial.replace('        with patch(', '        from unittest.mock import patch\n        with patch(');
    const complete = importFixed.replace('sample.datetime.now', 'sample.datetime').replace('clock.return_value', 'clock.now.return_value')
        .replace('clock.assert_called_once_with()', 'clock.now.assert_called_once_with()');
    const journal = new AnalysisJournal(directory, source, 'target', 'scripted-draft-continuity', undefined, 'execution');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const env = buildGeneratedTestEnvironment(process.env, [root]);
    const revisions: string[] = [], rejected: string[] = [];
    try {
        const baseline = await runExecutionVerification({ directory, file, target: 'target', targetModule: 'sample', python, env,
            dependencies: [], journal, generate: async () => initial,
            hooks: {
                validate: async code => {
                    const run = await runSpawn(python, ['-B', pythonToolPath('bindings'), '--payload'], {
                        input: JSON.stringify({ code, context: { module: 'sample', target: 'target', source,
                            moduleSource: source, requireMockBehavior: true, requireTargetBehavior: true } }), env, timeout: 5000
                    });
                    assert.equal(run.code, 0, run.stderr);
                    const value = JSON.parse(run.stdout);
                    if (!value.valid) { rejected.push(value.reason); return value.reason; }
                    return undefined;
                },
                revise: async (code, _feedback, role, attempt) => {
                    revisions.push(code); assert.equal(role, 'writer');
                    return attempt === 1 ? importFixed : complete;
                },
                event: (stage, status, detail) => { journal.record(1, stage, status, detail); }
            }
        });
        assert.match(rejected[0], /patch is undefined/);
        assert.match(rejected[1], /immutable datetime\/date/);
        assert.deepEqual(revisions, [initial, importFixed]);
        assert.equal(baseline.testHash, evidenceHash(complete));
        assert.equal(verifyExecutionEvidence(directory, file, baseline,
            { runId: journal.runId, sourceHash: journal.sourceHash, target: 'target' }), true);
        assert.equal(fs.readdirSync(directory).filter(name => /^exec\d+_test\.py$/.test(name)).length, 1);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
        const actual = fs.realpathSync(root);
        assert.equal(path.dirname(actual), tempRoot);
        assert.ok(path.basename(actual).startsWith('writer-draft-continuity-'));
        assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
        fs.rmSync(actual, { recursive: true, force: true });
    }
});
