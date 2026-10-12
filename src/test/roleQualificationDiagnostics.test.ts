import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessBugFixerQualification, assessReviewerQualification, runRoleQualificationProbes } from '../llm/roleQualification';
import { responseSchemaForOutputFormat } from '../llm/customApi';
import { parseTestReviewDetailed } from '../roles/testReviewer';
import { ROLE_QUALIFICATION_TEST_FILE } from '../llm/roleQualification';

test('Reviewer qualification uses the formal review-v7 schema transport and retains compatible legacy reader', async () => {
    const formats: string[] = [];
    const result = await runRoleQualificationProbes({ state: 'verified', reason: 'fixed-public-probe' },
        async (_prompt, format) => { formats.push(format); return format === 'review-json' ? '{"findings":[]}' : ''; });
    assert.deepEqual(formats, ['review-json', 'text']);
    assert.deepEqual(responseSchemaForOutputFormat(formats[0] as 'review-json')?.required, ['findings']);
    assert.equal(result.reviewer.state, 'verified');
    assert.equal(result.reviewer.diagnostics?.contractVersion, 'review-v7');
    const legacy = '{"blocking":[],"quality":[]}';
    assert.equal(assessReviewerQualification(legacy).state, 'unverified', 'a legacy envelope cannot certify the current role');
    assert.ok(parseTestReviewDetailed(legacy, ROLE_QUALIFICATION_TEST_FILE).review,
        'the existing non-qualification compatibility reader stays available');
});

test('safe Reviewer diagnostics explain parser rejection without leaking arbitrary reply strings or keys', () => {
    const secretMarker = 'private-provider-response-secret-marker';
    const responses = ['not-json-' + secretMarker,
        JSON.stringify({ findings: [{ category: 'invented-' + secretMarker, test_line: 'L5', reason: secretMarker, action: secretMarker }] }),
        JSON.stringify({ findings: [{ category: 'setup-error', test_line: 'L999', reason: secretMarker, action: secretMarker }] })];
    for (const [index, response] of responses.entries()) {
        const result = assessReviewerQualification(response);
        assert.equal(result.state, 'unverified');
        assert.equal(result.diagnostics?.failureKind, 'contract');
        assert.ok(result.diagnostics!.reasonCodes.length > 0);
        assert.equal(result.diagnostics?.responseShape.characters, response.length);
        assert.equal(result.diagnostics?.responseShape.findingsCount, index === 0 ? undefined : 1);
        assert.equal(JSON.stringify(result).includes(secretMarker), false);
    }
    assert.equal(assessReviewerQualification(responses[0]).diagnostics?.reasonCode, 'invalid-json');
    assert.equal(assessReviewerQualification(responses[1]).diagnostics?.reasonCode, 'invalid-category');
    assert.equal(assessReviewerQualification(responses[2]).diagnostics?.reasonCode, 'invalid-test-line');
});

test('Bug Fixer failure metadata distinguishes replacement contract from unavailable execution', () => {
    const invalid = assessBugFixerQualification('private-provider-reply');
    assert.equal(invalid.diagnostics?.reasonCode, 'bug-fixer-replacement-contract');
    assert.equal(invalid.diagnostics?.failureKind, 'contract');
    assert.equal(JSON.stringify(invalid).includes('private-provider-reply'), false);
    const executable = assessBugFixerQualification('```python\ndef test_increment(self):\n    self.assertEqual(increment(1), 2)\n```');
    assert.equal(executable.diagnostics?.failureKind, 'unavailable');
    assert.equal(executable.diagnostics?.executionState, 'unavailable');
});

test('connection role probe exceptions are unavailable instead of invalid reply diagnoses', async () => {
    const result = await runRoleQualificationProbes({ state: 'verified', reason: 'fixture' }, async () => {
        throw new Error('private-transport-message');
    });
    assert.equal(result.reviewer.state, 'not-run');
    assert.equal(result.reviewer.diagnostics?.failureKind, 'unavailable');
    assert.equal(result.bugFixer.state, 'not-run');
    assert.equal(JSON.stringify(result).includes('private-transport-message'), false);
});
