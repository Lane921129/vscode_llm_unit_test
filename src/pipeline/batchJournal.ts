import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { evidenceHash } from './analysisJournal';
import { ROLE_CONTRACT_VERSIONS } from '../roles/roleContracts';

interface BatchTarget {
    id: number; file: string; target: string;
    state: 'pending' | 'running' | 'finished';
    terminalStatus?: string; category?: string; stage?: string; reportDirectory?: string;
    modelRequests?: number; environment?: EnvironmentIssue;
}
interface EnvironmentIssue {
    kind: 'missing-dependency' | 'import-side-effect' | 'module-resolution' | 'other';
    missingModule?: string; operation?: string; origin?: { file: string; line: number };
}

/** Explicit inventory and completion; a report's mere existence is never a pass. */
export class BatchJournal {
    private readonly id = randomUUID();
    private readonly startedAt = new Date().toISOString();
    private status = 'discovering';
    private finishedAt?: string;
    private readonly targets: BatchTarget[] = [];
    private readonly discoveryFailures: Array<{ file: string; stage: string }> = [];
    private readonly files: string[] = [];
    constructor(readonly directory: string, private readonly sourceRoot: string,
        private readonly identity: { model: string; buildTimestamp: string; python: string }) {
        this.save();
    }
    private relative(file: string): string {
        const relative = path.relative(this.sourceRoot, file);
        if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
            throw new Error('批次來源不在已選資料夾內。');
        }
        return relative.replace(/\\/g, '/') || '.';
    }
    discover(file: string, targets: string[]): void {
        const relative = this.relative(file);
        this.files.push(relative);
        for (const target of targets) { this.targets.push({ id: this.targets.length, file: relative, target, state: 'pending' }); }
        this.save();
    }
    discoveryFailed(file: string, stage: string): void {
        this.discoveryFailures.push({ file: this.relative(file), stage }); this.save();
    }
    start(): void { this.status = 'running'; this.save(); }
    begin(id: number): void { this.targets[id].state = 'running'; this.save(); }
    attach(id: number, directory: string): void {
        const relative = path.relative(this.directory, directory);
        if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
            throw new Error('批次報告不在本次輸出資料夾內。');
        }
        this.targets[id].reportDirectory = relative.replace(/\\/g, '/'); this.save();
    }
    dummy(id: number): void { this.targets[id].terminalStatus = 'dummy-skipped'; }
    refresh(id: number): void {
        const target = this.targets[id];
        const directory = target.reportDirectory && path.join(this.directory, target.reportDirectory);
        try {
            if (!directory || !fs.existsSync(path.join(directory, 'final_report.md'))) { throw Error('missing-report'); }
            if (target.terminalStatus !== 'dummy-skipped') {
                const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
                const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'run_manifest.json'), 'utf8'));
                if (!knowledge.runId || manifest.runId !== knowledge.runId || !knowledge.sourceHash || manifest.sourceHash !== knowledge.sourceHash
                    || manifest.target !== target.target || knowledge.target !== target.target || typeof knowledge.terminalStatus !== 'string'
                    || knowledge.terminalStatus === 'running') { throw Error('incomplete-provenance'); }
                if (knowledge.terminalStatus === 'passed') {
                    const test = knowledge.acceptedTest;
                    if (typeof test !== 'string' || path.basename(test) !== test || /[\\/]/.test(test)
                        || !['completed', 'not-required'].includes(knowledge.reviewStatus)
                        || !Array.isArray(knowledge.qualityGaps) || knowledge.qualityGaps.length
                        || typeof knowledge.execution !== 'string' || !knowledge.execution.trim()
                        || knowledge.mutationScore !== 100 || !Array.isArray(knowledge.survivors) || knowledge.survivors.length
                        || evidenceHash(fs.readFileSync(path.join(directory, test), 'utf8')) !== knowledge.acceptedCodeHash) {
                        throw Error('incomplete-provenance');
                    }
                }
                target.terminalStatus = knowledge.terminalStatus;
                target.category = knowledge.failureCategory;
                target.stage = knowledge.failureStage;
                if (target.category === 'environment') {
                    const diagnostic = knowledge.diagnostic || {};
                    const origin = diagnostic.origin;
                    target.environment = diagnostic.exception_type === 'ModuleNotFoundError' && typeof diagnostic.missing_module === 'string'
                        ? { kind: 'missing-dependency', missingModule: diagnostic.missing_module }
                        : diagnostic.exception_type === 'TraceSafetyError' && typeof diagnostic.blocked_operation === 'string'
                            ? { kind: 'import-side-effect', operation: diagnostic.blocked_operation }
                            : { kind: target.stage === 'module-resolution' ? 'module-resolution' : 'other' };
                    if (origin && typeof origin.file === 'string' && !path.isAbsolute(origin.file)
                        && !origin.file.split(/[\\/]/).includes('..') && Number.isInteger(origin.line) && origin.line > 0) {
                        target.environment.origin = origin;
                    }
                }
                const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
                if (events.some(event => event.runId !== knowledge.runId || event.sourceHash !== knowledge.sourceHash)) {
                    throw Error('incomplete-provenance');
                }
                target.modelRequests = events.filter(event => event.stage === 'model-request' && event.status === 'requested').length;
            }
            target.state = 'finished';
        } catch {
            target.state = 'running';
            target.terminalStatus = 'incomplete-report';
            delete target.environment;
            delete target.modelRequests;
            // A failed/missing checkpoint is not a completed target, even when
            // its outer task returned. Keep it visibly unfinished.
        }
        this.save();
    }
    finish(status: 'completed' | 'cancelled' | 'failed'): void {
        this.status = status === 'completed' && (this.discoveryFailures.length || this.targets.some(target => target.state !== 'finished'))
            ? 'incomplete' : status;
        this.finishedAt = new Date().toISOString(); this.save();
    }
    private save(): void {
        const counts: Record<string, number> = {};
        const groups = new Map<string, { kind: string; issue: string; affectedTargets: number; files: Set<string> }>();
        for (const target of this.targets) {
            const status = target.terminalStatus || target.state;
            counts[status] = (counts[status] || 0) + 1;
            const environment = target.environment;
            if (environment) {
                const origin = environment.origin;
                const issue = environment.missingModule || (environment.operation
                    ? `${environment.operation}${origin ? ` (${origin.file}:${origin.line})` : ''}` : target.stage || 'environment');
                const key = `${environment.kind}/${issue}`;
                const group = groups.get(key) || { kind: environment.kind, issue, affectedTargets: 0, files: new Set<string>() };
                group.affectedTargets++; group.files.add(target.file); groups.set(key, group);
            }
        }
        const environmentIssues = [...groups.values()].map(group => ({ ...group, files: [...group.files].sort() }));
        const complete = this.status === 'completed';
        const passed = counts.passed || 0;
        const manifest = { schemaVersion: 1, batchId: this.id, startedAt: this.startedAt, finishedAt: this.finishedAt,
            status: this.status, complete, allTargetsPassed: complete && this.targets.length > 0 && passed === this.targets.length,
            model: this.identity.model, buildTimestamp: this.identity.buildTimestamp,
            pythonExecutable: this.identity.python, roleContracts: ROLE_CONTRACT_VERSIONS,
            discoveredFiles: this.files, discoveryFailures: this.discoveryFailures,
            expectedTargets: this.targets.length, finishedTargets: this.targets.filter(t => t.state === 'finished').length,
            statusCounts: counts, environmentIssues, targets: this.targets };
        const temporary = path.join(this.directory, 'batch_manifest.pending.json');
        fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), 'utf8');
        fs.renameSync(temporary, path.join(this.directory, 'batch_manifest.json'));
        const safe = (value: string) => value.replace(/[|\r\n]/g, ' ');
        const report = ['# 批次執行摘要', '', `- 狀態：${this.status}（執行完成不代表測試通過）`,
            `- 預期目標：${this.targets.length}；已有終態：${manifest.finishedTargets}；完整通過：${passed}`,
            `- 模型：${safe(this.identity.model)}；建置：${safe(this.identity.buildTimestamp)}`,
            `- Python：${safe(this.identity.python)}`, '', '| 目標狀態 | 數量 |', '| --- | ---: |',
            ...Object.entries(counts).map(([status, count]) => `| ${status} | ${count} |`), '',
            '## 環境障礙', '', '| 分類 | 共同原因 | 受影響目標 |', '| --- | --- | ---: |',
            ...environmentIssues.map(issue => `| ${issue.kind} | ${safe(issue.issue)} | ${issue.affectedTargets} |`), '',
            '缺套件：依被測專案的 requirements／lockfile，在上述 Python 環境安裝相依；套件匯入名稱不一定是安裝名稱，請勿猜測版本。',
            '匯入副作用：把目錄／檔案／資料庫初始化移到明確啟動階段或隔離測試入口，保留安全防護。', '',
            '## 未完成與略過', '',
            ...this.discoveryFailures.map(item => `- 無法掃描 ${safe(item.file)}：${safe(item.stage)}`),
            ...this.targets.filter(t => t.state !== 'finished').map(t => `- ${safe(t.file)} :: ${safe(t.target)}：${t.terminalStatus || t.state}`),
            'Dummy／Stub、審查未完成、品質不足及缺報告皆不計為通過。逐目標輸出與模型請求數見 batch_manifest.json。', ''].join('\n');
        fs.writeFileSync(path.join(this.directory, 'batch_summary.md'), report, 'utf8');
    }
}
