import { resultDataDirectory, resultArtifactPath } from './resultLayout';
import { localize } from '../i18n/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { evidenceHash } from './analysisJournal';
import { ROLE_CONTRACT_VERSIONS } from '../roles/roleContracts';
import { evaluateQuality, validateQualityPolicy } from './qualityPolicy';
import { describeImportIssue } from '../environment/importDiagnostics';
import { verifyExecutionEvidence } from './executionEvidence';
import { VerificationMode } from './verificationMode';
import { conciseReason, isReportExcluded, reportCell, reportLink, summarizeTarget, TargetReportSummary } from './targetReport';

interface BatchTarget {
    id: number; file: string; target: string;
    state: 'pending' | 'running' | 'finished';
    terminalStatus?: string; category?: string; stage?: string; reportDirectory?: string;
    modelRequests?: number; environment?: EnvironmentIssue;
}
interface EnvironmentIssue {
    kind: 'missing-dependency' | 'import-side-effect' | 'dependency-api' | 'module-resolution' | 'other';
    issue?: string; advice?: string;
    missingModule?: string; operation?: string; origin?: { file: string; line: number };
}

/** Recompute a new report from its fixed policy and immutable candidate. The
 * displayed score and the persisted "passed" flag are never sufficient. */
function verifyQualityPass(directory: string, sourcePath: string, target: string,
    manifest: any, knowledge: any): void {
    const invalid = () => { throw Error('incomplete-quality-provenance'); };
    const validated = validateQualityPolicy(manifest.qualityPolicy);
    if (!validated.ok || !['standard', 'strict100'].includes(validated.policy.mode)
        || manifest.qualityContractVersion !== 'quality-policy-v1'
        || knowledge.qualityContractVersion !== 'quality-policy-v1'
        || !isDeepStrictEqual(manifest.qualityPolicy, knowledge.qualityPolicy)
        || knowledge.evidenceValid === false) { return invalid(); }
    const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'quality_baseline.json'), 'utf8'));
    const test = knowledge.acceptedTest;
    const immutableTest = snapshot.testFile;
    if (snapshot.schemaVersion !== 'quality-baseline-v1'
        || snapshot.sourceHash !== knowledge.sourceHash || snapshot.target !== target
        || !isDeepStrictEqual(snapshot.qualityPolicy, validated.policy)
        || typeof test !== 'string' || path.basename(test) !== test || /[\\/]/.test(test)
        || typeof immutableTest !== 'string' || path.basename(immutableTest) !== immutableTest || /[\\/]/.test(immutableTest)
        || typeof snapshot.code !== 'string' || evidenceHash(snapshot.code) !== snapshot.codeHash
        || knowledge.acceptedCodeHash !== snapshot.codeHash
        || evidenceHash(fs.readFileSync(sourcePath, 'utf8')) !== knowledge.sourceHash
        || evidenceHash(fs.readFileSync(resultArtifactPath(directory, test), 'utf8')) !== snapshot.codeHash
        || evidenceHash(fs.readFileSync(resultArtifactPath(directory, immutableTest), 'utf8')) !== snapshot.codeHash
        || typeof snapshot.execution !== 'string' || !snapshot.execution.trim()
        || snapshot.execution !== knowledge.execution || snapshot.reviewStatus !== knowledge.reviewStatus
        || snapshot.generationMode !== knowledge.generationMode
        || snapshot.tier !== knowledge.resolvedTier
        || ['qualityGaps', 'measuredQualityGaps'].some(field => !Array.isArray(snapshot[field])
            || !snapshot[field].every((item: unknown) => typeof item === 'string'))
        || !isDeepStrictEqual(snapshot.coverage?.assessment, knowledge.coverage?.assessment)
        || !isDeepStrictEqual(snapshot.mutation, knowledge.mutation)) { return invalid(); }
    const targetScope = { kind: 'function' as const, qualifiedName: target };
    const assessment = evaluateQuality(validated.policy, {
        identity: { sourcePath, sourceHash: knowledge.sourceHash, testHash: snapshot.codeHash,
            targetScope, policyHash: validated.policy.policyHash },
        executionPassed: true,
        coverage: { sourceHash: knowledge.sourceHash, testHash: snapshot.codeHash, targetScope,
            assessment: snapshot.coverage.assessment },
        mutation: snapshot.mutation, reviewStatus: snapshot.reviewStatus,
        generationMode: snapshot.generationMode, qualityGaps: []
    });
    if (!assessment.fullyPassed || !isDeepStrictEqual(assessment, snapshot.qualityAssessment)
        || !isDeepStrictEqual(assessment, knowledge.qualityAssessment)) { return invalid(); }
}

/** Explicit inventory and completion; a report's mere existence is never a pass. */
export class BatchJournal {
    private readonly id = randomUUID();
    private readonly startedAt = new Date().toISOString();
    private status = 'discovering';
    private finishedAt?: string;
    private blockedModules = 0;
    private readonly targets: BatchTarget[] = [];
    private readonly discoveryFailures: Array<{ file: string; stage: string }> = [];
    private readonly files: string[] = [];
    private readonly reportSummaries = new Map<number, TargetReportSummary>();
    constructor(readonly directory: string, private readonly sourceRoot: string,
        private readonly identity: { model: string; buildTimestamp: string; python: string; validationMode?: VerificationMode }) {
        this.save();
    }
    private relative(file: string): string {
        const relative = path.relative(this.sourceRoot, file);
        if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
            throw new Error(localize("批次來源不在已選資料夾內。"));
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
    preflight(blockedModules: number): void { this.blockedModules = blockedModules; this.save(); }
    begin(id: number): void { this.targets[id].state = 'running'; this.save(); }
    attach(id: number, directory: string): void {
        const relative = path.relative(this.directory, directory);
        if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
            throw new Error(localize("批次報告不在本次輸出資料夾內。"));
        }
        this.targets[id].reportDirectory = relative.replace(/\\/g, '/'); this.save();
    }
    dummy(id: number): void { this.targets[id].terminalStatus = 'dummy-skipped'; }
    refresh(id: number): void {
        const target = this.targets[id];
        const reportRoot = target.reportDirectory && path.join(this.directory, target.reportDirectory);
        try {
            if (!reportRoot) { throw Error('missing-report'); }
            const directory = resultDataDirectory(reportRoot);
            const hasFinal = fs.existsSync(path.join(reportRoot, 'final_report.md'));
            const hasWorkflow = fs.existsSync(path.join(directory, 'workflow_report.md'));
            if (!hasFinal && !hasWorkflow) { throw Error('missing-report'); }
            if (target.terminalStatus !== 'dummy-skipped') {
                const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
                const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'run_manifest.json'), 'utf8'));
                if (!knowledge.runId || manifest.runId !== knowledge.runId || !knowledge.sourceHash || manifest.sourceHash !== knowledge.sourceHash
                    || manifest.target !== target.target || knowledge.target !== target.target || typeof knowledge.terminalStatus !== 'string'
                    || knowledge.terminalStatus === 'running') { throw Error('incomplete-provenance'); }
                if ((manifest.validationMode ?? 'full') !== (this.identity.validationMode ?? 'full')
                    || (knowledge.validationMode ?? 'full') !== (manifest.validationMode ?? 'full')) { throw Error('mode-mismatch'); }
                if (!hasFinal && !isReportExcluded(knowledge.terminalStatus)) { throw Error('missing-report'); }
                if (knowledge.terminalStatus === 'passed') {
                    if (manifest.validationMode === 'execution' || knowledge.validationMode === 'execution') { throw Error('mode-mismatch'); }
                    const hasQualityContract = [manifest, knowledge].some(artifact =>
                        ['qualityContractVersion', 'qualityPolicy', 'qualityAssessment'].some(key => Object.hasOwn(artifact, key)));
                    if (hasQualityContract) {
                        verifyQualityPass(directory, path.resolve(this.sourceRoot, target.file), target.target, manifest, knowledge);
                    } else {
                        const test = knowledge.acceptedTest;
                        if (typeof test !== 'string' || path.basename(test) !== test || /[\\/]/.test(test)
                            || !['completed', 'not-required'].includes(knowledge.reviewStatus)
                            || !Array.isArray(knowledge.qualityGaps) || knowledge.qualityGaps.length
                            || typeof knowledge.execution !== 'string' || !knowledge.execution.trim()
                            || knowledge.mutationScore !== 100 || !Array.isArray(knowledge.survivors) || knowledge.survivors.length
                            || evidenceHash(fs.readFileSync(resultArtifactPath(directory, test), 'utf8')) !== knowledge.acceptedCodeHash) {
                            throw Error('incomplete-provenance');
                        }
                    }
                }
                if (knowledge.terminalStatus === 'execution-passed') {
                    const baseline = JSON.parse(fs.readFileSync(path.join(directory, 'execution_baseline.json'), 'utf8'));
                    if (manifest.validationMode !== 'execution' || knowledge.validationMode !== 'execution'
                        || (this.identity.validationMode ?? 'full') !== 'execution'
                        || knowledge.evidenceValid !== true || knowledge.executionVerified !== true
                        || knowledge.executionBaseline !== 'execution_baseline.json'
                        || knowledge.acceptedTest !== baseline.testFile || knowledge.acceptedCodeHash !== baseline.testHash
                        || !verifyExecutionEvidence(directory, path.resolve(this.sourceRoot, target.file), baseline, {
                            runId: manifest.runId, sourceHash: manifest.sourceHash, target: target.target
                        })) { throw Error('incomplete-execution-provenance'); }
                }
                target.terminalStatus = knowledge.terminalStatus;
                target.category = knowledge.failureCategory;
                target.stage = knowledge.failureStage;
                if (target.category === 'environment') {
                    const diagnostic = knowledge.diagnostic || {};
                    target.environment = describeImportIssue(diagnostic, target.stage || 'environment');
                    if (target.environment.kind === 'missing-dependency') { target.environment.missingModule = target.environment.issue; }
                    if (target.environment.kind === 'import-side-effect') { target.environment.operation = target.environment.issue; }
                }
                const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
                if (events.some(event => event.runId !== knowledge.runId || event.sourceHash !== knowledge.sourceHash)) {
                    throw Error('incomplete-provenance');
                }
                target.modelRequests = events.filter(event => event.stage === 'model-request' && event.status === 'requested').length;
                this.reportSummaries.set(id, summarizeTarget(directory, knowledge, {
                    schemaVersion: 'target-report-v1', sourcePath: path.resolve(this.sourceRoot, target.file),
                    sourceFile: target.file, target: target.target, modelIdentity: this.identity.model, requestedTier: ''
                }, knowledge.sourceHash));
            }
            target.state = 'finished';
        } catch {
            this.reportSummaries.delete(id);
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
    summary(): string {
        const passed = this.targets.filter(t => t.terminalStatus === 'passed').length;
        const executed = this.targets.filter(t => t.terminalStatus === 'execution-passed').length;
        const blocked = this.targets.filter(t => t.category === 'environment').length;
        const failed = this.targets.filter(t => t.category !== 'environment'
            && ['failed', 'retained-after-failure', 'source-changed'].includes(t.terminalStatus || '')).length;
        const skipped = this.targets.filter(t => ['dummy-skipped', 'stub-skipped', 'stub-smoke-generated', 'no-mutation-candidates'].includes(t.terminalStatus || '')).length;
        return localize("共 {0} 個目標；執行驗證通過 {1}、完整通過 {2}、環境受阻 {3}、失敗 {4}、略過／未評分 {5}、未完成 {6}", this.targets.length, executed, passed, blocked, failed, skipped, this.targets.length - executed - passed - blocked - failed - skipped);
    }
    private save(): void {
        const counts: Record<string, number> = {};
        const groups = new Map<string, { kind: string; issue: string; advice?: string; affectedTargets: number; files: Set<string> }>();
        for (const target of this.targets) {
            const status = target.terminalStatus || target.state;
            counts[status] = (counts[status] || 0) + 1;
            const environment = target.environment;
            if (environment) {
                const origin = environment.origin;
                const issue = (environment.issue || environment.missingModule || environment.operation || target.stage || 'environment')
                    + (origin && environment.kind !== 'missing-dependency' ? ` (${origin.file}:${origin.line})` : '');
                const key = `${environment.kind}/${issue}`;
                const group = groups.get(key) || { kind: environment.kind, issue, advice: environment.advice, affectedTargets: 0, files: new Set<string>() };
                group.affectedTargets++; group.files.add(target.file); groups.set(key, group);
            }
        }
        const environmentIssues = [...groups.values()].map(group => ({ ...group, files: [...group.files].sort() }));
        const complete = this.status === 'completed';
        const passed = counts.passed || 0;
        const executed = counts['execution-passed'] || 0;
        const mode = this.identity.validationMode ?? 'full';
        const manifest = { schemaVersion: 1, batchId: this.id, startedAt: this.startedAt, finishedAt: this.finishedAt,
            validationMode: mode,
            allTargetsExecutionVerified: complete && this.targets.length > 0 && executed === this.targets.length,
            status: this.status, complete, allTargetsPassed: complete && this.targets.length > 0 && passed === this.targets.length,
            preflightBlockedModules: this.blockedModules,
            model: this.identity.model, buildTimestamp: this.identity.buildTimestamp,
            pythonExecutable: this.identity.python, roleContracts: ROLE_CONTRACT_VERSIONS,
            discoveredFiles: this.files, discoveryFailures: this.discoveryFailures,
            expectedTargets: this.targets.length, finishedTargets: this.targets.filter(t => t.state === 'finished').length,
            statusCounts: counts, environmentIssues, targets: this.targets };
        const temporary = path.join(this.directory, 'batch_manifest.pending.json');
        fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), 'utf8');
        fs.renameSync(temporary, path.join(this.directory, 'batch_manifest.json'));
        const safe = (value: string) => value.replace(/[|\r\n]/g, ' ');
        const report = [localize("# 批次執行摘要"), '', `## ${manifest.allTargetsPassed ? localize("完整通過")
            : manifest.allTargetsExecutionVerified ? localize("全部執行驗證通過；完整品質尚未驗證") : localize("未全部通過")}`, '', this.summary(), '',
            localize("- 驗證目標：{0}", mode === 'execution' ? localize("執行驗證；Trace、覆蓋率、突變與品質審查未執行") : localize("完整品質驗證")),
            localize("- 狀態：{0}（執行完成不代表測試通過）", this.status),
            ...(this.blockedModules ? [localize("- 前置預檢有 {0} 個模組受阻：[原因與處理方式](preflight/import_check.md)。未開始的目標保持未完成。", this.blockedModules)] : []),
            localize("- 預期目標：{0}；已有終態：{1}；完整通過：{2}", this.targets.length, manifest.finishedTargets, passed),
            localize("- 模型：{0}；建置：{1}", safe(this.identity.model), safe(this.identity.buildTimestamp)),
            `- Python：${safe(this.identity.python)}`, '', localize("| 目標狀態 | 數量 |"), '| --- | ---: |',
            ...Object.entries(counts).map(([status, count]) => `| ${status} | ${count} |`), '',
            localize("## 環境障礙"), '', localize("| 分類 | 共同原因 | 受影響目標 | 處理方式 |"), '| --- | --- | ---: | --- |',
            ...environmentIssues.map(issue => `| ${issue.kind} | ${safe(issue.issue)} | ${issue.affectedTargets} | ${safe(issue.advice || '')} |`), '',
            localize("缺套件：依被測專案的 requirements／lockfile，在上述 Python 環境安裝相依；套件匯入名稱不一定是安裝名稱，請勿猜測版本。"),
            localize("匯入副作用：在測試工具設定 llmUnitTest.importFixtures，明確模擬初始化相依，保持受測原檔不變。安裝套件不能解決目錄建立等副作用；API 不相容須核對原專案版本宣告。"), '',
            localize("## 未完成與略過"), '',
            ...this.discoveryFailures.map(item => localize("- 無法掃描 {0}：{1}", safe(item.file), safe(item.stage))),
            ...this.targets.filter(t => t.state !== 'finished').map(t => `- ${safe(t.file)} :: ${safe(t.target)}：${t.terminalStatus || t.state}`),
            localize("Dummy／Stub、審查未完成、品質不足及缺報告皆不計為通過。逐目標輸出與模型請求數見 batch_manifest.json。"), ''].join('\n');
        // The audit inventory stays complete; the user-facing result list contains only attempted test targets.
        fs.writeFileSync(path.join(this.directory, 'batch_workflow.md'), report, 'utf8');
        const visible = this.targets.filter(t => t.state !== 'pending' && !isReportExcluded(t.terminalStatus));
        const failureTargets = visible.filter(t => t.reportDirectory && fs.existsSync(path.join(this.directory, t.reportDirectory, 'failure_report.md')));
        const failures = this.discoveryFailures.length > 0 || ['cancelled', 'failed', 'incomplete'].includes(this.status)
            || visible.some(t => t.terminalStatus && !['passed', 'execution-passed'].includes(t.terminalStatus)) || failureTargets.length > 0;
        const concise = [localize('# 批次測試結果'), '', localize('- **模型識別**: {0}', reportCell(this.identity.model)),
            localize('- 狀態：{0}（執行完成不代表測試通過）', this.status), '',
            localize('| 目標 | 結果／失敗原因 | 覆蓋率 | 突變分數 | 測資與突變測資 |'), '| --- | --- | --- | --- | --- |',
            ...visible.map(t => {
                const summary = this.reportSummaries.get(t.id);
                const link = t.reportDirectory && fs.existsSync(path.join(this.directory, t.reportDirectory, 'final_report.md'))
                    ? `[${localize('查看結果')}](${reportLink(t.reportDirectory + '/final_report.md')})` : '—';
                return `| ${reportCell(t.file)} :: ${reportCell(t.target)} | ${reportCell(summary ? `${summary.outcome} / ${conciseReason(summary.reason)}` : t.terminalStatus || t.state)} | ${summary?.coverage || 'N/A'} | ${summary?.mutation || 'N/A'} | ${link} |`;
            }), '', ...(visible.length ? [] : [localize('本次沒有可列入的測試目標。'), '']),
            ...(failures ? [localize('[失敗報告與完整流程](failure_report.md)'), ''] : [])].join('\n');
        fs.writeFileSync(path.join(this.directory, 'batch_summary.md'), concise, 'utf8');
        if (failures) {
            fs.writeFileSync(path.join(this.directory, 'failure_report.md'), [localize('# 批次失敗報告'), '', report,
                localize('## 各目標完整流程'), '', ...visible.map(t => {
                    const file = t.reportDirectory && fs.existsSync(path.join(this.directory, t.reportDirectory, 'failure_report.md'))
                        ? 'failure_report.md' : 'workflow_report.md';
                    return t.reportDirectory && fs.existsSync(path.join(this.directory, t.reportDirectory, file))
                        ? `- [${reportCell(t.file)} :: ${reportCell(t.target)}](${reportLink(t.reportDirectory + '/' + file)})`
                        : `- ${reportCell(t.file)} :: ${reportCell(t.target)}：${localize('尚無流程報告；未計入通過。')}`;
                }), ''].join('\n'), 'utf8');
        }
    }
}
