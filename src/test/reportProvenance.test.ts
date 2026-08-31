import * as assert from 'assert';
import { test } from 'node:test';
import { formatReportProvenance } from '../reportProvenance';

test('report provenance identifies the actual extension build and model qualification', () => {
    const text = formatReportProvenance({
        extensionEntry: 'D:/project/dist/extension.js',
        workingDirectory: 'D:/project',
        modelName: 'local-instruct',
        requestedTier: 'tier3',
        resolvedTier: 1,
        qualified: false,
    });
    assert.match(text, /D:\/project\/dist\/extension\.js/);
    assert.match(text, /請求 tier3，實際 Tier 1/);
    assert.match(text, /未通過/);
});
