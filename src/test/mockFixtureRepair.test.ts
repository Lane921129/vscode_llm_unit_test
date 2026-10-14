import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { formatDependencyMockContract, formatFixtureConsumptionGuidance } from '../prompts/dependencyMockContract';
import { canRepairTestMethod, getBugFixerUserPrompt, isMockInitializationFailure } from '../roles/bugFixer';
import { validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { generatedUnittestArguments, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const source = 'def target(cursor, table):\n    cursor.execute(table)\n    return [row[1] for row in cursor.fetchall()]\n';

function extract(directory: string, code: string): any {
    const file = path.join(directory, 'sample.py');
    fs.writeFileSync(file, code);
    const result = spawnSync(python, ['-B', pythonToolPath('ast'), file, 'target'], {
        encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), code);
    return JSON.parse(result.stdout);
}

function execute(directory: string, code: string) {
    fs.writeFileSync(path.join(directory, 'generated.py'), code);
    return spawnSync(python, generatedUnittestArguments('generated', directory, false, true), {
        cwd: directory, encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
}

test('real extractor identifies fetchall iterable and row indexes, never execute result or expected values', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-consumption-'));
    try {
        const context = extract(directory, source);
        const prompt = formatDependencyMockContract('sample', context);
        assert.match(prompt, /cursor\.fetchall\.return_value is the exact result iterated/);
        assert.match(prompt, /Configure cursor\.fetchall\.return_value as an explicit controlled iterable/);
        assert.match(prompt, /Each item must support \[1\]; a tuple\/list fixture needs at least 2 entries/);
        assert.match(prompt, /a compatible mapping\/object may also satisfy/);
        assert.match(prompt, /supplies no expected output or exception/);
        assert.doesNotMatch(prompt, /Fixture shape: cursor\.execute/);
        assert.match(prompt, /Input cursor is used with methods execute, fetchall/);
        const candidate = 'import unittest\nfrom unittest.mock import MagicMock\nfrom sample import target\n'
            + 'class Cases(unittest.TestCase):\n    def test_rows(self):\n'
            + '        cursor = MagicMock()\n        cursor.execute.return_value = [("first",), ("second",)]\n'
            + '        self.assertEqual(target(cursor, "controlled-table"), ["first", "second"])\n';
        const failed = execute(directory, candidate);
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, /AssertionError: Lists differ: \[\]/);
        assert.equal(isMockInitializationFailure(candidate, failed.stderr), false);
        assert.equal(canRepairTestMethod(candidate, failed.stderr), true, 'a unique actual assertion remains repairable');
        const repairPrompt = getBugFixerUserPrompt(candidate, failed.stderr, 'target', ['cursor', 'table'], source, context, 'sample');
        assert.match(repairPrompt, /Configure cursor\.fetchall\.return_value/);
        const correct = candidate.replace('cursor.execute.return_value = [("first",), ("second",)]',
            'cursor.fetchall.return_value = [(0, "first"), (1, "second")]');
        const passed = execute(directory, correct);
        assert.equal(passed.status, 0, passed.stdout + passed.stderr);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), source);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('shape guidance refuses stale source identities, oracle flags and unproven conditional item requirements', () => {
    const context: any = { name: 'target', code: source, dependency_fixture_contract: {
        schemaVersion: 'dependency-fixture-contract-v1', target: 'target', sourceHashKind: 'normalized-target-source',
        targetSourceHash: createHash('sha256').update(source).digest('hex'), authority: 'fixture-shape-only',
        status: 'partial', assertionOracle: false, patchAuthorization: false,
        flows: [{ root: { kind: 'parameter', name: 'cursor' }, steps: [], method: 'fetchall',
            resultConsumption: { kind: 'iterable', itemAccesses: [{ kind: 'index', index: 1 }] } }] } };
    assert.match(formatFixtureConsumptionGuidance('sample', context), /cursor\.fetchall\.return_value/);
    const instance = formatDependencyMockContract('sample', { class_name: 'Service', method_kind: 'instance',
        signature: [{ name: 'self' }, { name: 'cursor' }], calls: ['self.prepare', 'cursor.execute'] });
    assert.doesNotMatch(instance, /Input self is used with methods/);
    assert.match(instance, /Input cursor is used with methods execute/);
    const staticMethod = formatDependencyMockContract('sample', { class_name: 'Service', method_kind: 'static',
        signature: [{ name: 'cursor' }], calls: ['cursor.execute'] });
    assert.match(staticMethod, /Input cursor is used with methods execute/);
    for (const change of [{ targetSourceHash: '0'.repeat(64) }, { target: 'other' }, { assertionOracle: true },
        { patchAuthorization: true }, { status: 'unsupported' }]) {
        assert.equal(formatFixtureConsumptionGuidance('sample', { ...context,
            dependency_fixture_contract: { ...context.dependency_fixture_contract, ...change } }), '');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-unknown-'));
    try {
        const conditional = extract(directory, 'def target(cursor, keep):\n    return [row[1] for row in cursor.fetchall() if keep(row)]\n');
        assert.equal(formatFixtureConsumptionGuidance('sample', conditional), '');
        const scalar = extract(directory, 'def target(cursor):\n    cursor.execute("controlled")\n');
        assert.match(formatDependencyMockContract('sample', scalar), /Input cursor is used with methods execute;.*not a string\/scalar/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual missing optional patch attribute routes to Writer, then executes and requires a fresh review', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-entry-routing-'));
    const targetSource = 'from types import SimpleNamespace\nruntime = SimpleNamespace()\ndef target():\n    return getattr(runtime, "enabled", False)\n';
    const candidate = 'import unittest\nfrom unittest.mock import patch\nimport sample\nfrom sample import target\n'
        + 'class Cases(unittest.TestCase):\n    def test_flag(self):\n'
        + '        with patch.object(sample.runtime, "enabled", True):\n            self.assertIs(target(), True)\n';
    try {
        extract(directory, targetSource);
        const failed = execute(directory, candidate);
        assert.notEqual(failed.status, 0);
        assert.equal(isMockInitializationFailure(candidate, failed.stderr), true, failed.stderr);
        assert.equal(canRepairTestMethod(candidate, failed.stderr), false);
        const correct = candidate.replace('"enabled", True)', '"enabled", True, create=True)');
        const roles: string[] = [], events: string[] = [];
        let reviewed = '';
        const result = await validateTestCandidate(candidate, {
            validate: async () => undefined,
            execute: async code => { const execution = execute(directory, code);
                return { ok: execution.status === 0, out: execution.stderr, qualityGaps: [], testModule: 'generated' }; },
            revise: async (_code, _failure, role) => { roles.push(role); return correct; },
            review: async code => { reviewed = code; return { issues: [] }; },
            event: (stage, status, detail: any) => { events.push(`${stage}:${status}:${detail?.action || ''}`); },
            checkCancelled: () => {}
        }, 1);
        assert.deepEqual(roles, ['writer']);
        assert.ok(events.includes('repair-routing:selected:writer-fixture-setup'));
        assert.equal(result.execution.ok, true);
        assert.equal(reviewed, correct);
        assert.equal(result.approvedCodeHash, createHash('sha256').update(correct).digest('hex'));
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), targetSource);
        assert.equal(isMockInitializationFailure(candidate.replace('with patch.object', 'with something.object'), failed.stderr), false);
        assert.equal(isMockInitializationFailure(candidate, failed.stderr.replace('ERROR:', 'FAIL:')), false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a target-internal mock AttributeError is not reclassified as generated fixture initialization', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'target-mock-error-'));
    const targetSource = 'from unittest.mock import patch\nfrom types import SimpleNamespace\nruntime = SimpleNamespace()\n'
        + 'def target():\n    with patch.object(runtime, "absent", True):\n        return True\n';
    const candidate = 'import unittest\nfrom unittest.mock import patch\nfrom sample import target\n'
        + 'class Cases(unittest.TestCase):\n    def test_target(self):\n        self.assertIs(target(), True)\n';
    try {
        extract(directory, targetSource);
        const failed = execute(directory, candidate);
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, /does not have the attribute/);
        assert.equal(isMockInitializationFailure(candidate, failed.stderr), false);
        assert.equal(canRepairTestMethod(candidate, failed.stderr), true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('optional packaging and source-file branches use scoped owners and the controlled resolved parent', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'path-source-shape-'));
    const targetSource = 'import sys as runtime\nfrom pathlib import Path\ndef target():\n'
        + '    if getattr(runtime, "packaged", False):\n        return Path(runtime.executable).resolve().parent\n'
        + '    return Path(__file__).resolve().parent\n';
    try {
        const context = extract(directory, targetSource);
        const guidance = formatDependencyMockContract('sample', context);
        assert.match(guidance, /patch\.object\(sample\.runtime, "packaged", controlled_value, create=True\)/);
        assert.match(guidance, /patch "sample\.__file__" within the test/);
        assert.match(guidance, /path-constructor argument is input, not the returned resolved parent/);
        const candidate = 'import unittest\nfrom unittest.mock import patch\nimport sample\nfrom sample import target\n'
            + 'class Cases(unittest.TestCase):\n'
            + '    def test_packaged(self):\n'
            + '        with patch.object(sample.runtime, "packaged", True, create=True):\n'
            + '            with patch.object(sample.runtime, "executable", "controlled-executable"):\n'
            + '                with patch("sample.Path") as path_factory:\n'
            + '                    path_factory.return_value.resolve.return_value.parent = "controlled-parent"\n'
            + '                    self.assertEqual(target(), "controlled-parent")\n'
            + '                    path_factory.assert_called_once_with("controlled-executable")\n'
            + '                    path_factory.return_value.resolve.assert_called_once_with()\n'
            + '    def test_source_file(self):\n'
            + '        with patch.object(sample.runtime, "packaged", False, create=True):\n'
            + '            with patch("sample.__file__", "controlled-source-file"):\n'
            + '                with patch("sample.Path") as path_factory:\n'
            + '                    path_factory.return_value.resolve.return_value.parent = "controlled-parent"\n'
            + '                    self.assertEqual(target(), "controlled-parent")\n'
            + '                    path_factory.assert_called_once_with("controlled-source-file")\n'
            + '                    path_factory.return_value.resolve.assert_called_once_with()\n';
        const wrong = execute(directory, candidate.replace('self.assertEqual(target(), "controlled-parent")',
            'self.assertEqual(target(), "controlled-executable")'));
        assert.notEqual(wrong.status, 0, 'constructor input is not an expected parent value');
        const correct = execute(directory, candidate);
        assert.equal(correct.status, 0, correct.stdout + correct.stderr);
        assert.match(correct.stderr, /Ran 2 tests/);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), targetSource);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
