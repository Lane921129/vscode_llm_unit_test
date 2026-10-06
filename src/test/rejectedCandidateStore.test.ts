import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { RejectedCandidateIdentity, RejectedCandidateInput, RejectedCandidateStore } from '../pipeline/rejectedCandidateStore';

const identity: RejectedCandidateIdentity = { sourceHash: 'a'.repeat(64), target: 'target', runId: 'run-one',
    sourceCode: 'def target(value):\n    return value + 1\n' };
const code = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
    + '    def test_target(self):\n        self.assertEqual(target(1), 9)\n';
const rejection = (candidate = code): RejectedCandidateInput => ({ code: candidate, phase: 'seed', tier: 2,
    attempt: 0, gate: 'assertion-evidence', reasonCode: 'observed-result-mismatch' });

function inDirectory(run: (directory: string) => void): void {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rejected-candidate-'));
    try { run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('rejected Python is immutable evidence with separate attempt metadata, never an executable checkpoint', () => {
    inDirectory(directory => {
        const store = new RejectedCandidateStore(directory, identity);
        const first = store.record(rejection());
        assert.equal(first.status, 'saved');
        assert.equal(first.executable, false);
        assert.equal(first.codeHash, createHash('sha256').update(code).digest('hex'));
        assert.equal(fs.readFileSync(path.join(directory, first.artifactPath!), 'utf8'), code);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, first.metadataPath!), 'utf8')), first);
        assert.equal(fs.existsSync(path.join(directory, 'executable_baseline.json')), false);
        assert.doesNotMatch(path.basename(first.artifactPath!), /^test/);
        const second = store.record({ ...rejection(), phase: 'generation', tier: 1, attempt: 1 });
        assert.equal(second.artifactPath, first.artifactPath);
        assert.notEqual(second.metadataPath, first.metadataPath);
        const names = fs.readdirSync(path.join(directory, 'rejected_candidates'));
        assert.equal(names.filter(name => name.endsWith('.py')).length, 1);
        assert.equal(names.filter(name => name.endsWith('.json')).length, 2);
        assert.equal(names.some(name => name.endsWith('.pending')), false);
        assert.ok(!JSON.stringify(first).includes(identity.sourceCode!));
    });
});

test('malformed extracted Python is retained before a syntax gate rejects it', () => {
    inDirectory(directory => {
        const malformed = 'import unittest\nclass Cases(unittest.TestCase)\n    def test_target(self):\n        pass\n';
        const result = new RejectedCandidateStore(directory, identity).record({ ...rejection(malformed),
            gate: 'python-syntax', reasonCode: 'invalid-python-syntax' });
        assert.equal(result.status, 'saved');
        assert.equal(fs.readFileSync(path.join(directory, result.artifactPath!), 'utf8'), malformed);
    });
});

test('raw provider text and wrappers are withheld instead of becoming candidate artifacts', () => {
    inDirectory(directory => {
        const store = new RejectedCandidateStore(directory, identity);
        for (const raw of [`Provider explanation\n\`\`\`python\n${code}\`\`\`\nprivate provider suffix`,
            JSON.stringify({ code }), '<thinking>private reasoning</thinking>\n' + code, 'I cannot generate a test.']) {
            const result = store.record(rejection(raw));
            assert.equal(result.withheldReason, 'not-extracted-python');
            assert.equal(result.artifactPath, undefined);
            const saved = fs.readFileSync(path.join(directory, result.metadataPath!), 'utf8');
            assert.ok(!saved.includes(raw));
            assert.ok(!saved.includes('private provider suffix'));
        }
        assert.equal(fs.readdirSync(path.join(directory, 'rejected_candidates')).some(name => name.endsWith('.py')), false);
    });
});

test('known credentials and high-confidence token patterns never reach artifacts or metadata', () => {
    inDirectory(directory => {
        const secret = 'known-private-value-12345';
        const store = new RejectedCandidateStore(directory, identity, [secret]);
        const tokens = [secret, 'sk-proj-' + 'A'.repeat(48), 'AIza' + 'a'.repeat(35),
            'ghp_' + 'a'.repeat(36), 'Bearer ' + 'a'.repeat(40),
            'eyJ' + 'a'.repeat(20) + '.' + 'b'.repeat(30) + '.' + 'c'.repeat(30)];
        for (const token of tokens) {
            const result = store.record(rejection(`import unittest\nsecret = '${token}'\n`));
            assert.equal(result.withheldReason, 'credential-detected');
            assert.ok(!JSON.stringify(result).includes(token));
        }
        const assigned = store.record(rejection(`import unittest\napi_key = '${'q'.repeat(32)}'\n`));
        assert.equal(assigned.withheldReason, 'credential-detected');
        for (const name of fs.readdirSync(path.join(directory, 'rejected_candidates'))) {
            assert.ok(!name.endsWith('.py'));
            const saved = fs.readFileSync(path.join(directory, 'rejected_candidates', name), 'utf8');
            for (const token of tokens) { assert.ok(!saved.includes(token)); }
        }
    });
});

test('copied target functions, classes and embedded original source are withheld', () => {
    inDirectory(directory => {
        const store = new RejectedCandidateStore(directory, identity);
        assert.equal(store.record(rejection(identity.sourceCode)).withheldReason, 'source-copy');
        assert.equal(store.record(rejection(code + '\n' + identity.sourceCode)).withheldReason, 'source-copy');
        const embedded = 'import unittest\nclass Copy:\n    def target(value):\n        return value + 1\n';
        assert.equal(store.record(rejection(embedded)).withheldReason, 'source-copy');
    });
    inDirectory(directory => {
        const store = new RejectedCandidateStore(directory, { ...identity, target: 'Original.call' });
        assert.equal(store.record(rejection('class Original:\n    def call(self):\n        return 5\n')).withheldReason, 'source-copy');
    });
});

test('record, candidate size and total storage limits remain bounded across reopened stores', () => {
    inDirectory(directory => {
        const first = new RejectedCandidateStore(directory, identity, [], { maxCandidates: 1 }).record(rejection());
        const reopened = new RejectedCandidateStore(directory, identity, [], { maxCandidates: 1 });
        const second = reopened.record(rejection(code + '# another\n'));
        assert.equal(second.withheldReason, 'record-limit');
        assert.equal(second.metadataPath, undefined);
        assert.equal(fs.readdirSync(path.join(directory, 'rejected_candidates')).length, 2);
        assert.ok(fs.existsSync(path.join(directory, first.artifactPath!)));
    });
    inDirectory(directory => {
        const limited = new RejectedCandidateStore(directory, identity, [], { maxCandidateBytes: 10 });
        assert.equal(limited.record(rejection()).withheldReason, 'candidate-size-limit');
    });
    inDirectory(directory => {
        const limited = new RejectedCandidateStore(directory, identity, [], { maxTotalBytes: 1 });
        assert.equal(limited.record(rejection()).withheldReason, 'storage-limit');
        assert.deepEqual(fs.readdirSync(path.join(directory, 'rejected_candidates')), []);
    });
});

test('corrupted candidates, conflicting identities and unsafe diagnostics are rejected', () => {
    inDirectory(directory => {
        const store = new RejectedCandidateStore(directory, identity);
        const saved = store.record(rejection());
        fs.writeFileSync(path.join(directory, saved.artifactPath!), 'corrupt');
        assert.throws(() => store.record(rejection()), /artifact conflict/);
        const other = new RejectedCandidateStore(directory, { ...identity, sourceHash: 'b'.repeat(64) });
        assert.throws(() => other.record(rejection()), /identity conflict/);
        assert.throws(() => store.record({ ...rejection(), reasonCode: 'raw error: private payload' }), /diagnostic is invalid/);
        assert.throws(() => store.record({ ...rejection(), attempt: -1 }), /diagnostic is invalid/);
        assert.throws(() => new RejectedCandidateStore(directory, identity, [], { maxCandidates: Infinity }), /limit is invalid/);
        assert.equal(fs.readdirSync(path.join(directory, 'rejected_candidates')).some(name => name.endsWith('.pending')), false);
    });
});
