import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareQualityExperiments, mergeQualityExperimentTests, assessQualityCandidateNovelty } from '../pipeline/qualityExperiments';
import { QualityImprovementSession } from '../pipeline/qualityImprovementSession';
import { planMutationProbes } from '../pipeline/mutationProbePlan';
import { evidenceHash } from '../pipeline/analysisJournal';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';
import { validateUnittestStructure } from '../validation/generatedTestValidator';
import { validateTraceEvidence } from '../validation/traceAssertionEvidence';
import { MutationRun } from '../mutation/mutationResult';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const source = `class Ledger:
    def __init__(self):
        self.entries = {}
    def increase(self, name, units=1):
        if name in self.entries:
            self.entries[name] += units
        else:
            self.entries[name] = units
`;
const modelTests = `import unittest
from sample import Ledger
class ModelCases(unittest.TestCase):
    def setUp(self):
        self.ledger = Ledger()
    def test_value(self):
        self.assertIsNone(self.ledger.increase('entry', 2))
`;

test('host state experiments cross structure, binding, trace and independent execution gates before merge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-quality-'));
    try {
        const file = path.join(root, 'sample.py'); fs.writeFileSync(file, source);
        const result = await prepareQualityExperiments({ sourcePath: file, source, target: 'Ledger.increase', module: 'sample',
            testCode: modelTests, focus: { id: 'state-gap', kind: 'coverage', line: 6, evidence: 'line:6' }, python,
            env: { ...process.env, PYTHONPATH: root } });
        assert.equal(result.status, 'observed', JSON.stringify(result));
        assert.ok(result.testCode?.includes('instance.entries'));
        assert.equal(result.testHash, evidenceHash(result.testCode!));
        const structure = validateUnittestStructure(result.testCode!, 'increase', 'sample', 'call', undefined, 'Ledger', true);
        assert.equal(structure.valid, true, structure.reason);
        const binding = spawnSync(python, ['-B', pythonToolPath('bindings'), '--payload'], { encoding: 'utf8',
            input: JSON.stringify({ code: result.testCode, context: { module: 'sample', target: 'increase', className: 'Ledger',
                source, dependencies: {}, requireTargetBehavior: true, requireMockBehavior: false, targetUsage: 'call' } }) });
        assert.equal(binding.status, 0, binding.stdout + binding.stderr);
        assert.equal(JSON.parse(binding.stdout).valid, true, binding.stdout);
        assert.equal((await validateTraceEvidence(result.testCode!, 'increase', undefined, 'sample', python, 'Ledger')).valid, true);
        const testFile = path.join(root, 'test_state.py'); fs.writeFileSync(testFile, result.testCode!);
        const baseline = spawnSync(python, ['-B', pythonToolPath('testRunner'), 'test_state'], {
            cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONPATH: root } });
        assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
        const merged = await mergeQualityExperimentTests(modelTests, result.testCode!, python);
        assert.ok(merged.code.includes('class ModelCases'));
        const novelty = await assessQualityCandidateNovelty(modelTests, merged.code, python);
        assert.ok(novelty.novelMethods > 0);
        const session = new QualityImprovementSession(); session.record(result);
        const repeated = await prepareQualityExperiments({ sourcePath: file, source, target: 'Ledger.increase', module: 'sample',
            testCode: modelTests.replace('test_value', 'test_renamed'),
            focus: { id: 'different-label', kind: 'coverage', line: 6, evidence: 'line:6' }, python,
            triedFingerprints: session.triedFingerprints, env: { ...process.env, PYTHONPATH: root } });
        assert.equal(repeated.status, 'duplicate');
        assert.equal(session.measured('state-gap', ['m1'], ['m1']), 'unchanged');
        assert.equal(session.measured('state-gap', ['m1'], []), 'improved');
        assert.equal(session.measured('state-gap', [], ['m1']), 'regressed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('novelty ignores test names and formatting but preserves changes to fixture state and expectations', async () => {
    const renamed = modelTests.replace('test_value', 'test_renamed');
    assert.equal((await assessQualityCandidateNovelty(modelTests, renamed, python)).novelMethods, 0);
    const fixture = modelTests.replace('self.ledger = Ledger()', "self.ledger = Ledger()\n        self.ledger.entries = {'entry': 10}");
    assert.ok((await assessQualityCandidateNovelty(modelTests, fixture, python)).novelMethods > 0);
    const assertion = modelTests.replace('self.assertIsNone(self.ledger.increase(\'entry\', 2))',
        "self.ledger.increase('entry', 2)\n        self.assertEqual(self.ledger.entries, {'entry': 2})");
    assert.ok((await assessQualityCandidateNovelty(modelTests, assertion, python)).novelMethods > 0);
});

test('numeric boundary planning accepts Mutatest operators and rejects different source or scope', async () => {
    const numeric = 'def classify(amount):\n    if amount < 10: return 1\n    return 2\n';
    const mutation = { engine: 'mutatest', status: 'complete', sourceHash: evidenceHash(numeric),
        scopeVersion: 'selected-function-body-v1', targetScope: { kind: 'function', qualifiedName: 'classify' },
        mutants: [{ id: 'm1', status: 'SURVIVED', kind: 'Compare', line: 2, column: 7, position: 0, from: 'Lt', to: 'LtE' }] } as MutationRun;
    const observations = { func_name: 'classify', args: ['amount'], examples: [{ args: ['2'], result: '1' }], errors: [], load_error: null };
    const planned = await planMutationProbes(numeric, 'classify', mutation, observations, python);
    assert.deepEqual(planned.inputs.map(input => input.args), [[10]]);
    assert.equal(planned.assertionOracle, false);
    assert.equal((await planMutationProbes(numeric + '# changed', 'classify', mutation, observations, python)).inputs.length, 0);
    assert.equal((await planMutationProbes(numeric, 'Other.classify', mutation, observations, python)).inputs.length, 0);
});
