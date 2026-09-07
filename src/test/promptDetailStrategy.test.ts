import * as assert from 'assert';
import { test } from 'node:test';
import { selectPromptDetail } from '../prompts/promptDetailStrategy';

test('chooses prompt detail from capability metadata without vendor naming', () => {
    assert.strictEqual(selectPromptDetail('31B', 8192, 2), 'large');
    assert.strictEqual(selectPromptDetail('8B', 8192, 2), 'small');
    assert.strictEqual(selectPromptDetail('Cloud', 128000, 2), 'large');
    assert.strictEqual(selectPromptDetail('unknown', 4096, 4), 'large');
});
