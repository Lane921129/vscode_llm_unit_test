import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BatchJournal } from '../pipeline/batchJournal';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { CandidateCheckpointStore } from '../pipeline/candidateCheckpoint';
import { createStrictQualityPolicy } from '../pipeline/qualityPolicy';
import { SOURCE_VERSIONS_VERSION, sourceVersionsCurrent } from '../pipeline/sourceVersions';
import { preflightTargetModule } from '../pipeline/modulePreflight';

test('guarded preflight tracks constant, module and transitive imports by actual source origin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-versions-'));
    try {
        fs.mkdirSync(path.join(root, 'pkg'));
        fs.writeFileSync(path.join(root, 'pkg', '__init__.py'), '');
        fs.writeFileSync(path.join(root, 'pkg', 'config.py'), 'LIMIT=10\r\nfrom . import helper\r\n');
        fs.writeFileSync(path.join(root, 'pkg', 'helper.py'), 'from .config import LIMIT\ndef value(x): return x + LIMIT\n');
        const target = path.join(root, 'pkg', 'target.py');
        fs.writeFileSync(target, 'from . import helper\nfrom .config import LIMIT\ndef target(x): return helper.value(x) + LIMIT\n');
        const python = path.resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
        const result = await preflightTargetModule(python, target, 'pkg.target', [root], root, [], root);
        assert.equal(result.sourceVersionsVersion, SOURCE_VERSIONS_VERSION);
        assert.deepEqual(result.sourceVersions.map(item => path.basename(item.file)).sort(), ['__init__.py', 'config.py', 'helper.py', 'target.py']);
        assert.equal(sourceVersionsCurrent(result.sourceVersions), true, 'CRLF hashes agree across Python and TS');
        fs.writeFileSync(path.join(root, 'pkg', 'config.py'), 'LIMIT=99\n');
        assert.equal(sourceVersionsCurrent(result.sourceVersions), false);
        fs.unlinkSync(path.join(root, 'pkg', 'helper.py'));
        assert.equal(sourceVersionsCurrent(result.sourceVersions), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const change of ['modify', 'delete', 'same-name', 'legacy', 'mismatch', 'empty', 'target'] as const) {
    test(`batch finish revalidates prior passes: ${change}`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-version-'));
        try {
            const file = path.join(root, 'target.py'), helper = path.join(root, 'helper.py');
            const other = path.join(root, 'other', 'helper.py');
            fs.mkdirSync(path.dirname(other));
            fs.writeFileSync(file, 'def target(x): return x + 1\n');
            fs.writeFileSync(helper, 'VALUE = 1\n'); fs.writeFileSync(other, 'VALUE = 2\n');
            const directory = path.join(root, 'batch'), report = path.join(directory, 'target');
            fs.mkdirSync(report, { recursive: true });
            const policy = createStrictQualityPolicy();
            const journal = new AnalysisJournal(report, fs.readFileSync(file, 'utf8'), 'target', 'fixture', policy);
            const input = JSON.parse(fs.readFileSync(path.resolve('contracts/quality-policy-cases-v1.json'), 'utf8')).cases[0].evidence;
            const code = 'import unittest\n';
            const store = new CandidateCheckpointStore(report, journal.sourceHash, 'target', {
                policy, sourcePath: file, targetScope: { kind: 'function', qualifiedName: 'target' }
            });
            const executable = store.saveExecutable({ code, execution: 'Ran 1 test\nOK', scenarios: [], qualityGaps: [],
                measuredQualityGaps: [], reviewStatus: 'completed', reviewWarnings: [], tier: 1, generationMode: 'llm-evidence-bound',
                dependencyEvidenceVersion: SOURCE_VERSIONS_VERSION,
                dependencyVersions: [helper, other].map(file => ({ file, hash: evidenceHash(fs.readFileSync(file, 'utf8')) })),
                coverage: { coverageText: '100%', missingLines: '', selectedTarget: {
                    qualifiedName: 'target', executableLines: input.coverage.assessment.executableTargetLines, missingLines: [], branchesCovered: true
                }, assessment: { ...input.coverage.assessment,
                    invocationEvidence: { ...input.coverage.assessment.invocationEvidence, testHash: evidenceHash(code) } } }
            });
            const quality = store.saveQuality(executable, { ...input.mutation, sourcePath: file,
                sourceHash: journal.sourceHash, testHash: executable.codeHash, targetScope: { kind: 'function', qualifiedName: 'target' } });
            assert.equal(quality.qualityAssessment?.fullyPassed, true);
            journal.knowledge({ terminalStatus: 'passed', acceptedTest: quality.testFile, acceptedCodeHash: quality.codeHash,
                execution: quality.execution, coverage: quality.coverage, mutation: quality.mutation, qualityAssessment: quality.qualityAssessment,
                reviewStatus: quality.reviewStatus, generationMode: quality.generationMode, resolvedTier: quality.tier,
                dependencyEvidenceVersion: quality.dependencyEvidenceVersion, dependencyVersions: quality.dependencyVersions });
            journal.record(1, 'pipeline', 'passed', {});
            fs.writeFileSync(path.join(report, 'final_report.md'), 'historical report');
            const batch = new BatchJournal(directory, root, { model: 'fixture', buildTimestamp: 'build', python: 'python' });
            batch.discover(file, ['target']); batch.start(); batch.begin(0); batch.attach(0, report); batch.refresh(0);
            const manifest = () => JSON.parse(fs.readFileSync(path.join(directory, 'batch_manifest.json'), 'utf8'));
            assert.equal(manifest().targets[0].terminalStatus, 'passed');
            if (change === 'modify') { fs.writeFileSync(helper, 'VALUE = 3\n'); }
            if (change === 'same-name') { fs.writeFileSync(other, 'VALUE = 3\n'); }
            if (change === 'delete') { fs.unlinkSync(helper); }
            if (change === 'target') { fs.writeFileSync(file, 'def target(x): return x + 2\n'); }
            if (change === 'legacy') {
                const snapshot = { ...quality, dependencyEvidenceVersion: undefined,
                    dependencyVersions: quality.dependencyVersions.map(item => ({ module: 'helper.py', hash: item.hash })) };
                fs.writeFileSync(path.join(report, 'quality_baseline.json'), JSON.stringify(snapshot));
            }
            if (change === 'mismatch') { journal.knowledge({ dependencyVersions: [] }); }
            if (change === 'empty') {
                fs.writeFileSync(path.join(report, 'quality_baseline.json'), JSON.stringify({ ...quality, dependencyVersions: [] }));
                journal.knowledge({ dependencyVersions: [] });
            }
            batch.finish('completed');
            assert.equal(manifest().allTargetsPassed, false);
            assert.equal(manifest().statusCounts.passed, undefined);
            assert.notEqual(manifest().targets[0].terminalStatus, 'passed');
            assert.equal(fs.readFileSync(path.join(report, 'final_report.md'), 'utf8'), 'historical report');
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
}
