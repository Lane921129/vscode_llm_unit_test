import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { SerialRequestQueue } from '../llm/serialRequestQueue';

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
