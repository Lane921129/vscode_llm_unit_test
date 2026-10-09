import { localize } from '../i18n/core';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pythonEnvironmentActivity } from './pythonEnvironmentSetup';
import { configuredPythonForResource } from './pythonEnvironmentController';
import { extractFunctionsWithAst, findPythonFilesInDir } from '../utils/utils';
import { currentExecution, ExecutionContext, runInExecution, throwIfExecutionCancelled } from '../pipeline/executionContext';
import { createBatchDirectory } from '../pipeline/analysisOutput';
import { createImportFixturePlan, ImportFixtureRule, refreshEntryPointApprovals } from '../pipeline/importFixtures';
import { inspectProjectImports, ImportCheck, ImportCheckTarget, verifyImportProposal } from './projectImportCheck';
import { hasDummyFunctionNameMarker } from '../tier/stubClassifier';
import { importSetupMessage, ImportSetupReason, recheckReason, saveImportSetupSession } from './importSetupSession';
import { externalExactResourcePaths, projectParentResourcePaths, uncVirtualResourcePaths } from './resourceSetup';

export type ImportSetupStatus = 'ready' | 'blocked' | 'cancelled' | 'declined' | 'failed'
    | 'busy' | 'no-targets' | 'untrusted' | 'invalid-root';

/** Terminal evidence for a caller continuing the same selected scope. */
export interface ImportSetupResult {
    status: ImportSetupStatus;
    /** The last completed scan's actual fixture plan, never its proposed plan. */
    fixtureId: string | null;
    directory?: string;
    root?: string;
    python?: string;
    targets: ImportCheckTarget[];
    rows: Array<{ file: string; status: 'loaded' | 'blocked' }>;
    applied: boolean;
    reason?: ImportSetupReason;
}

/** Explicit setup preview. No package installation or target source edits. */
export class ImportSetupController {
    private execution?: ExecutionContext;
    constructor(private readonly publish: (message: unknown) => void) {}
    dispose(): void { this.execution?.cancel(); }

    async prepare(projectRoot?: string, outputPath?: string, selectedTargets?: readonly ImportCheckTarget[]): Promise<ImportSetupResult> {
        const emptyResult = (status: ImportSetupStatus): ImportSetupResult => ({
            status, fixtureId: null, targets: [], rows: [], applied: false
        });
        if (vscode.workspace.isTrusted === false) { await vscode.window.showWarningMessage(localize("請先信任此工作區，再執行隔離匯入預檢。")); return emptyResult('untrusted'); }
        const root = projectRoot || vscode.workspace.getConfiguration('llmUnitTest').get<string>('projectPath', '');
        if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
            await vscode.window.showWarningMessage(localize("請先選擇受測專案資料夾。")); return emptyResult('invalid-root');
        }
        const release = pythonEnvironmentActivity.acquire('setup');
        if (!release) { await vscode.window.showInformationMessage(localize("請等待目前分析或環境準備完成。")); return emptyResult('busy'); }
        const execution = this.execution = new ExecutionContext({});
        const detachParentCancellation = currentExecution()?.onCancel(() => execution.cancel());
        let message = localize("模組載入預檢未完成。");
        let directory: string | undefined;
        let reason: ImportSetupReason = 'error';
        let applied = false;
        let fixtureId: string | null = null;
        let python: string | undefined;
        let validateFinalCheck: (() => void) | undefined;
        const checks: ImportCheck[] = [];
        const targets: ImportCheckTarget[] = [];
        const requestedTargets = selectedTargets?.map(target => ({ ...target }));
        const readyCandidate = () => reason !== 'interrupted' && reason !== 'error' && reason !== 'proposal-declined'
            && !!checks.at(-1)?.rows.length && !checks.at(-1)?.proposedPlan
            && checks.at(-1)!.rows.every(row => row.status === 'loaded');
        this.publish({ command: 'environmentPreparation', busy: true, text: localize("正在檢查模組載入；不會呼叫模型。") });
        try {
            await runInExecution(execution, async () => {
                const config = vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri.file(root));
                python = configuredPythonForResource(root, root);
                const scanPython = python;
                directory = createBatchDirectory(outputPath || config.get<string>('outputPath', '') || os.tmpdir(),
                    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16), 'import_check');
                const rules = config.get<ImportFixtureRule[]>('importFixtures', []);
                refreshEntryPointApprovals(root, rules, config.get<string>('importFixtureRoot', ''));
                const excluded = [directory, ...(outputPath && path.resolve(outputPath) !== path.resolve(root) ? [outputPath] : [])];
                if (requestedTargets) {
                    const canonicalRoot = fs.realpathSync(root);
                    for (const target of requestedTargets) {
                        const relative = path.relative(canonicalRoot, fs.realpathSync(target.file));
                        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
                            || !target.file.endsWith('.py') || !target.target) {
                            throw new Error(localize('預檢來源超出受測根目錄。'));
                        }
                        targets.push({ file: fs.realpathSync(target.file), target: target.target });
                    }
                } else {
                    const files = await findPythonFilesInDir(root, true, excluded, true);
                    for (const file of files) {
                        throwIfExecutionCancelled();
                        const functions = await extractFunctionsWithAst(file, scanPython, true);
                        const target = functions.find(func => !hasDummyFunctionNameMarker(func.fullName));
                        if (target) { targets.push({ file, target: target.fullName }); }
                    }
                }
                const readConfig = () => vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri.file(root));
                const scan = async () => {
                    throwIfExecutionCancelled();
                    const savedRules = structuredClone(readConfig().get<ImportFixtureRule[]>('importFixtures', []));
                    const boundRoot = readConfig().get<string>('importFixtureRoot', '');
                    const refreshed = refreshEntryPointApprovals(root, savedRules, boundRoot);
                    const activeRules = refreshed.rules;
                    const scannedPlan = createImportFixturePlan(root, activeRules, boundRoot);
                    const canonicalRoot = fs.realpathSync(root);
                    const sourceHashes = new Map(targets.map(target => [fs.realpathSync(target.file),
                        createHash('sha256').update(fs.readFileSync(target.file)).digest('hex')]));
                    const expectedFiles = new Set([...sourceHashes.keys()].map(file => path.relative(canonicalRoot, file).replace(/\\/g, '/')));
                    const check = await inspectProjectImports(root, scanPython, targets,
                        path.join(directory!, String(checks.length + 1)), activeRules, text => this.publish({ command: 'appendLog', text }), boundRoot);
                    checks.push(check);
                    fixtureId = check.fixtureId !== undefined ? check.fixtureId : scannedPlan?.id || null;
                    validateFinalCheck = () => {
                        execution.throwIfCancelled();
                        if (check.root !== canonicalRoot || check.python !== scanPython
                            || check.rows.length !== expectedFiles.size || new Set(check.rows.map(row => row.file)).size !== expectedFiles.size
                            || check.rows.some(row => !expectedFiles.has(row.file))) {
                            throw new Error(localize('預檢來源超出受測根目錄。'));
                        }
                        if ([...sourceHashes].some(([file, hash]) => fs.realpathSync(file) !== file
                            || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash)) {
                            throw new Error(localize('來源在預檢期間改變；請重新檢查後再建立初始化設定。'));
                        }
                        if (JSON.stringify(readConfig().get('importFixtures', [])) !== JSON.stringify(savedRules)
                            || readConfig().get('importFixtureRoot', '') !== boundRoot
                            || configuredPythonForResource(root, root) !== scanPython
                            || (createImportFixturePlan(root, readConfig().get('importFixtures', []), boundRoot)?.id || null) !== fixtureId) {
                            throw new Error(localize('設定在預覽期間改變；請重新檢查。'));
                        }
                    };
                    throwIfExecutionCancelled();
                    if (refreshed.expired.length && !check.proposedPlan) {
                        check.proposedPlan = createImportFixturePlan(root, check.proposedRules);
                    }
                    if (check.proposedPlan) { fs.writeFileSync(path.join(check.directory, 'setup_proposal.json'), JSON.stringify({
                        note: localize("清單中的 resources 會建立獨立暫存資源；mkdir/configFiles 舊設定與啟動入口仍是明確替身，不執行其副作用或 callback。受測原檔不變，不會複製正式資料。套用後重新預檢。"),
                        evidence: check.proposals,
                        expiredEntryPointSources: refreshed.expired,
                        'llmUnitTest.importFixtureRoot': check.root,
                        'llmUnitTest.importFixtures': check.proposedRules,
                        sourceHashes: check.proposedPlan.rules.map(rule => ({ file: rule.file, sourceHash: rule.sourceHash }))
                    }, null, 2)); }
                    return { check, savedRules, boundRoot };
                };
                const { check, savedRules, boundRoot } = await scan();
                reason = check.rows.length ? 'initial-check' : 'no-targets';
                message = importSetupMessage(reason, check);
                if (check.proposedPlan && check.rows.length) {
                    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(check.directory, 'import_check.md')), { preview: true });
                    const preview = path.join(check.directory, 'setup_proposal.json');
                    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(preview), { preview: true });
                    throwIfExecutionCancelled();
                    const applyLabel = localize("套用此清單並重新檢查");
                    const parentResources = projectParentResourcePaths(check.proposedRules);
                    const externalResources = externalExactResourcePaths(check.proposedRules);
                    const uncResources = uncVirtualResourcePaths(check.proposedRules);
                    const approved = await vscode.window.showWarningMessage(
                        localize("已開啟初始化與隔離資源清單。套用會保存測試工具設定，再重新檢查；受測原檔不變，缺少的套件、資料表或 API 仍會失敗。")
                            + (parentResources.length ? '\n' + localize('專案父層資源：{0}。這些邏輯路徑將導向全新暫存資源；不讀取或寫入原位置。', parentResources.join(', ')) : '')
                            + externalResources.map(resource => '\n' + localize('外部絕對路徑：{0}。只映射至全新暫存資源；不讀取或寫入原位置。', resource)).join('')
                            + uncResources.map(resource => '\n' + localize('網路樣式路徑：{0}。只在本機暫存區建立測試資源，不連線、不讀寫原共享位置；此確認不授予網路存取權限。', resource)).join(''),
                        { modal: true }, applyLabel);
                    throwIfExecutionCancelled();
                    if (approved !== applyLabel) {
                        reason = 'proposal-declined'; message = importSetupMessage(reason, check); return;
                    }
                    reason = 'error';
                    verifyImportProposal(check);
                    if (JSON.stringify(readConfig().get('importFixtures', [])) !== JSON.stringify(savedRules)
                        || readConfig().get('importFixtureRoot', '') !== boundRoot) { throw new Error(localize("設定在預覽期間改變；請重新檢查。")); }
                    // Global tool settings avoid writing .vscode files into the tested project.
                    await config.update('importFixtureRoot', check.root, vscode.ConfigurationTarget.Global);
                    try { await config.update('importFixtures', check.proposedRules, vscode.ConfigurationTarget.Global); }
                    catch (error) { await config.update('importFixtureRoot', boundRoot || undefined, vscode.ConfigurationTarget.Global); throw error; }
                    if (createImportFixturePlan(root, readConfig().get('importFixtures', []), readConfig().get('importFixtureRoot', ''))?.id !== check.proposedPlan.id) {
                        throw new Error(localize("工作區設定覆蓋了已儲存設定，尚未生效；請核對 importFixtures 與 importFixtureRoot。"));
                    }
                    applied = true;
                    this.publish({ command: 'appendLog', text: localize('已套用確認的初始化設定；正在進行本次唯一一次重新預檢。') });
                    const after = (await scan()).check;
                    reason = recheckReason(check, after);
                    message = importSetupMessage(reason, after);
                }
            });
            execution.throwIfCancelled();
            if (readyCandidate()) { validateFinalCheck!(); }
        } catch (error) {
            reason = execution.cancelled ? 'interrupted' : 'error';
            message = execution.cancelled ? localize("已中止模組預檢。") : localize("模組預檢未完成：{0}", error instanceof Error ? error.message : String(error));
            await vscode.window.showWarningMessage(message);
        } finally {
            if (directory) {
                try {
                    const report = saveImportSetupSession(directory, checks, applied, reason, message);
                    if (!execution.cancelled) {
                        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(report), { preview: true });
                    }
                } catch {
                    this.publish({ command: 'appendLog', text: localize('無法開啟模組預檢總結；請查看輸出資料夾內的逐次診斷。') });
                }
            }
            // Opening the report yields to the UI: cancellation or changes there
            // must also stop a caller from continuing with stale ready evidence.
            try {
                execution.throwIfCancelled();
                if (readyCandidate()) { validateFinalCheck!(); }
            } catch {
                reason = execution.cancelled ? 'interrupted' : 'error';
                message = importSetupMessage(reason);
                if (directory) {
                    try { saveImportSetupSession(directory, checks, applied, reason, message); }
                    catch { /* Existing per-scan diagnostics remain available. */ }
                }
            }
            detachParentCancellation?.();
            this.execution = undefined; release();
            this.publish({ command: 'environmentPreparation', busy: false, text: message });
            this.publish({ command: 'environmentPreparationFinished' });
        }
        const latest = checks.at(-1);
        const resultStatus = (terminalReason: ImportSetupReason): ImportSetupStatus => terminalReason === 'interrupted' ? 'cancelled'
            : terminalReason === 'error' ? 'failed' : terminalReason === 'proposal-declined' ? 'declined'
            : terminalReason === 'no-targets' || !latest?.rows.length ? 'no-targets'
            : readyCandidate() ? 'ready' : 'blocked';
        return { status: resultStatus(reason), fixtureId, directory, root: latest?.root || root, python,
            targets: targets.map(target => ({ ...target })),
            rows: latest?.rows.map(row => ({ file: row.file, status: row.status })) || [], applied, reason };
    }
}
