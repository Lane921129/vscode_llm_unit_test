import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { reserveArtifactFiles, checkOutputPath } from '../pipeline/artifactPaths';
import { createAnalysisDirectory, createBatchDirectory } from '../pipeline/analysisOutput';

test('short artifact pairs preserve existing evidence, including an orphaned coverage file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'short-art-'));
    try {
        fs.writeFileSync(path.join(root, 'coverage_001.json'), 'prior evidence');
        const first = reserveArtifactFiles(root, ['invocation', 'coverage'], 'json');
        assert.deepEqual(first.map(file => path.basename(file)), ['invocation_002.json', 'coverage_002.json']);
        assert.equal(fs.existsSync(path.join(root, 'invocation_001.json')), false);
        assert.equal(fs.readFileSync(path.join(root, 'coverage_001.json'), 'utf8'), 'prior evidence');
        const next = reserveArtifactFiles(root, ['invocation', 'coverage'], 'json');
        assert.notEqual(next[0], first[0]);
        assert.match(path.basename(reserveArtifactFiles(root, ['trace'], 'jsonl')[0]), /^trace_\d{3}\.jsonl$/);
        assert.throws(() => reserveArtifactFiles(root, ['../escape'], 'json'), /Invalid/);
        assert.throws(() => checkOutputPath(path.join(root, 'x'.repeat(240))), /輸出目錄/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('deep sources and long qualified targets have bounded flat output with exact identity and fresh attempts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'short-dir-'));
    try {
        const batch = createBatchDirectory(root, '2026_09_24_14_05', 'a_very_long_project_name_'.repeat(6));
        const source = path.join(root, ...Array(12).fill('deep_source_tree'), 'module.py');
        const target = 'LongClassName.' + 'method_name_'.repeat(16);
        const first = createAnalysisDirectory(root, 'date', source, target, 'project', root, batch);
        assert.equal(path.dirname(first), batch);
        assert.ok(path.basename(first).length <= 36);
        assert.ok(path.basename(batch).length <= 41);
        const mapping = JSON.parse(fs.readFileSync(path.join(first, 'target.json'), 'utf8'));
        assert.equal(mapping.sourceFile, source);
        assert.equal(mapping.target, target);
        assert.equal(mapping.sourceKeyHash.length, 64);
        const retry = createAnalysisDirectory(root, 'date', source, target, 'project', root, batch);
        const another = createAnalysisDirectory(root, 'date', path.join(root, 'other/module.py'), target, 'project', root, batch);
        assert.notEqual(first, retry);
        assert.notEqual(first, another);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first, 'target.json'), 'utf8')), mapping);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
