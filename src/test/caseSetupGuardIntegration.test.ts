import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createBatchDirectory } from '../pipeline/analysisOutput';
import { BatchJournal } from '../pipeline/batchJournal';
import { runCaseTablePipeline, CaseTablePipelineOptions } from '../pipeline/caseTable/runCaseTablePipeline';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { captureSurvivorRow, runTestFile } from '../pipeline/caseTable/rowExecution';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const childProcess: typeof import('node:child_process') = require('node:child_process');
const processRunner: typeof import('../utils/processRunner') = require('../utils/processRunner');
const root = path.resolve(__dirname, '../..');
const python = resolvePythonExecutable(undefined, root);
const row = (args: string) => JSON.stringify({ scenario: 'fixture', category: 'normal', args, kwargs: '{}', mocks: '', requirement: '' });
const SOURCE = `import time
import sys

def primary(value):
    return value * 2

def doomed(value):
    print('RUNNER_KILL_READY', file=sys.stderr, flush=True)
    time.sleep(3)
    return value * 2

def following(value):
    return value + 1
`;

async function withBatch(first: string, replies: string[], check: (result: {
    batch: Record<string, unknown>; targets: Array<Record<string, unknown>>;
    directories: string[]; errors: unknown[];
}) => void, override: Partial<CaseTablePipelineOptions> = {}) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-setup-guard-'));
    try {
        const project = path.join(temporary, 'project');
        fs.mkdirSync(project);
        const source = path.join(project, 'sample.py');
        fs.writeFileSync(source, SOURCE);
        const directory = createBatchDirectory(temporary, 'guard', 'project');
        const batch = new BatchJournal(directory, project, { model: 'fixed-replies', buildTimestamp: 'fixture', python });
        batch.discover(source, [first, 'following']);
        batch.start();
        const directories: string[] = [];
        const errors: unknown[] = [];
        for (const [id, target] of [first, 'following'].entries()) {
            batch.begin(id);
            const responses = id === 0 ? [...replies] : [row('(3,)')];
            try {
                await runCaseTablePipeline({
                    filePath: source, funcName: target, projectRoot: project, outputPath: temporary,
                    sessionDate: 'guard', batchDirectory: directory, pythonExecutable: python,
                    specOracle: 'off', qualityAnalyst: 'off', mutation: { engine: 'builtin', workers: 1, stageSeconds: 60 },
                    log: () => undefined,
                    requestModel: async () => {
                        const response = responses.shift();
                        assert.notEqual(response, undefined, 'no extra model/fixer request is allowed');
                        return response!;
                    },
                    ...(id === 0 ? override : {}),
                    onTargetDirectory: targetDirectory => { directories[id] = targetDirectory; batch.attach(id, targetDirectory); }
                });
            } catch (error) { errors.push(error); }
            finally { batch.refresh(id); assert.equal(batch.stopDispatch(), false); }
        }
        batch.finish('completed');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'batch_manifest.json'), 'utf8'));
        assert.equal(manifest.finishedTargets, 2, 'both targets reach report verification');
        assert.ok(manifest.targets.every((target: { state: string }) => target.state === 'finished'));
        assert.equal(manifest.targets[1].terminalStatus, 'usable', 'the next target still executes, measures and reports');
        check({ batch: manifest, targets: manifest.targets, directories, errors });
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function knowledge(directory: string) {
    return JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
}

test('forbidden Writer setup is rejected without a fixer; following rows and targets finish', async () => {
    const before = processRunner.runSpawn;
    const pythonState = async () => (await before(python, ['-B', '-c',
        'import sys,json;print(json.dumps([getattr(sys,"frozen",False),sys.executable]))'], { timeout: 10000 })).stdout;
    const state = await pythonState();
    await withBatch('primary', [
        [row('<needs-setup: construct one input>'), row('(3,)')].join('\n'),
        '```python\nimport sys\nsys.frozen = True\nsys.executable = None\nargs = (2,)\nkwargs = {}\n```'
    ], ({ targets, directories, errors }) => {
        assert.deepEqual(errors, []);
        assert.equal(targets[0].terminalStatus, 'usable');
        const table = JSON.parse(fs.readFileSync(path.join(directories[0], 'case_table.json'), 'utf8'));
        assert.deepEqual(table.rows.map((entry: { status: string; reason?: string }) => [entry.status, entry.reason ?? null]),
            [['capture-failed', 'setup-forbidden-mutation'], ['test-passed', null]]);
        assert.ok(!fs.existsSync(path.join(directories[0], 'v2_runs/row_c1_0_test.py')));
        const events = fs.readFileSync(path.join(directories[0], 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(events.filter(event => event.status === 'requested').map(event => event.detail.role),
            ['analyst-scenario', 'writer-row-setup']);
    });
    assert.equal(await pythonState(), state, 'a fresh process has unchanged sys.frozen/executable');
});

test('a killed real generated-test runner produces failed/runner-crashed and the next target reports', async t => {
    const spawn = childProcess.spawn;
    let killed = false;
    t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
        const child = spawn(command, args, options);
        if (args.includes('doomed') && args.some(arg => arg.includes('row_c1_0_test'))) {
            child.stderr?.on('data', data => {
                if (!killed && data.toString().includes('RUNNER_KILL_READY')) { killed = child.kill('SIGKILL'); }
            });
        }
        return child;
    });
    await withBatch('doomed', [row('(2,)')], ({ targets, directories, errors }) => {
        assert.equal(killed, true);
        assert.equal(errors.length, 1);
        assert.equal(targets[0].terminalStatus, 'failed');
        const report = knowledge(directories[0]);
        assert.equal(report.reasonCode, 'runner-crashed');
        assert.equal(report.failureStage, 'case-table-runner');
        assert.match(fs.readFileSync(path.join(directories[0], 'final_report.md'), 'utf8'), /failed.*runner-crashed/);
    });
});

test('a real capture timeout is finalized as failed and the next target reports', async t => {
    const spawn = processRunner.runSpawn;
    let limited = false;
    t.mock.method(processRunner, 'runSpawn', (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
        if (!limited && args.some(arg => arg.endsWith('case_capture_runner.py')) && options.input?.includes('"target":"doomed"')) {
            limited = true;
            return spawn(command, args, { ...options, timeout: 200 });
        }
        return spawn(command, args, options);
    });
    await withBatch('doomed', [row('(2,)')], ({ targets, directories, errors }) => {
        assert.equal(limited, true);
        assert.equal(errors.length, 1);
        assert.equal(targets[0].terminalStatus, 'failed');
        assert.equal(knowledge(directories[0]).reasonCode, 'runner-timeout');
    });
});

test('errors before capture retain role diagnostics and a verifiable failed report', async () => {
    await withBatch('primary', [], ({ targets, directories, errors }) => {
        assert.equal(errors.length, 1);
        assert.equal(targets[0].terminalStatus, 'failed');
        const report = knowledge(directories[0]);
        assert.equal(report.reasonCode, 'fixture-model-error');
        assert.equal(report.failureStage, 'model-request');
        const events = fs.readFileSync(path.join(directories[0], 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(events.map(event => event.status), ['requested', 'error', 'failed']);
    }, { requestModel: async () => { throw new AnalysisStageError('model-api', 'model-request', 'fixture transport failure',
        { reasonCode: 'fixture-model-error' }); } });
});

test('nested capture process loss cannot be accepted as a distinguishable survivor', async t => {
    const runtime = { python, sourceFile: path.join(root, 'sample.py'), target: 'primary',
        importPaths: [root], artifacts: os.tmpdir() };
    for (const lost of ['clean', 'mutant']) {
        const report = { id: 'C1', status: 'distinguishable', distinguishable: true,
            clean: { id: 'C1', status: 'captured', actual: { kind: 'return', value: '4' } },
            mutant: { id: 'C1', status: 'captured', actual: { kind: 'return', value: '5' } } };
        Object.assign(report[lost as 'clean' | 'mutant'], { status: 'capture-failed', reason: `${lost}-capture-parse-failed` });
        const mocked = t.mock.method(processRunner, 'runSpawn', async () => ({ code: 0, stdout: JSON.stringify(report), stderr: '' }));
        await assert.rejects(captureSurvivorRow(runtime, { id: 'C1', args: '(2,)', mocks: [] }, { id: 'fixture', line: 1 }, []),
            error => error instanceof AnalysisStageError && (error.diagnostic as { reasonCode: string }).reasonCode === 'runner-crashed');
        mocked.mock.restore();
    }
});

test('a nonzero worker exit cannot certify a passing report; completed test failures stay repairable', async t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-worker-exit-'));
    try {
        const runtime = { python, sourceFile: path.join(temporary, 'sample.py'), target: 'primary',
            importPaths: [temporary], artifacts: temporary };
        t.mock.method(processRunner, 'runSpawn', async (_command: string, args: string[]) => {
            const resultFile = args[args.indexOf('--result-json') + 1];
            fs.writeFileSync(resultFile, JSON.stringify({ schemaVersion: 'generated-test-result-v1',
                status: resultFile.includes('late_crash') ? 'passed' : 'failed' }));
            return { code: 1, stdout: '', stderr: '' };
        });
        await assert.rejects(runTestFile(runtime, 'test_late_crash', 'fixture'),
            error => error instanceof AnalysisStageError && (error.diagnostic as { reasonCode: string }).reasonCode === 'runner-crashed');
        assert.equal((await runTestFile(runtime, 'test_assertion_failure', 'fixture')).passed, false);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
