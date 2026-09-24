import * as fs from 'fs';
import * as path from 'path';
import { evidenceHash } from './analysisJournal';
import { ReviewStatus } from '../roles/reviewSession';
import { ScenarioIdentity } from '../validation/scenarioIdentity';
import { MutationRun, MutationScope, mutationScore } from '../mutation/mutationResult';
import { TargetCoverageAssessment } from '../mutation/targetCoverage';
import { evaluateQuality, QualityAssessment, QualityPolicySnapshot } from './qualityPolicy';

export interface CandidateCoverage {
    assessment?: TargetCoverageAssessment;
    coverageText: string;
    missingLines: string;
    selectedTarget?: { qualifiedName: string; executableLines: number[]; missingLines: number[]; branchesCovered: boolean };
}

export interface ExecutableCandidate {
    code: string;
    execution: string;
    coverage: CandidateCoverage;
    scenarios: ScenarioIdentity[];
    qualityGaps: string[];
    measuredQualityGaps: string[];
    reviewStatus: ReviewStatus;
    reviewWarnings: string[];
    tier: number;
    generationMode?: string;
    dependencyVersions: Array<{ module: string; hash: string }>;
}

export interface ExecutableCheckpoint extends ExecutableCandidate {
    schemaVersion: 'executable-baseline-v1';
    sourceHash: string;
    target: string;
    codeHash: string;
    testFile: string;
    mutationStatus: 'not-measured';
    mutationScore: null;
    qualityPolicy?: QualityPolicySnapshot;
}

export interface QualityCheckpoint extends Omit<ExecutableCheckpoint, 'schemaVersion' | 'mutationStatus' | 'mutationScore'> {
    schemaVersion: 'quality-baseline-v1';
    mutationStatus: 'complete' | 'no-candidates';
    mutationScore: number | null;
    mutation: MutationRun;
    qualityAssessment?: QualityAssessment;
}

function freezeCopy<T>(value: T): T {
    const copy = JSON.parse(JSON.stringify(value));
    const freeze = (item: any): void => {
        if (item && typeof item === 'object') {
            Object.values(item).forEach(freeze);
            Object.freeze(item);
        }
    };
    freeze(copy);
    return copy;
}

/** Save executable work before review/mutation can fail. Never invent a quality score. */
export class CandidateCheckpointStore {
    private retained?: ExecutableCheckpoint;
    private bestQuality?: QualityCheckpoint;

    constructor(private readonly directory: string, private readonly sourceHash: string,
        private readonly target: string,
        private readonly qualityContext?: { policy: QualityPolicySnapshot; sourcePath: string; targetScope: MutationScope }) {}

    get executable(): ExecutableCheckpoint | undefined { return this.retained; }
    get quality(): QualityCheckpoint | undefined { return this.bestQuality; }

    saveExecutable(candidate: ExecutableCandidate): ExecutableCheckpoint {
        const codeHash = evidenceHash(candidate.code);
        // The full hash is retained and verified below; a short-name collision
        // must fail closed instead of replacing an existing candidate.
        const testFile = `exec_${codeHash.slice(0, 16)}.py`;
        const snapshot = freezeCopy<ExecutableCheckpoint>({ ...candidate,
            schemaVersion: 'executable-baseline-v1', sourceHash: this.sourceHash,
            target: this.target, codeHash, testFile, mutationStatus: 'not-measured', mutationScore: null,
            ...(this.qualityContext ? { qualityPolicy: this.qualityContext.policy } : {}) });
        fs.mkdirSync(this.directory, { recursive: true });
        const artifact = path.join(this.directory, testFile);
        if (!fs.existsSync(artifact)) {
            fs.writeFileSync(artifact, snapshot.code, { encoding: 'utf8', flag: 'wx' });
        } else if (evidenceHash(fs.readFileSync(artifact, 'utf8')) !== codeHash) {
            throw new Error('Executable checkpoint artifact does not match its code hash.');
        }
        const pending = path.join(this.directory, 'executable_baseline.pending.json');
        fs.writeFileSync(pending, JSON.stringify(snapshot, null, 2), 'utf8');
        fs.renameSync(pending, path.join(this.directory, 'executable_baseline.json'));
        this.retained = snapshot;
        return snapshot;
    }

    saveQuality(candidate: ExecutableCheckpoint, mutation: MutationRun): QualityCheckpoint {
        if (candidate.sourceHash !== this.sourceHash || mutation.sourceHash !== this.sourceHash
            || candidate.target !== this.target || mutation.targetScope.qualifiedName !== this.target
            || mutation.testHash !== candidate.codeHash || !mutation.baselinePassed
            || !['complete', 'no-candidates'].includes(mutation.status)) {
            throw new Error('Quality checkpoint requires complete measurement of this exact executable candidate.');
        }
        const context = this.qualityContext;
        const qualityAssessment = context ? evaluateQuality(context.policy, {
            identity: { sourcePath: context.sourcePath, sourceHash: this.sourceHash, testHash: candidate.codeHash,
                targetScope: context.targetScope, policyHash: context.policy.policyHash },
            executionPassed: candidate.execution.trim().length > 0,
            coverage: { sourceHash: this.sourceHash, testHash: candidate.codeHash, targetScope: context.targetScope,
                assessment: candidate.coverage.assessment || { available: false, coverageText: 'N/A', missingLines: '未知' } },
            mutation, reviewStatus: candidate.reviewStatus, generationMode: candidate.generationMode,
            // These displayed gaps are derived from native coverage, which the
            // policy evaluates directly against its fixed thresholds above.
            qualityGaps: []
        }) : undefined;
        if (qualityAssessment?.policyStatus === 'unassessable'
            && qualityAssessment.measurementStatus !== 'not-applicable') {
            throw new Error('Quality checkpoint evidence is not assessable: ' + qualityAssessment.reasons.join(', '));
        }
        const snapshot = freezeCopy<QualityCheckpoint>({ ...candidate, schemaVersion: 'quality-baseline-v1',
            mutationStatus: mutation.status as QualityCheckpoint['mutationStatus'], mutationScore: mutationScore(mutation), mutation,
            ...(qualityAssessment ? { qualityAssessment } : {}) });
        const pending = path.join(this.directory, 'quality_baseline.pending.json');
        fs.writeFileSync(pending, JSON.stringify(snapshot, null, 2), 'utf8');
        fs.renameSync(pending, path.join(this.directory, 'quality_baseline.json'));
        this.bestQuality = snapshot;
        return snapshot;
    }
}
