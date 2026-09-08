import * as assert from 'assert';
import { test } from 'node:test';
import { formatModelQualificationLog, qualificationForRequest } from '../llm/modelQualification';

test('uses a generation qualification only for the exact probed model', () => {
    const profile = {
        envType: 'local' as const,
        modelName: 'reliable-instruct',
        testGenerationReady: true
    };

    assert.strictEqual(
        qualificationForRequest(profile, { envType: 'local', modelName: 'reliable-instruct' }),
        true
    );
    assert.strictEqual(
        qualificationForRequest(profile, { envType: 'local', modelName: 'different-model' }),
        false
    );
    assert.strictEqual(
        qualificationForRequest(profile, { envType: 'cloud', modelName: 'reliable-instruct' }),
        false
    );
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
        testGenerationReady: false,
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
        testGenerationReady: true,
        testGenerationMode: '結構化 JSON unittest'
    });

    assert.ok(!message.includes('\n'));
    assert.match(message, /local model/);
});
