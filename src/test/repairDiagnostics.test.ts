import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeBugFixReplacement, mergeBugFixReplacementDetailed } from '../roles/bugFixer';
import { AnalysisJournal } from '../pipeline/analysisJournal';
import { validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { formatRepairRouting, RepairReasonCode, repairHash } from '../pipeline/repairDiagnostics';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const original = 'import unittest\nimport datetime\nclass Cases(unittest.TestCase):\n    def test_one(self):\n        self.assertEqual(1, 2)\n';
const failure = 'FAIL: test_one (Cases.test_one)\nAssertionError: 1 != 2';
const method = 'def test_one(self):\n    self.assertEqual(1, 1)';
const fence = (text: string) => '```python\n' + text + '\n```';

test('repair parser assigns concrete format reasons while retaining strict Python and legacy JSON acceptance', () => {
    const cases: Array<[string, RepairReasonCode]> = [
        ['', 'empty-response'], [method, 'missing-code-fence'],
        ['Explanation\n' + fence(method), 'extra-text'],
        [fence(method) + '\nExplanation', 'extra-text'],
        [fence(method) + '\n' + fence(method), 'multiple-code-blocks'],
        [fence('class Cases:\n    ' + method.replace('\n', '\n    ')), 'class-wrapper'],
        [fence('pass'), 'missing-test-method'],
        [fence(method.replace('test_one', 'test_other')), 'method-name-mismatch'],
        [fence(method + '\n' + method.replace('test_one', 'test_other')), 'multiple-test-methods'],
        [fence('import a\nimport b\nimport c\nimport d\n' + method), 'import-limit'],
        [fence('# extra setup\n' + method), 'invalid-import'],
        [fence(method + '\nunittest.main()'), 'forbidden-entrypoint'],
        ['{"method":"test_one"}', 'invalid-json-replacement']
    ];
    for (const [raw, reason] of cases) {
        const result = mergeBugFixReplacementDetailed(raw, original, failure);
        assert.equal(result.code, undefined, reason);
        assert.deepEqual(result.diagnostic?.reasonCodes, [reason]);
        assert.equal(result.diagnostic?.previousTestHash, repairHash(original));
        assert.equal(mergeBugFixReplacement(raw, original, failure), undefined);
    }
    for (const raw of [fence(method), JSON.stringify({ method: 'test_one', replacement: method, imports: [] })]) {
        const result = mergeBugFixReplacementDetailed(raw, original, failure);
        assert.equal(result.diagnostic, undefined);
        assert.equal(result.code, original.trimEnd().replace('1, 2', '1, 1'));
    }
    assert.deepEqual(mergeBugFixReplacementDetailed(fence(method), original, 'ImportError: unavailable').diagnostic?.reasonCodes,
        ['unidentified-failure']);
});

test('journal saves each refusal and a safe report immediately, preserving first/last diagnostics and baseline state', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-diagnostic-'));
    try {
        const marker = 'PRIVATE_PROVIDER_CONTENT_MUST_NOT_BE_LOGGED';
        const diagnostic = mergeBugFixReplacementDetailed(marker + '\n' + fence(method), original, failure).diagnostic!;
        const journal = new AnalysisJournal(directory, 'neutral source', 'target', 'fixture-model');
        const first = journal.record(1, 'bug-fixer', 'format-rejected', { attempt: 1, diagnostic, elapsedMs: 123,
            contractVersion: 'bug-fix-v4', category: 'model-format' });
        assert.match(first, /extra-text/);
        assert.match(first, /尚未建立/);
        journal.knowledge({ executableBaseline: { codeHash: 'baseline-hash' } });
        const second = journal.record(2, 'bug-fixer', 'format-rejected', { attempt: 2, diagnostic,
            contractVersion: 'bug-fix-v4', category: 'model-format' });
        journal.record(2, 'pipeline', 'failed', { reason: 'Later terminal failure' });
        assert.match(second, /已另存，繼續保留/);
        const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
        const lines = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(lines[0].detail.diagnostic.responseShape.hasOutsideText, true);
        assert.equal(lines[0].detail.executableBaselineAvailable, false);
        assert.equal(lines[1].detail.executableBaselineAvailable, true);
        assert.equal(knowledge.firstRepairFailure.sequence, 1);
        assert.equal(knowledge.lastRepairFailure.sequence, 2);
        assert.equal(knowledge.lastFailure.sequence, 3);
        assert.deepEqual(knowledge.repairFailureCounts, { 'extra-text': 2 });
        for (const file of fs.readdirSync(directory)) {
            assert.ok(!fs.readFileSync(path.join(directory, file), 'utf8').includes(marker));
        }
        assert.ok(!(first + second).includes(marker));
        assert.match(formatRepairRouting({ action: 'tier-fallback', fromTier: 2, toTier: 1 }), /Tier 2 → 1/);
        assert.equal(formatRepairRouting({ action: marker }), '');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('real Python repair-scope checks distinguish unchanged methods, conflicting imports and unrelated edits', () => {
    const root = path.resolve(__dirname, '../..');
    const python = resolvePythonExecutable(undefined, root);
    const check = (candidate: string) => {
        const run = spawnSync(python, ['-B', path.join(root, 'python_scripts/validate_repair_scope.py')], {
            input: JSON.stringify({ previous: original, candidate, failure }), encoding: 'utf8'
        });
        assert.equal(run.status, 0, run.stderr);
        return JSON.parse(run.stdout);
    };
    assert.equal(check(original + '\n').reasonCode, 'no-method-change');
    assert.equal(check('from datetime import datetime\n' + original.replace('1, 2', '1, 1')).reasonCode, 'import-conflict');
    assert.equal(check('import a\nimport b\nimport c\nimport d\n' + original).reasonCode, 'import-limit');
    assert.equal(check(original.replace('def test_one(self)', 'def test_one(self, extra)')).reasonCode, 'outside-method-change');
    assert.equal(check(original.replace('class Cases', 'class Other')).reasonCode, 'removed-callable');
    assert.equal(check('not valid Python').reasonCode, 'candidate-syntax');
    assert.deepEqual(check(original.replace('1, 2', '1, 1')), { valid: true, reason: '', reasonCode: null });
});

test('scope refusal is journaled before stopping and does not execute the rejected candidate', async () => {
    const events: Array<{ stage: string; status: string; detail: any }> = [];
    let executions = 0;
    await assert.rejects(validateTestCandidate(original, {
        validate: async () => undefined, review: async () => ({ issues: [] }),
        revise: async (_code, _failure, _role, attempt) => { assert.equal(attempt, 1); return original.replace('1, 2', '1, 1'); },
        validateRevision: async () => ({ reason: 'Conflicting import', reasonCode: 'import-conflict' }),
        execute: async () => { executions++; return { ok: false, out: failure, qualityGaps: [] }; },
        event: (stage, status, detail) => events.push({ stage, status, detail }), checkCancelled: () => {}
    }, 1), /修訂上限/);
    assert.equal(executions, 1);
    const rejected = events.find(event => event.status === 'scope-rejected')!;
    assert.equal(rejected.stage, 'bug-fixer');
    assert.deepEqual(rejected.detail.diagnostic.reasonCodes, ['import-conflict']);
    assert.equal(rejected.detail.diagnostic.previousTestUnchanged, true);
    assert.ok(rejected.detail.elapsedMs >= 0);
    assert.equal(events.at(-1)?.detail.action, 'stop-revisions');
});
