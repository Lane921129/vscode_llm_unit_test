import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { containsCredential, normalizeKnownSecrets, redactCredentialStrings, WITHHELD_SENSITIVE_CONTENT } from '../pipeline/artifactSafety';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { RejectedCandidateStore } from '../pipeline/rejectedCandidateStore';

const fakeSecret = 'fixture-private-value-12345678';

test('credential detection is shared, exact for configured secrets, and excludes short configuration mistakes', () => {
    assert.deepEqual(normalizeKnownSecrets(['', 'a', '1234567', fakeSecret, fakeSecret]), [fakeSecret]);
    assert.equal(containsCredential('ordinary candidate', ['', 'a']), false);
    assert.equal(containsCredential('prefix ' + fakeSecret + ' suffix', [fakeSecret]), true);
    assert.equal(containsCredential(fakeSecret.toUpperCase(), [fakeSecret]), false);
    assert.equal(containsCredential('prefix 12345678 suffix', ['12345678']), true);
    for (const token of ['sk-proj-' + 'q'.repeat(40), 'AIza' + 'q'.repeat(35), 'ghp_' + 'q'.repeat(36),
        'github_pat_' + 'q'.repeat(40), 'xoxb-' + 'q'.repeat(32), 'AKIA' + 'Q'.repeat(16),
        'Bearer ' + 'q'.repeat(40), 'eyJ' + 'q'.repeat(20) + '.' + 'w'.repeat(20) + '.' + 'e'.repeat(20),
        `api_key = '${'q'.repeat(32)}'`]) {
        assert.equal(containsCredential(token), true);
    }
});

test('recursive redaction preserves ordinary code, paths, identities, and numbers without mutating caller data', () => {
    const input = { code: 'import unittest\nclass Cases(unittest.TestCase):\n    pass\n',
        artifactPath: 'rejected_candidates/candidate_' + 'a'.repeat(64) + '.py', sourceHash: 'a'.repeat(64),
        runId: 'run-one', attempt: 3, ratio: 0.5, enabled: false, nullable: null,
        nested: [{ message: 'private ' + fakeSecret, normal: 'unchanged' }],
        credentialMap: { [fakeSecret]: 'private dictionary entry' }, apiKey: 'q'.repeat(32) };
    const safe = redactCredentialStrings(input, [fakeSecret]) as typeof input;
    assert.equal(safe.code, input.code);
    assert.equal(safe.artifactPath, input.artifactPath);
    assert.equal(safe.sourceHash, input.sourceHash);
    assert.equal(safe.runId, input.runId);
    assert.equal(safe.attempt, input.attempt);
    assert.equal(safe.ratio, input.ratio);
    assert.equal(safe.enabled, false);
    assert.equal(safe.nullable, null);
    assert.equal(safe.nested[0].message, WITHHELD_SENSITIVE_CONTENT);
    assert.equal(safe.nested[0].normal, 'unchanged');
    assert.equal(safe.apiKey, WITHHELD_SENSITIVE_CONTENT);
    assert.equal(safe.credentialMap[fakeSecret], undefined);
    assert.doesNotMatch(JSON.stringify(safe), /fixture-private-value/);
    assert.ok(input.nested[0].message.includes(fakeSecret));
});

test('journal guards manifest, events, snapshots, and knowledge while complete provider replies remain hashed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-journal-'));
    try {
        const journal = new AnalysisJournal(root, 'source with ' + fakeSecret, 'target', 'model-' + fakeSecret,
            undefined, 'full', undefined, [fakeSecret]);
        const normalCode = 'import unittest\nclass Cases(unittest.TestCase):\n    pass\n';
        const credentialCode = `import unittest\nvalue = '${fakeSecret}'\n`;
        const patternedToken = 'ghp_' + 'q'.repeat(36);
        const raw = 'provider envelope with ' + fakeSecret;
        journal.record(1, 'writer', 'candidate', { code: normalCode, attempt: 0, raw });
        journal.record(1, 'writer', 'failed', { code: credentialCode, reason: `request used ${fakeSecret}`,
            nested: [{ out: patternedToken }], providerResponse: { content: raw } });
        journal.record(2, 'private-' + fakeSecret, 'private-' + patternedToken, null);
        journal.knowledge({ acceptedTest: 'loop1_test.py', acceptedCodeHash: evidenceHash(normalCode),
            stableCode: normalCode, unsafeCode: credentialCode, nested: { raw, trace: [patternedToken] },
            tokenByName: { client_secret: 'q'.repeat(32) }, count: 42 });
        const events = fs.readFileSync(path.join(root, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(events[0].detail.code, normalCode);
        assert.equal(events[0].detail.responseHash, evidenceHash(raw));
        assert.equal(events[0].detail.responseCharacters, raw.length);
        assert.equal(events[1].detail.code, WITHHELD_SENSITIVE_CONTENT);
        assert.equal(events[1].detail.reason, WITHHELD_SENSITIVE_CONTENT);
        assert.equal(events[1].detail.nested[0].out, WITHHELD_SENSITIVE_CONTENT);
        assert.equal(events[2].stage, WITHHELD_SENSITIVE_CONTENT);
        assert.equal(events[2].status, WITHHELD_SENSITIVE_CONTENT);
        assert.equal(journal.snapshot().stableCode, normalCode);
        assert.equal(journal.snapshot().unsafeCode, WITHHELD_SENSITIVE_CONTENT);
        assert.equal(journal.snapshot().acceptedTest, 'loop1_test.py');
        assert.equal(journal.snapshot().acceptedCodeHash, evidenceHash(normalCode));
        assert.equal(journal.snapshot().count, 42);
        assert.deepEqual((journal.snapshot().nested as any).trace, [WITHHELD_SENSITIVE_CONTENT]);
        assert.equal((journal.snapshot().nested as any).responseHash, evidenceHash(raw));
        for (const name of fs.readdirSync(root)) {
            const text = fs.readFileSync(path.join(root, name), 'utf8');
            assert.ok(!text.includes(fakeSecret), name);
            assert.ok(!text.includes(patternedToken), name);
            assert.ok(!text.includes('q'.repeat(32)), name);
            assert.ok(!text.includes(raw), name);
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'run_manifest.json'), 'utf8'));
        assert.equal(manifest.model, WITHHELD_SENSITIVE_CONTENT);
        assert.equal(manifest.runId, journal.runId);
        assert.equal(manifest.sourceHash, journal.sourceHash);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('store and journal agree on sensitive candidate withholding while ordinary candidate evidence remains available', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-credential-guard-'));
    try {
        const journal = new AnalysisJournal(root, 'source', 'target', 'model', undefined, 'full', undefined, [fakeSecret]);
        const store = new RejectedCandidateStore(root, { sourceHash: journal.sourceHash, target: 'target' }, [fakeSecret]);
        for (const code of [`import unittest\nvalue = '${fakeSecret}'\n`,
            `import unittest\napi_key = '${'q'.repeat(32)}'\n`,
            'import unittest\n# ordinary malformed candidate\n']) {
            const artifact = store.record({ code, phase: 'seed', tier: 1, attempt: 0,
                gate: 'unittest-structure', reasonCode: 'candidate-structure-rejected' });
            journal.record(1, 'writer', 'candidate', { code });
            assert.equal(artifact.withheldReason === 'credential-detected', containsCredential(code, [fakeSecret]));
            if (!containsCredential(code, [fakeSecret])) {
                assert.equal(fs.readFileSync(path.join(root, artifact.artifactPath!), 'utf8'), code);
            }
        }
        const events = fs.readFileSync(path.join(root, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(events[0].detail.code, WITHHELD_SENSITIVE_CONTENT);
        assert.equal(events[1].detail.code, WITHHELD_SENSITIVE_CONTENT);
        assert.match(events[2].detail.code, /ordinary malformed candidate/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
