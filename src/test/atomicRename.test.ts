import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renameAtomicSync, AtomicRenameRetry } from '../utils/atomicRename';

const sharingError = (code = 'EPERM') => Object.assign(new Error('fixture sharing violation'), { code });

test('atomic publication succeeds after N Windows EPERM failures and journals every retry', () => {
    for (let failures = 1; failures <= 4; failures++) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-rename-'));
        try {
            const source = path.join(root, 'knowledge.pending.json'), destination = path.join(root, 'knowledge.json');
            const bytes = Buffer.from('{"evidence":"原子發布"}\n');
            fs.writeFileSync(source, bytes); fs.writeFileSync(destination, 'previous evidence');
            let calls = 0, clock = 0;
            const waits: number[] = [];
            renameAtomicSync(source, destination, { platform: 'win32', now: () => clock,
                sleep: delay => { waits.push(delay); clock += delay; },
                rename: (from, to) => { if (++calls <= failures) { throw sharingError(); } fs.renameSync(from, to); } });
            assert.equal(calls, failures + 1);
            assert.deepEqual(waits, [20, 40, 80, 160].slice(0, failures));
            assert.ok(clock < 500);
            assert.deepEqual(fs.readFileSync(destination), bytes);
            assert.equal(fs.existsSync(source), false);
            const retries: AtomicRenameRetry[] = fs.readFileSync(path.join(root, 'journal_io_retries.jsonl'), 'utf8')
                .trim().split('\n').map(line => JSON.parse(line));
            assert.deepEqual(retries.map(retry => retry.nextAttempt), Array.from({ length: failures }, (_, i) => i + 2));
            assert.deepEqual(retries.map(retry => retry.delayMs), waits);
            assert.ok(retries.every(retry => retry.errorCode === 'EPERM' && retry.maximumAttempts === 5
                && retry.destination === 'knowledge.json' && retry.version === 'atomic-rename-retry-v1'));
            assert.ok(!JSON.stringify(retries).includes(root), 'retry journal omits paths and original error text');
        } finally {
            assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('exhausted Windows rename attempts throw the original error after four logged backoffs', () => {
    const error = sharingError(), retries: AtomicRenameRetry[] = [], waits: number[] = [];
    let calls = 0, clock = 0;
    assert.throws(() => renameAtomicSync('pending', 'final', { platform: 'win32',
        rename: () => { calls++; throw error; }, now: () => clock,
        sleep: delay => { waits.push(delay); clock += delay; }, journal: retry => retries.push(retry) }), thrown => thrown === error);
    assert.equal(calls, 5);
    assert.deepEqual(waits, [20, 40, 80, 160]);
    assert.equal(clock, 300);
    assert.equal(retries.length, 4);
});

test('only Windows EPERM, EACCES and EBUSY qualify for retry', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        let calls = 0;
        renameAtomicSync('pending', 'final', { platform: 'win32', sleep: () => {}, journal: () => {},
            rename: () => { if (++calls === 1) { throw sharingError(code); } } });
        assert.equal(calls, 2);
    }
    for (const [platform, code] of [['linux', 'EPERM'], ['darwin', 'EBUSY'], ['win32', 'ENOENT']] as const) {
        let calls = 0;
        const error = sharingError(code);
        assert.throws(() => renameAtomicSync('pending', 'final', { platform,
            rename: () => { calls++; throw error; }, sleep: () => assert.fail('no backoff'),
            journal: () => assert.fail('no retry journal') }), thrown => thrown === error);
        assert.equal(calls, 1);
    }
});

test('retry respects the original deadline and logging cannot mask a rename error', () => {
    const error = sharingError();
    let calls = 0, clock = 0;
    assert.throws(() => renameAtomicSync('pending', 'final', { platform: 'win32',
        rename: () => { calls++; throw error; }, now: () => clock, remainingMs: () => 20 - clock,
        sleep: () => assert.fail('deadline would be crossed'), journal: () => assert.fail('no retry scheduled') }),
    thrown => thrown === error);
    assert.equal(calls, 1);
    calls = 0;
    assert.throws(() => renameAtomicSync('pending', 'final', { platform: 'win32',
        rename: () => { calls++; throw error; }, now: () => clock, remainingMs: () => 500 - clock,
        journal: () => { clock = 499; }, sleep: () => assert.fail('retry window expired') }), thrown => thrown === error);
    assert.equal(calls, 1);
    assert.throws(() => renameAtomicSync('pending', 'final', { platform: 'win32', rename: () => { throw error; },
        journal: () => { throw new Error('fixture journal unavailable'); }, sleep: () => assert.fail('no unjournaled retry') }),
    thrown => thrown === error);
});
