import * as path from 'path';
import { MutationRun, MutationOutcome, readStoredMutationRun } from '../mutation/mutationResult';
import { TargetCoverageAssessment } from '../mutation/targetCoverage';
import { QualityFocus } from '../roles/qualityAnalyst';
import { coverageGapIds } from './qualityRegression';

export type FocusProgressStatus = 'resolved' | 'unchanged' | 'unavailable';
export type GlobalQualityProgress = 'improved' | 'unchanged' | 'regressed' | 'unavailable';

interface MeasurementIdentity {
    sourcePath: string; sourceHash: string; targetScope: MutationRun['targetScope'];
    engine: MutationRun['engine']; operatorSetVersion: string | null; scopeVersion: string;
    candidateSetId: string | null; engineVersion?: string; executionBackend?: string;
}

/** A focus is bound before the AI revises its tests. Never infer its identity
 * from a percentage or a translated description in the next result. */
export interface PendingQualityFocus {
    readonly focus: QualityFocus;
    readonly identity?: MeasurementIdentity;
    readonly testHash: string;
    readonly coverage: TargetCoverageAssessment;
    readonly mutants: ReadonlyArray<{ id: string; status: MutationOutcome }>;
    readonly candidateId?: string;
}

export interface FocusedQualityMeasurement {
    focus: QualityFocus;
    identity?: MeasurementIdentity;
    status: FocusProgressStatus;
    globalProgress: GlobalQualityProgress;
    reason: string;
    candidateId?: string;
    previousTestHash: string;
    currentTestHash: string;
    retainEvidence: boolean;
    feedback: string;
}

const normalizedPath = (value: string): string => process.platform === 'win32'
    ? path.resolve(value).toLowerCase() : path.resolve(value);

function verifiedRun(run: MutationRun): boolean {
    const parsed = readStoredMutationRun(run, run);
    return parsed.ok && parsed.run.baselinePassed
        && (parsed.run.status === 'no-candidates' || parsed.run.status === 'complete' && parsed.run.scoreAvailable);
}

function identityOf(run: MutationRun): MeasurementIdentity {
    return { sourcePath: normalizedPath(run.sourcePath), sourceHash: run.sourceHash, targetScope: { ...run.targetScope },
        engine: run.engine, operatorSetVersion: run.operatorSetVersion, scopeVersion: run.scopeVersion,
        candidateSetId: run.candidateSetId, engineVersion: run.engineVersion, executionBackend: run.executionBackend };
}

function sameIdentity(previous: MeasurementIdentity, current: MeasurementIdentity): boolean {
    return previous.sourcePath === current.sourcePath && previous.sourceHash === current.sourceHash
        && previous.engine === current.engine && previous.operatorSetVersion === current.operatorSetVersion
        && previous.engineVersion === current.engineVersion && previous.executionBackend === current.executionBackend
        && previous.scopeVersion === current.scopeVersion && previous.candidateSetId !== null
        && previous.candidateSetId === current.candidateSetId
        && previous.targetScope.kind === current.targetScope.kind
        && previous.targetScope.qualifiedName === current.targetScope.qualifiedName
        && previous.targetScope.startLine === current.targetScope.startLine
        && previous.targetScope.endLine === current.targetScope.endLine;
}

function coverageUsable(coverage: TargetCoverageAssessment, testHash: string): boolean {
    return coverage.available && coverage.evidenceVersion === 'coverage-evidence-v1'
        && coverage.scopeStatus === 'verified' && coverage.targetExecuted === true
        && coverage.invocationEvidence?.observed === true && coverage.invocationEvidence.testHash === testHash
        && Boolean(coverage.invocationEvidence.testRunId) && Boolean(coverage.executableTargetLines?.length)
        && coverage.missingTargetLines !== undefined && coverage.missingTargetBranches !== undefined;
}

export function beginQualityFocus(focus: QualityFocus, coverage: TargetCoverageAssessment, mutation: MutationRun): PendingQualityFocus {
    return {
        focus: { ...focus }, identity: verifiedRun(mutation) ? identityOf(mutation) : undefined,
        testHash: mutation.testHash, coverage: structuredClone(coverage),
        mutants: mutation.mutants.map(({ id, status }) => ({ id, status })),
        candidateId: focus.kind === 'survivor' ? /^- id ([a-f0-9]{64}),/.exec(focus.evidence)?.[1] : undefined
    };
}

/** Global gains and the selected task's result answer different questions.
 * A new line can be useful while the specifically selected mutant still lives. */
export function measureQualityFocus(pending: PendingQualityFocus, coverage: TargetCoverageAssessment,
    mutation: MutationRun): FocusedQualityMeasurement {
    const result = (status: FocusProgressStatus, globalProgress: GlobalQualityProgress, reason: string): FocusedQualityMeasurement => {
        const finding = { focus: { ...pending.focus }, identity: pending.identity ? structuredClone(pending.identity) : undefined,
            status, globalProgress, reason, candidateId: pending.candidateId,
            previousTestHash: pending.testHash, currentTestHash: mutation.testHash, retainEvidence: status !== 'resolved' };
        const instruction = status === 'unchanged'
            ? 'The selected gap is still measured in the revised tests. Preserve its exact observations and the passing baseline. '
                + (pending.focus.kind === 'survivor'
                    ? 'The selected mutant survived; the suite did not distinguish this variant. Check the exact observed result and whether the assertion rejects the changed behavior. '
                    : 'The selected line or branch is still uncovered. Propose a different input or controlled setup that reaches this exact gap. ')
                + 'Any other coverage or mutation gain does not resolve this task. No individual assertion failure attribution is established here.'
            : status === 'unavailable'
                ? 'This task could not be compared using the same complete measured identity. Preserve its observations for the same source only; do not claim it resolved.'
                : 'The selected gap is resolved by comparable measurements. This establishes the measured suite outcome, not independent requirements or a particular assertion as the cause.';
        return { ...finding, feedback: 'FOCUSED QUALITY RESULT (measured, not an output oracle):\n'
            + JSON.stringify({ ...finding, instruction }) };
    };
    if (!pending.identity || !verifiedRun(mutation)) {
        return result('unavailable', 'unavailable', 'complete-mutation-measurement-required');
    }
    if (!sameIdentity(pending.identity, identityOf(mutation))) {
        return result('unavailable', 'unavailable', 'measurement-identity-changed');
    }
    const previousCoverageUsable = coverageUsable(pending.coverage, pending.testHash);
    const currentCoverageUsable = coverageUsable(coverage, mutation.testHash)
        && JSON.stringify([...(pending.coverage.executableTargetLines || [])].sort((a, b) => a - b))
            === JSON.stringify([...(coverage.executableTargetLines || [])].sort((a, b) => a - b));
    const beforeGaps = new Set([...coverageGapIds(pending.coverage),
        ...pending.mutants.filter(item => item.status === 'SURVIVED').map(item => `mutant:${item.id}`)]);
    const afterGaps = new Set([...coverageGapIds(coverage),
        ...mutation.mutants.filter(item => item.status === 'SURVIVED').map(item => `mutant:${item.id}`)]);
    const globalProgress: GlobalQualityProgress = !previousCoverageUsable || !currentCoverageUsable ? 'unavailable'
        : [...afterGaps].some(value => !beforeGaps.has(value)) ? 'regressed'
            : [...beforeGaps].some(value => !afterGaps.has(value)) ? 'improved' : 'unchanged';
    if (pending.focus.kind === 'survivor') {
        const previous = pending.mutants.find(item => item.id === pending.candidateId);
        const current = mutation.mutants.find(item => item.id === pending.candidateId);
        if (!pending.candidateId || previous?.status !== 'SURVIVED' || !current) {
            return result('unavailable', globalProgress, 'focused-mutant-not-measured');
        }
        return current.status === 'KILLED' ? result('resolved', globalProgress, 'focused-mutant-killed')
            : current.status === 'SURVIVED' ? result('unchanged', globalProgress, 'focused-mutant-survived')
                : result('unavailable', globalProgress, 'focused-mutant-not-measured');
    }
    if (!previousCoverageUsable || !currentCoverageUsable) {
        return result('unavailable', globalProgress, 'focused-coverage-unavailable');
    }
    if (!/^(?:line:[1-9]\d*|branch:[1-9]\d*->(?:-?[1-9]\d*|exit))$/.test(pending.focus.evidence)
        || !coverageGapIds(pending.coverage).includes(pending.focus.evidence)) {
        return result('unavailable', globalProgress, 'focused-coverage-gap-not-measured');
    }
    return coverageGapIds(coverage).includes(pending.focus.evidence)
        ? result('unchanged', globalProgress, 'focused-coverage-gap-remains')
        : result('resolved', globalProgress, 'focused-coverage-gap-covered');
}
