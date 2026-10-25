import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { digestReferenceHypotheses } from '../pipeline/digestReference';

const descriptor = () => ({ basis: 'hashlib-reference-v1', changed: false, referenceOperations: [{
    version: 'hashlib-reference-v1', algorithm: 'sha256', encoding: 'utf-8', inputBytesHex: '31323334',
    method: 'Cases.test_seed', line: 7, previous: 'wrong-algorithm-result'
}] });
const expected = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4';

test('builtin reference computes SHA-256 while keeping raw input out of the proof and leaving AI revision required', () => {
    const value = digestReferenceHypotheses(descriptor())!;
    assert.equal(value.corrections[0].calculated, expected);
    assert.equal((value.corrections[0].basis as any).assertionOracle, false);
    assert.equal('code' in value, false);
    assert.doesNotMatch(JSON.stringify(value), /inputBytesHex|31323334/);
    assert.match(value.limitation, /AI revision and isolated execution are required/);
});

test('an already matching reference does not trigger a correction', () => {
    const value = descriptor(); value.referenceOperations[0].previous = expected;
    assert.equal(digestReferenceHypotheses(value), undefined);
    assert.equal(digestReferenceHypotheses({ basis: 'source-derived-arithmetic-v1' }), undefined);
});

test('unknown operations, encodings, invalid bytes and unbounded fields are rejected', () => {
    for (const change of [{ algorithm: 'external' }, { encoding: 'custom-codec' }, { inputBytesHex: 'g0' },
        { inputBytesHex: '0' }, { inputBytesHex: '00'.repeat(1025) }, { line: 0 }, { method: 'not-a-test' }]) {
        const value = descriptor(); Object.assign(value.referenceOperations[0], change);
        assert.throws(() => digestReferenceHypotheses(value), /Invalid bounded digest reference descriptor/);
    }
});
