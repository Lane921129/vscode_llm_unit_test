import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createDefaultQualityPolicy } from '../qualityPolicy';
import { mutationScore, readStoredMutationRun } from '../../mutation/mutationResult';
import { CaseRow } from './caseTable';
import { readCaseTable } from './caseTableStore';
import { CoverageMeasurement, MutationMeasurement, sha256File } from './rowExecution';
import { CASE_TABLE_QUALITY_JSON, CASE_TABLE_REVIEW_JSON, ROW_RUN_DIRECTORY, mergedTestModule } from './artifactNames';

export interface CaseTableReviewCompletion { enabled: boolean; completed: boolean; addedRowIds: string[] }
export interface CaseTableQualityEvidence {
    usable: boolean;
    coverage?: CoverageMeasurement;
    mutation?: Pick<MutationMeasurement, 'run' | 'score'>;
    review: CaseTableReviewCompletion;
}
const thresholdPolicy = () => {
    const policy = createDefaultQualityPolicy();
    return { policyId: policy.policyId, policyHash: policy.policyHash,
        lineThreshold: policy.lineThreshold, mutationThreshold: policy.mutationThreshold };
};
const meets = (part: number, total: number, ratio: { numerator: number; denominator: number }) =>
    Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(part) && part >= 0 && part <= total
    && part * ratio.denominator >= total * ratio.numerator;

/** v2's approved five conditions; only numeric thresholds come from standard.
 * This does not grant v1's same-candidate test-code review approval. */
export function assessCaseTableQuality(evidence: CaseTableQualityEvidence, rows: CaseRow[]) {
    const policy = thresholdPolicy();
    const reasons: string[] = [];
    if (!evidence.usable) { reasons.push('not-usable'); }
    const coverage = evidence.coverage;
    if (!coverage?.available || !Array.isArray(coverage.missingLines)
        || !meets(coverage.executableLines - coverage.missingLines.length, coverage.executableLines, policy.lineThreshold)) {
        reasons.push('line-threshold-not-met');
    }
    if (coverage?.branchesCovered !== true || !Array.isArray(coverage.missingBranches) || coverage.missingBranches.length) {
        reasons.push('branches-not-covered');
    }
    const run = evidence.mutation?.run;
    if (!run || run.status !== 'complete' || !run.baselinePassed || !run.scoreAvailable
        || !meets(run.counts.killed, run.counts.selected, policy.mutationThreshold)) {
        reasons.push('mutation-threshold-not-met');
    }
    const toolsSatisfied = reasons.length === 0;
    const review = evidence.review;
    if (!review.enabled) { reasons.push('review-disabled'); }
    if (!review.completed || !Array.isArray(review.addedRowIds) || !review.addedRowIds.every(id =>
        rows.some(row => row.id === id && (['invalid', 'capture-failed', 'test-passed', 'test-failed'].includes(row.status)
            || (row.status === 'captured' && ['spec-mismatch', 'needs-review'].includes(row.oracleStatus ?? '')))))) {
        reasons.push('review-incomplete');
    }
    if (rows.some(row => row.reviewFlags?.length)) { reasons.push('review-flags-unresolved'); }
    return { version: 'case-table-quality-v1' as const, thresholdPolicy: policy,
        toolsSatisfied, fullyPassed: reasons.length === 0, reasons };
}
export type CaseTableQualityAssessment = ReturnType<typeof assessCaseTableQuality>;

function reviewCompletion(directory: string, enabled: boolean): CaseTableReviewCompletion {
    if (!enabled) { return { enabled: false, completed: false, addedRowIds: [] }; }
    const review = JSON.parse(fs.readFileSync(path.join(directory, CASE_TABLE_REVIEW_JSON), 'utf8'));
    return { enabled: true, completed: review.completed === true, addedRowIds: review.addedRowIds };
}

/** Bind the accepted v2 formal test and native measurement to this target. */
export function writeCaseTableQuality(directory: string, sourceFile: string, target: string,
    stage: { terminal: string; testFile?: string; coverage?: CoverageMeasurement; mutation?: MutationMeasurement },
    rows: CaseRow[], reviewEnabled: boolean): CaseTableQualityAssessment | undefined {
    if (stage.terminal !== 'usable' || !stage.testFile) { return undefined; }
    const sourceHash = sha256File(sourceFile), testHash = sha256File(stage.testFile);
    const context = { sourcePath: path.resolve(sourceFile), sourceHash, testHash,
        targetScope: { kind: 'function' as const, qualifiedName: target } };
    const native = readStoredMutationRun(stage.mutation?.run, context);
    const evidence: CaseTableQualityEvidence = {
        usable: native.ok && mutationScore(native.run) === stage.mutation?.score,
        coverage: stage.coverage, mutation: { run: stage.mutation?.run, score: stage.mutation?.score ?? null },
        review: reviewCompletion(directory, reviewEnabled)
    };
    const assessment = assessCaseTableQuality(evidence, rows);
    fs.writeFileSync(path.join(directory, CASE_TABLE_QUALITY_JSON), JSON.stringify({ version: 'case-table-quality-evidence-v1',
        sourceHash, testHash, target, testFile: path.relative(directory, stage.testFile).replace(/\\/g, '/'),
        evidence, assessment }, null, 2) + '\n', 'utf8');
    return assessment;
}

/** v2-only batch verification. v1 verifyQualityPass/evaluateQuality stay unchanged. */
export function verifyCaseTableQuality(directory: string, sourceFile: string, target: string,
    manifest: any, knowledge: any): void {
    const invalid = () => { throw Error('incomplete-v2-quality-provenance'); };
    if (manifest.pipelineVersion !== 'v2-case-table' || knowledge.pipelineVersion !== manifest.pipelineVersion
        || knowledge.qualityContractVersion !== 'case-table-quality-v1') { return invalid(); }
    const saved = JSON.parse(fs.readFileSync(path.join(directory, CASE_TABLE_QUALITY_JSON), 'utf8'));
    const allowed = ['', '_followup'].map(suffix => `${ROW_RUN_DIRECTORY}/${mergedTestModule(suffix)}.py`);
    if (saved.version !== 'case-table-quality-evidence-v1' || saved.target !== target || !allowed.includes(saved.testFile)
        || saved.sourceHash !== manifest.sourceHash || saved.sourceHash !== sha256File(sourceFile)
        || saved.testHash !== sha256File(path.join(directory, saved.testFile))) { return invalid(); }
    const native = readStoredMutationRun(saved.evidence?.mutation?.run, {
        sourcePath: path.resolve(sourceFile), sourceHash: saved.sourceHash, testHash: saved.testHash,
        targetScope: { kind: 'function', qualifiedName: target }
    });
    if (!native.ok || !saved.evidence.usable || mutationScore(native.run) !== saved.evidence.mutation.score
        || !isDeepStrictEqual(saved.evidence.review, reviewCompletion(directory, true))) { return invalid(); }
    const table = readCaseTable(directory);
    if (table.target !== target) { return invalid(); }
    const assessment = assessCaseTableQuality(saved.evidence, table.rows);
    const result = JSON.parse(fs.readFileSync(path.join(directory, 'v2_result.json'), 'utf8'));
    const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (!assessment.fullyPassed || !isDeepStrictEqual(assessment, saved.assessment)
        || !isDeepStrictEqual(assessment, knowledge.qualityAssessment) || !isDeepStrictEqual(assessment, result.qualityAssessment)
        || result.terminal !== 'quality-passed' || !isDeepStrictEqual(result.coverage, saved.evidence.coverage)
        || !events.some(event => event.stage === 'model-request' && event.status === 'completed'
            && event.detail?.role === 'case-table-review')) { return invalid(); }
}
