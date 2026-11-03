import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { mayFallbackTier, selectCandidateRepairRole } from '../tier/tierFailurePolicy';
import { CandidateValidationError } from '../pipeline/testCandidatePipeline';
import { AnalysisStageError } from '../utils/executionFailureCategory';

test('only exhausted generated candidates permit a lower generation strategy', () => {
    assert.equal(mayFallbackTier(new CandidateValidationError('candidate did not execute'), 2), true);
    assert.equal(mayFallbackTier(new CandidateValidationError('candidate did not execute'), 1), false);
    assert.equal(mayFallbackTier(new CandidateValidationError('candidate did not execute'), 9), false);
    for (const error of [new Error('candidate did not execute'),
        new AnalysisStageError('validation', 'reviewer', 'candidate did not execute'),
        new AnalysisStageError('environment', 'coverage', 'candidate did not execute'),
        new AnalysisStageError('model-api', 'model-request', 'candidate did not execute'),
        new AnalysisStageError('timeout', 'model-request', 'candidate did not execute')]) {
        assert.equal(mayFallbackTier(error, 2), false);
    }
});

test('a qualified Writer can handle a method failure when Bug Fixer is unavailable', () => {
    assert.equal(selectCandidateRepairRole(false, true), 'writer');
    assert.equal(selectCandidateRepairRole(true, true), 'bug-fixer');
    assert.equal(selectCandidateRepairRole(true, false), 'writer');
});
