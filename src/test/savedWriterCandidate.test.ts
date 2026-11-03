import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evidenceHash } from '../pipeline/analysisJournal';
import { readSavedWriterCandidate } from '../pipeline/savedWriterCandidate';
import { WITHHELD_SENSITIVE_CONTENT } from '../pipeline/artifactSafety';
import { AnalysisStageError } from '../utils/executionFailureCategory';

function fixture(run: (value: any) => void) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lut-saved-candidate-'));
    try {
        const sourceFile = path.join(directory, 'subject.py');
        fs.writeFileSync(sourceFile, 'def run():\n    return 1\n');
        const sourceHash = evidenceHash(fs.readFileSync(sourceFile, 'utf8'));
        const code = 'import unittest\nfrom subject import run\nclass Cases(unittest.TestCase):\n'
            + '    def test_run(self):\n        self.assertEqual(run(), 1)\n';
        const expected = { sourceFile, sourceHash, target: 'run', model: 'unit-model', modelIdentity: 'local/unit-model' };
        const manifest = { runId: 'original-run', validationMode: 'execution', sourceHash, target: 'run',
            model: 'unit-model', report: { modelIdentity: expected.modelIdentity } };
        const event = (sequence: number, stage: string, status: string, detail: object) =>
            ({ sequence, stage, status, detail, loop: 1, sourceHash, runId: manifest.runId });
        const events = [event(1, 'model-request', 'requested', { role: 'writer' }),
            event(2, 'model-request', 'completed', { role: 'writer' }),
            event(3, 'writer', 'candidate', { code, validationMode: 'execution' })];
        const write = () => {
            fs.writeFileSync(path.join(directory, 'run_manifest.json'), JSON.stringify(manifest));
            fs.writeFileSync(path.join(directory, 'target.json'), JSON.stringify({ sourceFile, target: 'run' }));
            fs.writeFileSync(path.join(directory, 'role_events.jsonl'), events.map(value => JSON.stringify(value)).join('\n'));
        };
        const request = { directory, sequence: 3, codeHash: evidenceHash(code) };
        write();
        run({ directory, expected, manifest, events, request, code, write });
    } finally {
        const relative = path.relative(os.tmpdir(), directory);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
            && path.basename(directory).startsWith('lut-saved-candidate-'));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
const rejected = (action: () => unknown) => assert.throws(action, (error: any) =>
    error instanceof AnalysisStageError && error.stage === 'candidate-replay');

test('saved candidate preserves original model bytes and provenance without granting execution approval', () => fixture(f => {
    const value = readSavedWriterCandidate(f.request, f.expected);
    assert.equal(value.code, f.code);
    assert.deepEqual(value.origin, { version: 'saved-writer-candidate-v1', runId: 'original-run',
        sequence: 3, codeHash: evidenceHash(f.code), sourceRelationship: 'same-native-file' });
    assert.equal('executionVerified' in value, false);
}));

test('identical-source opt-in transfers only a draft and requires both current file hashes', () => fixture(f => {
    const other = path.join(f.directory, 'copy.py');
    fs.copyFileSync(f.expected.sourceFile, other);
    const request = { ...f.request, allowIdenticalSource: true };
    const expected = { ...f.expected, sourceFile: other };
    assert.equal(readSavedWriterCandidate(request, expected).origin.sourceRelationship, 'identical-source-draft');
    fs.appendFileSync(other, '\n# changed\n');
    rejected(() => readSavedWriterCandidate(request, expected));
    fs.copyFileSync(f.expected.sourceFile, other);
    fs.appendFileSync(f.expected.sourceFile, '\n# original changed\n');
    rejected(() => readSavedWriterCandidate(request, expected));
}));

test('saved candidate requires exact source, target, model, provider and artifact hash', () => fixture(f => {
    const other = path.join(f.directory, 'other.py');
    fs.copyFileSync(f.expected.sourceFile, other);
    for (const change of [{ sourceFile: other }, { sourceHash: '0'.repeat(64) }, { target: 'other' },
        { model: 'different' }, { modelIdentity: 'cloud/unit-model' }]) {
        rejected(() => readSavedWriterCandidate(f.request, { ...f.expected, ...change }));
    }
    rejected(() => readSavedWriterCandidate({ ...f.request, codeHash: '0'.repeat(64) }, f.expected));
}));

test('unfinished model replies and cross-run events cannot become saved candidates', () => fixture(f => {
    f.events[1].status = 'error'; f.write();
    rejected(() => readSavedWriterCandidate(f.request, f.expected));
    f.events[1].status = 'completed'; f.events[2].runId = 'another-run'; f.write();
    rejected(() => readSavedWriterCandidate(f.request, f.expected));
}));

test('a model-authored fixer candidate is also only an unapproved draft', () => fixture(f => {
    f.events[1].detail.role = 'bug-fixer'; f.events[2].stage = 'bug-fixer'; f.write();
    assert.equal(readSavedWriterCandidate(f.request, f.expected).code, f.code);
}));

test('redacted, truncated or missing artifacts fail closed without exposing content', () => fixture(f => {
    f.events[2].detail.code = WITHHELD_SENSITIVE_CONTENT; f.write();
    rejected(() => readSavedWriterCandidate({ ...f.request, codeHash: evidenceHash(WITHHELD_SENSITIVE_CONTENT) }, f.expected));
    fs.appendFileSync(path.join(f.directory, 'role_events.jsonl'), '\n{"incomplete":');
    rejected(() => readSavedWriterCandidate(f.request, f.expected));
    fs.unlinkSync(path.join(f.directory, 'target.json'));
    rejected(() => readSavedWriterCandidate(f.request, f.expected));
}));

test('full-quality reports and invalid selectors do not authorize execution-only replay', () => fixture(f => {
    f.manifest.validationMode = 'full'; f.write();
    rejected(() => readSavedWriterCandidate(f.request, f.expected));
    for (const change of [{ sequence: 0 }, { sequence: 2.5 }, { directory: 'relative-directory' },
        { repair: 'true' }, { codeHash: 'invalid' }]) {
        rejected(() => readSavedWriterCandidate({ ...f.request, ...change }, f.expected));
    }
}));
