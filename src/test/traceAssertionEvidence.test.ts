import * as assert from 'assert';
import { test } from 'node:test';
import { findDirectTraceAssertionContradiction } from '../validation/traceAssertionEvidence';

const trace = {
    examples: [
        { args: ["'value'", '2'], result: "{'ok': True}", call_assertable: true, result_assertable: true },
    ]
};

test('rejects a direct LLM assertion that contradicts the same verified Trace call', () => {
    const code = "self.assertEqual(target(\"value\", 2), {'ok': False})";
    const contradiction = findDirectTraceAssertionContradiction(code, 'target', trace);

    assert.match(contradiction || '', /回傳 \{'ok': True\}/);
});

test('accepts the exact Trace assertion and leaves untraced inputs available for normal validation', () => {
    assert.strictEqual(
        findDirectTraceAssertionContradiction("self.assertEqual(target('value', 2), {'ok': True})", 'target', trace),
        undefined
    );
    assert.strictEqual(
        findDirectTraceAssertionContradiction("self.assertEqual(target('other', 2), {'ok': False})", 'target', trace),
        undefined
    );
});

test('supports a target module alias and ignores non-assertion setup calls', () => {
    assert.match(
        findDirectTraceAssertionContradiction("self.assertEqual(module.target('value', 2), {'ok': False})", 'target', trace) || '',
        /模型對相同呼叫斷言/
    );
    assert.strictEqual(findDirectTraceAssertionContradiction("result = target('value', 2)", 'target', trace), undefined);
});
