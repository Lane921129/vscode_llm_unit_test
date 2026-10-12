import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { mayFallbackTier } from '../tier/tierFailurePolicy';
import { RepairResponseError, RepairReasonCode } from '../pipeline/repairDiagnostics';

test('repair scope and preservation tool failures stop without further model revisions, execution or Tier fallback', async () => {
    for (const reasonCode of ['scope-tool-error', 'scope-result-invalid', 'preservation-tool-error'] as RepairReasonCode[]) {
        let executions = 0, revisions = 0;
        await assert.rejects(validateTestCandidate('original', {
            reviewRequired: false, checkCancelled() {}, event() {}, validate: async () => undefined,
            review: async () => undefined,
            execute: async () => { executions++; return { ok: false, out: 'failed', qualityGaps: [] }; },
            repairRole: () => 'writer',
            revise: async () => { revisions++; return 'changed'; },
            validateRevision: async () => ({ reason: 'tool did not complete', reasonCode })
        }, 5), (error: unknown) => error instanceof AnalysisStageError && error.stage === 'repair-scope'
            && !mayFallbackTier(error, 2));
        assert.equal(executions, 1);
        assert.equal(revisions, 1);
        assert.equal(mayFallbackTier(new RepairResponseError({ version: 'repair-diagnostics-v1', gate: 'repair-scope',
            reasonCodes: [reasonCode], previousTestHash: 'a'.repeat(64), previousTestUnchanged: true }), 2), false);
    }
});
