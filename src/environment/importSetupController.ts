import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pythonEnvironmentActivity } from './pythonEnvironmentSetup';
import { configuredPythonForResource } from './pythonEnvironmentController';
import { extractFunctionsWithAst, findPythonFilesInDir } from '../utils/utils';
import { ExecutionContext, runInExecution, throwIfExecutionCancelled } from '../pipeline/executionContext';
import { createBatchDirectory } from '../pipeline/analysisOutput';
import { createImportFixturePlan, ImportFixtureRule } from '../pipeline/importFixtures';
import { inspectProjectImports, ImportCheckTarget, verifyImportProposal } from './projectImportCheck';
import { hasDummyFunctionNameMarker } from '../tier/stubClassifier';

/** Explicit setup preview. No package installation or target source edits. */
export class ImportSetupController {
    private execution?: ExecutionContext;
    constructor(private readonly publish: (message: unknown) => void) {}
    dispose(): void { this.execution?.cancel(); }

    async prepare(projectRoot?: string, outputPath?: string): Promise<void> {
        if (vscode.workspace.isTrusted === false) { await vscode.window.showWarningMessage('請先信任此工作區，再執行隔離匯入預檢。'); return; }
        const root = projectRoot || vscode.workspace.getConfiguration('llmUnitTest').get<string>('projectPath', '');
        if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
            await vscode.window.showWarningMessage('請先選擇受測專案資料夾。'); return;
        }
        const release = pythonEnvironmentActivity.acquire('setup');
        if (!release) { await vscode.window.showInformationMessage('請等待目前分析或環境準備完成。'); return; }
        const execution = this.execution = new ExecutionContext({});
        let message = '模組載入預檢未完成。';
        this.publish({ command: 'environmentPreparation', busy: true, text: '正在檢查模組載入；不會呼叫模型。' });
        try {
            await runInExecution(execution, async () => {
                const config = vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri.file(root));
                const python = configuredPythonForResource(root, root);
                const directory = createBatchDirectory(outputPath || config.get<string>('outputPath', '') || os.tmpdir(),
                    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16), 'import_check');
                const rules = config.get<ImportFixtureRule[]>('importFixtures', []);
                createImportFixturePlan(root, rules, config.get<string>('importFixtureRoot', ''));
                const excluded = [directory, ...(outputPath && path.resolve(outputPath) !== path.resolve(root) ? [outputPath] : [])];
                const files = await findPythonFilesInDir(root, true, excluded, true);
                const targets: ImportCheckTarget[] = [];
                for (const file of files) {
                    throwIfExecutionCancelled();
                    const functions = await extractFunctionsWithAst(file, python, true);
                    const target = functions.find(func => !hasDummyFunctionNameMarker(func.fullName));
                    if (target) { targets.push({ file, target: target.fullName }); }
                }
                for (let attempt = 0; attempt < 8; attempt++) {
                    const readConfig = () => vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri.file(root));
                    const activeRules = readConfig().get<ImportFixtureRule[]>('importFixtures', []);
                    const boundRoot = readConfig().get<string>('importFixtureRoot', '');
                    const check = await inspectProjectImports(root, python, targets,
                        path.join(directory, String(attempt + 1)), activeRules, text => this.publish({ command: 'appendLog', text }), boundRoot);
                    const blocked = check.rows.filter(row => row.status === 'blocked').length;
                    message = `模組預檢：${check.rows.length} 個模組，${blocked} 個受阻；尚未執行函式測試。`;
                    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(check.directory, 'import_check.md')), { preview: true });
                    if (!check.proposedPlan) { break; }
                    const preview = path.join(check.directory, 'setup_proposal.json');
                    fs.writeFileSync(preview, JSON.stringify({
                        note: '只模擬列出來源的模組頂層 Path.mkdir，不建立真實目錄；其他操作仍隔離。套用後重新預檢。',
                        'llmUnitTest.importFixtureRoot': check.root,
                        'llmUnitTest.importFixtures': check.proposedRules,
                        sourceHashes: check.proposedPlan.rules.map(rule => ({ file: rule.file, sourceHash: rule.sourceHash }))
                    }, null, 2));
                    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(preview), { preview: true });
                    const approved = await vscode.window.showWarningMessage(
                        '已開啟初始化替身清單。套用會保存測試工具設定，再重新檢查；受測原檔不變，缺少的套件或 API 仍會失敗。',
                        { modal: true }, '套用此清單並重新檢查');
                    throwIfExecutionCancelled();
                    if (approved !== '套用此清單並重新檢查') { message += ' 未套用初始化替身。'; break; }
                    verifyImportProposal(check);
                    if (JSON.stringify(readConfig().get('importFixtures', [])) !== JSON.stringify(activeRules)
                        || readConfig().get('importFixtureRoot', '') !== boundRoot) { throw new Error('設定在預覽期間改變；請重新檢查。'); }
                    // Global tool settings avoid writing .vscode files into the tested project.
                    await config.update('importFixtureRoot', check.root, vscode.ConfigurationTarget.Global);
                    try { await config.update('importFixtures', check.proposedRules, vscode.ConfigurationTarget.Global); }
                    catch (error) { await config.update('importFixtureRoot', boundRoot || undefined, vscode.ConfigurationTarget.Global); throw error; }
                    if (createImportFixturePlan(root, readConfig().get('importFixtures', []), readConfig().get('importFixtureRoot', ''))?.id !== check.proposedPlan.id) {
                        throw new Error('工作區設定覆蓋了已儲存設定，尚未生效；請核對 importFixtures 與 importFixtureRoot。');
                    }
                    message = '初始化設定已保存，尚待重新預檢。';
                }
            });
        } catch (error) {
            message = execution.cancelled ? '已中止模組預檢。' : `模組預檢未完成：${error instanceof Error ? error.message : String(error)}`;
            await vscode.window.showWarningMessage(message);
        } finally {
            this.execution = undefined; release();
            this.publish({ command: 'environmentPreparation', busy: false, text: message });
            this.publish({ command: 'environmentPreparationFinished' });
        }
    }
}
