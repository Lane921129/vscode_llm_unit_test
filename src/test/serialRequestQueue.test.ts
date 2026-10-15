import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { SerialRequestQueue, SerialRequestQueueError, SerialRequestQueueExit } from '../llm/serialRequestQueue';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
}

test('serial request queue never overlaps model work and continues after a rejection', async () => {
    const queue = new SerialRequestQueue();
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const task = (name: string, reject = false) => queue.run(async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        order.push(`start:${name}`);
        await new Promise(resolve => setTimeout(resolve, 5));
        order.push(`end:${name}`);
        active--;
        if (reject) { throw new Error(name); }
        return name;
    });

    const results = await Promise.allSettled([task('one'), task('two', true), task('three')]);

    assert.equal(maximumActive, 1);
    assert.deepEqual(order, [
        'start:one', 'end:one', 'start:two', 'end:two', 'start:three', 'end:three'
    ]);
    assert.equal(results[2].status, 'fulfilled');
});

test('queued deadline rejects immediately and its task stays skipped after the active request drains', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const queue = new SerialRequestQueue();
    const gate = deferred<string>();
    const started = deferred<void>();
    const first = queue.run(async () => { started.resolve(); return gate.promise; });
    await started.promise;
    let expiredCalls = 0;
    let followingStarted = false;
    const exits: SerialRequestQueueExit[] = [];
    const expired = queue.run(async () => { expiredCalls++; return 'must not run'; },
        { deadlineAt: 1050, onQueueExit: event => exits.push(event) });
    const rejected = assert.rejects(expired, error => {
        assert.ok(error instanceof SerialRequestQueueError);
        assert.equal(error.reasonCode, 'timeout');
        assert.equal(error.phase, 'queue');
        assert.equal(error.started, false);
        assert.equal(error.queueWaitMs, 50);
        assert.equal(error.deadlineAt, 1050);
        return true;
    });
    const following = queue.run(async () => { followingStarted = true; return 'next'; });
    t.mock.timers.tick(50);
    await rejected;
    assert.equal(expiredCalls, 0);
    assert.equal(followingStarted, false);
    assert.deepEqual(exits, [{ reason: 'timeout', queuedAt: 1000, exitedAt: 1050,
        queueWaitMs: 50, deadlineAt: 1050 }]);
    gate.resolve('first');
    assert.equal(await first, 'first');
    assert.equal(await following, 'next');
    assert.equal(expiredCalls, 0);
});

test('pre-aborted and waiting cancellation never invoke a task or poison the next request', async () => {
    const queue = new SerialRequestQueue();
    const gate = deferred<void>();
    const started = deferred<void>();
    const first = queue.run(async () => { started.resolve(); await gate.promise; });
    await started.promise;
    let cancelledCalls = 0;
    const preAborted = new AbortController();
    preAborted.abort('private abort reason must not enter diagnostics');
    await assert.rejects(queue.run(async () => { cancelledCalls++; }, { signal: preAborted.signal }), error => {
        assert.ok(error instanceof SerialRequestQueueError);
        assert.equal(error.reasonCode, 'cancelled');
        assert.equal(error.message.includes('private'), false);
        return true;
    });
    const controller = new AbortController();
    const exits: SerialRequestQueueExit[] = [];
    const cancelled = queue.run(async () => { cancelledCalls++; },
        { signal: controller.signal, onQueueExit: event => exits.push(event) });
    const rejected = assert.rejects(cancelled, error => error instanceof SerialRequestQueueError
        && error.reasonCode === 'cancelled');
    controller.abort();
    await rejected;
    controller.abort();
    assert.equal(exits.length, 1);
    assert.equal(exits[0].reason, 'cancelled');
    const following = queue.run(async () => 'healthy');
    gate.resolve();
    await first;
    assert.equal(await following, 'healthy');
    assert.equal(cancelledCalls, 0);
});

test('a task already started owns its queue slot until it settles after cancellation and deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const queue = new SerialRequestQueue();
    const gate = deferred<string>();
    const started = deferred<void>();
    const controller = new AbortController();
    const exits: SerialRequestQueueExit[] = [];
    let active = 0;
    let maximumActive = 0;
    let followingStarted = false;
    const first = queue.run(async () => {
        active++; maximumActive = Math.max(maximumActive, active); started.resolve();
        try { return await gate.promise; } finally { active--; }
    }, { deadlineAt: 1010, signal: controller.signal, onQueueExit: event => exits.push(event) });
    await started.promise;
    const following = queue.run(async () => {
        active++; maximumActive = Math.max(maximumActive, active); followingStarted = true; active--; return 'next';
    });
    controller.abort();
    t.mock.timers.tick(100);
    await Promise.resolve();
    assert.equal(followingStarted, false);
    assert.equal(active, 1);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].reason, 'started');
    gate.resolve('drained');
    assert.equal(await first, 'drained');
    assert.equal(await following, 'next');
    assert.equal(maximumActive, 1);
});

test('queue guards remove their timer and abort listener when work starts or waiting is cancelled', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const clearTimer = t.mock.method(globalThis, 'clearTimeout');
    const queue = new SerialRequestQueue();
    const controller = new AbortController();
    const addListener = t.mock.method(controller.signal, 'addEventListener');
    const removeListener = t.mock.method(controller.signal, 'removeEventListener');
    const exits: SerialRequestQueueExit[] = [];
    assert.equal(await queue.run(async () => 'started', { deadlineAt: 1050, signal: controller.signal,
        onQueueExit: event => exits.push(event) }), 'started');
    assert.equal(addListener.mock.callCount(), 1);
    assert.equal(removeListener.mock.callCount(), 1);
    assert.equal(clearTimer.mock.callCount(), 1);
    controller.abort();
    t.mock.timers.tick(100);
    assert.equal(exits.length, 1);

    const gate = deferred<void>();
    const started = deferred<void>();
    const first = queue.run(async () => { started.resolve(); await gate.promise; });
    await started.promise;
    const waiting = new AbortController();
    const removeWaiting = t.mock.method(waiting.signal, 'removeEventListener');
    const cancelled = queue.run(async () => undefined, { deadlineAt: 1200, signal: waiting.signal });
    const rejected = assert.rejects(cancelled, SerialRequestQueueError);
    waiting.abort();
    await rejected;
    assert.equal(removeWaiting.mock.callCount(), 1);
    assert.equal(clearTimer.mock.callCount(), 2);
    gate.resolve();
    await first;
});

test('expired or invalid deadlines cannot start work even without a preceding task', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const queue = new SerialRequestQueue();
    let calls = 0;
    await assert.rejects(queue.run(async () => { calls++; }, { deadlineAt: 999 }),
        error => error instanceof SerialRequestQueueError && error.reasonCode === 'timeout');
    for (const deadlineAt of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(queue.run(async () => { calls++; }, { deadlineAt }), TypeError);
    }
    assert.equal(calls, 0);
    assert.equal(await queue.run(async () => 'healthy'), 'healthy');
});

test('long deadlines are split into safe timer intervals without expiring at Node timer overflow', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const queue = new SerialRequestQueue();
    const gate = deferred<void>();
    const started = deferred<void>();
    const first = queue.run(async () => { started.resolve(); await gate.promise; });
    await started.promise;
    let calls = 0;
    const deadlineAt = 1000 + 2_147_483_647 + 50;
    const pending = queue.run(async () => { calls++; }, { deadlineAt });
    let rejected = false;
    const checked = assert.rejects(pending, error => {
        assert.ok(error instanceof SerialRequestQueueError);
        assert.equal(error.reasonCode, 'timeout');
        assert.equal(error.queueWaitMs, 2_147_483_647 + 50);
        rejected = true;
        return true;
    });
    t.mock.timers.tick(2_147_483_647);
    await Promise.resolve();
    assert.equal(rejected, false);
    t.mock.timers.tick(49);
    await Promise.resolve();
    assert.equal(rejected, false);
    t.mock.timers.tick(1);
    await checked;
    gate.resolve();
    await first;
    assert.equal(calls, 0);
});

test('dispatch rechecks the deadline when the clock advances before its timer is serviced', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const queue = new SerialRequestQueue();
    const gate = deferred<void>();
    const started = deferred<void>();
    const first = queue.run(async () => { started.resolve(); await gate.promise; });
    await started.promise;
    let calls = 0;
    const pending = queue.run(async () => { calls++; }, { deadlineAt: 1050 });
    const rejected = assert.rejects(pending, error => error instanceof SerialRequestQueueError
        && error.reasonCode === 'timeout');
    t.mock.timers.setTime(1100);
    gate.resolve();
    await first;
    await rejected;
    assert.equal(calls, 0);
});

test('a cancelled queued observer and a later active rejection cannot prevent the next request', async () => {
    const queue = new SerialRequestQueue();
    const gate = deferred<void>();
    const started = deferred<void>();
    const first = queue.run(async () => { started.resolve(); await gate.promise; });
    const lateFailure = new Error('active work rejected while draining');
    const firstRejected = assert.rejects(first, error => error === lateFailure);
    await started.promise;
    const controller = new AbortController();
    const cancelled = queue.run(async () => assert.fail('cancelled task must stay skipped'), {
        signal: controller.signal,
        onQueueExit: () => { throw new Error('diagnostic observer failed'); }
    });
    const cancelledRejected = assert.rejects(cancelled, error => error instanceof SerialRequestQueueError
        && error.reasonCode === 'cancelled');
    controller.abort();
    await cancelledRejected;
    let followingStarted = false;
    const following = queue.run(async () => { followingStarted = true; return 'healthy'; });
    await Promise.resolve();
    assert.equal(followingStarted, false);
    gate.reject(lateFailure);
    await firstRejected;
    assert.equal(await following, 'healthy');
});
