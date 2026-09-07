import * as assert from 'assert';
import { test } from 'node:test';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';
import { runSpawn } from '../utils/processRunner';

test('cancelling an old Python process does not terminate a replacement process', async () => {
    const oldRun = new ExecutionContext(null);
    const newRun = new ExecutionContext(null);
    const oldProcess = runInExecution(oldRun, () => runSpawn('python', [
        '-B', '-c', 'import time; time.sleep(30)'
    ], { timeout: 5000 }));
    const rejected = assert.rejects(oldProcess, /中止/);
    const newProcess = runInExecution(newRun, () => runSpawn('python', [
        '-B', '-c', 'import sys; print(sys.stdin.read())'
    ], { input: 'replacement remains active', timeout: 5000 }));
    oldRun.cancel();
    await rejected;
    const result = await newProcess;
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /replacement remains active/);
});

test('cancelled contexts cannot launch another subprocess', async () => {
    const context = new ExecutionContext(null);
    context.cancel();
    await assert.rejects(runInExecution(context, () => runSpawn('python', ['-B', '-c', 'pass'], {})), /中止/);
});

test('runner preserves nonzero output and rejects a timed-out child', async () => {
    const result = await runSpawn('python', ['-B', '-c', 'import sys; print("failure evidence", file=sys.stderr); sys.exit(7)'], {});
    assert.strictEqual(result.code, 7);
    assert.match(result.stderr, /failure evidence/);
    await assert.rejects(runSpawn('python', ['-B', '-c', 'import time; time.sleep(30)'], { timeout: 100 }), /超時/);
});
