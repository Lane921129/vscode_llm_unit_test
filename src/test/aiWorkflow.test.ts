import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { evidenceHash } from '../pipeline/analysisJournal';
import { AI_WORKFLOW_VERSION, requireReviewApproval } from '../pipeline/aiWorkflow';

test('mutation approval cannot cross candidates, runs, source versions or targets', () => {
    const code = 'one executed and reviewed candidate';
    const identity = { runId: 'run', sourceHash: evidenceHash('source'), target: 'Class.method' };
    const approval = { ...identity, workflowVersion: AI_WORKFLOW_VERSION, testHash: evidenceHash(code) } as const;
    assert.doesNotThrow(() => requireReviewApproval(code, approval, identity));
    for (const patch of [{ runId: 'other' }, { sourceHash: evidenceHash('changed') }, { target: 'method' }]) {
        assert.throws(() => requireReviewApproval(code, approval, { ...identity, ...patch }), { stage: 'reviewer' });
    }
    assert.throws(() => requireReviewApproval(code + ' changed', approval, identity), { stage: 'reviewer' });
    assert.throws(() => requireReviewApproval(code, undefined, identity), { stage: 'reviewer' });
});
