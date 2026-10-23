import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareParameterFixtureExperiments, parameterFixturePrompt, validateParameterFixtureResult,
    ParameterFixtureSession } from '../pipeline/parameterFixtureExperiments';
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
        assert.equal(session.prompt(result, 20, []), '');
        const first = session.prompt(result, 8000, []);
        assert.equal(session.prompt(result, 8000, []), '', 'the presented case is not handed off repeatedly');
        const next = await prepareParameterFixtureExperiments({ ...input, triedFingerprints: session.triedFingerprints });
        session.record(next);
        const second = session.prompt(next, 8000, []);
        assert.ok(first && second && first !== second);
        assert.equal(session.triedFingerprints.length, 2, 'only actually attempted cases are consumed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
