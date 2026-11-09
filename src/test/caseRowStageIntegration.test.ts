import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runCaseTablePipeline } from '../pipeline/caseTable/runCaseTablePipeline';
import { observedExpectation } from '../pipeline/caseTable/runRowStage';
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
            sessionDate: 'rows', pythonExecutable: python, specOracle: 'off', log: () => undefined,
            mutation: { engine: 'builtin', workers: 1, stageSeconds: 60 },
            requestModel: async (_system, user) => { prompts.push(user); const reply = replies.shift(); if (reply === undefined) { throw new Error('unexpected request'); } return reply; },
            ...extra
        });
        return { result, prompts, remaining: replies.length };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('instance methods get one Writer setup per row and then run as host-written tests', async () => {
    const setup = (size: number) => '```python\ninstance = target_module.Box(' + size + ')\nargs = (3,)\nkwargs = {}\n```';
    const { result, prompts } = await run('Box.grow', [
        [line({ scenario: '加三', category: 'normal', args: '(3,)' }), line({ scenario: '負數', category: 'error', args: '(-1,)' })].join('\n'),
        setup(2),
        '```python\ninstance = target_module.Box(2)\nargs = (-1,)\nkwargs = {}\n```'
    ]);
    assert.equal(prompts.length, 3);
    assert.match(prompts[1], /- instance: the Box object whose method is tested/);
    assert.deepEqual(result.rows.map(row => [row.id, row.status, row.actual?.value]), [['C1', 'test-passed', '5'], ['C2', 'test-passed', 'ValueError']]);
    assert.equal(result.stage!.terminal, 'usable');
});

test('a failing row gets at most two fixes and a fix that changes the expected value is rejected', async () => {
    const wrong = { kind: 'return' as const, value: '999' };
    const changed = '```python\ndef test_c1(self):\n    result = target_module.double(*(2,), **{})\n    self.assertEqual(result, 4)\n```';
    const kept = '```python\ndef test_c1(self):\n    value = 2\n    result = target_module.double(*(value,), **{})\n    self.assertEqual(result, 999)\n```';
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
