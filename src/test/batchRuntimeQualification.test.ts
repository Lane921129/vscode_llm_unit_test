import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BatchRuntimeQualification, currentBatchRuntimeQualification,
    initializeBatchRuntimeQualification } from '../pipeline/batchRuntimeQualification';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';
import { evidenceHash } from '../pipeline/analysisJournal';
import { QUALIFICATION_VERSION } from '../llm/modelQualification';
import { requalifyLocalRuntime } from '../llm/localRuntimeRequalification';

const writer = 'import unittest\nclass TestProbe(unittest.TestCase):\n'
    + '    def test_positive(self):\n        self.assertEqual(increment(1), 2)\n'
    + '    def test_negative(self):\n        self.assertEqual(increment(-1), 0)\n';
const runtime = { endpointKey: 'exact-endpoint-digest', modelName: 'neutral-model', numCtx: 9216,
    qualificationVersion: QUALIFICATION_VERSION };
const qualification = () => requalifyLocalRuntime({ numCtx: runtime.numCtx,
    request: async role => role === 'writer' ? writer : '{"findings":[]}', executor: async () => true });

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-runtime-identity-'));
    const files = ['one.py', 'two.py'].map(name => path.join(root, name));
    for (const file of files) { fs.writeFileSync(file, 'def target(value): return value + 1\n'); }
    const scripts = path.join(root, 'venv', 'Scripts');
    fs.mkdirSync(scripts, { recursive: true });
    const python = path.join(scripts, 'python.exe');
    fs.writeFileSync(python, 'identity-only-fake-interpreter-never-executed');
    const configuration = path.join(root, 'venv', 'pyvenv.cfg');
    fs.writeFileSync(configuration, 'home = identity-fixture-one\n');
    return { root, files, python, configuration, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('two targets share the same execution-owned qualification store; another batch cannot borrow cache or preferred capacity', async () => {
    const sample = fixture();
    try {
        const result = await qualification();
        let first!: BatchRuntimeQualification;
        runInExecution(new ExecutionContext({}), () => {
            initializeBatchRuntimeQualification(sample.root, sample.files, sample.python);
            first = currentBatchRuntimeQualification(sample.root, sample.files[0], sample.python);
            assert.equal(currentBatchRuntimeQualification(sample.root, sample.files[1], sample.python), first);
            const identity = first.identity(runtime, 'approved-fixture-one');
            assert.equal(first.session.set(identity, result), true);
            first.rememberContext(identity);
            assert.equal(first.preferredContext({ ...identity, numCtx: 4096 }), 9216);
        });
        runInExecution(new ExecutionContext({}), () => {
            initializeBatchRuntimeQualification(sample.root, sample.files, sample.python);
            const second = currentBatchRuntimeQualification(sample.root, sample.files[1], sample.python);
            assert.notEqual(second, first);
            assert.notEqual(second.session.batchId, first.session.batchId);
            const identity = second.identity(runtime, 'approved-fixture-one');
            assert.equal(second.session.get(identity), undefined);
            assert.equal(second.preferredContext(identity), undefined);
        });
        assert.notEqual(currentBatchRuntimeQualification(sample.root, sample.files[0], sample.python),
            currentBatchRuntimeQualification(sample.root, sample.files[0], sample.python),
            'unowned calls never create a global cache singleton');
    } finally { sample.cleanup(); }
});

test('selected source drift revokes both cache and preferred capacity and restoring old bytes cannot revive stale evidence', async () => {
    const sample = fixture();
    try {
        const store = new BatchRuntimeQualification('batch-source', sample.root, sample.files, sample.python);
        const identity = store.identity(runtime);
        assert.equal(store.session.set(identity, await qualification()), true);
        store.rememberContext(identity);
        const original = fs.readFileSync(sample.files[1], 'utf8');
        fs.writeFileSync(sample.files[1], original + '# changed source\n');
        assert.equal(store.current(), false);
        assert.equal(store.session.size, 0);
        assert.equal(store.preferredContext(identity), undefined);
        fs.writeFileSync(sample.files[1], original);
        assert.equal(store.current(), false);
        const fresh = new BatchRuntimeQualification('new-batch', sample.root, sample.files, sample.python);
        assert.equal(fresh.current(), true);
        assert.equal(fresh.session.get(fresh.identity(runtime)), undefined);
    } finally { sample.cleanup(); }
});

test('interpreter binary or virtual environment configuration drift invalidates capability evidence', async () => {
    const sample = fixture();
    try {
        for (const file of [sample.python, sample.configuration]) {
            const store = new BatchRuntimeQualification('batch-python', sample.root, sample.files, sample.python);
            const identity = store.identity(runtime);
            assert.equal(store.session.set(identity, await qualification()), true);
            store.rememberContext(identity);
            fs.appendFileSync(file, '\nchanged-interpreter-environment\n');
            assert.equal(store.current(), false);
            assert.equal(store.session.get(identity), undefined);
            assert.equal(store.preferredContext(identity), undefined);
        }
    } finally { sample.cleanup(); }
});

test('fixture/endpoint/model/version changes do not borrow preferred capacity or qualifications from another identity', async () => {
    const sample = fixture();
    try {
        const store = new BatchRuntimeQualification('batch-scope', sample.root, sample.files, sample.python);
        const identity = store.identity(runtime, 'fixture-one');
        assert.equal(store.session.set(identity, await qualification()), true);
        store.rememberContext(identity);
        const changed = [store.identity(runtime, 'fixture-two'),
            store.identity({ ...runtime, endpointKey: 'another-endpoint' }, 'fixture-one'),
            store.identity({ ...runtime, modelName: 'another-model' }, 'fixture-one'),
            store.identity({ ...runtime, qualificationVersion: 'another-version' }, 'fixture-one')];
        for (const next of changed) {
            assert.equal(store.session.get(next), undefined);
            assert.equal(store.preferredContext(next), undefined);
        }
        assert.equal(store.current(), true);
        assert.equal(store.session.get({ ...identity, numCtx: 10240 }), undefined);
    } finally { sample.cleanup(); }
});

test('loaded dependency drift and already-stale preflight evidence clear the owned runtime store', async () => {
    const sample = fixture();
    try {
        const dependency = path.join(sample.root, 'dependency.py');
        fs.writeFileSync(dependency, 'CONSTANT = 1\n');
        const version = { file: dependency, hash: evidenceHash(fs.readFileSync(dependency, 'utf8')) };
        const store = new BatchRuntimeQualification('batch-dependency', sample.root, sample.files, sample.python);
        const identity = store.identity(runtime);
        store.bindDependencies([version]);
        assert.equal(store.current(), true);
        assert.equal(store.session.set(identity, await qualification()), true);
        store.rememberContext(identity);
        fs.writeFileSync(dependency, 'CONSTANT = 2\n');
        assert.equal(store.current(), false);
        assert.equal(store.session.get(identity), undefined);
        assert.equal(store.preferredContext(identity), undefined);
        const fresh = new BatchRuntimeQualification('batch-stale-preflight', sample.root, sample.files, sample.python);
        const freshIdentity = fresh.identity(runtime);
        assert.equal(fresh.session.set(freshIdentity, await qualification()), true);
        fresh.rememberContext(freshIdentity);
        fresh.bindDependencies([version]);
        assert.equal(fresh.current(), false);
        assert.equal(fresh.session.size, 0);
        assert.equal(fresh.preferredContext(freshIdentity), undefined);
    } finally { sample.cleanup(); }
});

test('a fresh preflight cannot replace old dependency bytes and resurrect a qualification before drift was observed', async () => {
    const sample = fixture();
    try {
        const dependency = path.join(sample.root, 'dependency.py');
        fs.writeFileSync(dependency, 'CONSTANT = 1\n');
        const store = new BatchRuntimeQualification('batch-reloaded-dependency', sample.root, sample.files, sample.python);
        const identity = store.identity(runtime);
        store.bindDependencies([{ file: dependency, hash: evidenceHash(fs.readFileSync(dependency, 'utf8')) }]);
        assert.equal(store.session.set(identity, await qualification()), true);
        store.rememberContext(identity);
        fs.writeFileSync(dependency, 'CONSTANT = 2\n');
        // No intervening current() call: the new import must check the old binding itself.
        store.bindDependencies([{ file: dependency, hash: evidenceHash(fs.readFileSync(dependency, 'utf8')) }]);
        assert.equal(store.current(), false);
        assert.equal(store.session.size, 0);
        assert.equal(store.preferredContext(identity), undefined);
    } finally { sample.cleanup(); }
});
