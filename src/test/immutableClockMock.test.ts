import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { formatDependencyMockContract } from '../prompts/dependencyMockContract';
import { buildWriterRevisionContext } from '../prompts/compactWriterContext';
import { getUserPrompt } from '../roles/unittestWriter';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { generatedUnittestArguments, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';

const source = 'from datetime import datetime as Clock\ndef stamp():\n    return Clock.now().strftime("%H:%M")\n';
const clockFlow = { root: { kind: 'use-point', name: 'Clock' }, steps: [], method: 'now', line: 3 };
const context = { name: 'stamp', code: source, args: [], signature: [], method_kind: 'module', calls: ['Clock.now'],
    file_imports: [{ kind: 'from', module: 'datetime', name: 'datetime', alias: 'Clock', bound_name: 'Clock' }],
    dependency_fixture_contract: { schemaVersion: 'dependency-fixture-contract-v1', status: 'complete',
        flows: [clockFlow, { root: clockFlow.root, steps: [{ kind: 'member', name: 'now' }, { kind: 'return_value' }],
            method: 'strftime', line: 3 }] } };
const evidence: WriterEvidenceBundleV3 = { schemaVersion: 'writer-evidence-v3', sourceHash: 'neutral-clock-source', semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'neutral-clock-source', ids: [], selectedRules: [],
        guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance'] };

test('generation and revision receive the exact source-supported owner and return chain without an output oracle', () => {
    const prompts = [getUserPrompt('sample.py', 'stamp', source, 'small', context, undefined, 4000, '', evidence),
        getUserPrompt('sample.py', 'stamp', source, 'large', context, undefined, 4000, '', evidence),
        buildWriterRevisionContext({ module: 'sample', name: 'stamp', source, context, evidence })];
    for (const prompt of prompts) {
        assert.ok(prompt.includes(source));
        assert.match(prompt, /with patch\('sample\.Clock'\) as clock_stub/);
        assert.match(prompt, /clock_stub\.now\.return_value = controlled_clock_value/);
        assert.match(prompt, /concrete real datetime fixture imported through a separate test-local alias/);
        assert.match(prompt, /leaving its real strftime to execute/);
        assert.match(prompt, /Never mock strftime or configure its return_value from expected text/);
        assert.doesNotMatch(prompt, /\.strftime\.return_value = controlled_text/);
        assert.match(prompt, /never patch datetime\.datetime\.now or a built-in type member/);
        assert.match(prompt, /selected target callable intact/);
        assert.match(prompt, /not an observed assertion oracle/);
        assert.doesNotMatch(prompt, /patch\('sample\.stamp'\)/);
    }
});

test('module imports replace their local owner and unknown or absent receiver layers stay unknown', () => {
    const moduleContext = { ...context, code: 'def stamp():\n    return dates.datetime.now()\n',
        file_imports: [{ kind: 'import', module: 'datetime', alias: 'dates', bound_name: 'dates' }],
        dependency_fixture_contract: { ...context.dependency_fixture_contract,
            flows: [{ root: { kind: 'use-point', name: 'dates' }, steps: [{ kind: 'member', name: 'datetime' }], method: 'now' }] } };
    const prompt = formatDependencyMockContract('pkg.sample', moduleContext);
    assert.match(prompt, /with patch\('pkg\.sample\.dates'\) as clock_stub/);
    assert.match(prompt, /clock_stub\.datetime\.now\.return_value = controlled_clock_value/);
    assert.doesNotMatch(prompt, /\.strftime\.return_value =/);
    assert.doesNotMatch(prompt, /patch\('pkg\.sample\.dates\.datetime/);
    assert.doesNotMatch(prompt, /concrete real .* fixture/, 'no recorded formatter means no formatter-specific advice');
    const formatterContext = { ...moduleContext, dependency_fixture_contract: { ...moduleContext.dependency_fixture_contract,
        flows: [...moduleContext.dependency_fixture_contract.flows, { root: { kind: 'use-point', name: 'dates' },
            steps: [{ name: 'datetime', kind: 'member' }, { name: 'now', kind: 'member' }, { kind: 'return_value' }],
            method: 'strftime' }] } };
    assert.match(formatDependencyMockContract('pkg.sample', formatterContext), /concrete real datetime fixture/);
    const dateContext = { ...context, code: 'def stamp():\n    return Day.today().strftime("%Y")\n',
        file_imports: [{ kind: 'from', module: 'datetime', name: 'date', alias: 'Day', bound_name: 'Day' }],
        dependency_fixture_contract: { ...context.dependency_fixture_contract, flows: [
            { root: { kind: 'use-point', name: 'Day' }, steps: [], method: 'today' },
            { root: { kind: 'use-point', name: 'Day' }, steps: [{ kind: 'member', name: 'today' }, { kind: 'return_value' }], method: 'strftime' }
        ] } };
    const dateGuidance = formatDependencyMockContract('pkg.sample', dateContext);
    assert.match(dateGuidance, /patch\('pkg\.sample\.Day'\)/);
    assert.match(dateGuidance, /clock_stub\.today\.return_value = controlled_clock_value/);
    assert.match(dateGuidance, /concrete real date fixture/);
    const unrelatedReceiver = { ...formatterContext, dependency_fixture_contract: { ...formatterContext.dependency_fixture_contract,
        flows: [moduleContext.dependency_fixture_contract.flows[0], { root: { kind: 'use-point', name: 'dates' },
            steps: [{ kind: 'member', name: 'datetime' }, { kind: 'member', name: 'other' }, { kind: 'return_value' }], method: 'strftime' }] } };
    assert.doesNotMatch(formatDependencyMockContract('pkg.sample', unrelatedReceiver), /concrete real .* fixture/);
    for (const changed of [
        { ...context, name: 'Clock.stamp' },
        { ...context, dependency_fixture_contract: undefined },
        { ...context, dependency_fixture_contract: { ...context.dependency_fixture_contract, status: 'unsupported' } },
        { ...context, file_imports: [{ kind: 'from', module: 'other', name: 'datetime', alias: 'Clock' }] },
        { ...context, dependency_fixture_contract: { ...context.dependency_fixture_contract,
            flows: [{ ...clockFlow, root: { kind: 'parameter', name: 'Clock' } }] } }
    ]) {
        assert.doesNotMatch(formatDependencyMockContract('sample', changed), /IMMUTABLE CLOCK SETUP/);
    }
});

test('scoped owner replacement executes the real target while immutable-member patch fails and original bindings restore', () => {
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-clock-'));
    const testCode = 'import unittest\nfrom unittest.mock import patch\nfrom datetime import datetime as RealClock\nimport sample\n'
        + 'class Cases(unittest.TestCase):\n    def test_controlled_clock(self):\n'
        + '        with self.assertRaises(TypeError):\n            with patch("sample.Clock.now"):\n                pass\n'
        + '        self.assertIs(sample.Clock, RealClock)\n'
        + '        with patch("sample.Clock") as clock_stub:\n'
        + '            fixed_clock = RealClock(2031, 2, 3, 14, 27, 19)\n'
        + '            clock_stub.now.return_value = fixed_clock\n'
        + '            self.assertEqual(sample.stamp(), "14:27")\n'
        + '            clock_stub.now.assert_called_once_with()\n'
        + '            self.assertIs(clock_stub.now.return_value, fixed_clock)\n'
        + '        self.assertIs(sample.Clock, RealClock)\n';
    try {
        fs.writeFileSync(path.join(directory, 'sample.py'), source);
        fs.writeFileSync(path.join(directory, 'generated.py'), testCode);
        const run = spawnSync(python, generatedUnittestArguments('generated', directory, false, true), {
            cwd: directory, encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.match(run.stderr, /Ran 1 test/);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), source);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a real clock fixture kills formatter mutations that a fixed mock formatting result hides', () => {
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-formatter-mutants-'));
    const sourceFile = path.join(directory, 'sample.py');
    const testFile = path.join(directory, 'test_stamp.py');
    // The neutral fixture's explicit test contract is HH:MM for a controlled
    // datetime input. No application output, live clock or guessed oracle is used.
    const candidate = (realFormatter: boolean) => 'import unittest\nfrom unittest.mock import patch\n'
        + 'from datetime import datetime as RealClock\nimport sample\n'
        + 'class Cases(unittest.TestCase):\n    def test_stamp(self):\n'
        + '        with patch("sample.Clock") as clock_stub:\n'
        + (realFormatter ? '            clock_stub.now.return_value = RealClock(2031, 2, 3, 14, 27, 19)\n'
            : '            clock_stub.now.return_value.strftime.return_value = "14:27"\n')
        + '            self.assertEqual(sample.stamp(), "14:27")\n'
        + '            clock_stub.now.assert_called_once_with()\n';
    const measure = (realFormatter: boolean) => {
        fs.writeFileSync(testFile, candidate(realFormatter));
        const run = spawnSync(python, ['-B', pythonToolPath('mutation'), sourceFile, testFile, '0', '5', 'stamp', '', '30', '1'], {
            cwd: directory, encoding: 'utf8', timeout: 40000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(run.status, 0, run.stderr);
        const value = JSON.parse(run.stdout);
        assert.equal(value.engine, 'builtin');
        assert.equal(value.operatorSetVersion, 'builtin-ast-v2');
        assert.equal(value.executionBackend, 'isolated-unittest-v1');
        assert.equal(value.baseline_passed, true);
        assert.equal(value.status, 'complete');
        assert.equal(value.counts.executed, value.counts.available);
        assert.equal(value.counts.error, 0);
        assert.equal(value.counts.timeout, 0);
        assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
        return value;
    };
    try {
        fs.writeFileSync(sourceFile, source);
        const hidden = measure(false);
        const measured = measure(true);
        const formatting = (value: any) => value.mutants.filter((mutant: any) => mutant.kind === 'string_constant');
        assert.equal(formatting(hidden).length, 2);
        assert.ok(formatting(hidden).every((mutant: any) => mutant.status === 'SURVIVED'));
        assert.equal(formatting(measured).length, 2);
        assert.ok(formatting(measured).every((mutant: any) => mutant.status === 'KILLED'
            && mutant.killedBy.includes('test_stamp.Cases.test_stamp')));
        assert.ok(measured.counts.killed > hidden.counts.killed);
        assert.equal(measured.counts.survived, 0);
        assert.equal(measured.sourceHash, hidden.sourceHash);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
