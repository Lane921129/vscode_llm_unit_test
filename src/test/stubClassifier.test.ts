import * as assert from 'assert';
import { test } from 'node:test';
import { isStructurallyInertStub } from '../stubClassifier';

test('recognizes inert Python stub bodies and the explicit dummy name marker', () => {
    assert.strictEqual(isStructurallyInertStub('def anything():\n    pass'), true);
    assert.strictEqual(isStructurallyInertStub('def anything():\n    \"\"\"pending\"\"\"\n    return None'), true);
    assert.strictEqual(isStructurallyInertStub("async def anything():\n    return 'ready'"), true);
    assert.strictEqual(isStructurallyInertStub('def dummy_noise_function_001(a=None, b=None):\n    value = 1 * 42\n    return value'), true);
});

test('does not hide short functions with observable calculations or assignments unless marked dummy', () => {
    assert.strictEqual(isStructurallyInertStub('def generated_noise_function_001(a=None, b=None):\n    value = 1 * 42\n    return value'), false);
    assert.strictEqual(isStructurallyInertStub('def add(a, b):\n    return a + b'), false);
    assert.strictEqual(isStructurallyInertStub('def store(items, value):\n    items.append(value)'), false);
});
