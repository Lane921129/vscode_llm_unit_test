import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { preparePythonEnvironment, PythonCandidate, pythonEnvironmentActivity, EnvironmentSetupError } from './pythonEnvironmentSetup';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';

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
        try {
            if (!filePath) {
                const previous = this.state.get<string>('llmUnitTest.lastEnvironmentFile.v1');
                const choice = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false,
                    canSelectMany: false, filters: { Python: ['py'] }, openLabel: '選擇要檢查相依的 Python 檔案',
                    defaultUri: previous ? vscode.Uri.file(previous) : undefined });
                if (!choice?.[0]) { return; }
                filePath = choice[0].fsPath;
            }
            await this.state.update('llmUnitTest.lastEnvironmentFile.v1', filePath);
            const resource = vscode.Uri.file(filePath);
            const containingWorkspace = vscode.workspace.getWorkspaceFolder?.(resource);
            const config = vscode.workspace.getConfiguration('llmUnitTest', resource);
            projectRoot = projectRoot || config.get<string>('projectPath', '') || containingWorkspace?.uri.fsPath || path.dirname(filePath);
            // A remembered/selected folder from another project cannot control this target's search.
            const relative = path.relative(projectRoot, filePath);
            if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) { projectRoot = path.dirname(filePath); }
            const targetFile = filePath;
            const root = projectRoot;
            this.publish({ command: 'environmentPreparation', busy: true, text: '正在尋找可沿用的 Python 環境…' });
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                title: '檢查並補齊 Python 環境', cancellable: true }, async (progress, token) => {
                const subscription = token.onCancellationRequested(() => this.controller?.abort());
                if (token.isCancellationRequested) { this.controller?.abort(); }
                try {
                    const candidates = await discoverPythonCandidates(resource, root);
                    const result = await preparePythonEnvironment({ projectRoot: root, file: targetFile, candidates,
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
                    });
                    if (this.controller!.signal.aborted) { return; }
                    const target = containingWorkspace ? vscode.ConfigurationTarget.WorkspaceFolder
                        : vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
                    await config.update('pythonPath', result.python, target);
                    if (result.requirements) { await this.state.update('llmUnitTest.lastRequirements.v1.' + root, result.requirements); }
                    this.publish({ command: 'environmentPreparation', busy: false,
                        text: '所選檔案的匯入與測試工具檢查通過。Python：' + result.python });
                    await vscode.window.showInformationMessage(result.installed.length
                        ? '已補齊相依並保存 Python，現在可以重新測試。'
                        : '已找到相依完整的 Python，未安裝套件；已保存供後續測試使用。');
                } finally { subscription.dispose(); }
            });
        } catch (error) {
            const message = error instanceof EnvironmentSetupError ? '[' + error.stage + '] ' + error.message
                : '環境準備未完成，請確認檔案、Python 與設定寫入權限。';
            this.publish({ command: 'environmentPreparation', busy: false, text: message });
            this.publish({ command: 'appendLog', text: '[環境] ' + message });
            await vscode.window.showWarningMessage(message);
        } finally {
            this.controller = undefined;
            release();
            this.publish({ command: 'environmentPreparationFinished' });
        }
    }
}
