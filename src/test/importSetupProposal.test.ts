import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readInitializationCandidate } from '../environment/importSetupProposal';

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
