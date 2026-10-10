import { LOCAL_RUNTIME_QUALIFICATION_VERSION, QUALIFICATION_VERSION, qualificationAppliesToRequest, isLocalRuntimeQualification } from '../llm/modelQualification';
import * as assert from 'assert';
import { test } from 'node:test';
import { formatModelQualificationLog, qualificationForRequest } from '../llm/modelQualification';
import { assessBugFixerQualification, assessReviewerQualification, BUG_FIXER_QUALIFICATION_PROMPT, REVIEWER_QUALIFICATION_PROMPT, ROLE_QUALIFICATION_FAILURE, ROLE_QUALIFICATION_TEST_FILE, runRoleQualificationProbes } from '../llm/roleQualification';

test('uses a generation qualification only for the exact probed model', () => {
    const profile = {
        envType: 'local' as const,
        modelName: 'reliable-instruct',
        qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 8192 } as const,
        qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true
    };

    assert.strictEqual(
        qualificationForRequest(profile, { envType: 'local', modelName: 'reliable-instruct', runtimeContextTokens: 8192 }),
        true
    );
    assert.strictEqual(
        qualificationForRequest(profile, { envType: 'local', modelName: 'different-model', runtimeContextTokens: 8192 }),
        false
    );
    assert.strictEqual(
        qualificationForRequest(profile, { envType: 'cloud', modelName: 'reliable-instruct' }),
        false
    );
});

test('local qualification matches the effective context independently of Writer outcome', () => {
    const profile = {
        envType: 'local' as const, modelName: 'neutral-model', qualificationVersion: QUALIFICATION_VERSION,
        qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 8192 } as const, testGenerationReady: false
    };
    const request = { envType: 'local' as const, modelName: 'neutral-model', runtimeContextTokens: 8192 };
    assert.strictEqual(qualificationAppliesToRequest(profile, request), true, 'identity does not certify Writer');
    assert.strictEqual(qualificationForRequest(profile, request), false, 'a failed Writer stays unqualified');
    for (const runtimeContextTokens of [undefined, 0, 5000, NaN, Infinity, 8192.5]) {
        assert.strictEqual(qualificationAppliesToRequest(profile, { ...request, runtimeContextTokens }), false);
        assert.strictEqual(qualificationForRequest({ ...profile, testGenerationReady: true }, { ...request, runtimeContextTokens }), false);
    }
    assert.strictEqual(qualificationForRequest({ ...profile, testGenerationReady: true }, request), true);
});

test('legacy and malformed local runtime bindings never certify a current request', () => {
    const request = { envType: 'local' as const, modelName: 'neutral-model', runtimeContextTokens: 8192 };
    const base = { envType: 'local' as const, modelName: 'neutral-model', qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true };
    for (const qualificationRuntime of [undefined, null, {}, [], '8192',
        { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: '8192' },
        { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 0 },
        { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: Infinity },
        { version: 'old', numCtx: 8192 }]) {
        assert.strictEqual(isLocalRuntimeQualification(qualificationRuntime), false);
        assert.strictEqual(qualificationForRequest({ ...base, qualificationRuntime } as any, request), false);
    }
    assert.strictEqual(qualificationForRequest({ qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true }, request), false);
});

test('local runtime settings do not expire Cloud or Custom qualification', () => {
    for (const envType of ['cloud', 'custom'] as const) {
        const profile = { envType, modelName: 'neutral-model', qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true };
        assert.strictEqual(qualificationForRequest(profile, { ...profile, runtimeContextTokens: 8192 }), true);
        assert.strictEqual(qualificationForRequest(profile, { ...profile, runtimeContextTokens: 0 }), true);
        assert.strictEqual(qualificationForRequest({ ...profile, testGenerationReady: false }, profile), false);
    }
});

test('keeps unprobed profiles neutral until a probe result exists', () => {
    assert.strictEqual(
        qualificationForRequest(
            { envType: 'local', modelName: 'pending-model' },
            { envType: 'local', modelName: 'pending-model' }
        ),
        undefined
    );
});

test('formats a non-secret system log for a successful connection that fails qualification', () => {
    const message = formatModelQualificationLog({
        envType: 'cloud',
        modelName: 'gemma-4-31b-it',
        qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: false,
        testGenerationMode: '純 Python unittest',
        testGenerationReason: '模型沒有產生有效的 unittest 結構。'
    });

    assert.strictEqual(
        message,
        '[模型資格] Cloud Gemini／gemma-4-31b-it：連線成功，但未通過 純 Python unittest（模型沒有產生有效的 unittest 結構。）。Auto 將保守使用 Tier 1。'
    );
});

test('keeps newlines out of qualification logs', () => {
    const message = formatModelQualificationLog({
        envType: 'local',
        modelName: 'local\nmodel',
        qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true,
        testGenerationMode: '結構化 JSON unittest'
    });

    assert.ok(!message.includes('\n'));
    assert.match(message, /local model/);
});

test('appends the fixed-fixture probe reply only when qualification fails', () => {
    const failed = formatModelQualificationLog({
        envType: 'cloud',
        modelName: 'gemma-4-31b-it',
        qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: false,
        testGenerationReason: '安全 fixture 拒絕。'
    }, '```python\n# probe reply\n```');
    const passed = formatModelQualificationLog({
        envType: 'cloud',
        modelName: 'gemma-4-31b-it',
        qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true
    }, 'this reply must not be logged after success');

    assert.match(failed, /\[模型探測回應\][\s\S]*# probe reply/);
    assert.ok(!passed.includes('this reply must not be logged after success'));
});

test('selectAnalysisResponseFormat handles legacy and normalized python mode identifiers', () => {
    const { selectAnalysisResponseFormat, TEST_GEN_MODE_PYTHON, TEST_GEN_MODE_JSON } = require('../llm/modelQualification');
    assert.strictEqual(selectAnalysisResponseFormat({ testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON }), 'text');
    assert.strictEqual(selectAnalysisResponseFormat({ testGenerationReady: true, testGenerationMode: 'plain-python' }), 'text');
    assert.strictEqual(selectAnalysisResponseFormat({ testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_JSON }), 'json');
    assert.strictEqual(selectAnalysisResponseFormat({ testGenerationReady: false, testGenerationMode: TEST_GEN_MODE_PYTHON }), 'json');
});

test('qualifies Reviewer JSON and Bug Fixer method replacement independently', () => {
    assert.strictEqual(assessReviewerQualification('{"findings":[]}').state, 'verified');
    assert.strictEqual(assessBugFixerQualification(JSON.stringify({
        method: 'test_increment',
        replacement: 'def test_increment(self):\n    self.assertEqual(increment(1), 2)',
        imports: []
    })).state, 'unverified', 'format alone cannot certify execution');
    assert.match(REVIEWER_QUALIFICATION_PROMPT, /reason/);
    assert.match(BUG_FIXER_QUALIFICATION_PROMPT, /test_increment/);
    assert.match(ROLE_QUALIFICATION_TEST_FILE, /increment\(1\)/);
    assert.match(ROLE_QUALIFICATION_FAILURE, /FAIL/);
    assert.strictEqual(assessReviewerQualification('{"blocking":[{"test_excerpt":"x","action":"focused correction"}],"quality":[]}').state, 'unverified');
});

test('role qualification runs Reviewer and Bug Fixer probes independently', async () => {
    const prompts: string[] = [];
    const formats: string[] = [];
    const profile = await runRoleQualificationProbes(
        { state: 'verified', reason: 'writer passed' },
        async (prompt, format) => {
            prompts.push(prompt);
            formats.push(format);
            return prompt.includes('ONE findings array')
                ? '{"findings":[]}'
                : JSON.stringify({ method: 'test_increment', replacement: 'def test_increment(self):\n    self.assertEqual(increment(1), 2)', imports: [] });
        }, async code => {
            assert.match(code, /increment\(1\), 2/);
            assert.match(code, /increment\(-1\), 0/);
            return true;
        }
    );
    assert.deepStrictEqual(formats, ['json', 'text']);
    assert.deepStrictEqual(prompts.map(prompt => prompt.includes('ONE findings array')), [true, false]);
    assert.deepStrictEqual(
        [profile.writer.state, profile.reviewer.state, profile.bugFixer.state],
        ['verified', 'verified', 'verified']
    );
});
