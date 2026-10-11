import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dispatchTestRules } from '../pipeline/testRuleDispatcher';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { pythonToolPath } from '../pipeline/pythonTools';
import { getUserPrompt } from '../roles/unittestWriter';
import { generatedUnittestArguments, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const bindings = [
    { statement: 'from datetime import datetime', bound: 'datetime', imported: 'datetime', module: false },
    { statement: 'from datetime import datetime as Clock', bound: 'Clock', imported: 'datetime', module: false },
    { statement: 'import datetime', bound: 'datetime', imported: null, module: true },
    { statement: 'import datetime as dates', bound: 'dates', imported: null, module: true }
] as const;

function fixture(binding: typeof bindings[number]) {
    const call = binding.bound + (binding.module ? '.datetime.now' : '.now');
    const source = binding.statement + '\ndef target():\n'
        + `    return ${call}().strftime('%Y-%m-%d %H:%M:%S')\n`;
    const context = { name: 'target', code: source, args: [], method_kind: 'module' as const,
        calls: [call, call + '().strftime'],
        file_imports: [{ module: 'datetime', name: binding.imported, bound_name: binding.bound }],
        dependencies: [{ name: binding.bound }] };
    const receiver = binding.module ? 'clock.datetime.now' : 'clock.now';
    const code = 'import unittest\nfrom unittest.mock import patch\nfrom datetime import datetime as RealDateTime\n'
        + 'from sample import target\nclass Cases(unittest.TestCase):\n    def test_fixed_clock(self):\n'
        + '        fixed = RealDateTime(2041, 2, 3, 4, 5, 6)\n'
        + `        with patch('sample.${binding.bound}') as clock:\n`
        + `            ${receiver}.return_value = fixed\n`
        + "            self.assertEqual(target(), '2041-02-03 04:05:06')\n"
        + `            ${receiver}.assert_called_once_with()\n`;
    return { source, context, code, receiver };
}

function validateBinding(code: string, source: string, binding: typeof bindings[number],
    structure: ReturnType<typeof validateUnittestStructure>) {
    const checked = spawnSync(python, ['-B', pythonToolPath('bindings'), '--payload'], {
        encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ code, context: { module: 'sample', target: 'target', source,
            dependencies: { [binding.bound]: binding.module ? 'datetime' : 'datetime.datetime' },
            requireTargetBehavior: structure.requiresTargetBehaviorEvidence,
            requireMockBehavior: structure.requiresMockBehaviorEvidence, targetUsage: 'call' } })
    });
    assert.equal(checked.status, 0, checked.stderr);
    const result = JSON.parse(checked.stdout);
    assert.equal(result.valid, true, result.reason);
}

function execute(directory: string, code: string) {
    fs.writeFileSync(path.join(directory, 'generated.py'), code);
    return spawnSync(python, generatedUnittestArguments('generated', directory, false, true), {
        cwd: directory, encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
}

test('source-bound clock rules reach both Writer prompt strategies with distinct class/module receiver guidance', () => {
    for (const binding of bindings) {
        const { source, context } = fixture(binding);
        const selected = dispatchTestRules(source, context);
        assert.ok(selected.ids.includes('datetime_freezing'));
        const evidence: WriterEvidenceBundleV3 = { schemaVersion: 'writer-evidence-v3', sourceHash: selected.sourceHash,
            semanticGuidance: selected.guidance, ruleSelection: selected,
            evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance'] };
        for (const strategy of ['small', 'large'] as const) {
            const prompt = getUserPrompt('sample.py', 'target', source, strategy, context, undefined, 4000, '', evidence);
            assert.ok(prompt.includes(source), 'retain complete target source beside the conditional examples');
            assert.match(prompt, /clock\.now\.return_value = fixed/);
            assert.match(prompt, /clock\.datetime\.now\.return_value = fixed/);
            assert.match(prompt, /built-in datetime class is immutable/);
            assert.match(prompt, /actual source alias/);
            assert.match(prompt, /never copy uncontrolled-ambient-read observations/);
        }
    }
});

test('real guarded datetime class/module imports and aliases accept a fixed real time at the source binding', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'datetime-binding-'));
    try {
        for (const binding of bindings) {
            const { source, code } = fixture(binding);
            fs.writeFileSync(path.join(directory, 'sample.py'), source);
            const structure = validateUnittestStructure(code, 'target', 'sample', 'call', [], undefined, true);
            assert.equal(structure.valid, true, structure.reason);
            validateBinding(code, source, binding, structure);
            const result = execute(directory, code);
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.match(result.stderr, /Ran 1 test/);
            assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), source);
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('wrong datetime receiver depth and direct immutable now patch remain real execution failures', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'datetime-negative-'));
    try {
        for (const binding of [bindings[0], bindings[2]]) {
            const { source, code, receiver } = fixture(binding);
            fs.writeFileSync(path.join(directory, 'sample.py'), source);
            const otherReceiver = binding.module ? 'clock.now' : 'clock.datetime.now';
            const wrong = execute(directory, code.replaceAll(receiver, otherReceiver));
            assert.notEqual(wrong.status, 0);
            assert.match(wrong.stderr, /^AssertionError:/m, 'a mock on the wrong receiver does not control the real target result');
        }
        const { source } = fixture(bindings[0]);
        fs.writeFileSync(path.join(directory, 'sample.py'), source);
        const immutable = 'import unittest\nfrom unittest.mock import patch\nfrom sample import target\n'
            + 'class Cases(unittest.TestCase):\n    def test_clock(self):\n'
            + "        with patch('datetime.datetime.now'):\n            self.assertEqual(target(), '2041-02-03 04:05:06')\n";
        const failed = execute(directory, immutable);
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, /^TypeError:.*(?:immutable|built-in\/extension)/m);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), source);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
