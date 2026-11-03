import * as assert from 'node:assert/strict';

/** Fail before native filesystem calls can query a network-style location. */
export async function withoutUncFileSystem<T>(operation: () => Promise<T> | T): Promise<T> {
    const fs = require('node:fs') as Record<string, any>;
    const saved = new Map<string, any>();
    let attempts = 0;
    for (const name of ['statSync', 'lstatSync', 'realpathSync', 'accessSync', 'existsSync', 'readFileSync', 'readdirSync', 'openSync', 'mkdirSync']) {
        const original = fs[name]; saved.set(name, original);
        const wrap = (call: (...args: any[]) => any) => (...args: any[]) => {
            const value = Buffer.isBuffer(args[0]) ? args[0].toString() : args[0];
            if (typeof value === 'string' && /^[\\/]{2}/.test(value)) {
                attempts++; throw new Error('Unexpected original UNC filesystem access');
            }
            return call(...args);
        };
        fs[name] = Object.assign(wrap(original), original.native ? { native: wrap(original.native) } : {});
    }
    try { return await operation(); }
    finally {
        for (const [name, original] of saved) { fs[name] = original; }
        assert.equal(attempts, 0, 'UNC configuration must not query original metadata or contents');
    }
}
