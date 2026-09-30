import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repairWithNumericSkill, verifyNumericObservations } from '../pipeline/numericTestSkill';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { runSpawn } from '../utils/processRunner';
import { pythonToolPath } from '../pipeline/pythonTools';
import { evidenceHash } from '../pipeline/analysisJournal';
import { dispatchTestRules } from '../pipeline/testRuleDispatcher';
import { describeStageEvent } from '../pipeline/resultPresentation';
import { setLanguage } from '../i18n/core';

test('numeric skill requires completed exact typed observations and preserves fallback on unavailable evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-skill-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const source = 'def metric(amount, scale):\n    return round(amount / scale, 2)\n';
    const file = path.join(root, 'sample.py');
    fs.writeFileSync(file, source);
    const code = 'import unittest\nfrom sample import metric\nclass Cases(unittest.TestCase):\n'
        + '    def test_value(self):\n        value = metric(3.0, 2)\n        self.assertEqual(value, 9.0)\n';
    let observations: any, proof: any;
    const events: any[] = [];
    const options = { code, failure: 'FAIL: test_value (generated.Cases.test_value)\nAssertionError', source,
        target: 'metric', module: 'sample', python, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        directory: root, runId: 'test-run', sourceHash: evidenceHash(source), checkCurrent: () => {},
        event: (stage: string, status: string, detail: unknown) => events.push({ stage, status, detail }),
        observe: async (calls: any[]) => {
            const run = await runSpawn(python, [pythonToolPath('trace'), file, 'metric', JSON.stringify({
                schema_version: 'probe-inputs-v1', cases: calls.map(call => ({ input: call.trace_input, source: { kind: 'semantic_guided' } }))
            }), JSON.stringify({ total_timeout_seconds: 8, case_timeout_seconds: 2 })], { timeout: 15000 });
            assert.equal(run.code, 0, run.stderr);
            observations = JSON.parse(run.stdout);
            return observations;
        }
    };
    try {
        const repaired = await repairWithNumericSkill(options);
        assert.ok(repaired, JSON.stringify(events));
        assert.match(repaired.code, /self.assertEqual\(value, 1.5\)/);
        proof = repaired.evidence as any;
        assert.equal(proof.status, 'verified');
        assert.equal(proof.sourceHash, evidenceHash(source));
        assert.equal(proof.candidateTestHash, evidenceHash(repaired.code));
        assert.equal(proof.previousTestHash, evidenceHash(code));
        const calculations = proof.corrections.map((item: any) => item.basis);
        assert.equal(verifyNumericObservations(calculations, observations, 'metric'), true);
        for (const corrupt of [
            (t: any) => { t.complete = false; },
            (t: any) => { t.examples[0].call_assertable = false; },
            (t: any) => { t.examples[0].result_assertable = false; },
            (t: any) => { t.examples[0].non_deterministic_operations = ['clock']; },
            (t: any) => { t.cases[0].result_snapshot.value.value = '2.5'; },
            (t: any) => { delete t.cases[0].result_snapshot; },
            (t: any) => { t.cases[0].input_before.args.value.items[0] = { type: 'int', value: '3' }; },
            (t: any) => { t.cases[0].status = 'blocked'; },
            (t: any) => { t.cases.push({ ...t.cases[0], case_id: 'duplicate-input' }); },
            (t: any) => { t.func_name = 'other'; },
            (t: any) => { t.load_error = 'import failure'; },
            (t: any) => { t.cases[0].inputs_mutated = true; }
        ]) {
            const changed = structuredClone(observations); corrupt(changed);
            assert.equal(verifyNumericObservations(calculations, changed, 'metric'), false, corrupt.toString());
        }
        assert.equal(await repairWithNumericSkill({ ...options, observe: async () => null }), undefined);
        assert.equal(events.at(-1).status, 'unverified');
        let checks = 0;
        await assert.rejects(repairWithNumericSkill({ ...options,
            checkCurrent: () => { if (++checks >= 3) { throw Error('source-changed'); } }
        }), /source-changed/);
        assert.equal(events.at(-1).detail.reason, 'evidence-invalidated-or-interrupted');
        assert.equal(await repairWithNumericSkill({ ...options, source: 'def metric(amount, scale):\n    return open("never")\n',
            observe: async () => { assert.fail('unsupported source must never reach Trace'); } }), undefined);
        assert.equal(events.at(-1).status, 'unsupported');
        const many = Array.from({ length: 7 }, (_, i) => `    def test_${i}(self):\n        value = metric(${i + 1}, 2)\n        self.assertEqual(value, 99)\n`).join('');
        assert.equal(await repairWithNumericSkill({ ...options,
            code: 'import unittest\nfrom sample import metric\nclass Cases(unittest.TestCase):\n' + many,
            failure: Array.from({ length: 7 }, (_, i) => `FAIL: test_${i} (generated.Cases.test_${i})`).join('\n'),
            observe: async () => { assert.fail('case budget must stop before Trace'); }
        }), undefined);
        assert.equal(events.at(-1).detail.reason, 'case-budget');
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('numeric skill is source-selected, has exact-input guidance and localized progress', () => {
    const selected = dispatchTestRules('def any_name(x, y):\n    return round(x / y, 2)');
    assert.ok(selected.ids.includes('numeric_calculation'));
    assert.match(selected.guidance, /exact-input verified observations/);
    assert.ok(!dispatchTestRules('def text(x):\n    return x.upper()').ids.includes('numeric_calculation'));
    assert.ok(!dispatchTestRules('def target():\n    return datetime.now().year + 1', {
        calls: ['datetime.now'], method_kind: 'module'
    }).ids.includes('numeric_calculation'), 'unsupported external calls must not consume a small model prompt budget');
    assert.ok(!dispatchTestRules('def target(self, x):\n    return x + 1', {
        class_name: 'Holder', method_kind: 'instance'
    }).ids.includes('numeric_calculation'));
    try {
        setLanguage('en');
        for (const status of ['planned', 'verified', 'unverified', 'unsupported', 'unavailable']) {
            const description = describeStageEvent('numeric-skill', status, {});
            assert.notEqual(description, status);
            assert.doesNotMatch(description, /[\u3400-\u9fff]/);
        }
    } finally { setLanguage('zh-tw'); }
});
