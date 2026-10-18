import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { runExecutionVerification } from '../pipeline/executionVerification';
import { verifyExecutionEvidence } from '../pipeline/executionEvidence';
import { pythonToolPath } from '../pipeline/pythonTools';
import { buildReviewFacts, buildReviewerEvidenceDiagnostic, reviewFactsForPrompt } from '../roles/reviewFacts';
import { reviewConstraintDiagnostics, TestReview } from '../roles/testReviewer';
import { buildGeneratedTestEnvironment, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

test('guarded controlled-patch execution supplies a target binding while observations and independent findings remain unknown', async () => {
    const tempRoot = fs.realpathSync.native(os.tmpdir());
    const root = fs.mkdtempSync(path.join(tempRoot, 'review-patch-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const file = path.join(root, 'sample.py'), directory = path.join(root, 'o');
    const source = 'def channel(value):\n    return value + 1\ndef score(value):\n    return channel(value)\n';
    const code = 'import unittest\nfrom unittest.mock import patch\nfrom sample import score\n'
        + 'class Cases(unittest.TestCase):\n    def test_value(self):\n'
        + '        with patch("sample.channel") as channel:\n'
        + '            channel.return_value = 9\n            result = score(1)\n'
        + '            self.assertEqual(result, 9)\n            channel.assert_called_once_with(1)\n';
    const env = buildGeneratedTestEnvironment(process.env, [root]);
    try {
        fs.writeFileSync(file, source);
        const journal = new AnalysisJournal(directory, source, 'score', 'neutral-scripted-patch-return-facts');
        const baseline = await runExecutionVerification({ directory, file, target: 'score', python, env,
            dependencies: [], journal, generate: async () => code,
            hooks: {
                event: () => {}, repairRole: () => 'writer',
                revise: async () => assert.fail('this neutral fixture must not need a role revision'),
                validate: async candidate => {
                    const structure = validateUnittestStructure(candidate, 'score', 'sample');
                    if (!structure.valid) { return structure.reason; }
                    const run = spawnSync(python, ['-B', pythonToolPath('bindings'), '--payload'], {
                        input: JSON.stringify({ code: candidate, context: { module: 'sample', target: 'score',
                            source: 'def score(value):\n    return channel(value)', moduleSource: source, requireTargetBehavior: true } }),
                        encoding: 'utf8', timeout: 10000, env
                    });
                    assert.equal(run.status, 0, run.stderr);
                    const binding = JSON.parse(run.stdout);
                    return binding.valid ? undefined : binding.reason;
                }
            }
        });
        const executionVerified = verifyExecutionEvidence(directory, file, baseline,
            { runId: journal.runId, sourceHash: evidenceHash(source), target: 'score' });
        assert.equal(executionVerified, true);
        const saved = fs.readFileSync(path.join(directory, baseline.testFile), 'utf8');
        assert.equal(saved, code);
        const facts = await buildReviewFacts({ code: saved, target: 'score', module: 'sample', python, env,
            executionVerified, runId: baseline.runId, sourceHash: baseline.sourceHash });
        assert.equal(facts.testHash, baseline.testHash);
        const diagnostic = buildReviewerEvidenceDiagnostic(facts);
        assert.equal(diagnostic.targetAssertionCount, 1);
        assert.equal(diagnostic.observationVerifiedCount, 0);
        assert.equal(diagnostic.observationContradictedCount, 0);
        assert.equal(diagnostic.observationUnknownCount, 1);
        assert.equal(diagnostic.returnedCallCount, 0);
        assert.equal(facts.methods[0].assertions[0].targetCallLine, facts.methods[0].calls[0].line);
        const prompt = JSON.parse(reviewFactsForPrompt(facts).split('\n').slice(1).join('\n'));
        assert.equal(prompt.methods[0].assertions[0].observationStatus, 'unknown');
        const review: TestReview = { issues: [{ id: 'B1', severity: 'blocking', category: 'assertion-evidence',
            testLine: diagnostic.assertions[0].line, evidence: 'self.assertEqual(result, 9)',
            reason: 'The supplied specification requires score(1) to return 4, independently of this controlled channel fixture.',
            action: 'Add a separate test for score(1) with the specified expected result.' }] };
        assert.deepEqual(reviewConstraintDiagnostics(review, { module: 'sample', target: 'score', methodKind: 'module', facts }), []);
        assert.equal(review.issues.length, 1);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
        const resolved = fs.realpathSync.native(root);
        assert.equal(path.dirname(resolved), tempRoot);
        fs.rmSync(resolved, { recursive: true, force: true });
    }
});
