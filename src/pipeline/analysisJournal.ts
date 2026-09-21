import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { EVIDENCE_CONTRACT_VERSIONS } from './evidenceContracts';
import { ROLE_CONTRACT_VERSIONS } from '../roles/roleContracts';
import { classifyExecutionFailure } from '../utils/executionFailureCategory';
import type { QualityPolicySnapshot } from './qualityPolicy';
import { formatRepairDiagnostic, RepairDiagnostic } from './repairDiagnostics';

export const evidenceHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Append-only artifacts survive fallback, rollback and interrupted model requests. */
export class AnalysisJournal {
    private sequence = 0;
    private knowledgeState: Record<string, unknown> = {};
    private repairFailureCounts: Record<string, number> = {};
    readonly runId = randomUUID();
    readonly sourceHash: string;
    constructor(private readonly directory: string, source: string, target: string, model: string,
        qualityPolicy?: QualityPolicySnapshot) {
        this.sourceHash = evidenceHash(source);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'run_manifest.json'), JSON.stringify({
            schemaVersion: 2, runId: this.runId, startedAt: new Date().toISOString(),
            sourceHash: this.sourceHash, target, model, promptVersion: 'role-contracts-v7',
            evidenceContracts: EVIDENCE_CONTRACT_VERSIONS, roleContracts: ROLE_CONTRACT_VERSIONS,
            repairDiagnosticsVersion: 'repair-diagnostics-v1',
            ...(qualityPolicy ? { qualityContractVersion: 'quality-policy-v1', qualityPolicy } : {})
        }, null, 2), { encoding: 'utf8', flag: 'wx' });
        this.knowledge({ target, terminalStatus: 'running', stage: 'starting',
            ...(qualityPolicy ? { qualityContractVersion: 'quality-policy-v1', qualityPolicy } : {}) });
    }
    record(loop: number, stage: string, status: string, detail: unknown): string {
        const repair = detail as { diagnostic?: RepairDiagnostic; attempt: number; elapsedMs?: number } | undefined;
        const isRepair = repair?.diagnostic?.version === 'repair-diagnostics-v1';
        if (isRepair) {
            detail = { ...repair, executableBaselineAvailable: Boolean(this.knowledgeState.executableBaseline) };
        }
        const event = { sequence: ++this.sequence, runId: this.runId, sourceHash: this.sourceHash,
            time: new Date().toISOString(), loop, stage, status, detail };
        fs.appendFileSync(path.join(this.directory, 'role_events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
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
        this.knowledgeState = { ...this.knowledgeState, ...value };
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
