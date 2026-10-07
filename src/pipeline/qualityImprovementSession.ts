import { QualityExperimentResult, validateQualityExperimentResult } from './qualityExperiments';
import { MutationRun } from '../mutation/mutationResult';
import { TargetCoverageAssessment } from '../mutation/targetCoverage';
import { QualityFocus } from '../roles/qualityAnalyst';
import { beginQualityFocus, FocusedQualityMeasurement, measureQualityFocus, PendingQualityFocus } from './focusedQualityProgress';

export { PendingQualityFocus, FocusedQualityMeasurement } from './focusedQualityProgress';

/** Run-local ledger. A suggestion, a renamed test, or a completed probe is never
 * counted as a quality gain; only measured gap sets can establish progress. */
export class QualityImprovementSession {
    private readonly attempts = new Set<string>();
    private readonly history: Array<{ gapId: string; status: string; fingerprints: string[]; measurement?: FocusedQualityMeasurement }> = [];
    private readonly observations: QualityExperimentResult[] = [];
    private readonly presented = new Set<string>();

    get triedFingerprints(): readonly string[] { return [...this.attempts]; }
    get events(): ReadonlyArray<{ gapId: string; status: string; fingerprints: string[]; measurement?: FocusedQualityMeasurement }> {
        return structuredClone(this.history);
    }
    record(result: QualityExperimentResult): void {
        validateQualityExperimentResult(result);
        const fingerprints = result.experiments.map(item => item.fingerprint);
        fingerprints.forEach(value => this.attempts.add(value));
        this.history.push({ gapId: result.gapId, status: result.status, fingerprints });
        if (result.status === 'observed') {
            const retained = structuredClone(result);
            // Keep completed cases as complete units. Oversized evidence stays
            // in the artifact/current result, never as a partial cached oracle.
            retained.experiments = retained.experiments.filter(item => item.status === 'observed');
            if (JSON.stringify(retained).length <= 1000000) { this.observations.push(retained); }
            while (this.observations.length > 8 || this.observations.reduce((total, item) => total + item.experiments.length, 0) > 24
                || JSON.stringify(this.observations).length > 1000000) { this.observations.shift(); }
        }
    }

    /** Tried fingerprints avoid rerunning probes; they never erase observations
     * that a prompt budget omitted. Reuse only this session's exact identity and
     * preserve the original gapId, even when the active task focuses a new gap. */
    evidenceFor(result: QualityExperimentResult): QualityExperimentResult | undefined {
        validateQualityExperimentResult(result);
        const matches = (item: QualityExperimentResult): boolean => !!result.context && item.sourceHash === result.sourceHash
            && item.target === result.target && item.context?.sourceRoot === result.context.sourceRoot
            && item.context?.sourcePath === result.context.sourcePath && item.context?.module === result.context.module
            && item.context?.importFixturePlanHash === result.context.importFixturePlanHash;
        const available = result.status === 'observed' ? [result]
            : this.observations.filter(matches).slice().reverse();
        const retained = available.find(item => item.experiments.some(outcome => outcome.status === 'observed'
            && !this.presented.has(outcome.fingerprint))) || available[0];
        if (!retained) { return undefined; }
        const handoff = structuredClone(retained);
        handoff.experiments.sort((left, right) => Number(this.presented.has(left.fingerprint)) - Number(this.presented.has(right.fingerprint)));
        return handoff;
    }

    recordHandoff(result: QualityExperimentResult, fingerprints: readonly string[]): void {
        validateQualityExperimentResult(result);
        const valid = new Set(result.experiments.filter(item => item.status === 'observed').map(item => item.fingerprint));
        if (fingerprints.some(value => !valid.has(value))) { throw new Error('Unknown quality observation handoff.'); }
        fingerprints.forEach(value => this.presented.add(value));
    }

    beginFocus(focus: QualityFocus, coverage: TargetCoverageAssessment, mutation: MutationRun): PendingQualityFocus {
        return beginQualityFocus(focus, coverage, mutation);
    }

    measureFocus(pending: PendingQualityFocus, coverage: TargetCoverageAssessment, mutation: MutationRun): FocusedQualityMeasurement {
        const measurement = measureQualityFocus(pending, coverage, mutation);
        this.history.push({ gapId: pending.focus.id, status: measurement.status, fingerprints: [], measurement: structuredClone(measurement) });
        return measurement;
    }

    /** Historical global-set comparison. New focused tasks use measureFocus. */
    measured(gapId: string, previousGaps: readonly string[], currentGaps: readonly string[]): 'improved' | 'unchanged' | 'regressed' {
        const before = new Set(previousGaps), after = new Set(currentGaps);
        const status = [...after].some(value => !before.has(value)) ? 'regressed'
            : [...before].some(value => !after.has(value)) ? 'improved' : 'unchanged';
        this.history.push({ gapId, status, fingerprints: [] });
        return status;
    }
}
