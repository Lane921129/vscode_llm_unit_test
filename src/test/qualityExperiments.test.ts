import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareQualityExperiments, assessQualityCandidateNovelty, buildQualityExperimentEvidencePrompt,
    validateQualityExperimentResult, QualityExperimentResult } from '../pipeline/qualityExperiments';
import { QualityImprovementSession } from '../pipeline/qualityImprovementSession';
import { planMutationProbes } from '../pipeline/mutationProbePlan';
import { evidenceHash } from '../pipeline/analysisJournal';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { MutationRun } from '../mutation/mutationResult';
import { createImportFixturePlan, IMPORT_FIXTURE_ENV, withImportFixtures } from '../pipeline/importFixtures';

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

test('quality evidence verifies the effective fixture plan injected into its worker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-fixture-context-'));
    try {
        const file = path.join(root, 'sample.py'); fs.writeFileSync(file, source);
        const plan = createImportFixturePlan(root, [{ file: 'sample.py', mkdir: true }])!;
        const result = await withImportFixtures(plan, () => prepareQualityExperiments({ sourcePath: file, source,
            target: 'Ledger.increase', module: 'sample', testCode: modelTests,
            focus: { id: 'fixture-gap', kind: 'coverage', line: 6, evidence: 'line:6' }, python,
            env: { ...process.env, PYTHONPATH: root, [IMPORT_FIXTURE_ENV]: 'untrusted inherited plan' } }));
        assert.equal(result.status, 'observed');
        assert.equal(result.context?.importFixturePlanHash, evidenceHash(JSON.stringify(plan)));
        validateQualityExperimentResult(result);
        assert.deepEqual(fs.readdirSync(root), ['sample.py']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('isolated state experiments provide complete Writer evidence without generating or merging tests', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-quality-'));
    try {
        const file = path.join(root, 'sample.py'); fs.writeFileSync(file, source);
        const result = await prepareQualityExperiments({ sourcePath: file, source, target: 'Ledger.increase', module: 'sample',
            testCode: modelTests, focus: { id: 'state-gap', kind: 'coverage', line: 6, evidence: 'line:6' }, python,
            env: { ...process.env, PYTHONPATH: root } });
        assert.equal(result.status, 'observed', JSON.stringify(result));
        assert.equal('testCode' in result, false);
        assert.equal('testHash' in result, false);
        assert.deepEqual(fs.readdirSync(root), ['sample.py']);
        validateQualityExperimentResult(result);
        const prompt = buildQualityExperimentEvidencePrompt(result);
        assert.match(prompt, /Writer must author/);
        const projection = JSON.parse(prompt.slice(prompt.indexOf('{')));
        assert.ok(projection.includedCases > 0);
        assert.equal(projection.includedCases + projection.omittedCases, projection.observedCases);
        assert.equal(projection.experiments[0].evidenceHash, result.experiments[0].evidenceHash);
        assert.equal(projection.assertionOracle, false);
        assert.equal(projection.experiments[0].steps.length, 2);
        assert.equal(projection.experiments[0].constructor.type, 'dict');
        assert.equal(projection.experiments[0].steps[0].after.type, 'dict');
        assert.equal(projection.context.importFixturePlanHash, evidenceHash(''));
        assert.equal(projection.valueEncoding, 'trace-value-v1');
        for (const budget of [0, 100, 500, 3000, 6000, 12000]) {
            const bounded = buildQualityExperimentEvidencePrompt(result, budget);
            assert.ok(bounded.length <= budget);
            if (bounded) {
                const contents = JSON.parse(bounded.slice(bounded.indexOf('{')));
                assert.equal(contents.includedCases + contents.omittedCases, projection.observedCases);
                for (const observed of contents.experiments ?? []) {
                    const actual = result.experiments.find(item => item.fingerprint === observed.fingerprint)!.evidence!;
                    assert.deepEqual(observed.constructor, actual.constructor.value);
                    assert.deepEqual(observed.initialState, actual.initialState.value);
                    assert.deepEqual(observed.steps, actual.steps.map(step => ({ input: step.input.value, before: step.before.value,
                        after: step.after.value, status: step.status, result: step.result!.value })));
                }
            }
        }
        const secretExcluded = buildQualityExperimentEvidencePrompt(result, 12000, ['Ledger.increase']);
        assert.equal(secretExcluded, '');
        for (const mutate of [
            (value: QualityExperimentResult) => { value.experiments[0].evidence!.sourceHash = '0'.repeat(64); },
            (value: QualityExperimentResult) => { value.experiments[0].evidence!.gapId = 'another-gap'; },
            (value: QualityExperimentResult) => { value.experiments[0].evidence!.context.importFixturePlanHash = '0'.repeat(64); },
            (value: QualityExperimentResult) => { value.experiments[0].evidence!.steps.pop(); },
            (value: QualityExperimentResult) => { value.experiments[0].evidenceHash = '0'.repeat(64); },
            (value: QualityExperimentResult) => { (value as any).testCode = modelTests; },
            (value: QualityExperimentResult) => { value.experiments[0].status = 'unavailable'; }
        ]) {
            const changed = structuredClone(result); mutate(changed);
            assert.throws(() => buildQualityExperimentEvidencePrompt(changed), /quality|Quality|Unavailable/);
        }
        const session = new QualityImprovementSession(); session.record(result);
        const repeated = await prepareQualityExperiments({ sourcePath: file, source, target: 'Ledger.increase', module: 'sample',
            testCode: modelTests.replace('test_value', 'test_renamed'),
            focus: { id: 'different-label', kind: 'coverage', line: 6, evidence: 'line:6' }, python,
            triedFingerprints: session.triedFingerprints, env: { ...process.env, PYTHONPATH: root } });
        assert.equal(repeated.status, 'duplicate');
        const retained = session.evidenceFor(repeated)!;
        assert.equal(retained.gapId, 'state-gap', 'reuse preserves the observed gap instead of rewriting history');
        assert.deepEqual(retained.experiments, result.experiments);
        const handed: string[] = [];
        buildQualityExperimentEvidencePrompt(retained, 3100, [], fingerprints => {
            handed.push(...fingerprints); session.recordHandoff(retained, fingerprints);
        });
        assert.equal(handed.length, 1, 'a bounded prompt sends one complete case');
        const nextHandoff = session.evidenceFor(repeated)!;
        assert.notEqual(nextHandoff.experiments[0].fingerprint, handed[0], 'previously omitted observations remain available first');
        assert.deepEqual(new Set(nextHandoff.experiments.map(item => item.fingerprint)), new Set(result.experiments.map(item => item.fingerprint)));
        nextHandoff.experiments.splice(0);
        assert.ok(session.evidenceFor(repeated)!.experiments.length > 0, 'callers cannot mutate the cached evidence');
        assert.throws(() => session.recordHandoff(retained, ['0'.repeat(64)]), /Unknown quality observation/);
        const changedSource = { ...repeated, sourceHash: '0'.repeat(64) };
        assert.equal(session.evidenceFor(changedSource), undefined);
        const changedFixture = structuredClone(repeated); changedFixture.context!.importFixturePlanHash = '0'.repeat(64);
        assert.equal(session.evidenceFor(changedFixture), undefined);
        const changedRoot = structuredClone(repeated); changedRoot.context!.sourceRoot += '/other';
        assert.equal(session.evidenceFor(changedRoot), undefined);
        const changedPath = structuredClone(repeated); changedPath.context!.sourcePath += '.other';
        assert.equal(session.evidenceFor(changedPath), undefined);
        const changedModule = structuredClone(repeated); changedModule.context!.module = 'other';
        assert.equal(session.evidenceFor(changedModule), undefined);
        assert.equal(new QualityImprovementSession().evidenceFor(repeated), undefined, 'observations never cross runs');
        assert.equal(session.measured('state-gap', ['m1'], ['m1']), 'unchanged');
        assert.equal(session.measured('state-gap', ['m1'], []), 'improved');
        assert.equal(session.measured('state-gap', [], ['m1']), 'regressed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('exception type and arguments remain complete typed observations for the Writer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-exception-'));
    try {
        const observedSource = source.replace('self.entries[name] = units', "raise ValueError('empty entry', name)");
        const file = path.join(root, 'sample.py'); fs.writeFileSync(file, observedSource);
        const result = await prepareQualityExperiments({ sourcePath: file, source: observedSource,
            target: 'Ledger.increase', module: 'sample', testCode: modelTests,
            focus: { id: 'exception-gap', kind: 'coverage', line: 8, evidence: 'line:8' }, python,
            env: { ...process.env, PYTHONPATH: root } });
        assert.equal(result.status, 'observed');
        const projected = buildQualityExperimentEvidencePrompt(result);
        const observation = JSON.parse(projected.slice(projected.indexOf('{'))).experiments[0];
        assert.equal(observation.steps[0].status, 'raised');
        assert.equal(observation.steps[0].exception, 'ValueError');
        assert.equal(observation.steps[0].exceptionArgs.type, 'tuple');
        assert.deepEqual(observation.steps[0].exceptionArgs.items.map((item: any) => item.value), ['empty entry', 'entry']);
        assert.equal(observation.steps.length, 1);
        assert.equal('testCode' in result, false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('credential-shaped observed state is withheld before it can enter Writer evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-secret-'));
    try {
        for (const secret of ['sk-' + 'x'.repeat(32), 'local-"secret-phrase']) {
            const observedSource = source.replace('self.entries[name] = units', `self.entries[name] = ${JSON.stringify(secret)}`);
            const file = path.join(root, 'sample.py'); fs.writeFileSync(file, observedSource);
            await assert.rejects(() => prepareQualityExperiments({ sourcePath: file, source: observedSource,
                target: 'Ledger.increase', module: 'sample', testCode: modelTests, knownSecrets: [secret],
                focus: { id: 'secret-gap', kind: 'coverage', line: 8, evidence: 'line:8' }, python,
                env: { ...process.env, PYTHONPATH: root } }), /Sensitive quality observation was withheld/);
        }
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
