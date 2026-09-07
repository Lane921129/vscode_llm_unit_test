import * as assert from 'assert';
import { test } from 'node:test';
import { ExecutionManager, currentExecution, runInExecution, throwIfExecutionCancelled } from '../pipeline/executionContext';

test('cancelled workers retain their context and cannot publish into a replacement run', async () => {
    const manager = new ExecutionManager<{ models: string[] }>();
    const models = ['first'];
    const oldRun = manager.begin({ models })!;
    assert.strictEqual(manager.begin({ models }), undefined);
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const oldWorker = runInExecution(oldRun, async () => {
        await gate;
        assert.strictEqual(currentExecution(), oldRun);
        assert.throws(throwIfExecutionCancelled, /中止/);
        assert.strictEqual(manager.canPublish(oldRun), false);
        assert.strictEqual(manager.finish(oldRun), false);
    });
    assert.strictEqual(manager.cancel(), true);
    models[0] = 'second';
    const newRun = manager.begin({ models })!;
    assert.notStrictEqual(oldRun.id, newRun.id);
    assert.deepStrictEqual(oldRun.snapshot.models, ['first']);
    await runInExecution(newRun, async () => {
        resume();
        await oldWorker;
        assert.strictEqual(currentExecution(), newRun);
        assert.doesNotThrow(throwIfExecutionCancelled);
        assert.strictEqual(manager.canPublish(newRun), true);
    });
    assert.strictEqual(manager.finish(newRun), true);
});

test('cancellation only invokes resources belonging to that run and respects release', () => {
    const manager = new ExecutionManager<null>();
    const first = manager.begin(null)!;
    let releasedCalls = 0;
    const release = first.onCancel(() => { releasedCalls++; });
    release();
    let firstCalls = 0;
    first.onCancel(() => { firstCalls++; });
    manager.cancel();
    const second = manager.begin(null)!;
    let secondCalls = 0;
    second.onCancel(() => { secondCalls++; });
    first.cancel();
    assert.strictEqual(firstCalls, 1);
    assert.strictEqual(releasedCalls, 0);
    assert.strictEqual(secondCalls, 0);
    let lateCalls = 0;
    first.onCancel(() => { lateCalls++; });
    assert.strictEqual(lateCalls, 1);
    manager.cancel();
    assert.strictEqual(secondCalls, 1);
});
