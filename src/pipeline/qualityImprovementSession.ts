import { QualityExperimentResult } from './qualityExperiments';

/** Run-local ledger. A suggestion, a renamed test, or a completed probe is never
 * counted as a quality gain; only measured gap sets can establish progress. */
export class QualityImprovementSession {
    private readonly attempts = new Set<string>();
    private readonly history: Array<{ gapId: string; status: string; fingerprints: string[] }> = [];

    get triedFingerprints(): readonly string[] { return [...this.attempts]; }
    get events(): ReadonlyArray<{ gapId: string; status: string; fingerprints: string[] }> {
        return this.history.map(event => ({ ...event, fingerprints: [...event.fingerprints] }));
    }
    record(result: QualityExperimentResult): void {
        const fingerprints = result.experiments.map(item => item.fingerprint);
        fingerprints.forEach(value => this.attempts.add(value));
        this.history.push({ gapId: result.gapId, status: result.status, fingerprints });
    }
    measured(gapId: string, previousGaps: readonly string[], currentGaps: readonly string[]): 'improved' | 'unchanged' | 'regressed' {
        const before = new Set(previousGaps), after = new Set(currentGaps);
        const status = [...after].some(value => !before.has(value)) ? 'regressed'
            : [...before].some(value => !after.has(value)) ? 'improved' : 'unchanged';
        this.history.push({ gapId, status, fingerprints: [] });
        return status;
    }
}
