import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { EVIDENCE_CONTRACT_VERSIONS } from './evidenceContracts';
import { ROLE_CONTRACT_VERSIONS } from '../roles/roleContracts';
import { classifyExecutionFailure } from '../utils/executionFailureCategory';

export const evidenceHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Append-only artifacts survive fallback, rollback and interrupted model requests. */
export class AnalysisJournal {
    private sequence = 0;
    private knowledgeState: Record<string, unknown> = {};
    readonly runId = randomUUID();
    readonly sourceHash: string;
    constructor(private readonly directory: string, source: string, target: string, model: string) {
        this.sourceHash = evidenceHash(source);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'run_manifest.json'), JSON.stringify({
            schemaVersion: 2, runId: this.runId, startedAt: new Date().toISOString(),
            sourceHash: this.sourceHash, target, model, promptVersion: 'role-contracts-v6',
            evidenceContracts: EVIDENCE_CONTRACT_VERSIONS, roleContracts: ROLE_CONTRACT_VERSIONS
        }, null, 2), { encoding: 'utf8', flag: 'wx' });
        this.knowledge({ target, terminalStatus: 'running', stage: 'starting' });
    }
    record(loop: number, stage: string, status: string, detail: unknown): void {
        const event = { sequence: ++this.sequence, runId: this.runId, sourceHash: this.sourceHash,
            time: new Date().toISOString(), loop, stage, status, detail };
        fs.appendFileSync(path.join(this.directory, 'role_events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
        const progress: Record<string, unknown> = { stage, lastEvent: { sequence: this.sequence, status, time: event.time } };
        if (/(?:failed|rejected|error|invalid-response|budget-exceeded|retained-baseline)$/.test(status)) {
            const value = detail as { reason?: string; out?: string; category?: string; diagnostics?: string[] } | null;
            const reason = value?.reason || value?.out || value?.diagnostics?.join(', ') || status;
            const failure = { sequence: this.sequence, stage, status,
                category: value?.category || (status === 'invalid-response' ? 'model-format' : classifyExecutionFailure(reason)), reason };
            if (!this.knowledgeState.firstFailure) { progress.firstFailure = failure; }
            progress.lastFailure = failure;
        }
        this.knowledge(progress);
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
