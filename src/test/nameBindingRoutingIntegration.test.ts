import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AnalysisJournal } from '../pipeline/analysisJournal';
import { runExecutionVerification } from '../pipeline/executionVerification';
import { pythonToolPath } from '../pipeline/pythonTools';
import { validatePassingTestPreservation } from '../pipeline/passingTestPreservation';
import { buildGeneratedTestEnvironment, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { validateUnittestStructure } from '../validation/generatedTestValidator';
import { canRepairTestMethod } from '../roles/bugFixer';
import { wholeCandidateNameException } from '../validation/unittestException';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const yearSource = 'def target(value):\n    return value.year\n';
const missingDate = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
    + '    def test_value(self):\n        self.assertEqual(target(date(2024, 1, 1)), 2024)\n';

function inspect(tool: 'bindings' | 'repairScope', payload: unknown) {
    const result = spawnSync(python, ['-B', pythonToolPath(tool), ...(tool === 'bindings' ? ['--payload'] : [])], {
        encoding: 'utf8', timeout: 10000, input: JSON.stringify(payload), env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as { valid: boolean; reason?: string; reasonCode?: string };
}

async function runNeutral(options: { source: string; initial: string; revised: string; expectSuccess: boolean }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'name-route-'));
    const file = path.join(root, 'sample.py'), directory = path.join(root, 'result');
    const roles: string[] = [], failures: string[] = [], routing: any[] = [], rejected: string[] = [];
    let revisions = 0, gateChecks = 0;
    try {
        fs.writeFileSync(file, options.source);
        const journal = new AnalysisJournal(directory, options.source, 'target', 'neutral-scripted-role-fixture');
        const run = runExecutionVerification({ directory, file, target: 'target', python,
            env: buildGeneratedTestEnvironment(process.env, [root]), dependencies: [], journal,
            generate: async () => options.initial,
            hooks: {
                validate: async code => {
                    const structure = validateUnittestStructure(code, 'target', 'sample');
                    if (!structure.valid) { rejected.push(structure.reason || 'structure'); return structure.reason || 'structure rejected'; }
                    const binding = inspect('bindings', { code, context: { module: 'sample', target: 'target', source: options.source, dependencies: {} } });
                    if (!binding.valid) { rejected.push(binding.reason || 'binding'); return binding.reason || 'binding rejected'; }
                    return undefined;
                },
                repairRole: (code, failure) => canRepairTestMethod(code, failure) ? 'bug-fixer' : 'writer',
                revise: async (_, failure, role) => { revisions++; roles.push(role); failures.push(failure); return options.revised; },
                validateRevision: async (previous, candidate, failure, role) => {
                    gateChecks++;
                    if (role === 'bug-fixer') {
                        const scoped = inspect('repairScope', { previous, candidate, failure });
                        if (!scoped.valid) { return { reason: scoped.reasonCode || 'repair scope rejected', reasonCode: scoped.reasonCode || 'scope-tool-error' }; }
                    }
                    // Neither example has an already-passed method, matching the
                    // production caller's empty passed-method inventory.
                    const preserved = await validatePassingTestPreservation({ previousCode: previous, candidateCode: candidate,
                        protectedMethods: [], python });
                    return preserved.valid ? undefined : { reason: preserved.reason, reasonCode: preserved.reasonCode! };
                },
                event: (stage, _status, detail) => { if (stage === 'repair-routing') { routing.push(detail); } }
            }
        });
        if (options.expectSuccess) {
            const baseline = await run;
            assert.equal(fs.existsSync(path.join(directory, 'execution_baseline.json')), true);
            assert.equal(fs.readFileSync(path.join(directory, baseline.testFile), 'utf8'), options.revised);
        } else {
            await assert.rejects(run, (error: any) => error?.stage === 'candidate-validation');
            assert.equal(fs.existsSync(path.join(directory, 'execution_baseline.json')), false);
        }
        assert.equal(fs.readFileSync(file, 'utf8'), options.source, 'role selection never authorizes changing target source');
        return { roles, failures, routing, rejected, revisions, gateChecks };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('real guarded missing-import failure receives a whole-file Writer import fix and passes binding/execution evidence', async () => {
    const revised = 'from datetime import date\n' + missingDate;
    const result = await runNeutral({ source: yearSource, initial: missingDate, revised, expectSuccess: true });
    assert.deepEqual(result.roles, ['writer']); assert.equal(result.revisions, 1); assert.equal(result.gateChecks, 1);
    assert.equal(wholeCandidateNameException(result.failures[0]), 'NameError');
    assert.equal(result.routing[0].reasonCode, 'execution-name-binding');
    assert.equal(inspect('repairScope', { previous: missingDate, candidate: revised, failure: result.failures[0] }).reasonCode,
        'no-method-change', 'the narrower Bug Fixer gate remains unchanged; the Writer owns this import-only repair');
});

test('real guarded assertion failure remains a scoped Bug Fixer repair', async () => {
    const initial = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
        + '    def test_value(self):\n        self.assertEqual(target(2), 4)\n';
    const result = await runNeutral({ source: 'def target(value):\n    return value + 1\n', initial,
        revised: initial.replace('target(2), 4', 'target(2), 3'), expectSuccess: true });
    assert.deepEqual(result.roles, ['bug-fixer']); assert.equal(result.gateChecks, 1);
    assert.equal(wholeCandidateNameException(result.failures[0]), undefined);
    assert.equal(result.routing.filter(event => event.reasonCode === 'execution-name-binding').length, 0);
});

test('a target-source NameError may prefer Writer but cannot authorize mocking the target or count as passing', async () => {
    const initial = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
        + '    def test_value(self):\n        self.assertEqual(target(2), 3)\n';
    const revised = 'import unittest\nfrom unittest.mock import patch\nimport sample\nclass Cases(unittest.TestCase):\n'
        + "    def test_value(self):\n        with patch('sample.target', return_value=3):\n            self.assertEqual(sample.target(2), 3)\n";
    const result = await runNeutral({ source: 'def target(value):\n    return missing_value + value\n', initial, revised, expectSuccess: false });
    assert.ok(result.roles.length > 0); assert.ok(result.roles.every(role => role === 'writer'));
    assert.equal(wholeCandidateNameException(result.failures[0]), 'NameError');
    assert.ok(result.rejected.length > 0, 'the unchanged structure/binding gate rejects the patched target');
});
