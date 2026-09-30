import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';
import { runSpawn } from '../utils/processRunner';
import { repairWithNumericSkill } from '../pipeline/numericTestSkill';
import { validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { evidenceHash } from '../pipeline/analysisJournal';

for (const [fixture, expectedCount, expectedCorrections] of [
    ['bmi_lab_20260930_2023.py', 20, 11], ['bmi_lab_20260930_2015.py', 27, 2],
    ['bmi_lab_20260930_2130.py', 18, 8]
] as const) {
    test(`laboratory replay ${fixture}: real exception assertions succeed without another model request`, async () => {
        const repo = path.resolve(__dirname, '../..');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-lab-'));
        const python = resolvePythonExecutable(undefined, repo);
        const source = fs.readFileSync(path.join(repo, 'test/test_mut/bmi.py'), 'utf8');
        const original = fs.readFileSync(path.join(repo, 'test/fixtures/repair', fixture), 'utf8');
        const sourceFile = path.join(root, 'bmi.py'), testFile = path.join(root, 'generated.py');
        fs.writeFileSync(sourceFile, source);
        const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
        const executions: Array<{ ok: boolean; out: string }> = [];
        const evidence: any[] = [];
        const checkedBatches: number[] = [];
        try {
            const result = await validateTestCandidate(original, {
                reviewRequired: false, review: async () => undefined, checkCancelled() {}, event() {},
                validate: async () => undefined,
                revise: async () => { assert.fail('replaying these failures must not need an additional model response'); },
                execute: async code => {
                    fs.writeFileSync(testFile, code);
                    const run = await runSpawn(python, ['-B', pythonToolPath('testRunner'), 'generated', '-v'],
                        { cwd: root, env, timeout: 15000 });
                    const execution = { ok: run.code === 0, out: run.stdout + run.stderr, qualityGaps: [], testModule: 'generated' };
                    executions.push(execution);
                    return execution;
                },
                repairExpectations: async (code, failure) => {
                    const repaired = await repairWithNumericSkill({ code, failure, source, target: 'calculate_bmi', module: 'bmi',
                        python, env, directory: root, runId: 'lab-replay', sourceHash: evidenceHash(source),
                        checkCurrent: () => assert.equal(fs.readFileSync(sourceFile, 'utf8'), source), event() {},
                        observe: async calls => {
                            checkedBatches.push(calls.length);
                            const run = await runSpawn(python, ['-B', pythonToolPath('trace'), sourceFile, 'calculate_bmi',
                                JSON.stringify({ schema_version: 'probe-inputs-v1', cases: calls.map(call => ({
                                    input: call.trace_input, source: { kind: 'semantic_guided', detail: 'numeric-calculation' }
                                })) }), JSON.stringify({ total_timeout_seconds: 15, case_timeout_seconds: 2 })],
                            { cwd: root, env, timeout: 20000 });
                            assert.equal(run.code, 0, run.stderr);
                            return JSON.parse(run.stdout);
                        }
                    });
                    if (repaired) { evidence.push(repaired.evidence); }
                    return repaired;
                }
            });
            assert.equal(executions.length, 2);
            assert.equal(executions[0].ok, false);
            assert.match(executions[0].out, /(?:FAIL|ERROR): test_calculate_bmi/);
            assert.equal(result.execution.ok, true, result.execution.out);
            assert.match(result.execution.out, new RegExp(`Ran ${expectedCount} tests`));
            assert.match(result.execution.out, /\nOK\s*$/);
            assert.equal(evidence.length, 1);
            assert.equal(evidence[0].corrections.length, expectedCorrections);
            assert.ok(checkedBatches.every(count => count <= 6));
            assert.equal(checkedBatches.length, fixture.includes('2015') ? 1 : 2);
            assert.match(result.code, /with self.assertRaises\(ZeroDivisionError\):/);
            assert.match(result.code, /with self.assertRaises\(TypeError\):/);
            if (fixture.includes('2023')) {
                assert.match(result.code, /self.assertEqual\(type\(bmi\), float\)/);
                assert.match(result.code, /self.assertEqual\(type\(status\), str\)/);
            }
            assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
}
