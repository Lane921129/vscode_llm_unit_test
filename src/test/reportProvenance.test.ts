import * as assert from 'assert';
import { test } from 'node:test';
import { formatReportProvenance } from '../utils/reportProvenance';

test('report provenance identifies a portable extension build without local paths', () => {
    const text = formatReportProvenance({
        extensionId: 'lane.llm-unit-test',
        extensionVersion: '1.2.3',
        buildTimestamp: '2026-09-02T00:00:00.000Z',
        extensionMode: 'production',
        modelName: 'local-instruct',
        requestedTier: 'tier3',
        resolvedTier: 1,
        qualified: false,
        qualificationReason: '模型未驗證已知行為。',
        qualificationMode: '純 Python unittest',
    });
    assert.match(text, /lane\.llm-unit-test@1\.2\.3/);
    assert.match(text, /2026-09-02T00:00:00\.000Z/);
    assert.doesNotMatch(text, /[A-Z]:[\\/]/);
    assert.match(text, /請求 tier3，實際 Tier 1/);
    assert.match(text, /模型 unittest 生成能力（測試連線驗證）\*\*: 未通過/);
    assert.match(text, /驗證方式\*\*: 純 Python unittest/);
    assert.match(text, /驗證說明\*\*: 模型未驗證已知行為。/);
});
