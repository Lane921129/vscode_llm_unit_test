import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { validatePassingTestPreservation } from '../pipeline/passingTestPreservation';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { passingTestIds } from '../validation/repairFeedback';
import { REPAIR_REASON_LABELS, repairReasonCode } from '../pipeline/repairDiagnostics';
import { localize, setLanguage } from '../i18n/core';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const previous = `import unittest
from sample import measure
class Cases(unittest.TestCase):
    def test_passed(self):
        value, label = measure(100, 180)
        self.assertAlmostEqual(value, 30.86, places=2)
        self.assertEqual(label, 'large')
    def test_failed(self):
        self.assertEqual(measure(0, 0), 0)
`;

test('Python AST preservation rejects weaker string assertions and dropped cross-Tier scenarios', async () => {
    const weakened = await validatePassingTestPreservation({ previousCode: previous,
        candidateCode: previous.replace("assertEqual(label, 'large')", "assertGreaterEqual(label, 'large')"),
        protectedMethods: 'all', python });
    assert.equal(weakened.valid, false);
    assert.equal(weakened.reasonCode, 'assertion-weakened');
    assert.match(weakened.reason, /Cases.test_passed/);
    const dropped = await validatePassingTestPreservation({ previousCode: previous,
        candidateCode: previous.replace('test_passed', 'test_different'), protectedMethods: 'all', python });
    assert.equal(dropped.reasonCode, 'removed-passing-method');
});

test('runner passed identities protect only passed methods while an AI fixes the failed case', async () => {
    const output = 'test_passed (loop_2.Cases.test_passed) ... ok\ntest_failed (loop_2.Cases.test_failed) ... FAIL\n';
    const protectedMethods = [...passingTestIds(output, 'loop_2')];
    const fixed = previous.replace('        self.assertEqual(measure(0, 0), 0)',
        '        with self.assertRaises(ZeroDivisionError):\n            measure(0, 0)');
    const result = await validatePassingTestPreservation({ previousCode: previous, candidateCode: fixed, protectedMethods, python });
    assert.equal(result.valid, true, result.reason);
    assert.deepEqual(result.protectedMethods, ['Cases.test_passed']);
    const tampered = await validatePassingTestPreservation({ previousCode: previous,
        candidateCode: fixed.replace('30.86', '30.857142857142856'), protectedMethods, python });
    assert.equal(tampered.reasonCode, 'assertion-weakened');
});

test('small-model formatting, added cases and stricter numeric tolerance pass without host code changes', async () => {
    const candidate = 'import math\n' + previous.replace("'large'", '"large"').replace('places=2', 'places=3')
        + '\n    def test_boundary(self):\n        self.assertEqual(measure(18.5, 100)[1], "normal")\n';
    const result = await validatePassingTestPreservation({ previousCode: previous, candidateCode: candidate,
        protectedMethods: 'all', python });
    assert.equal(result.valid, true, result.reason);
    assert.deepEqual(result.protectedMethods, ['Cases.test_failed', 'Cases.test_passed']);
    assert.equal('code' in result, false);
});

test('preservation rejection reasons stay distinct and have English report labels', () => {
    const reasons = ['baseline-syntax', 'invalid-protected-methods', 'duplicate-binding', 'removed-passing-method',
        'passing-signature-changed', 'assertion-weakened', 'passing-scenario-changed', 'fixture-context-changed',
        'import-binding-changed', 'unsupported-preservation', 'preservation-tool-error'] as const;
    setLanguage('en');
    try {
        for (const reason of reasons) {
            assert.equal(repairReasonCode(reason), reason);
            assert.doesNotMatch(localize(REPAIR_REASON_LABELS[reason]), /[\u3400-\u9fff]/);
        }
    } finally { setLanguage('zh-TW'); }
});
