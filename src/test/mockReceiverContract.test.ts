import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildCompactWriterContext, buildWriterRevisionContext } from '../prompts/compactWriterContext';
import { formatFixtureReceiverGuidance, formatDependencyMockContract } from '../prompts/dependencyMockContract';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { pythonToolPath } from '../pipeline/pythonTools';
import { generatedUnittestArguments, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const source = 'import sqlite3 as storage\n'
    + 'def target():\n    connection = storage.connect("controlled")\n    cursor = connection.cursor()\n'
    + '    cursor.execute("first")\n    cursor.execute("second")\n    connection.commit()\n';

function extract(directory: string, code = source): any {
    const file = path.join(directory, 'sample.py');
    fs.writeFileSync(file, code);
    const result = spawnSync(python, ['-B', pythonToolPath('ast'), file, 'target'], {
        encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), code);
    return JSON.parse(result.stdout);
}

function evidence(code: string): WriterEvidenceBundleV3 {
    const sourceHash = createHash('sha256').update(code).digest('hex');
    return { schemaVersion: 'writer-evidence-v3', sourceHash, semanticGuidance: '',
        ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash, ids: [], selectedRules: [],
            guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
        evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance'] };
}

function run(directory: string, candidate: string) {
    fs.writeFileSync(path.join(directory, 'generated.py'), candidate);
    return spawnSync(python, generatedUnittestArguments('generated', directory, false, true), {
        cwd: directory, encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
}

test('compact generation keeps canonical target and source receiver paths when optional topology cannot fit', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receiver-projection-'));
    try {
        const context = extract(directory);
        const compact = buildCompactWriterContext({ module: 'sample', name: 'target', source: context.code,
            context, evidence: evidence(context.code), budgetTokens: 1 });
        const revision = buildWriterRevisionContext({ module: 'sample', name: 'target', source: context.code,
            context, evidence: evidence(context.code) });
        for (const prompt of [compact, revision]) {
            assert.match(prompt, /Target import: from sample import target/);
            assert.match(prompt, /never patch the target itself/);
            assert.match(prompt, /Source-consumed receiver objects: \["sample\.storage\.connect\.return_value\.cursor\.return_value"\]/);
            assert.match(prompt, /Source call sites are not executed call counts/);
            assert.match(prompt, /Do not guess call_count=1 or put several assert_called_once_with/);
            assert.match(prompt, /independently justified expectations and the exact argument types/);
            assert.match(prompt, /not patch authorization or expected target values/);
        }
        assert.match(compact, /Topology\/legend omitted whole for budget/);
        assert.doesNotMatch(compact, /SOURCE CONSUMPTION TOPOLOGY/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('receiver projection refuses stale, mismatched and oracle-bearing contracts without granting unknown shapes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receiver-identity-'));
    try {
        const context = extract(directory);
        const original = context.dependency_fixture_contract;
        for (const change of [{ targetSourceHash: '0'.repeat(64) }, { target: 'other' },
            { assertionOracle: true }, { patchAuthorization: true }, { status: 'unsupported' }]) {
            assert.equal(formatFixtureReceiverGuidance('sample', { ...context,
                dependency_fixture_contract: { ...original, ...change } }), '');
        }
        const unknown = extract(directory, 'def target(provider):\n    value = provider()\n    value = "rebound"\n    return value\n');
        assert.equal(formatFixtureReceiverGuidance('sample', unknown), '');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('scaffold retains consumed connection/cursor receivers without inventing fixture values or assertions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-receiver-'));
    try {
        extract(directory);
        const result = spawnSync(python, ['-B', pythonToolPath('scaffold'), path.join(directory, 'sample.py'), 'target', '{}', 'sample'], {
            encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(result.status, 0, result.stderr);
        const scaffold = JSON.parse(result.stdout);
        assert.deepEqual(scaffold.patches, ['sample.storage.connect']);
        assert.match(scaffold.scaffold, /mock_connect\.return_value\.cursor\.return_value/);
        assert.doesNotMatch(scaffold.scaffold, /mock_connect\.return_value = None/);
        assert.doesNotMatch(scaffold.scaffold, /assert_called|return_value = ["']/);
        assert.equal(scaffold.executable, false);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), source);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a controlled dependency must retain its receiver and multiple source calls do not become once assertions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receiver-execution-'));
    const candidate = 'import unittest\nfrom unittest.mock import patch, call\nfrom sample import target\n'
        + 'class Cases(unittest.TestCase):\n    def test_target(self):\n'
        + '        with patch("sample.storage.connect") as factory:\n'
        + '            target()\n            cursor = factory.return_value.cursor.return_value\n'
        + '            cursor.execute.assert_called_once_with("first")\n'
        + '            cursor.execute.assert_called_once_with("second")\n';
    try {
        extract(directory);
        const scalarFailure = run(directory, candidate.replace('            target()',
            '            factory.return_value = "wrong-shape"\n            target()'));
        assert.notEqual(scalarFailure.status, 0);
        assert.match(scalarFailure.stderr, /AttributeError: 'str' object has no attribute 'cursor'/);
        const countFailure = run(directory, candidate);
        assert.notEqual(countFailure.status, 0);
        assert.match(countFailure.stderr, /Expected 'execute' to be called once\. Called 2 times/);
        const corrected = candidate.replace('cursor.execute.assert_called_once_with("first")\n'
            + '            cursor.execute.assert_called_once_with("second")',
        'self.assertEqual(cursor.execute.call_args_list, [call("first"), call("second")])');
        assert.equal(validateUnittestStructure(corrected, 'target', 'sample', 'call', [], undefined, true).valid, true);
        const passed = run(directory, corrected);
        assert.equal(passed.status, 0, passed.stdout + passed.stderr);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), source);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('source call setup retains the consumed module binding instead of its upstream input', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-argument-type-'));
    const targetSource = 'import sqlite3 as storage\nfrom pathlib import PurePath\n'
        + 'UPSTREAM = PurePath("controlled")\nCONSUMED = str(UPSTREAM)\n'
        + 'def target():\n    return storage.connect(CONSUMED)\n';
    const candidate = 'import unittest\nfrom unittest.mock import patch\nimport sample\n'
        + 'class Cases(unittest.TestCase):\n    def test_target(self):\n'
        + '        with patch("sample.storage.connect") as dependency:\n'
        + '            sample.target()\n            dependency.assert_called_once_with(sample.UPSTREAM)\n';
    try {
        const context = extract(directory, targetSource);
        const prompt = formatDependencyMockContract('sample', context, [], false);
        assert.match(prompt, /Call setup storage\.connect: arg 1: sample\.CONSUMED/);
        assert.match(prompt, /str\(path\) is not the Path object/);
        const failed = run(directory, candidate);
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, /AssertionError: expected call not found/);
        const passed = run(directory, candidate.replace('sample.UPSTREAM)', 'sample.CONSUMED)'));
        assert.equal(passed.status, 0, passed.stdout + passed.stderr);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), targetSource);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
