import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { formatDependencyMockContract, formatFixtureConsumptionGuidance, sourceSetupCallGuidance } from '../prompts/dependencyMockContract';
import { buildCompactWriterContext, buildWriterRevisionContext } from '../prompts/compactWriterContext';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { getUserPrompt } from '../roles/unittestWriter';
import { validateUnittestStructure } from '../validation/generatedTestValidator';
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

function evidence(code: string): WriterEvidenceBundleV3 {
    const sourceHash = createHash('sha256').update(code).digest('hex');
    return { schemaVersion: 'writer-evidence-v3', sourceHash, semanticGuidance: '',
        ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash, ids: [], selectedRules: [],
            guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
        evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance'] };
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

test('side-effect return facts reach Writer and Fixer; repaired tests verify effects in two neutral source shapes', async () => {
    for (const parameter of [false, true]) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-return-'));
        const targetSource = parameter ? 'def target(store):\n    store.create(bind=store)\n'
            : 'from types import SimpleNamespace\nengine = object()\nstorage = SimpleNamespace(create=lambda **kwargs: None)\n'
                + 'def target():\n    storage.create(bind=engine)\n';
        const setup = parameter ? '        dependency = MagicMock()\n'
            : '        self.enterContext(patch("sample.storage.create"))\n        dependency = sample.storage\n';
        const call = parameter ? 'target(dependency)' : 'target()';
        const expectedBinding = parameter ? 'dependency' : 'sample.engine';
        const candidate = 'import unittest\nfrom unittest.mock import MagicMock, patch\nimport sample\nfrom sample import target\n'
            + 'class Cases(unittest.TestCase):\n    def test_effect(self):\n' + setup
            + '        dependency.create.return_value = "dependency-value"\n'
            + `        result = ${call}\n        self.assertEqual(result, "dependency-value")\n`;
        const correct = candidate.replace('self.assertEqual(result, "dependency-value")',
            `self.assertIsNone(result)\n        dependency.create.assert_called_once_with(bind=${expectedBinding})`);
        try {
            const context = extract(directory, targetSource);
            assert.equal(context.source_setup_call_contract.returnFlow.kind, 'normal-completion-none');
            const input = { module: 'sample', name: 'target', source: context.code, context, evidence: evidence(context.code) };
            for (const prompt of [buildCompactWriterContext({ ...input, budgetTokens: 6000 }), buildWriterRevisionContext(input)]) {
                assert.match(prompt, /SOURCE_RETURN_FLOW_V1/);
                assert.match(prompt, /Mock\.return_value is not automatically the target return/);
                assert.match(prompt, /assertIsNone alone does not verify those effects/);
            }
            const failed = execute(directory, candidate);
            assert.notEqual(failed.status, 0);
            assert.equal(canRepairTestMethod(candidate, failed.stderr), true);
            const repairPrompt = getBugFixerUserPrompt(candidate, failed.stderr, 'target', context.args, context.code, context, 'sample');
            assert.match(repairPrompt, /SOURCE_RETURN_FLOW_V1/);
            let reviewed = '';
            const result = await validateTestCandidate(candidate, {
                validate: async () => undefined,
                execute: async code => { const run = execute(directory, code);
                    return { ok: run.status === 0, out: run.stderr, qualityGaps: [], testModule: 'generated' }; },
                revise: async () => correct,
                review: async code => { reviewed = code; return { issues: [] }; },
                event: () => {},
                checkCancelled: () => {}
            }, 1);
            assert.equal(result.execution.ok, true);
            assert.equal(reviewed, correct);
            assert.equal(result.approvedCodeHash, createHash('sha256').update(correct).digest('hex'));
            // A None-only assertion could survive a removed side effect. The
            // concrete repair must detect that mutation as well as the return.
            extract(directory, targetSource.replace(parameter ? 'store.create(bind=store)' : 'storage.create(bind=engine)', 'pass'));
            assert.notEqual(execute(directory, correct).status, 0);
            extract(directory, targetSource);
            for (const changed of [{ targetSourceHash: '0'.repeat(64) }, { returnFlow: { kind: 'normal-completion-none', discardedCalls: 'invalid' } }]) {
                assert.equal(sourceSetupCallGuidance('sample', { ...context,
                    source_setup_call_contract: { ...context.source_setup_call_contract, ...changed } }), '');
            }
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
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

test('first compact Writer keeps consumed result shape even when optional topology does not fit', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'first-writer-fixture-'));
    try {
        const context = extract(directory, source);
        const input = { module: 'sample', name: 'target', source: context.code, context, evidence: evidence(context.code) };
        const first = buildCompactWriterContext({ ...input, budgetTokens: 1 });
        const revision = buildWriterRevisionContext(input);
        for (const prompt of [first, revision, formatDependencyMockContract('sample', context, undefined, false),
            getUserPrompt('sample.py', 'target', source, 'small', context, undefined, 1, '', input.evidence),
            getUserPrompt('sample.py', 'target', source, 'large', context, undefined, 1, '', input.evidence)]) {
            assert.match(prompt, /Configure cursor\.fetchall\.return_value as an explicit controlled iterable/);
            assert.match(prompt, /Each item must support \[1\]/);
            assert.doesNotMatch(prompt, /Fixture shape: cursor\.execute/);
        }
        assert.ok(first.includes(context.code), 'retain the exact extractor target fragment and its source identity');
        assert.match(first, /Topology\/legend omitted whole for budget/);
        assert.doesNotMatch(first, /SOURCE CONSUMPTION TOPOLOGY/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('source call setup retains the converted module binding rather than a path object or literal', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'module-argument-fixture-'));
    const targetSource = 'from pathlib import Path\nimport sqlite3\nDB_PATH = Path("controlled-location")\nDB_NAME = str(DB_PATH)\n'
        + 'def target():\n    return sqlite3.connect(DB_NAME)\n';
    try {
        const context = extract(directory, targetSource);
        const prompt = sourceSetupCallGuidance('sample', context);
        assert.match(prompt, /Call setup sqlite3\.connect: arg 1: sample\.DB_NAME/);
        assert.match(prompt, /do not substitute an upstream variable or hard-coded path/);
        const candidate = 'import unittest\nfrom unittest.mock import patch\nimport sample\n'
            + 'class Cases(unittest.TestCase):\n    def test_dependency(self):\n'
            + '        with patch("sample.sqlite3.connect") as connect:\n'
            + '            expected = connect.return_value\n            self.assertIs(sample.target(), expected)\n'
            + '            connect.assert_called_once_with(sample.DB_NAME)\n';
        const incorrect = execute(directory, candidate.replace('with(sample.DB_NAME)', 'with(sample.DB_PATH)'));
        assert.notEqual(incorrect.status, 0);
        assert.match(incorrect.stderr, /expected call not found/);
        const correct = execute(directory, candidate);
        assert.equal(correct.status, 0, correct.stdout + correct.stderr);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), targetSource);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('UI parameter spellings keep attribute objects and nested member identity in first and revision prompts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parameter-object-fixture-'));
    const targetSource = 'def target(page, dialog):\n    page.overlay.append(dialog)\n    dialog.open = True\n    page.update()\n';
    try {
        const context = extract(directory, targetSource);
        const input = { module: 'sample', name: 'target', source: context.code, context, evidence: evidence(context.code) };
        for (const prompt of [buildCompactWriterContext({ ...input, budgetTokens: 1 }), buildWriterRevisionContext(input)]) {
            assert.match(prompt, /Parameter object setup page: page\.overlay\.append\(\) \[call\]; page\.update\(\) \[call\]/);
            assert.match(prompt, /Parameter object setup dialog: dialog\.open \[write\]/);
            assert.match(prompt, /dictionary keys do not satisfy dot attribute access/);
            assert.match(prompt, /do not patch sample\.page merely because it is a parameter/);
            assert.match(prompt, /never an attribute value, concrete type or expected target result/);
        }
        const candidate = 'import unittest\nfrom unittest.mock import MagicMock\nfrom types import SimpleNamespace\nfrom sample import target\n'
            + 'class Cases(unittest.TestCase):\n    def test_dependency(self):\n'
            + '        page = SimpleNamespace(overlay=SimpleNamespace(append=MagicMock()), update=MagicMock())\n'
            + '        dialog = SimpleNamespace(open=False)\n        target(page, dialog)\n'
            + '        page.overlay.append.assert_called_once_with(dialog)\n        page.update.assert_called_once_with()\n';
        const structure = validateUnittestStructure(candidate, 'target', 'sample', 'call', [], undefined, true);
        assert.equal(structure.valid, true, structure.reason);
        const checked = spawnSync(python, ['-B', pythonToolPath('bindings'), '--payload'], {
            encoding: 'utf8', timeout: 10000, input: JSON.stringify({ code: candidate,
                context: { module: 'sample', target: 'target', source: context.code, dependencies: {}, targetUsage: 'call',
                    requireTargetBehavior: structure.requiresTargetBehaviorEvidence,
                    requireMockBehavior: structure.requiresMockBehaviorEvidence } }) });
        assert.equal(checked.status, 0, checked.stderr);
        const binding = JSON.parse(checked.stdout);
        assert.equal(binding.valid, true, binding.reason);
        const incorrect = execute(directory, candidate.replace('page = SimpleNamespace(overlay=SimpleNamespace(append=MagicMock()), update=MagicMock())',
            'page = {"overlay": []}').replace('dialog = SimpleNamespace(open=False)', 'dialog = {"open": False}'));
        assert.notEqual(incorrect.status, 0);
        assert.match(incorrect.stderr, /has no attribute 'overlay'/);
        const correct = execute(directory, candidate);
        assert.equal(correct.status, 0, correct.stdout + correct.stderr);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), targetSource);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('parameter member guidance refuses stale, malformed, undeclared and target-instance facts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parameter-shape-validation-'));
    try {
        const context = extract(directory, 'def target(page):\n    page.update()\n');
        const original = context.source_setup_call_contract;
        for (const change of [{ targetSourceHash: '0'.repeat(64) }, { assertionOracle: true },
            { parameterMembers: [{ parameter: 'other', members: ['update'], usage: 'call', line: 2 }] },
            { parameterMembers: [{ parameter: 'page', members: ['member;payload'], usage: 'call', line: 2 }] },
            { parameterMembers: [{ parameter: 'page', members: ['update'], usage: 'expected-output', line: 2 }] },
            { parameterMembers: Array.from({ length: 65 }, () => original.parameterMembers[0]) }]) {
            assert.equal(sourceSetupCallGuidance('sample', { ...context,
                source_setup_call_contract: { ...original, ...change } }), '');
        }
        const rebound = extract(directory, 'def target(page):\n    page.update()\n    page = object()\n');
        assert.doesNotMatch(sourceSetupCallGuidance('sample', rebound), /Parameter object setup/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
