import * as assert from 'assert';
import { test } from 'node:test';
import { resolveTierTwoSubtaskGate } from '../tier/subtaskResponseGate';

test('accepts a Tier 2 subtask only when structure and Trace evidence both pass', () => {
    assert.deepStrictEqual(
        resolveTierTwoSubtaskGate({ valid: true }, { valid: true }),
        { accepted: true }
    );
    assert.deepStrictEqual(
        resolveTierTwoSubtaskGate({ valid: false, reason: '缺少 unittest import' }, { valid: true }),
        { accepted: false, reason: '缺少 unittest import' }
    );
    assert.deepStrictEqual(
        resolveTierTwoSubtaskGate({ valid: true }, { valid: false, reason: 'Trace assertion 相反' }),
        { accepted: false, reason: 'Trace assertion 相反' }
    );
});
