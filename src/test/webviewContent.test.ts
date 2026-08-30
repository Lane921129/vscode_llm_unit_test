import * as assert from 'assert';
import { test } from 'node:test';
import { getWebviewContent } from '../webviewContent';

test('cloud credential editor has separate name, model, and key inputs and clears them after saving', () => {
    const html = getWebviewContent(key => key);

    assert.ok(html.includes('id="new-key-name"'));
    assert.ok(html.includes('id="new-key-model"'));
    assert.ok(html.includes('id="new-key-value"'));
    assert.ok(html.includes("case 'apiKeySaved':"));
    assert.ok(html.includes("document.getElementById('new-key-model').value = '';"));
    assert.ok(!html.includes("new-key-value').value = currentKeys[name]"));
});
