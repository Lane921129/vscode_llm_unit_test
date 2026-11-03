import { AnalysisStageError } from '../utils/executionFailureCategory';
import { containsCredential } from './artifactSafety';
import { evidenceHash } from './analysisJournal';
import { TraceValueSnapshot } from './evidenceContracts';
import { typedCallFields } from './probeInputs';
import { validTraceValueSnapshot } from './traceValues';

export interface NumericEvidenceIdentity { runId: string; sourceHash: string; target: string }
interface NumericObservation {
    call: TraceValueSnapshot;
    result_snapshot?: TraceValueSnapshot;
    exception?: { module: 'builtins'; qualname: 'TypeError' | 'ZeroDivisionError' };
}
interface EvidenceSegment { testHash: string; observations: NumericObservation[] }
const prefix = 'VERIFIED NUMERIC OBSERVATIONS (evidence only; the AI must revise the test):\n';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = (value: unknown): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : object(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
        : JSON.stringify(value);
function invalid(reason: string): never {
    throw new AnalysisStageError('validation', 'numeric-evidence', 'Numeric observation handoff is invalid.', { reasonCode: reason });
}
function observation(value: unknown): NumericObservation {
    if (!object(value) || !typedCallFields(value.call)) { return invalid('invalid-observation'); }
    if (value.exception !== undefined) {
        if (value.result_snapshot !== undefined || !object(value.exception)
            || Object.keys(value.exception).some(key => !['module', 'qualname'].includes(key))
            || value.exception.module !== 'builtins' || !['TypeError', 'ZeroDivisionError'].includes(String(value.exception.qualname))) {
            return invalid('invalid-exception');
        }
    } else if (!validTraceValueSnapshot(value.result_snapshot) || !value.result_snapshot.replayable) {
        return invalid('unassertable-result');
    }
    // Calculator steps and previous assertion literals are not observation facts.
    return structuredClone({ call: value.call, ...(value.exception !== undefined
        ? { exception: value.exception } : { result_snapshot: value.result_snapshot }) }) as unknown as NumericObservation;
}

/** Receives only collectNumericRepairEvidence output, never arbitrary model claims.
 * Whole source-bound observations survive Writer/Reviewer calls and quality rounds. */
export class NumericEvidenceLedger {
    private readonly identity: NumericEvidenceIdentity;
    private readonly knownSecrets: readonly string[];
    private readonly segments: EvidenceSegment[] = [];
    private evictedSegments = 0;
    private evictedCases = 0;
    constructor(identity: NumericEvidenceIdentity, knownSecrets: readonly string[] = []) {
        if (!digest(identity.sourceHash) || !identity.runId || !identity.target
            || identity.runId.length > 256 || identity.target.length > 256) { invalid('invalid-identity'); }
        this.identity = { ...identity };
        this.knownSecrets = [...knownSecrets];
    }

    get hasEvidence(): boolean { return this.segments.length > 0; }

    add(handoff: string | undefined): { addedCases: number; duplicateCases: number; retainedSegments: number } {
        if (!handoff) { return { addedCases: 0, duplicateCases: 0, retainedSegments: this.segments.length }; }
        if (containsCredential(handoff, this.knownSecrets)) { invalid('sensitive-observation'); }
        if (!handoff.startsWith(prefix) || Buffer.byteLength(handoff, 'utf8') > 65536) { invalid('invalid-envelope'); }
        let value: unknown;
        try { value = JSON.parse(handoff.slice(prefix.length)); } catch { invalid('invalid-json'); }
        if (!object(value) || value.schemaVersion !== 'numeric-observation-handoff-v1'
            || value.runId !== this.identity.runId || value.sourceHash !== this.identity.sourceHash || value.target !== this.identity.target
            || !digest(value.testHash) || !Array.isArray(value.corrections) || value.corrections.length < 1 || value.corrections.length > 32
            || Object.keys(value).some(key => !['schemaVersion', 'runId', 'sourceHash', 'target', 'testHash', 'corrections', 'limitation'].includes(key))) {
            return invalid('identity-or-contract-mismatch');
        }
        // Validate the complete handoff before changing the ledger.
        const facts = value.corrections.map(correction => {
            if (!object(correction) || typeof correction.method !== 'string' || !Number.isSafeInteger(correction.line)
                || Number(correction.line) < 1) {
                return invalid('invalid-correction');
            }
            return observation(correction.basis);
        });
        const existing = new Set(this.segments.flatMap(segment => segment.observations.map(item => evidenceHash(canonical(item)))));
        const added: NumericObservation[] = [];
        let duplicates = 0;
        for (const item of facts) {
            const key = evidenceHash(canonical(item));
            if (existing.has(key)) { duplicates++; continue; }
            existing.add(key); added.push(item);
        }
        if (added.length) {
            this.segments.push({ testHash: value.testHash, observations: added });
            if (this.segments.length > 8) {
                const removed = this.segments.shift()!;
                this.evictedSegments++; this.evictedCases += removed.observations.length;
            }
        }
        return { addedCases: added.length, duplicateCases: duplicates, retainedSegments: this.segments.length };
    }

    /** Newest complete segments first; omission is explicit, never partial JSON or a fabricated oracle. */
    prompt(maxChars: number): string {
        if (!Number.isSafeInteger(maxChars) || maxChars < 0) { invalid('invalid-prompt-budget'); }
        if (!this.hasEvidence) { return ''; }
        const selected: EvidenceSegment[] = [];
        const instructions = 'VERIFIED_NUMERIC_EVIDENCE_LEDGER_V1\n'
            + 'These exact typed calls were checked by calculation and isolated execution against this source. '
            + 'They describe current behavior, not independent requirements. Only complete included observations support assertions. '
            + 'Omitted observations are unavailable in this prompt: do not infer their values. The AI owns every test edit.\n';
        const retainedCases = this.segments.reduce((count, item) => count + item.observations.length, 0);
        const render = () => instructions + JSON.stringify({ schemaVersion: 'numeric-evidence-ledger-v1', ...this.identity,
            independentRequirements: false, includedSegments: selected.length,
            omittedSegments: this.evictedSegments + this.segments.length - selected.length,
            includedCases: selected.reduce((count, item) => count + item.observations.length, 0),
            omittedCases: this.evictedCases + retainedCases - selected.reduce((count, item) => count + item.observations.length, 0),
            segments: selected });
        for (const segment of [...this.segments].reverse()) {
            selected.push(segment);
            if (render().length > maxChars) { selected.pop(); }
        }
        if (!selected.length) {
            throw new AnalysisStageError('budget', 'prompt-budget',
                'No complete verified numeric observation fits the role prompt budget.', { reasonCode: 'numeric-evidence-budget' });
        }
        return render();
    }
}
