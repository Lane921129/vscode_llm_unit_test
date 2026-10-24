import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareParameterFixtureExperiments, parameterFixturePrompt, validateParameterFixtureResult,
    ParameterFixtureSession, checkParameterFixtureReplay, parameterFixtureReplayInstruction, type FixtureEvidence } from '../pipeline/parameterFixtureExperiments';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { evidenceHash } from '../pipeline/analysisJournal';

const source = `def select_label(context, event):
    try:
        return event.data
    except Exception:
        return context.fallback()
`;
const code = `import unittest
import types
from sample import select_label
class ModelCases(unittest.TestCase):
    def test_seed(self):
        context = types.SimpleNamespace(fallback=lambda: 'fallback')
        event = types.SimpleNamespace(data='event')
        self.assertEqual(select_label(context, event), 'event')
`;
test('parameter fixtures execute exact controls and validate identity, hashes and full prompt cases', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parameter-fixture-'));
    try {
        const file = path.join(root, 'sample.py');
        fs.writeFileSync(file, source);
        const input = { sourcePath: file, source, testCode: code,
            target: 'select_label', module: 'sample', python: resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')),
            focus: { id: 'line:4', kind: 'coverage' as const, evidence: 'line:4', line: 4 } };
        const result = await prepareParameterFixtureExperiments(input);
        assert.equal(result.status, 'observed', JSON.stringify(result));
        assert.equal(result.seedHash, evidenceHash(code));
        assert.equal(fs.readFileSync(file, 'utf8'), source);
        const prompt = parameterFixturePrompt(result);
        assert.match(prompt, /PARAMETER_FIXTURE_OBSERVATIONS_V1/);
        assert.match(prompt, /fallback/);
        assert.match(prompt, /"operation":"raise"/);
        assert.match(prompt, /RAISE WHEN READ/);
        assert.match(prompt, /target may catch it and return normally/);
        assert.equal((prompt.match(/"fingerprint"/g) || []).length, 1);
        assert.doesNotMatch(prompt, /def test_|self\.assert/);
        assert.equal(parameterFixturePrompt(result, 20), '');
        for (const mutate of [
            (v: any) => { v.sourceHash = 'a'.repeat(64); },
            (v: any) => { v.experiments[0].evidence.inputs.args[0].kind = 'eval'; },
            (v: any) => { v.experiments[0].evidence.outcome.result.value.extra = 'untrusted'; },
            (v: any) => { v.experiments[0].evidence.context.module = 'other'; },
            (v: any) => { v.experiments[0].evidence.execution.targetEntered = false; },
            (v: any) => { v.experiments[0].evidence.assertionOracle = true; }
        ]) {
            const changed = structuredClone(result); mutate(changed);
            assert.throws(() => validateParameterFixtureResult(changed));
        }
        const session = new ParameterFixtureSession();
        session.record(result);
        const handoffs: FixtureEvidence[] = [];
        assert.equal(session.prompt(result, 20, [], value => { handoffs.push(value); }), '');
        assert.equal(handoffs.length, 0, 'a budget-omitted case is not handed off to the replay checker');
        const first = session.prompt(result, 8000, [], value => { handoffs.push(value); });
        const handoff = handoffs[0];
        assert.equal(handoff.fingerprint, result.experiments[0].fingerprint);
        const mismatch = code + '\n    def test_new(self):\n        context = types.SimpleNamespace(fallback=lambda: "fallback")\n'
            + '        event = types.SimpleNamespace(data=None)\n        self.assertIsNone(select_label(context, event))\n';
        assert.equal((await checkParameterFixtureReplay({ ...input, code: mismatch, baseline: code, evidence: handoff })).status, 'contradicted');
        assert.equal((await checkParameterFixtureReplay({ ...input, code: mismatch, baseline: code + '\n', evidence: handoff })).status,
            'contradicted', 'the observation keeps its seed provenance when the later host baseline grows');
        await assert.rejects(checkParameterFixtureReplay({ ...input, source: source + '\n# changed', code: mismatch, baseline: code, evidence: handoff }));
        const otherSource = path.join(root, 'other.py');
        fs.writeFileSync(otherSource, source);
        await assert.rejects(checkParameterFixtureReplay({ ...input, sourcePath: otherSource, code: mismatch, baseline: code, evidence: handoff }),
            'equal source bytes cannot lend another file the observed fixture context');
        const instruction = parameterFixtureReplayInstruction(handoff);
        assert.match(instruction, /READING event\.data must raise built-in Exception\(\)/);
        assert.match(instruction, /@property def data\(self\)/);
        assert.match(instruction, /instance AS the owner of data/);
        assert.match(instruction, /EXACT CONTROL READ SUMMARY/);
        assert.match(instruction, /fallback: fresh factory return "fallback"/);
        assert.match(instruction, /Observed return with those controls: "fallback"/);
        assert.doesNotMatch(instruction, /self\.assert|def test_|raise Exception\(\)/);
        const large = structuredClone(handoff);
        if (large.inputs.args[0].kind === 'namespace') {
            large.inputs.args[0].attributes.fallback = { kind: 'literal', value: { schema_version: 'trace-value-v1',
                replayable: true, value: { type: 'str', value: 'LONG_CONTROL'.repeat(200) } } };
        }
        const omitted = parameterFixtureReplayInstruction(large);
        assert.doesNotMatch(omitted, /EXACT CONTROL READ SUMMARY|LONG_CONTROL/);
        assert.match(omitted, /Use the full case packet/);
        const raised: FixtureEvidence = { ...handoff, outcome: { status: 'raised', exception: 'Exception',
            exceptionArgs: { schema_version: 'trace-value-v1', replayable: true, value: { type: 'tuple', items: [] } } } };
        const raisedInstruction = parameterFixtureReplayInstruction(raised);
        assert.match(raisedInstruction, /target raised in this case/);
        assert.doesNotMatch(raisedInstruction, /target returned normally|Observed return with those controls/);
        assert.equal(session.prompt(result, 8000, []), '', 'the presented case is not handed off repeatedly');
        const next = await prepareParameterFixtureExperiments({ ...input, triedFingerprints: session.triedFingerprints });
        session.record(next);
        const second = session.prompt(next, 8000, []);
        assert.ok(first && second && first !== second);
        assert.equal(session.triedFingerprints.length, 2, 'only actually attempted cases are consumed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
