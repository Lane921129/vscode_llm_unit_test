import * as assert from 'assert';
import { test } from 'node:test';
import { detectMutationEngineForPlatform } from '../utils';

test('uses mutatest for Python 3.11 and earlier', () => {
    assert.strictEqual(detectMutationEngineForPlatform('3.11.9', 'win32'), 'mutatest');
    assert.strictEqual(detectMutationEngineForPlatform('3.10.14', 'linux'), 'mutatest');
});

test('uses mutmut for Python 3.12+ on non-Windows platforms', () => {
    assert.strictEqual(detectMutationEngineForPlatform('3.13.2', 'linux'), 'mutmut');
});

test('reports no native engine for Python 3.12+ on Windows', () => {
    assert.strictEqual(detectMutationEngineForPlatform('3.13.2', 'win32'), null);
});
