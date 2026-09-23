import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { preparePythonEnvironment, PythonCandidate, pythonEnvironmentActivity, EnvironmentSetupError } from './pythonEnvironmentSetup';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';
import { DependencyInventory, inventoryReport, inventorySummary } from './dependencyInventory';
import { installationPlanReport, PythonInstallationPlan } from './pythonInstallationPlan';
import { confirmPythonInstallation } from './pythonInstallationPreview';
import { createImportFixturePlan, withImportFixtures } from '../pipeline/importFixtures';

interface PythonApi {
    environments?: {
        getActiveEnvironmentPath(resource?: vscode.Uri): { path: string };
        resolveEnvironment(value: unknown): Promise<{ executable?: { uri?: { fsPath: string } } } | undefined>;
        known?: ReadonlyArray<{ path: string; executable?: { uri?: { fsPath: string } } }>;
    };
}

/** Share resource-scoped configuration across qualification, discovery, single-file and batch runs. */
export function configuredPythonForResource(resourcePath?: string, projectRoot?: string): string {
    const resource = resourcePath ? vscode.Uri.file(resourcePath) : undefined;
    const config = vscode.workspace.getConfiguration('llmUnitTest', resource);
    const configured = config.get<string>('pythonPath', '');
    const workspaceRoot = (resource && vscode.workspace.getWorkspaceFolder?.(resource)?.uri.fsPath)
        || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (typeof configured === 'string' && configured.trim()) { return configured.trim(); }
    if (projectRoot) {
        const projectPython = resolvePythonExecutable('', projectRoot);
        if (projectPython !== 'python') { return projectPython; }
    }
    return resolvePythonExecutable('', workspaceRoot);
}

/** Optional Microsoft Python API: no hard dependency, no source/environment-secret reads. */
export async function discoverPythonCandidates(resource?: vscode.Uri, projectRoot?: string): Promise<PythonCandidate[]> {
    const configured = vscode.workspace.getConfiguration('llmUnitTest', resource).get<string>('pythonPath', '').trim();
    // An explicit interpreter identifies the application's environment. Missing
    // dependencies are not permission to replace it with another installation.
    if (configured) { return [{ executable: configured }]; }
    const result: PythonCandidate[] = [];
    const workspaceRoot = resource ? vscode.workspace.getWorkspaceFolder?.(resource)?.uri.fsPath : undefined;
    for (const root of [projectRoot, workspaceRoot, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath]) {
        if (!root) { continue; }
        const python = resolvePythonExecutable('', root);
        if (python !== 'python') { result.push({ executable: python }); }
        const alternate = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        if (fs.existsSync(alternate)) { result.push({ executable: alternate }); }
    }
    try {
        const extension = vscode.extensions?.getExtension<PythonApi>('ms-python.python');
        if (extension) {
            const api = extension.isActive ? extension.exports : await extension.activate();
            const environments = api.environments;
            if (environments) {
                const active = await environments.resolveEnvironment(environments.getActiveEnvironmentPath(resource));
                if (active?.executable?.uri?.fsPath) { result.push({ executable: active.executable.uri.fsPath }); }
                for (const known of (environments.known || []).slice(0, 10)) {
                    if (known.executable?.uri?.fsPath) { result.push({ executable: known.executable.uri.fsPath }); }
                }
            }
        }
    } catch { /* An unavailable optional API must not prevent normal interpreter discovery. */ }
    for (const root of [process.env.VIRTUAL_ENV, process.env.CONDA_PREFIX]) {
        if (!root) { continue; }
        for (const relative of process.platform === 'win32' ? ['python.exe', 'Scripts/python.exe'] : ['bin/python']) {
            const python = path.join(root, relative);
            if (fs.existsSync(python)) { result.push({ executable: python }); }
        }
    }
    result.push({ executable: 'python' }, ...(process.platform === 'win32'
        ? [{ executable: 'py', args: ['-3'] }] : [{ executable: 'python3' }]));
    const keys = new Set<string>();
    return result.filter(item => {
        const key = JSON.stringify([item.executable, item.args || []]);
        if (keys.has(key)) { return false; }
        keys.add(key); return true;
    });
}

export class PythonEnvironmentController {
    private controller?: AbortController;
    constructor(private readonly state: vscode.Memento,
        private readonly publish: (message: unknown) => void) {}

    dispose(): void { this.controller?.abort(); }

    async prepare(filePath?: string, projectRoot?: string): Promise<void> {
        if (vscode.workspace.isTrusted === false) {
            await vscode.window.showWarningMessage('請先在 VS Code 信任此工作區，才能執行 Python 環境檢查及安裝相依。');
            return;
        }
        const release = pythonEnvironmentActivity.acquire('setup');
        if (!release) {
            await vscode.window.showInformationMessage('Python 分析、模型資格測試或環境準備仍在執行；請等待完成後再準備環境。');
            return;
        }
        this.controller = new AbortController();
        let latestInventory: DependencyInventory | undefined;
        let initialMissing: string[] | undefined;
        const installationPlans: { plan: PythonInstallationPlan; approved: boolean; mappingsUpdated?: boolean }[] = [];
        let outcome = '環境準備尚未完成。';
        try {
            // An explicit directory from the project button is already a selected scope.
            const directProject = filePath && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory() ? filePath : undefined;
            const preferredProject = directProject || projectRoot || vscode.workspace.getConfiguration('llmUnitTest',
                filePath ? vscode.Uri.file(filePath) : undefined).get<string>('projectPath', '');
            const previousScope = this.state.get<string>('llmUnitTest.lastEnvironmentScope.v1', 'project');
            const scopes = [
                { label: '整個專案', description: '掃描目前專案的所有 Python import', scope: 'project' },
                { label: '選擇資料夾', description: '掃描所選資料夾及其子目錄', scope: 'folder' },
                { label: '單一 Python 檔案', description: '保留原有的隔離載入與相依檢查', scope: 'file' }
            ].sort((a, b) => Number(b.scope === previousScope) - Number(a.scope === previousScope));
            const selection = directProject ? { scope: 'project' }
                : await vscode.window.showQuickPick(scopes, { title: '選擇 Python 相依檢查範圍' });
            if (!selection) { return; }
            const scope = selection.scope === 'file' ? 'file' : 'folder';
            if (selection.scope === 'project') {
                const folders = vscode.workspace.workspaceFolders || [];
                let root = preferredProject;
                if (!root && folders.length === 1) { root = folders[0].uri.fsPath; }
                if (!root && folders.length > 1) {
                    const previous = this.state.get<string>('llmUnitTest.lastEnvironmentProject.v1');
                    root = (await vscode.window.showQuickPick(folders.map(folder => ({ label: path.basename(folder.uri.fsPath),
                        description: folder.uri.fsPath })).sort((a, b) => Number(b.description === previous) - Number(a.description === previous)),
                    { title: '選擇要檢查相依的專案' }))?.description || '';
                    if (!root) { return; }
                }
                filePath = root;
            } else if (scope === 'folder') { filePath = undefined; }
            const selectionKey = 'llmUnitTest.lastEnvironment' + (selection.scope === 'project' ? 'Project' : scope === 'folder' ? 'Folder' : 'File') + '.v1';
            if (!filePath) {
                const previous = this.state.get<string>(selectionKey) || preferredProject;
                const choice = await vscode.window.showOpenDialog({ canSelectFiles: scope === 'file', canSelectFolders: scope === 'folder',
                    canSelectMany: false, filters: scope === 'file' ? { Python: ['py'] } : undefined,
                    openLabel: scope === 'file' ? '選擇要檢查相依的 Python 檔案' : '選擇要掃描相依的資料夾',
                    defaultUri: previous && fs.existsSync(previous) ? vscode.Uri.file(previous) : undefined });
                if (!choice?.[0]) { return; }
                filePath = choice[0].fsPath;
            }
            await this.state.update(selectionKey, filePath);
            await this.state.update('llmUnitTest.lastEnvironmentScope.v1', selection.scope);
            const resource = vscode.Uri.file(filePath);
            const containingWorkspace = vscode.workspace.getWorkspaceFolder?.(resource);
            const config = vscode.workspace.getConfiguration('llmUnitTest', resource);
            const configurationTarget = containingWorkspace ? vscode.ConfigurationTarget.WorkspaceFolder
                : vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            const fallbackRoot = scope === 'folder' ? filePath : path.dirname(filePath);
            projectRoot = selection.scope === 'project' ? filePath
                : projectRoot || config.get<string>('projectPath', '') || containingWorkspace?.uri.fsPath || fallbackRoot;
            // A remembered/selected folder from another project cannot control this target's search.
            const relative = path.relative(projectRoot, filePath);
            if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) { projectRoot = fallbackRoot; }
            const targetFile = filePath;
            const root = projectRoot;
            this.publish({ command: 'environmentPreparation', busy: true, text: '正在尋找可沿用的 Python 環境…' });
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                title: '檢查並補齊 Python 環境', cancellable: true }, async (progress, token) => {
                const subscription = token.onCancellationRequested(() => this.controller?.abort());
                if (token.isCancellationRequested) { this.controller?.abort(); }
                try {
                    const candidates = await discoverPythonCandidates(resource, root);
                    const fixtures = scope === 'file' ? createImportFixturePlan(root, config.get<unknown>('importFixtures', [])) : null;
                    const result = await withImportFixtures(fixtures, () => preparePythonEnvironment({ projectRoot: root, file: targetFile, candidates,
                        scope, excludedPaths: [config.get<string>('outputPath', '')].filter(Boolean).map(value => path.resolve(root, value)),
                        inventory: scan => { latestInventory = scan; initialMissing ??= [...scan.missing]; },
                        confirmInstall: async plan => {
                            const record = { plan, approved: false }; installationPlans.push(record);
                            const decision = await confirmPythonInstallation(plan, this.controller!.signal);
                            record.approved = decision === true;
                            return decision;
                        },
                        savePackageMappings: async mappings => {
                            await config.update('packageMappings', { ...config.get<Record<string, string>>('packageMappings', {}), ...mappings }, configurationTarget);
                            const record = installationPlans.at(-1);
                            if (record) { record.mappingsUpdated = true; }
                        },
                        toolRequirements: path.resolve(path.dirname(pythonToolPath('ast')), '..', 'requirements.txt'),
                        signal: this.controller!.signal,
                        progress: text => { progress.report({ message: text }); this.publish({ command: 'appendLog', text: '[環境] ' + text }); },
                        chooseRequirements: async files => {
                            const previous = this.state.get<string>('llmUnitTest.lastRequirements.v1.' + root);
                            const preferred = files.find(file => file === previous) || files.find(file => path.basename(file) === 'requirements.txt');
                            const selected = preferred || (await vscode.window.showQuickPick(files.map(file => ({ label: path.basename(file), description: file })),
                                { title: '選擇原應用的相依清單' }))?.description;
                            if (selected) { await this.state.update('llmUnitTest.lastRequirements.v1.' + root, selected); }
                            return selected;
                        },
                        packageName: async missing => {
                            const mappings = config.get<Record<string, string>>('packageMappings', {});
                            return Object.prototype.hasOwnProperty.call(mappings, missing) ? mappings[missing] : undefined;
                        }
                    }));
                    if (this.controller!.signal.aborted) { outcome = '環境準備已取消，未保存 Python 設定。'; return; }
                    await config.update('pythonPath', result.python, configurationTarget);
                    if (result.requirements) { await this.state.update('llmUnitTest.lastRequirements.v1.' + root, result.requirements); }
                    outcome = '靜態相依與測試工具檢查完成，已保存 Python；正式模組載入尚待測試預檢。';
                    this.publish({ command: 'environmentPreparation', busy: false,
                        text: (result.inventory ? inventorySummary(result.inventory) + ' 正式載入仍待測試預檢。'
                            : '所選檔案的匯入與測試工具檢查通過。') + 'Python：' + result.python });
                    void vscode.window.showInformationMessage(result.inventory
                        ? '相依掃描完成，已保存 Python。詳細結果已開啟；正式測試仍會檢查模組載入與執行限制。'
                        : result.installed.length
                        ? '已補齊相依並保存 Python，現在可以重新測試。'
                        : '已找到相依完整的 Python，未安裝套件；已保存供後續測試使用。');
                } finally { subscription.dispose(); }
            });
        } catch (error) {
            const message = error instanceof EnvironmentSetupError ? '[' + error.stage + '] ' + error.message
                : '環境準備未完成，請確認檔案、Python 與設定寫入權限。';
            outcome = message;
            this.publish({ command: 'environmentPreparation', busy: false, text: message });
            this.publish({ command: 'appendLog', text: '[環境] ' + message });
            void vscode.window.showWarningMessage(message);
        } finally {
            this.controller = undefined;
            release();
            this.publish({ command: 'environmentPreparationFinished' });
            if (latestInventory || installationPlans.length) {
                try {
                    const content = [latestInventory ? inventoryReport(latestInventory, initialMissing, outcome) : '# Python 環境準備\n\n' + outcome,
                        ...installationPlans.map(record => installationPlanReport(record.plan, record.approved, record.mappingsUpdated))].join('\n\n');
                    const document = await vscode.workspace.openTextDocument({ language: 'markdown',
                        content });
                    await vscode.window.showTextDocument(document, { preview: false });
                } catch {
                    this.publish({ command: 'appendLog', text: '[環境] 無法開啟相依報告；' + (latestInventory ? inventorySummary(latestInventory) : outcome) });
                }
            }
        }
    }
}
