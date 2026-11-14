import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runCaseTablePipeline } from '../pipeline/caseTable/runCaseTablePipeline';
import { captureSurvivorRow } from '../pipeline/caseTable/rowExecution';
import { runnerDiagnostic, runRowProcess } from '../pipeline/caseTable/runnerFailure';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const processRunner: typeof import('../utils/processRunner') = require('../utils/processRunner');
const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const reply = JSON.stringify({ scenario: 'normal input', category: 'normal', args: '(3,)', kwargs: '{}', mocks: '', requirement: '' });
const settings = { localThinkingMode: 'disabled' as const, requestContextTokens: 8192, requestOutputTokens: 512 };

for (const operation of ['capture', 'runTestFile', 'mutation']) {
    test(`a nonzero ${operation} runner persists safe exit evidence in events and v2_result`, async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-runner-diagnostics-'));
        try {
            const source = path.join(directory, 'sample.py');
            fs.writeFileSync(source, 'def double(value):\n    return value * 2\n');
            const original = processRunner.runSpawn;
            let failed = false;
            t.mock.method(processRunner, 'runSpawn', (command: string, args: string[], options: Parameters<typeof original>[2]) => {
                const matches = operation === 'capture' ? args.some(arg => arg.endsWith('case_capture_runner.py'))
                    : operation === 'mutation' ? args.some(arg => arg.endsWith('basic_mutation_runner.py')) && !args.includes('--capture-mutant')
                        : args.some(arg => arg.endsWith('generated_test_runner.py')) && args.includes('row_c1_0_test');
                if (!failed && matches) {
                    failed = true;
                    const stderr = 'prefix '.repeat(400) + '\npassword="private-value"\nFile "C:\\private\\runner.py"\nhttps://internal.example/private\nRUNNER_FAILURE_DETAIL\n';
                    const code = `import sys\nsys.stdout.write(${'"' + 'x'.repeat(2000) + '\\nSTDOUT_END\\n"'})\nsys.stderr.write(${JSON.stringify(stderr)})\nsys.exit(37)`;
                    return original(command, ['-B', '-c', code], options);
                }
                return original(command, args, options);
            });
            let targetDirectory = '';
            const run = runCaseTablePipeline({ filePath: source, funcName: 'double', projectRoot: directory,
                outputPath: path.join(directory, 'out'), sessionDate: 'diagnostics', pythonExecutable: python,
                specOracle: 'off', qualityAnalyst: 'off', mutation: { engine: 'builtin', workers: 1, stageSeconds: 30 },
                requestSettings: settings, log: () => undefined,
                onTargetDirectory: value => { targetDirectory = value; },
                requestModel: async (_system, _user, options) => {
                    options?.onTiming?.({ version: 'model-request-timing-v1', kind: 'transport' });
                    return reply;
                } });
            if (operation === 'mutation') { await run; } else { await assert.rejects(run, AnalysisStageError); }
            assert.equal(failed, true);
            const result = JSON.parse(fs.readFileSync(path.join(targetDirectory, 'v2_result.json'), 'utf8'));
            const events = fs.readFileSync(path.join(targetDirectory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            const event = events.find(event => event.stage === 'v2-case-table');
            const diagnostic = result.diagnostic;
            for (const record of [diagnostic, event.detail]) {
                assert.equal(record.operation, operation);
                assert.equal(record.rowId, operation === 'mutation' ? null : 'C1');
                assert.equal(record.exitCode, 37);
                assert.equal(record.signal, null);
                assert.equal(record.timedOut, false);
                assert.equal(record.runnerJsonExists, false);
                assert.ok(record.stdout.endsWith('STDOUT_END\n'));
                assert.match(record.stderr, /RUNNER_FAILURE_DETAIL/);
                assert.ok(record.stdout.length <= 1500 && record.stderr.length <= 1500);
                assert.doesNotMatch(record.stderr, /private-value|C:\\private|internal\.example/);
            }
            for (const event of events.filter(event => event.stage === 'model-request')) {
                assert.equal(event.detail.localThinkingMode, 'disabled');
                assert.equal(event.detail.num_ctx, 8192);
                assert.equal(event.detail.requestContextTokens, 8192);
                assert.equal(event.detail.num_predict, 512);
                assert.equal(event.detail.requestOutputTokens, 512);
            }
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
}

test('a real timeout retains final output and partial runner.json existence after process close', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-timeout-diagnostic-'));
    try {
        const resultFile = path.join(directory, 'partial.runner.json');
        const script = `import sys,time\nopen(${JSON.stringify(resultFile)},'w').write('{}')\nprint('BEFORE_TIMEOUT',file=sys.stderr,flush=True)\ntime.sleep(10)`;
        await assert.rejects(runRowProcess(python, ['-B', '-c', script], { timeout: 1500 }, 'runTestFile',
            { rowId: 'C4', resultFile }), error => {
            assert.ok(error instanceof AnalysisStageError);
            const d = error.diagnostic as ReturnType<typeof runnerDiagnostic>;
            assert.equal(d.rowId, 'C4');
            assert.equal(d.timedOut, true);
            assert.equal(d.reasonCode, 'runner-timeout');
            assert.equal(d.runnerJsonExists, true);
            assert.match(d.stderr, /BEFORE_TIMEOUT/);
            assert.ok(Object.hasOwn(d, 'signal'));
            return true;
        });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('known secrets are withheld before tail truncation, including secrets crossing the cutoff', () => {
    const secret = 'configured-private-' + 'x'.repeat(40);
    const d = runnerDiagnostic('capture', 1, { knownSecrets: [secret], stdout: secret + 'suffix'.repeat(400),
        stderr: 'Bearer ' + 'a'.repeat(40) });
    assert.equal(d.stdout, '[withheld-sensitive-content]');
    assert.equal(d.stderr, '[withheld-sensitive-content]');
});

test('output-limit errors record every request setting; omitted wire limits remain explicit nulls', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'request-settings-diagnostic-'));
    try {
        const file = path.join(directory, 'sample.py');
        fs.writeFileSync(file, 'def f(x):\n    return x\n');
        for (const requestSettings of [settings, undefined]) {
            let targetDirectory = '';
            await assert.rejects(runCaseTablePipeline({ filePath: file, funcName: 'f', projectRoot: directory,
                outputPath: directory, sessionDate: 'settings', pythonExecutable: python, specOracle: 'off', requestSettings,
                onTargetDirectory: value => { targetDirectory = value; }, log: () => undefined,
                requestModel: async (_system, _user, options) => {
                    options?.onTiming?.({ version: 'model-request-progress-v1', phase: 'dispatch' });
                    throw new AnalysisStageError('model-format', 'model-response', 'fixture output limit', { reasonCode: 'output-token-limit' });
                } }), AnalysisStageError);
            const events = fs.readFileSync(path.join(targetDirectory, 'role_events.jsonl'), 'utf8').trim().split('\n')
                .map(line => JSON.parse(line)).filter(event => event.stage === 'model-request');
            assert.deepEqual(events.map(event => event.status), ['requested', 'timing', 'error']);
            for (const { detail } of events) {
                assert.equal(detail.localThinkingMode, requestSettings?.localThinkingMode ?? null);
                assert.equal(detail.num_ctx, requestSettings?.requestContextTokens ?? null);
                assert.equal(detail.num_predict, requestSettings?.requestOutputTokens ?? null);
            }
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('short token and secret assignments use the existing v1 diagnostic privacy predicate', () => {
    const d = runnerDiagnostic('capture', 1, { stderr: 'token=short-value\nsecret: private-value\nNEXT_TRACE_LINE' });
    assert.doesNotMatch(d.stderr, /short-value|private-value/);
    assert.match(d.stderr, /NEXT_TRACE_LINE/);
});

test('a wrapped nested capture failure retains its observed outer exit code without inventing a signal', async t => {
    t.mock.method(processRunner, 'runSpawn', async () => ({ code: 0, stderr: 'outer capture completed',
        stdout: JSON.stringify({ id: 'C2', status: 'capture-failed', distinguishable: false,
            clean: { id: 'C2', status: 'capture-failed', reason: 'clean-capture-parse-failed' } }) }));
    await assert.rejects(captureSurvivorRow({ python, sourceFile: 'sample.py', target: 'double',
        importPaths: [], artifacts: os.tmpdir() }, { id: 'C2', args: '(3,)', mocks: [] }, { id: 'fixture', line: 1 }, []), error => {
        assert.ok(error instanceof AnalysisStageError);
        const d = error.diagnostic as ReturnType<typeof runnerDiagnostic>;
        assert.equal(d.operation, 'survivor-capture');
        assert.equal(d.rowId, 'C2');
        assert.equal(d.exitCode, 0);
        assert.equal(d.signal, null);
        assert.match(d.stderr, /outer capture completed/);
        return true;
    });
});
