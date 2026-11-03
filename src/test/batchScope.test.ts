import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { batchScopeFiles, batchScopeItems, batchScopeStateKey, createBatchScopeSelection, deduplicateTargets } from '../pipeline/batchScope';

test('batch scope uses real file identity without merging different folders or silently excluding backups', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-scope-'));
    try {
        fs.mkdirSync(path.join(root, 'old backup'));
        const first = path.join(root, 'source.py'), second = path.join(root, 'old backup', 'source.py');
        fs.writeFileSync(first, ''); fs.writeFileSync(second, '');
        const files = batchScopeFiles(root, [first, second, path.join(root, '.', 'source.py')]);
        assert.deepEqual(files, ['old backup/source.py', 'source.py']);
        const items = batchScopeItems(files);
        assert.ok(items.every(item => item.selected));
        assert.equal(items[0].hint, 'backup');
        assert.equal(batchScopeItems(['tests/helper.py'])[0].hint, 'test-fixture');
        assert.equal(batchScopeItems(['business/testimonials.py'])[0].hint, undefined);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('saved scope keeps explicit exclusions and selects newly discovered files visibly', () => {
    const items = batchScopeItems(['main.py', 'old backup/main.py', 'new.py'], {
        knownFiles: ['main.py', 'old backup/main.py'], selectedFiles: ['main.py'] });
    assert.deepEqual(items.map(item => [item.file, item.selected, item.added]), [
        ['main.py', true, false], ['old backup/main.py', false, false], ['new.py', true, true] ]);
});

test('batch scope rejects escape paths, binds saved choices to each root and hashes explicit selection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-scope-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-scope-other-'));
    try {
        const outsider = path.join(other, 'source.py'); fs.writeFileSync(outsider, '');
        assert.throws(() => batchScopeFiles(root, [outsider]), /escapes/);
        assert.notEqual(batchScopeStateKey(root), batchScopeStateKey(other));
        const selection = createBatchScopeSelection(root, ['a.py', 'b.py'], ['b.py']);
        assert.equal(selection.root, path.resolve(root), 'scope must preserve execution identity path spelling');
        assert.deepEqual(selection.excludedFiles, ['a.py']);
        assert.equal(selection.scopeId, createBatchScopeSelection(root, ['b.py', 'a.py'], ['b.py']).scopeId);
        assert.notEqual(selection.scopeId, createBatchScopeSelection(root, ['a.py', 'b.py'], ['a.py']).scopeId);
        assert.throws(() => createBatchScopeSelection(root, ['a.py'], ['../a.py']));
        assert.throws(() => createBatchScopeSelection(root, ['../a.py'], ['../a.py']));
        assert.throws(() => createBatchScopeSelection(root, ['a.py'], []));
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

test('ambiguous selectors become one diagnostic and do not discard independent valid targets', () => {
    const result = deduplicateTargets([{ fullName: 'calculate' }, { fullName: 'calculate' },
        { fullName: 'calculate' }, { fullName: 'Calculator.calculate' }, { fullName: 'save' }]);
    assert.deepEqual(result.ambiguousTargets, ['calculate']);
    assert.deepEqual(result.targets.map(item => item.fullName), ['Calculator.calculate', 'save']);
    assert.deepEqual(deduplicateTargets([{ fullName: 'calculate' }]).targets, [{ fullName: 'calculate' }]);
});

test('scope picker remembers approval only, preserves cancellation, and rejects responses after root changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-picker-'));
    const first = path.join(root, 'first.py'), second = path.join(root, 'second.py');
    fs.writeFileSync(first, ''); fs.writeFileSync(second, '');
    const stored = new Map<string, unknown>();
    const state = { get: (key: string) => stored.get(key), update: async (key: string, value: unknown) => { stored.set(key, value); } };
    const pending: Array<{ items: any[]; resolve: (value: any) => void }> = [];
    const Module = require('module'), original = Module._load;
    const mock = {
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        }, window: {
            showQuickPick: (items: any[]) => new Promise(resolve => { pending.push({ items, resolve }); }),
            showWarningMessage: async () => {}, showInformationMessage: async () => {}
        }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? mock : original.call(this, name, ...args); };
    try {
        const { BatchScopeController } = require('../ui/BatchScopeController');
        const controller = new BatchScopeController(state);
        let operation = controller.preview(root, [first, second]);
        let dialog = pending.shift()!; dialog.resolve([dialog.items.find(item => item.file === 'first.py')]);
        assert.deepEqual((await operation).selectedFiles, ['first.py']);
        const before = JSON.stringify([...stored]);
        operation = controller.preview(root, [first, second]);
        dialog = pending.shift()!;
        assert.equal(dialog.items.find(item => item.file === 'second.py').picked, false);
        dialog.resolve(undefined); assert.equal(await operation, undefined); assert.equal(JSON.stringify([...stored]), before);
        operation = controller.preview(root, [first, second]); dialog = pending.shift()!;
        controller.invalidate(); dialog.resolve(dialog.items);
        assert.equal(await operation, undefined); assert.equal(JSON.stringify([...stored]), before);
        operation = controller.preview(root, [first, second]); pending.shift()!.resolve([]);
        assert.equal(await operation, undefined); assert.equal(JSON.stringify([...stored]), before);
    } finally { Module._load = original; fs.rmSync(root, { recursive: true, force: true }); }
});
