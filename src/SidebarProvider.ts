import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewContent } from './webviewContent';

export class MutationViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mutation-test-view';
    public webview?: vscode.Webview;

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this.webview = webviewView.webview;
        this.webview.options = { enableScripts: true };

        this.webview.html = getWebviewContent();

        this.webview.onDidReceiveMessage(async (message) => {
            const config = vscode.workspace.getConfiguration('llmUnitTest');

            switch (message.command) {
                case 'getInitialData': {
                    const keys = config.get<Record<string, string>>('apiKeys', {});
                    const savedProjPath = config.get<string>('projectPath', '');
                    const files = await this.findPythonFiles(savedProjPath);
                    const savedPath = config.get<string>('outputPath', '');

                    this.webview?.postMessage({ command: 'setApiKeys', keys });
                    if (savedProjPath) {
                        this.webview?.postMessage({ command: 'setProjectPath', path: savedProjPath });
                    }
                    this.webview?.postMessage({ command: 'setFiles', files });
                    if (savedPath) {
                        this.webview?.postMessage({ command: 'setOutputPath', path: savedPath });
                    }

                    // Background fetch for local models
                    this.fetchLocalModels().then(models => {
                        this.webview?.postMessage({ command: 'setModels', models });
                    });
                    break;
                }


                case 'browseProjectFolder': {
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: '選擇專案資料夾'
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const projectPath = fileUri[0].fsPath;
                        try {
                            await config.update('projectPath', projectPath, true);
                        } catch (e) {
                            console.error('更新 projectPath 設定失敗', e);
                        }
                        this.webview?.postMessage({ command: 'setProjectPath', path: projectPath });
                        
                        // 顯示載入中
                        vscode.window.showInformationMessage(`正在掃描資料夾中的 Python 檔案，請稍候...`);

                        // 重新掃描並更新檔案列表
                        const files = await this.findPythonFiles(projectPath);
                        this.webview?.postMessage({ command: 'setFiles', files });
                        
                        if (files.length === 0) {
                            vscode.window.showWarningMessage('在選擇的資料夾中沒有找到任何 .py 檔案。');
                        } else {
                            vscode.window.showInformationMessage(`✅ 成功載入 ${files.length} 個 Python 檔案`);
                        }
                    }
                    break;
                }

                case 'browseFolder': {
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: '選擇輸出資料夾'
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const outputPath = fileUri[0].fsPath;
                        try {
                            await config.update('outputPath', outputPath, true);
                        } catch (e) {
                            console.error('更新 outputPath 設定失敗', e);
                        }
                        this.webview?.postMessage({ command: 'setOutputPath', path: outputPath });
                    }
                    break;
                }

                case 'getFunctions': {
                    const funcs = await this.findPythonFunctions(message.filePath);
                    this.webview?.postMessage({ command: 'setFunctions', funcs });
                    break;
                }

                case 'updateApiKey': {
                    // 使用外層的 config，不重複宣告
                    const currentKeys = { ...config.get<Record<string, string>>('apiKeys', {}) };

                    if (message.oldName && message.oldName !== message.newName) {
                        delete currentKeys[message.oldName];
                    }
                    currentKeys[message.newName] = message.key;

                    await config.update('apiKeys', currentKeys, true);
                    this.webview?.postMessage({ command: 'setApiKeys', keys: currentKeys });
                    vscode.window.showInformationMessage(`✅ 已存檔：${message.newName}`);
                    break;
                }

                case 'deleteApiKey': {
                    // 使用外層的 config，不重複宣告
                    const currentKeys = { ...config.get<Record<string, string>>('apiKeys', {}) };

                    if (currentKeys[message.name]) {
                        delete currentKeys[message.name];
                        await config.update('apiKeys', currentKeys, true);
                        this.webview?.postMessage({ command: 'setApiKeys', keys: currentKeys });
                        vscode.window.showInformationMessage(`🗑️ 已刪除：${message.name}`);
                    }
                    break;
                }

                case 'startAnalysis': {
                    vscode.commands.executeCommand('llm-unit-test.runCaptureAndTest', message);
                    break;
                }
            }
        });
    }

    // --- 輔助函式：掃描檔案與函式 ---

    private async findPythonFiles(dirPath?: string): Promise<{ name: string; path: string }[]> {
        let rootPath = dirPath;
        if (!rootPath) {
            rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        }
        if (!rootPath || !fs.existsSync(rootPath)) {
            return [];
        }

        const files: { name: string; path: string }[] = [];
        const ignoredDirs = new Set(['node_modules', 'venv', 'env', '.env', '.git', '__pycache__', '.pytest_cache']);

        const walkAsync = async (dir: string) => {
            let list: fs.Dirent[];
            try {
                list = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch (e) {
                return;
            }
            
            const tasks = list.map(async (dirent) => {
                const file = dirent.name;
                if (file.startsWith('.') && file !== '.py' && file.length > 1) return; // skip hidden folders
                if (ignoredDirs.has(file)) return;
                
                const fullPath = path.join(dir, file);
                try {
                    if (dirent.isDirectory()) {
                        await walkAsync(fullPath);
                    } else if (file.endsWith('.py')) {
                        files.push({ name: file, path: fullPath });
                    }
                } catch (e) {
                    // ignore
                }
            });
            await Promise.all(tasks);
        };

        try {
            await walkAsync(rootPath);
        } catch (e) {
            console.error('掃描專案檔案失敗', e);
        }
        return files;
    }

    private async findPythonFunctions(filePath: string): Promise<string[]> {
        if (!fs.existsSync(filePath)) {
            return [];
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const regex = /^def\s+([a-zA-Z0-9_]+)\s*\(/gm;
        let match: RegExpExecArray | null;
        const funcs: string[] = [];
        while ((match = regex.exec(content)) !== null) {
            funcs.push(match[1]);
        }
        return funcs;
    }

    private async fetchLocalModels(): Promise<string[]> {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1000);

            const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
            clearTimeout(timeoutId);

            const data = await res.json() as { models?: Array<{ name: string }> };
            return (data.models || []).map(m => m.name);
        } catch (e) {
            console.error('Ollama 讀取失敗', e);
            return ['Ollama連線失敗 (請確認已啟動)'];
        }
    }
}