import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runCaseTablePipeline } from '../pipeline/caseTable/runCaseTablePipeline';
import { observedExpectation } from '../pipeline/caseTable/runRowStage';
import { runTestFile } from '../pipeline/caseTable/rowExecution';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const root = path.resolve(__dirname, '../..');
const python = resolvePythonExecutable(undefined, root);
const line = (fields: Record<string, string>) => JSON.stringify({ kwargs: '{}', mocks: '', requirement: '', ...fields });
const SOURCE = 'class Box:\n    def __init__(self, size):\n        self.size = size\n\n    def grow(self, extra):\n        if extra < 0:\n            raise ValueError("negative")\n        return self.size + extra\n\n\ndef double(value):\n    return value * 2\n';

async function run(target: string, replies: string[], extra: Partial<Parameters<typeof runCaseTablePipeline>[0]> = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-rows-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'shapes.py'), SOURCE, 'utf8');
    const prompts: string[] = [];
    try {
        const result = await runCaseTablePipeline({
            filePath: path.join(project, 'shapes.py'), funcName: target, projectRoot: project, outputPath: path.join(directory, 'out'),
            sessionDate: 'rows', pythonExecutable: python, specOracle: 'off', qualityAnalyst: 'off', log: () => undefined,
            mutation: { engine: 'builtin', workers: 1, stageSeconds: 60 },
            requestModel: async (_system, user, options) => {
                prompts.push(user);
                options?.onTiming?.({ version: 'model-request-timing-v1', kind: 'transport', outcome: 'completed',
                    ollama: { promptEvalCount: 40, evalCount: 12, completionReason: 'stop' } });
                const reply = replies.shift();
                if (reply === undefined) { throw new Error('unexpected request'); }
                return reply;
            },
            ...extra
        });
        const eventsFile = path.join(result.directory, 'role_events.jsonl');
        const events = fs.existsSync(eventsFile)
            ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
        const knowledgeFile = path.join(result.directory, 'function_knowledge.json');
        const knowledge = fs.existsSync(knowledgeFile) ? JSON.parse(fs.readFileSync(knowledgeFile, 'utf8')) : null;
        return { result, prompts, remaining: replies.length, events, knowledge };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('instance methods get one Writer setup per row and then run as host-written tests', async () => {
    const setup = (size: number) => '```python\ninstance = target_module.Box(' + size + ')\nargs = (3,)\nkwargs = {}\n```';
    const messages: Record<string, unknown>[] = [];
    const { result, prompts, events, knowledge } = await run('Box.grow', [
        [line({ scenario: '加三', category: 'normal', args: '(3,)' }), line({ scenario: '負數', category: 'error', args: '(-1,)' })].join('\n'),
        setup(2),
        '```python\ninstance = target_module.Box(2)\nargs = (-1,)\nkwargs = {}\n```'
    ], { postMessage: message => { messages.push(message); } });
    assert.equal(prompts.length, 3);
    assert.match(prompts[1], /- instance: the Box object whose method is tested/);
    assert.deepEqual(result.rows.map(row => [row.id, row.status, row.actual?.value]), [['C1', 'test-passed', '5'], ['C2', 'test-passed', 'ValueError']]);
    assert.equal(result.stage!.terminal, 'usable');
    const coverage = result.stage!.coverage!;
    assert.ok(coverage.available ? typeof coverage.linePercent === 'number' : typeof coverage.reasonCode === 'string',
        'coverage is either measured or carries a reason code; it never changes the usable tier');
    const outcome = messages.find(message => message.command === 'updateOutcome')!;
    assert.deepEqual(outcome.caseTable, { tier: 'usable', usableRows: 2, totalRows: 2, specMismatch: 0 });
    assert.equal(outcome.fileName, 'shapes.py:Box.grow');
    const requests = events.filter(event => event.stage === 'model-request');
    assert.deepEqual(requests.filter(event => event.status === 'requested').map(event => event.detail.role),
        ['analyst-scenario', 'writer-row-setup', 'writer-row-setup'], 'every v2 request is journaled with its role');
    assert.equal(requests.filter(event => event.status === 'completed').length, 3);
    const timing = requests.find(event => event.status === 'timing');
    assert.deepEqual([timing.detail.role, timing.detail.kind, timing.detail.ollama.evalCount, timing.detail.ollama.completionReason],
        ['analyst-scenario', 'transport', 12, 'stop'], 'transport telemetry is recorded in the v1 timing shape');
    assert.ok(events.every(event => typeof event.runId === 'string' && typeof event.sourceHash === 'string' && Number.isInteger(event.sequence)));
    assert.deepEqual([knowledge.caseTableResult.testPassedRows, knowledge.caseTableResult.totalRows], [2, 2]);
    assert.equal(knowledge.caseTableResult.mutationScore, result.stage!.mutation!.score);
    assert.equal(messages.find(message => message.command === 'updateCoverage')!.score, `${Math.round(result.stage!.mutation!.score! * 10) / 10}%`);
});

test('a failing row gets at most two fixes and a fix that changes the expected value is rejected', async () => {
    const wrong = { kind: 'return' as const, value: '999' };
    const changed = '```python\ndef test_c1(self):\n    result = target_module.double(*(2,), **{})\n    self.assertEqual(result, 4)\n```';
    // Setup-only edit: accepted by the contract check, but the wrong expectation still fails.
    const kept = '```python\ndef test_c1(self):\n    unused = 2\n    result = target_module.double(*(2,), **{})\n    self.assertEqual(result, 999)\n```';
    const { result, prompts, remaining } = await run('double', [
        [line({ scenario: '二的兩倍', category: 'normal', args: '(2,)' }), line({ scenario: '零', category: 'boundary', args: '(0,)' })].join('\n'),
        changed, kept
    ], {
        decideExpected: async (row, capture) => {
            const observed = observedExpectation(row, capture);
            return row.id === 'C1' ? { row: { ...observed.row, expected: { ...wrong, source: 'spec', confirmedBySpec: true } }, expectation: wrong } : observed;
        }
    });
    assert.equal(remaining, 0);
    assert.equal(prompts.length, 3, 'one scenario request plus exactly two fix requests');
    assert.match(prompts[1], /self\.assertEqual\(result, 999\)/);
    assert.deepEqual(result.rows.map(row => [row.id, row.status, row.reason ?? null]), [['C1', 'test-failed', 'test-failed'], ['C2', 'test-passed', null]]);
    assert.equal(result.stage!.terminal, 'usable', 'the other row still passes and is measured');
});

test('a passing method that never executes the real target is not counted as target-observed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-observed-'));
    try {
        const project = path.join(directory, 'project');
        const artifacts = path.join(directory, 'runs');
        fs.mkdirSync(project);
        fs.mkdirSync(artifacts);
        const source = path.join(project, 'shapes.py');
        fs.writeFileSync(source, SOURCE, 'utf8');
        const runtime = { python, sourceFile: source, target: 'double', importPaths: [project], artifacts };
        const header = 'import unittest\nfrom unittest import mock\nimport shapes as target_module\n\n\nclass TestCaseTable(unittest.TestCase):\n';
        const real = await runTestFile(runtime, 'real_test', header + '    def test_c1(self):\n        self.assertEqual(target_module.double(*(2,), **{}), 4)\n');
        assert.deepEqual([real.passed, real.targetObserved], [true, true]);
        const fake = await runTestFile(runtime, 'fake_test', header
            + '    def test_c1(self):\n        target_module.double = lambda *a, **k: 4\n        self.assertEqual(target_module.double(*(2,), **{}), 4)\n');
        assert.deepEqual([fake.passed, fake.targetObserved], [true, false], 'unittest passes, but the real target never ran');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
