import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { assessTargetCoverageEvidence } from '../mutation/targetCoverage';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';

test('native coverage measures multiline target statements and branches without importing the source reader', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-target-coverage-'));
    const python = resolvePythonExecutable('', path.resolve(__dirname, '../..'));
    const reader = path.join(path.dirname(pythonToolPath('testRunner')), 'coverage_read.py');
    const run = (args: string[]) => {
        const executed = spawnSync(python, ['-B', ...args], { cwd: directory, encoding: 'utf8', timeout: 30000,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(executed.status, 0, executed.stdout + executed.stderr);
        return executed.stdout;
    };
    try {
        const file = path.join(directory, 'sample.py');
        const source = [
            'def target(value):', '    """Not a coverage statement."""', '    adjusted = (',
            '        value + 1', '    )', '    if adjusted > 1:', '        return adjusted', '    return 0', '',
            'def other(value):', '    if value:', '        return 1', '    return 2', '',
            'def not_called(value):', '    """Importing this definition must not prove invocation."""', '    return value', '',
            'def one_line(): return 1', '',
            'class First:', '    def target(self, value):', '        return value + 10', '',
            'class Second:', '    def target(self, value):', '        return value + 20', ''
        ].join('\n');
        fs.writeFileSync(file, source);
        fs.writeFileSync(path.join(directory, 'neutral_test.py'), [
            'import unittest', 'from sample import target, First', 'class Cases(unittest.TestCase):',
            '    def test_positive(self):', '        self.assertEqual(target(2), 3)',
            '        self.assertEqual(First().target(2), 12)', ''
        ].join('\n'));
        run([pythonToolPath('testRunner'), 'neutral_test', `--coverage-source=${directory}`]);
        const sourceHash = createHash('sha256').update(source).digest('hex');
        const raw = run([reader, file, 'target']);
        const assessment = assessTargetCoverageEvidence(raw, file, 'target', sourceHash);
        assert.equal(assessment.available, true, raw);
        assert.equal(assessment.targetExecuted, true);
        assert.equal(assessment.targetFullyCovered, false);
        assert.deepEqual(assessment.missingTargetLines, [8]);
        assert.ok(!assessment.executableTargetLines?.includes(2));
        assert.ok(!assessment.executableTargetLines?.some(line => line >= 10));
        assert.deepEqual(assessment.missingTargetBranches, ['6->8']);
        assert.equal(assessment.targetBranchesCovered, false);

        const uncalled = assessTargetCoverageEvidence(run([reader, file, 'not_called']), file, 'not_called', sourceHash);
        assert.equal(uncalled.targetExecuted, false);
        assert.deepEqual(uncalled.missingTargetLines, [17]);
        const ambiguous = assessTargetCoverageEvidence(run([reader, file, 'one_line']), file, 'one_line', sourceHash);
        assert.equal(ambiguous.available, false);
        assert.equal(ambiguous.reason, 'target-scope-ambiguous');
        assert.equal(ambiguous.scopeStatus, 'ambiguous');
        assert.equal(assessTargetCoverageEvidence(run([reader, file, 'Missing.target']), file, 'Missing.target').available, false);
        const first = assessTargetCoverageEvidence(run([reader, file, 'First.target']), file, 'First.target', sourceHash);
        const second = assessTargetCoverageEvidence(run([reader, file, 'Second.target']), file, 'Second.target', sourceHash);
        assert.equal(first.targetExecuted, true);
        assert.equal(first.targetFullyCovered, true);
        assert.equal(second.targetExecuted, false);
        assert.equal(second.targetFullyCovered, false);

        const unrelated = path.join(directory, 'another', 'sample.py');
        fs.mkdirSync(path.dirname(unrelated));
        fs.writeFileSync(unrelated, source);
        assert.equal(assessTargetCoverageEvidence(raw, unrelated, 'target', sourceHash).available, false);
        assert.equal(JSON.parse(run([reader, unrelated, 'target'])).available, false);

        run(['-m', 'coverage', 'run', `--source=${directory}`, '--data-file=line.coverage', pythonToolPath('testRunner'), 'neutral_test']);
        const withoutBranches = assessTargetCoverageEvidence(run([reader, file, 'target', 'line.coverage']), file, 'target', sourceHash);
        assert.equal(withoutBranches.available, true);
        assert.equal(withoutBranches.targetBranchesCovered, undefined);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('single-line coverage requires current guarded-run invocation and rejects stale artifacts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-invocation-coverage-'));
    const python = resolvePythonExecutable('', path.resolve(__dirname, '../..'));
    const reader = path.join(path.dirname(pythonToolPath('testRunner')), 'coverage_read.py');
    const run = (args: string[]) => {
        const executed = spawnSync(python, ['-B', ...args], { cwd: directory, encoding: 'utf8', timeout: 30000,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(executed.status, 0, executed.stdout + executed.stderr);
        return executed.stdout;
    };
    try {
        const sourceFile = path.join(directory, 'sample.py');
        const testFile = path.join(directory, 'candidate.py');
        const evidenceFile = path.join(directory, 'invocation.json');
        const source = 'def target(): return 2\n';
        const sourceHash = createHash('sha256').update(source).digest('hex');
        fs.writeFileSync(sourceFile, source);
        for (const invokes of [false, true]) {
            const tests = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
                + `    def test_case(self):\n        ${invokes ? 'self.assertEqual(target(), 2)' : 'self.assertTrue(True)'}\n`;
            fs.writeFileSync(testFile, tests);
            const expected = { testRunId: randomUUID(), testHash: createHash('sha256').update(tests).digest('hex') };
            run([pythonToolPath('testRunner'), 'candidate', `--coverage-source=${directory}`,
                '--target-file', sourceFile, '--target-name', 'target', '--target-evidence', evidenceFile,
                '--target-run-id', expected.testRunId, '--target-test-file', testFile]);
            const readerArgs = [reader, sourceFile, 'target', '--invocation-evidence', evidenceFile,
                '--expected-run-id', expected.testRunId, '--expected-test-hash', expected.testHash];
            const output = run(readerArgs);
            const result = assessTargetCoverageEvidence(output, sourceFile, 'target', sourceHash, expected);
            assert.equal(result.available, true, output);
            assert.equal(result.targetExecuted, invokes);
            assert.equal(result.targetFullyCovered, invokes);
            const stale = [...readerArgs];
            stale[stale.indexOf('--expected-run-id') + 1] = randomUUID();
            assert.equal(JSON.parse(run(stale)).reason, 'invalid-invocation-evidence');
            fs.appendFileSync(path.join(directory, '.coverage'), '\nchanged-coverage-artifact');
            assert.equal(JSON.parse(run(readerArgs)).reason, 'invalid-invocation-evidence');
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
