import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTier1TestFile } from '../tier/tier1TestFileBuilder';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';
import { preflightTargetModule, preflightFailureCacheSize } from '../pipeline/modulePreflight';
import { validateUnittestStructure } from '../validation/generatedTestValidator';
import { ReviewSession } from '../roles/reviewSession';
import { qualifiedRole, RoleQualificationProfile } from '../llm/roleQualification';
import { canUseModelAuthoredRepair, canUseTierOneLlmGeneration } from '../tier/tierRouter';

test('Reviewer cache and consecutive failure limit bound requests without turning unknown into approval', async () => {
    const session = new ReviewSession();
    const events: string[] = [];
    let requests = 0;
    const event = (status: string) => { events.push(status); };
    const unavailable = async () => { requests++; return undefined; };
    assert.equal(await session.review('candidate-a/context-a', unavailable, event), undefined);
    assert.equal(await session.review('candidate-a/context-a', unavailable, event), undefined);
    assert.equal(await session.review('candidate-b/context-a', unavailable, event), undefined);
    assert.equal(await session.review('candidate-c/context-a', unavailable, event), undefined);
    assert.equal(requests, 2);
    assert.deepEqual(events, ['cache-hit', 'suspended']);
    const fresh = new ReviewSession();
    const valid = async () => { requests++; return { issues: [] }; };
    assert.deepEqual(await fresh.review('a/context-a', valid, event), { issues: [] });
    assert.deepEqual(await fresh.review('a/context-a', unavailable, event), { issues: [] });
    await fresh.review('a/context-b', valid, event);
    assert.equal(requests, 4, 'changed evidence must be reviewed; a new analysis must retry');
    await assert.rejects(fresh.review('cancelled', async () => { throw new Error('cancelled'); }, event));
    assert.deepEqual(await fresh.review('cancelled', valid, event), { issues: [] });
});

test('Auto uses each current role qualification and Writer revisions never depend on Bug Fixer readiness', () => {
    const profile: RoleQualificationProfile = {
        writer: { state: 'verified', reason: 'executed' },
        reviewer: { state: 'unverified', reason: 'invalid contract' },
        bugFixer: { state: 'not-run', reason: 'not run' }
    };
    assert.equal(qualifiedRole('writer', profile, true), true);
    assert.equal(qualifiedRole('reviewer', profile, true, true), false);
    assert.equal(qualifiedRole('bugFixer', undefined, true, true), false);
    assert.equal(qualifiedRole('reviewer', undefined, true, true), false);
    assert.equal(qualifiedRole('writer', profile, false, true), false);
    assert.equal(canUseTierOneLlmGeneration(qualifiedRole('writer', profile, true), 'auto'), true);
    assert.equal(canUseModelAuthoredRepair(qualifiedRole('bugFixer', profile, true), 'auto'), false);
    assert.equal(canUseModelAuthoredRepair(false, 'tier1'), true);
});

test('mock assertions defer to the mandatory Python evidence gate instead of passing the fast validator alone', () => {
    const code = `import unittest
from unittest.mock import patch
from sample import target
class Cases(unittest.TestCase):
    def test_behavior(self):
        with patch('sample.connect') as dependency:
            target(3)
            dependency.assert_called_once_with(3)
`;
    assert.equal(validateUnittestStructure(code, 'target', 'sample').valid, false);
    assert.deepEqual(validateUnittestStructure(code, 'target', 'sample', 'call', [], undefined, true),
        { valid: true, requiresMockBehaviorEvidence: true });
});

test('private targets and source-defined exception identities produce executable Trace baselines', () => {
    const root = path.resolve(__dirname, '../..');
    const python = resolvePythonExecutable(undefined, root);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-import-contract-'));
    try {
        const source = "__all__ = []\nclass SpecificError(ValueError): pass\ndef _target(value):\n    if value < 0:\n        raise SpecificError()\n    return value + 1\n";
        const file = path.join(directory, 'sample.py');
        fs.writeFileSync(file, source);
        const trace = spawnSync(python, ['-B', path.join(root, 'python_scripts/dynamic_tracer.py'), file, '_target', '[[2], [-1]]'], { encoding: 'utf8' });
        assert.equal(trace.status, 0, trace.stderr);
        const facts = JSON.parse(trace.stdout);
        const built = buildTier1TestFile({ moduleName: 'sample', functionName: '_target', examples: facts.examples, errors: facts.errors });
        assert.ok(built.code);
        fs.writeFileSync(path.join(directory, 'baseline_test.py'), built.code);
        const executed = spawnSync(python, ['-B', '-m', 'unittest', 'baseline_test'], { cwd: directory, encoding: 'utf8' });
        assert.equal(executed.status, 0, executed.stdout + executed.stderr);
        assert.match(executed.stderr, /Ran [1-9]\d* tests?/);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('unknown Trace exceptions never become guessed broad Exception assertions', () => {
    const built = buildTier1TestFile({ moduleName: 'sample', functionName: 'target', examples: [],
        errors: [{ args: [], exception: 'UnresolvedError' }, { args: [], exception: 'invalid-type()' }] });
    assert.equal(built.methodCount, 0);
    assert.equal(built.code, undefined);
});

test('preflight deduplicates failures within a batch and sees repaired dependencies in the next batch', async () => {
    const root = path.resolve(__dirname, '../..');
    const python = resolvePythonExecutable(undefined, root);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-recovery-'));
    const runner = require('../utils/processRunner');
    const originalRun = runner.runSpawn;
    let processes = 0;
    runner.runSpawn = (...args: any[]) => { processes++; return originalRun(...args); };
    try {
        const source = path.join(directory, 'source');
        const firstOutput = path.join(directory, 'first');
        const secondOutput = path.join(directory, 'second');
        for (const folder of [source, firstOutput, secondOutput]) { fs.mkdirSync(folder); }
        const target = path.join(source, 'sample.py');
        fs.writeFileSync(target, 'import repaired_dependency\ndef target(): return 1\n');
        await runInExecution(new ExecutionContext({}), async () => {
            for (const output of [firstOutput, secondOutput]) {
                await assert.rejects(preflightTargetModule(python, target, 'sample', [source, output], output), /repaired_dependency/);
            }
            assert.equal(preflightFailureCacheSize(), 1);
            assert.equal(processes, 1);
        });
        fs.writeFileSync(path.join(source, 'repaired_dependency.py'), 'VALUE = 1\n');
        await runInExecution(new ExecutionContext({}), async () => {
            assert.equal((await preflightTargetModule(python, target, 'sample', [source, secondOutput], secondOutput)).ok, true);
            assert.equal(preflightFailureCacheSize(), 0);
        });
        assert.equal(processes, 2);
    } finally {
        runner.runSpawn = originalRun;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('transient preflight runner errors are not cached as durable module failures', async () => {
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-transient-'));
    const runner = require('../utils/processRunner');
    const originalRun = runner.runSpawn;
    let attempts = 0;
    runner.runSpawn = (...args: any[]) => {
        if (++attempts === 1) { return Promise.reject(new Error('temporary process timeout')); }
        return originalRun(...args);
    };
    try {
        const target = path.join(directory, 'sample.py');
        fs.writeFileSync(target, 'def target(): return 1\n');
        await runInExecution(new ExecutionContext({}), async () => {
            await assert.rejects(preflightTargetModule(python, target, 'sample', [directory], directory), /temporary process timeout/);
            assert.equal(preflightFailureCacheSize(), 0);
            assert.equal((await preflightTargetModule(python, target, 'sample', [directory], directory)).ok, true);
        });
        assert.equal(attempts, 2);
    } finally {
        runner.runSpawn = originalRun;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('concurrent successful preflights retain each target output import root', async () => {
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-roots-'));
    try {
        const target = path.join(directory, 'sample.py');
        fs.writeFileSync(target, 'def target(): return 1\n');
        const outputs = ['first', 'second'].map(name => path.join(directory, name));
        outputs.forEach(folder => fs.mkdirSync(folder));
        await runInExecution(new ExecutionContext({}), async () => {
            const results = await Promise.all(outputs.map(output =>
                preflightTargetModule(python, target, 'sample', [directory, output], output)));
            results.forEach((result, index) => {
                assert.ok(result.importPaths.includes(outputs[index]));
                assert.ok(!result.importPaths.includes(outputs[1 - index]));
            });
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
