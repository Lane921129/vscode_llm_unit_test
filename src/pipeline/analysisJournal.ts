import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { EVIDENCE_CONTRACT_VERSIONS } from './evidenceContracts';
import { ROLE_CONTRACT_VERSIONS } from '../roles/roleContracts';
import { classifyExecutionFailure } from '../utils/executionFailureCategory';
import type { QualityPolicySnapshot } from './qualityPolicy';
import { formatRepairDiagnostic, RepairDiagnostic } from './repairDiagnostics';
import { VerificationMode } from './verificationMode';
import type { ReportIdentity } from './targetReport';
import { normalizeKnownSecrets, redactCredentialStrings } from './artifactSafety';

export const evidenceHash = (text: string): string => createHash('sha256').update(text).digest('hex');

const providerReplyFields = new Set(['raw', 'providerresponse', 'rawresponse', 'responsetext',
    'modelresponse', 'llmresponse', 'rawproviderresponse', 'providerpayload', 'fullresponse']);

/** Preserve parsed evidence and candidate code, but never journal a complete provider envelope. */
function summarizeProviderReplies(value: unknown): unknown {
    if (Array.isArray(value)) { return value.map(summarizeProviderReplies); }
    if (!value || typeof value !== 'object') { return value; }
    const result: Record<string, unknown> = {};
    const summaries: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (providerReplyFields.has(key.replace(/[_-]/g, '').toLowerCase())) {
            if (item === undefined) { continue; }
            const text = typeof item === 'string' ? item : JSON.stringify(item);
            const prefix = key === 'raw' ? 'response' : key;
            summaries[`${prefix}Hash`] = evidenceHash(text);
            summaries[`${prefix}Characters`] = text.length;
        } else { result[key] = summarizeProviderReplies(item); }
    }
    // Computed evidence wins over untrusted pre-existing summary fields.
    return { ...result, ...summaries };
}

/** Append-only artifacts survive fallback, rollback and interrupted model requests. */
export class AnalysisJournal {
    private sequence = 0;
    private knowledgeState: Record<string, unknown> = {};
    private repairFailureCounts: Record<string, number> = {};
    private readonly secrets: readonly string[];
    readonly runId = randomUUID();
    readonly sourceHash: string;
    snapshot(): Record<string, unknown> { return { ...this.knowledgeState }; }
    constructor(private readonly directory: string, source: string, target: string, model: string,
        qualityPolicy?: QualityPolicySnapshot, validationMode: VerificationMode = 'full', report?: ReportIdentity,
        knownSecrets: readonly string[] = []) {
        this.secrets = normalizeKnownSecrets(knownSecrets);
        this.sourceHash = evidenceHash(source);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'run_manifest.json'), JSON.stringify(this.protect({
            schemaVersion: 2, runId: this.runId, startedAt: new Date().toISOString(), validationMode,
            sourceHash: this.sourceHash, target, model, promptVersion: 'role-contracts-v7',
            workflowVersion: 'seed-expand-v1', writerSeedVersion: 'writer-seed-v1',
            writerExpansionVersion: 'writer-expansion-v1', reviewRepairVersion: 'review-contract-repair-v1',
            qualityExperimentVersion: 'quality-experiment-result-v1',
            evidenceContracts: EVIDENCE_CONTRACT_VERSIONS, roleContracts: ROLE_CONTRACT_VERSIONS,
            repairDiagnosticsVersion: 'repair-diagnostics-v1',
            ...(report ? { report } : {}),
            ...(qualityPolicy ? { qualityContractVersion: 'quality-policy-v1', qualityPolicy } : {})
        }), null, 2), { encoding: 'utf8', flag: 'wx' });
        this.knowledge({ target, terminalStatus: 'running', stage: 'starting', validationMode,
            ...(qualityPolicy ? { qualityContractVersion: 'quality-policy-v1', qualityPolicy } : {}) });
    }
    private protect(value: unknown): unknown {
        return redactCredentialStrings(summarizeProviderReplies(value), this.secrets);
    }
    record(loop: number, stage: string, status: string, detail: unknown): string {
        detail = this.protect(detail);
        const repair = detail as { diagnostic?: RepairDiagnostic; attempt: number; elapsedMs?: number } | undefined;
        const isRepair = repair?.diagnostic?.version === 'repair-diagnostics-v1';
        if (isRepair) {
            detail = { ...repair, executableBaselineAvailable: Boolean(this.knowledgeState.executableBaseline) };
        }
        const event = { sequence: ++this.sequence, runId: this.runId, sourceHash: this.sourceHash,
            time: new Date().toISOString(), loop, stage, status, detail };
        fs.appendFileSync(path.join(this.directory, 'role_events.jsonl'), JSON.stringify(this.protect(event)) + '\n', 'utf8');
        const progress: Record<string, unknown> = { stage, lastEvent: { sequence: this.sequence, status, time: event.time } };
        if (/(?:failed|rejected|error|invalid-response|budget-exceeded|retained-baseline)$/.test(status)) {
            const value = detail as { reason?: string; out?: string; category?: string; diagnostics?: string[] } | null;
            const reason = value?.reason || value?.out || value?.diagnostics?.join(', ') || status;
            const failure = { sequence: this.sequence, stage, status,
                category: value?.category || (status === 'invalid-response' ? 'model-format' : classifyExecutionFailure(reason)), reason,
                ...(isRepair ? { diagnostic: repair!.diagnostic, attempt: repair!.attempt } : {}) };
            if (!this.knowledgeState.firstFailure) { progress.firstFailure = failure; }
            progress.lastFailure = failure;
        }
        if (isRepair) {
            const failure = { sequence: this.sequence, loop, stage, status, ...detail as object };
            for (const code of repair!.diagnostic!.reasonCodes) {
                this.repairFailureCounts[code] = (this.repairFailureCounts[code] || 0) + 1;
            }
            if (!this.knowledgeState.firstRepairFailure) { progress.firstRepairFailure = failure; }
            progress.lastRepairFailure = failure;
            progress.repairFailureCounts = { ...this.repairFailureCounts };
        }
        this.knowledge(progress);
        return isRepair ? formatRepairDiagnostic(loop, detail as Parameters<typeof formatRepairDiagnostic>[1]) : '';
    }
    knowledge(value: Record<string, unknown>): void {
        this.knowledgeState = this.protect({ ...this.knowledgeState, ...value }) as Record<string, unknown>;
        const output = JSON.stringify({ schemaVersion: 2, runId: this.runId, sourceHash: this.sourceHash,
            ...this.knowledgeState }, null, 2);
        const temporary = path.join(this.directory, 'function_knowledge.pending.json');
        fs.writeFileSync(temporary, output, 'utf8');
        fs.renameSync(temporary, path.join(this.directory, 'function_knowledge.json'));
    }
}

/** Only measured coverage/survivor improvements reset stagnation, never prose or renaming. */
export class QualityProgress {
    private seenSurvivors = new Set<string>();
    private seenGaps = new Set<string>();
    private initialized = false;
    private stalled = 0;
    constructor(readonly limit = 3) {}
    observe(survivors: string[], gaps: string[]): boolean {
        const improved = !this.initialized
            || [...this.seenSurvivors].some(id => !survivors.includes(id))
            || [...this.seenGaps].some(id => !gaps.includes(id));
        this.stalled = improved ? 0 : this.stalled + 1;
        this.initialized = true;
        this.seenSurvivors = new Set(survivors);
        this.seenGaps = new Set(gaps);
        return this.stalled >= this.limit;
    }
}
