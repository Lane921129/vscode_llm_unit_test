import * as assert from 'assert';
import { test } from 'node:test';
import { extractKillTestMethods, parseMutantTriageResult } from '../roles/legacy/mutantTriage';

test('normalizes only actionable mutant-triage verdicts', () => {
    const result = parseMutantTriageResult(JSON.stringify({
        verdicts: [
            { mutant: 'replace < with <=', verdict: 'KILLABLE', reason: 'boundary input differs', kill_test: 'def test_kill_boundary(self):\n    self.assertEqual(1, 1)' },
            { mutant: 'remove defensive branch', verdict: 'EQUIVALENT', reason: 'branch is unreachable', kill_test: 'must not be retained' },
            { mutant: 'missing code', verdict: 'KILLABLE', reason: 'not actionable', kill_test: null },
            { mutant: 'unknown kind', verdict: 'MAYBE', reason: 'invalid', kill_test: null }
        ],
        has_killable: false,
        equivalent_count: 999
    }));

    assert.ok(result);
    assert.strictEqual(result!.verdicts.length, 2);
    assert.strictEqual(result!.has_killable, true);
    assert.strictEqual(result!.equivalent_count, 1);
    assert.match(extractKillTestMethods(result!), /test_kill_boundary/);
    assert.strictEqual(result!.verdicts[1].kill_test, null);
});

test('rejects unrelated or malformed triage JSON instead of crashing the mutation loop', () => {
    assert.strictEqual(parseMutantTriageResult(JSON.stringify({ message: 'gateway metadata' })), null);
    assert.strictEqual(parseMutantTriageResult(JSON.stringify({ verdicts: 'not-an-array' })), null);
    assert.strictEqual(parseMutantTriageResult('{'), null);
});
