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

test('deep sources have bounded source folders containing function results and fresh attempts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'short-dir-'));
    try {
        const batch = createBatchDirectory(root, '2026_09_24_14_05', 'a_very_long_project_name_'.repeat(6));
        const source = path.join(root, ...Array(12).fill('deep_source_tree'), 'module.py');
        const target = 'LongClassName.' + 'method_name_'.repeat(16);
        const first = createAnalysisDirectory(root, 'date', source, target, 'project', root, batch);
        assert.equal(path.dirname(path.dirname(first)), batch);
        assert.ok(path.basename(path.dirname(first)).length <= 25);
        assert.ok(path.basename(first).length <= 29);
        assert.ok(path.basename(batch).length <= 41);
        const mapping = JSON.parse(fs.readFileSync(path.join(first, 'target.json'), 'utf8'));
        assert.equal(mapping.sourceFile, source);
        assert.equal(mapping.target, target);
        assert.equal(mapping.sourceKeyHash.length, 64);
        const sourceMapping = JSON.parse(fs.readFileSync(path.join(path.dirname(first), 'source.json'), 'utf8'));
        assert.equal(sourceMapping.sourceFile, source);
        assert.equal(sourceMapping.sourceKeyHash.length, 64);
        const sibling = createAnalysisDirectory(root, 'date', source, 'another_function', 'project', root, batch);
        assert.equal(path.dirname(sibling), path.dirname(first));
        const retry = createAnalysisDirectory(root, 'date', source, target, 'project', root, batch);
        const another = createAnalysisDirectory(root, 'date', path.join(root, 'other/module.py'), target, 'project', root, batch);
        assert.notEqual(first, retry);
        assert.notEqual(first, another);
        assert.notEqual(path.dirname(first), path.dirname(another));
        assert.equal(path.dirname(retry), path.dirname(first));
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first, 'target.json'), 'utf8')), mapping);
        // A colliding short label must never combine unrelated source evidence.
        fs.writeFileSync(path.join(path.dirname(first), 'source.json'), JSON.stringify({ ...sourceMapping, sourceKeyHash: 'other' }));
        const collision = createAnalysisDirectory(root, 'date', source, 'fresh', 'project', root, batch);
        assert.notEqual(path.dirname(collision), path.dirname(first));
        assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(first), 'source.json'), 'utf8')).sourceKeyHash, 'other');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
