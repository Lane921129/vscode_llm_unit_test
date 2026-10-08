import { localize } from '../i18n/core';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pythonEnvironmentActivity } from './pythonEnvironmentSetup';
import { configuredPythonForResource } from './pythonEnvironmentController';
import { extractFunctionsWithAst, findPythonFilesInDir } from '../utils/utils';
import { ExecutionContext, runInExecution, throwIfExecutionCancelled } from '../pipeline/executionContext';
import { createBatchDirectory } from '../pipeline/analysisOutput';
import { createImportFixturePlan, ImportFixtureRule, refreshEntryPointApprovals } from '../pipeline/importFixtures';
import { inspectProjectImports, ImportCheck, ImportCheckTarget, verifyImportProposal } from './projectImportCheck';
import { hasDummyFunctionNameMarker } from '../tier/stubClassifier';
import { importSetupMessage, ImportSetupReason, recheckReason, saveImportSetupSession } from './importSetupSession';

/** Explicit setup preview. No package installation or target source edits. */
export class ImportSetupController {
    private execution?: ExecutionContext;
    constructor(private readonly publish: (message: unknown) => void) {}
    dispose(): void { this.execution?.cancel(); }

    async prepare(projectRoot?: string, outputPath?: string, selectedTargets?: readonly ImportCheckTarget[]): Promise<void> {
        if (vscode.workspace.isTrusted === false) { await vscode.window.showWarningMessage(localize("請先信任此工作區，再執行隔離匯入預檢。")); return; }
        const root = projectRoot || vscode.workspace.getConfiguration('llmUnitTest').get<string>('projectPath', '');
        if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
            await vscode.window.showWarningMessage(localize("請先選擇受測專案資料夾。")); return;
        }
        const release = pythonEnvironmentActivity.acquire('setup');
        if (!release) { await vscode.window.showInformationMessage(localize("請等待目前分析或環境準備完成。")); return; }
        const execution = this.execution = new ExecutionContext({});
        let message = localize("模組載入預檢未完成。");
        let directory: string | undefined;
        let reason: ImportSetupReason = 'error';
        let applied = false;
        const checks: ImportCheck[] = [];
        const requestedTargets = selectedTargets?.map(target => ({ ...target }));
        this.publish({ command: 'environmentPreparation', busy: true, text: localize("正在檢查模組載入；不會呼叫模型。") });
        try {
            await runInExecution(execution, async () => {
                const config = vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri.file(root));
                const python = configuredPythonForResource(root, root);
                directory = createBatchDirectory(outputPath || config.get<string>('outputPath', '') || os.tmpdir(),
                    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16), 'import_check');
                const rules = config.get<ImportFixtureRule[]>('importFixtures', []);
                refreshEntryPointApprovals(root, rules, config.get<string>('importFixtureRoot', ''));
                const excluded = [directory, ...(outputPath && path.resolve(outputPath) !== path.resolve(root) ? [outputPath] : [])];
                const targets: ImportCheckTarget[] = [];
                if (requestedTargets) {
                    const canonicalRoot = fs.realpathSync(root);
                    for (const target of requestedTargets) {
                        const relative = path.relative(canonicalRoot, fs.realpathSync(target.file));
                        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
                            || !target.file.endsWith('.py') || !target.target) {
                            throw new Error(localize('預檢來源超出受測根目錄。'));
                        }
                        targets.push(target);
                    }
                } else {
                    const files = await findPythonFilesInDir(root, true, excluded, true);
                    for (const file of files) {
                        throwIfExecutionCancelled();
                        const functions = await extractFunctionsWithAst(file, python, true);
                        const target = functions.find(func => !hasDummyFunctionNameMarker(func.fullName));
                        if (target) { targets.push({ file, target: target.fullName }); }
                    }
                }
                const readConfig = () => vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri.file(root));
                const scan = async () => {
                    throwIfExecutionCancelled();
                    const savedRules = readConfig().get<ImportFixtureRule[]>('importFixtures', []);
                    const boundRoot = readConfig().get<string>('importFixtureRoot', '');
                    const refreshed = refreshEntryPointApprovals(root, savedRules, boundRoot);
                    const activeRules = refreshed.rules;
                    const check = await inspectProjectImports(root, python, targets,
                        path.join(directory!, String(checks.length + 1)), activeRules, text => this.publish({ command: 'appendLog', text }), boundRoot);
                    checks.push(check);
                    throwIfExecutionCancelled();
                    if (refreshed.expired.length && !check.proposedPlan) {
                        check.proposedPlan = createImportFixturePlan(root, check.proposedRules);
                    }
                    if (check.proposedPlan) { fs.writeFileSync(path.join(check.directory, 'setup_proposal.json'), JSON.stringify({
                        note: localize("模擬列出來源的頂層目錄建立或指定行號的外部初始化呼叫；不執行其副作用或 callback。請確認測試不依賴被略過初始化建立的狀態。其他操作仍隔離，套用後重新預檢。"),
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
                    const approved = await vscode.window.showWarningMessage(
                        localize("已開啟初始化替身清單。套用會保存測試工具設定，再重新檢查；受測原檔不變，缺少的套件或 API 仍會失敗。"),
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
            this.execution = undefined; release();
            this.publish({ command: 'environmentPreparation', busy: false, text: message });
            this.publish({ command: 'environmentPreparationFinished' });
        }
    }
}
