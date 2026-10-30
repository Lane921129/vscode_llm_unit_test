import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readInitializationCandidate, readPlannedInitializationCandidate } from '../environment/importSetupProposal';
import { mergeInitializationProposal } from '../environment/initializationPlanning';

test('initialization advice must match the selected root, source bytes and observed contract', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-evidence-'));
    try {
        const file = path.join(root, 'sample.py'); fs.writeFileSync(file, 'value = 1\n');
        const candidate = { schemaVersion: 'import-initialization-candidate-v1', kind: 'entry-point',
            file: 'sample.py', line: 1, sourceHash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
            operation: 'neutral_runtime.launch', evidence: 'blocked-direct-module-call', returnValue: 'discarded' };
        const read = (value: unknown, exception_type = 'TraceSafetyError') =>
            readInitializationCandidate(root, { exception_type, initialization_candidate: value });
        assert.deepEqual(read(candidate), candidate);
        for (const change of [{ file: '../sample.py' }, { file }, { sourceHash: '0'.repeat(64) },
            { kind: 'unknown' }, { line: 0 }, { evidence: 'model-guess' }, { returnValue: 'assigned' },
            { operation: 'neutral_runtime.launch\n' }, { kind: 'mkdir' }]) {
            assert.equal(read({ ...candidate, ...change }), undefined);
        }
        assert.equal(read(candidate, 'AttributeError'), undefined);
        fs.appendFileSync(file, '# changed\n');
        assert.equal(read(candidate), undefined);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a source-bound text-file requirement accepts only a declared safe path and never carries source content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-text-fixture-'));
    try {
        const file = path.join(root, 'sample.py'); fs.writeFileSync(file, 'value = 1\n');
        const candidate = { schemaVersion: 'import-initialization-candidate-v1', kind: 'read-file',
            file: 'sample.py', line: 1, sourceHash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
            operation: 'builtins.open', evidence: 'static-direct-module-call', returnValue: 'used', resourcePath: 'settings.json' } as const;
        const read = (value: unknown) => readPlannedInitializationCandidate(root, value);
        assert.deepEqual(read(candidate), candidate);
        assert.equal(read({ ...candidate, returnValue: 'discarded' }), undefined);
        assert.equal(read({ ...candidate, resourcePath: '../settings.json' }), undefined);
        assert.equal(read({ ...candidate, operation: 'pathlib.Path.read_bytes' }), undefined);
        assert.equal(Object.hasOwn(read(candidate) || {}, 'text'), false);
        const rules: any[] = [];
        assert.equal(mergeInitializationProposal(rules, candidate), true);
        assert.deepEqual(rules[0].resources, [{ path: 'settings.json', kind: 'text', text: '' }]);
        assert.equal(rules[0].resourceSourceHash, candidate.sourceHash);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
