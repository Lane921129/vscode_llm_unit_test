import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { canonicalExistingPath, existingRealPath, sameRecordedFile } from '../utils/fileIdentity';
import { buildGeneratedTestEnvironment, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { runExecutionVerification } from '../pipeline/executionVerification';
import { verifyExecutionEvidence } from '../pipeline/executionEvidence';
import { prepareQualityExperiments } from '../pipeline/qualityExperiments';
import { mutationMeetsThreshold, parseBuiltinMutationRun } from '../mutation/mutationResult';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const normalizedCase = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;

function pythonPaths(file: string): { real: string; short: string } {
    const script = `import ctypes,json,os,sys
p=sys.argv[1]
s=p
if os.name=='nt':
    get_short=ctypes.WinDLL('kernel32',use_last_error=True).GetShortPathNameW
    get_short.argtypes=[ctypes.c_wchar_p,ctypes.c_wchar_p,ctypes.c_uint]
    get_short.restype=ctypes.c_uint
    size=get_short(p,None,0)
    if size:
        buf=ctypes.create_unicode_buffer(size)
        if get_short(p,buf,size): s=buf.value
print(json.dumps({'real':os.path.realpath(p),'short':s}))`;
    const result = spawnSync(python, ['-B', '-c', script, file], { encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout);
}

test('existing file identity matches Python and rejects different files even with identical contents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'physical-identity-'));
    try {
        const first = path.join(root, 'first.py'), second = path.join(root, 'second.py');
        fs.writeFileSync(first, 'def target(): return True\n'); fs.copyFileSync(first, second);
        const actual = pythonPaths(first);
        assert.equal(existingRealPath(first), actual.real);
        assert.equal(canonicalExistingPath(first), normalizedCase(actual.real));
        assert.equal(sameRecordedFile(first, actual.real), true);
        assert.equal(sameRecordedFile(first, second), false, 'equal hashes do not establish file identity');
        const missing = path.join(root, 'absent.py');
        assert.throws(() => canonicalExistingPath(missing));
        assert.equal(sameRecordedFile(missing, missing), true, 'unchanged historical records may outlive their sources');
        assert.equal(sameRecordedFile(missing, first), false);
        assert.equal(sameRecordedFile(missing, path.join(root, 'other-missing.py')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows short paths preserve real Python execution, observation and mutation identity without weakening gates',
    { skip: process.platform !== 'win32' }, async context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'physical identity with spaces '));
    try {
        const paths = pythonPaths(root);
        if (normalizedCase(paths.short) === normalizedCase(paths.real)) {
            context.skip('This temporary filesystem has no distinct Windows 8.3 alias.'); return;
        }
        assert.equal(canonicalExistingPath(paths.short), canonicalExistingPath(paths.real));
        const source = 'def target():\n    return True\n';
        const file = path.join(paths.real, 'sample.py'), shortFile = path.join(paths.short, 'sample.py');
        const other = path.join(paths.real, 'other.py');
        fs.writeFileSync(file, source); fs.writeFileSync(other, source);
        const code = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
            + '    def test_value(self): self.assertTrue(target())\n';
        const directory = path.join(paths.real, 'result');
        const journal = new AnalysisJournal(directory, source, 'target', 'neutral-path-fixture', undefined, 'execution');
        const baseline = await runExecutionVerification({ directory, file: shortFile, target: 'target', python,
            dependencies: [], journal, env: buildGeneratedTestEnvironment(process.env, [paths.short]),
            generate: async () => code, hooks: {
                validate: async candidate => { const result = validateUnittestStructure(candidate, 'target', 'sample');
                    return result.valid ? undefined : result.reason; },
                revise: async () => { throw Error('No repair is expected for the valid neutral candidate.'); },
                event: () => {}
            } });
        const expected = { runId: journal.runId, sourceHash: journal.sourceHash, target: 'target' };
        assert.equal(verifyExecutionEvidence(directory, shortFile, baseline, expected), true);
        assert.equal(verifyExecutionEvidence(directory, file, baseline, expected), true);
        assert.equal(verifyExecutionEvidence(directory, other, baseline, expected), false);
        for (const changed of [{ runId: 'another-run' }, { target: 'other' }, { sourceHash: '0'.repeat(64) }]) {
            assert.equal(verifyExecutionEvidence(directory, shortFile, baseline, { ...expected, ...changed }), false);
        }
        const invocationPath = path.join(directory, baseline.invocationFile);
        const invocation = JSON.parse(fs.readFileSync(invocationPath, 'utf8'));
        const otherTest = path.join(directory, 'other_test.py'); fs.copyFileSync(path.join(directory, baseline.testFile), otherTest);
        for (const changed of [{ canonicalFile: other }, { canonicalTestFile: otherTest }, { testHash: '0'.repeat(64) }]) {
            fs.writeFileSync(invocationPath, JSON.stringify({ ...invocation, ...changed }));
            assert.equal(verifyExecutionEvidence(directory, shortFile, baseline, expected), false);
        }
        fs.writeFileSync(invocationPath, JSON.stringify(invocation));

        const testPath = path.join(paths.short, 'test_sample.py'); fs.writeFileSync(testPath, code);
        const completed = spawnSync(python, ['-B', path.resolve('python_scripts/basic_mutation_runner.py'), shortFile,
            testPath, '0', '5', 'target', '', '20'], { encoding: 'utf8', timeout: 30000,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
        const candidate = { sourcePath: shortFile, sourceHash: evidenceHash(source), testHash: evidenceHash(code),
            targetScope: { kind: 'function' as const, qualifiedName: 'target' }, stageTimeoutSeconds: 20 };
        const mutation = parseBuiltinMutationRun(completed.stdout, candidate);
        assert.equal(mutation.status, 'complete', mutation.diagnostic);
        assert.equal(mutationMeetsThreshold(mutation), true);
        assert.equal(parseBuiltinMutationRun(completed.stdout, { ...candidate, sourcePath: file }).status, 'complete');
        for (const changed of [{ sourcePath: other }, { sourceHash: '0'.repeat(64) }, { testHash: '0'.repeat(64) },
            { targetScope: { kind: 'function' as const, qualifiedName: 'other' } }]) {
            assert.equal(parseBuiltinMutationRun(completed.stdout, { ...candidate, ...changed }).status, 'failed');
        }

        const stateSource = 'class Ledger:\n    def __init__(self):\n        self.entries = {}\n'
            + '    def increase(self, name, units=1):\n        if name in self.entries:\n'
            + '            self.entries[name] += units\n        else:\n            self.entries[name] = units\n';
        const stateFile = path.join(paths.short, 'ledger.py'); fs.writeFileSync(stateFile, stateSource);
        const stateTests = 'import unittest\nfrom ledger import Ledger\nclass Cases(unittest.TestCase):\n'
            + '    def setUp(self): self.ledger = Ledger()\n'
            + "    def test_value(self): self.assertIsNone(self.ledger.increase('entry', 2))\n";
        const observed = await prepareQualityExperiments({ sourcePath: stateFile, source: stateSource, target: 'Ledger.increase',
            module: 'ledger', testCode: stateTests, focus: { id: 'neutral-gap', kind: 'coverage', line: 6, evidence: 'line:6' },
            python, env: buildGeneratedTestEnvironment(process.env, [paths.short]) });
        assert.equal(observed.status, 'observed');
        assert.equal(canonicalExistingPath(observed.context!.sourcePath), canonicalExistingPath(stateFile));
        assert.equal(canonicalExistingPath(observed.context!.sourceRoot), canonicalExistingPath(paths.real));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
