import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewContent } from './webviewContent';
import { initI18n, t } from './i18n';

export class MutationViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mutation-test-view';
    public webview?: vscode.Webview;

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        initI18n();
        this.webview = webviewView.webview;
        this.webview.options = { enableScripts: true };

        const config = vscode.workspace.getConfiguration('llmUnitTest');
        const lang = config.get<string>('language', 'auto');
        const strategy = config.get<string>('promptStrategy', 'auto');
        const ollamaUrl = config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434');
        this.webview.html = getWebviewContent(t, lang, strategy, ollamaUrl);

        this.webview.onDidReceiveMessage(async (message) => {
            const config = vscode.workspace.getConfiguration('llmUnitTest');

            switch (message.command) {
                case 'getInitialData': {
                    const keys = config.get<Record<string, string>>('apiKeys', {});
                    this.webview?.postMessage({ command: 'setApiKeys', keys });

                    const customKeys = config.get<Record<string, any>>('customApiKeys', {});
                    this.webview?.postMessage({ command: 'setCustomKeys', keys: customKeys });

                    const savedProjPath = config.get<string>('projectPath', '');
                    const files = await this.findPythonFiles(savedProjPath);
                    const savedPath = config.get<string>('outputPath', '');

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

                case 'setLanguage': {
                    await config.update('language', message.lang, true);
                    initI18n();
                    if (this.webview) {
                        const strategy = config.get<string>('promptStrategy', 'auto');
                        this.webview.html = getWebviewContent(t, message.lang, strategy);
                    }
                    break;
                }
                
                case 'setPromptStrategy': {
                    await config.update('promptStrategy', message.strategy, true);
                    if (this.webview) {
                        const lang = config.get<string>('language', 'auto');
                        const ollamaUrl = config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434');
                        this.webview.html = getWebviewContent(t, lang, message.strategy, ollamaUrl);
                    }
                    break;
                }

                case 'saveOllamaUrl': {
                    await config.update('ollamaBaseUrl', message.url, true);
                    vscode.window.showInformationMessage(`✅ 已儲存 Ollama URL：${message.url}`);
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

                case 'browseBatchFolder': {
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: '選擇批次測試資料夾'
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const batchPath = fileUri[0].fsPath;
                        this.webview?.postMessage({ command: 'setBatchPath', path: batchPath });
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

                case 'updateCustomKey': {
                    const currentKeys = { ...config.get<Record<string, any>>('customApiKeys', {}) };
                    if (message.oldName && message.oldName !== message.newName) {
                        delete currentKeys[message.oldName];
                    }
                    currentKeys[message.newName] = { url: message.url, model: message.model, key: message.key };
                    await config.update('customApiKeys', currentKeys, true);
                    this.webview?.postMessage({ command: 'setCustomKeys', keys: currentKeys });
                    vscode.window.showInformationMessage(`✅ 已存檔自訂 API：${message.newName}`);
                    break;
                }

                case 'deleteCustomKey': {
                    const currentKeys = { ...config.get<Record<string, any>>('customApiKeys', {}) };
                    if (currentKeys[message.name]) {
                        delete currentKeys[message.name];
                        await config.update('customApiKeys', currentKeys, true);
                        this.webview?.postMessage({ command: 'setCustomKeys', keys: currentKeys });
                        vscode.window.showInformationMessage(`🗑️ 已刪除自訂 API：${message.name}`);
                    }
                    break;
                }

                case 'startAnalysis': {
                    vscode.commands.executeCommand('llm-unit-test.runCaptureAndTest', message);
                    break;
                }

                case 'startBatchAnalysis': {
                    vscode.commands.executeCommand('llm-unit-test.runBatchAnalysis', message);
                    break;
                }

                case 'testConnection': {
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "正在測試 API 連線...",
                        cancellable: false
                    }, async () => {
                        try {
                            const controller = new AbortController();
                            const timeoutId = setTimeout(() => controller.abort(), 5000);

                            if (message.envType === 'local') {
                                const config = vscode.workspace.getConfiguration('llmUnitTest');
                                const baseUrl = config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434');
                                const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal as any });
                                clearTimeout(timeoutId);
                                if (response.ok) vscode.window.showInformationMessage(`✅ Local Ollama 連線成功！`);
                                else throw new Error(`HTTP ${response.status}`);
                            } else if (message.envType === 'cloud') {
                                const config = vscode.workspace.getConfiguration('llmUnitTest');
                                const keys = config.get<Record<string, string>>('apiKeys', {});
                                const key = keys[message.modelName];
                                if (!key) {
                                    clearTimeout(timeoutId);
                                    throw new Error("找不到對應的 API Key");
                                }
                                
                                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
                                const response = await fetch(url, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
                                    signal: controller.signal as any
                                });
                                clearTimeout(timeoutId);
                                if (response.ok) vscode.window.showInformationMessage(`✅ Cloud Gemini 連線成功！`);
                                else throw new Error(`HTTP ${response.status} - ${await response.text()}`);
                            } else if (message.envType === 'custom') {
                                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                                if (message.customKey) headers['Authorization'] = `Bearer ${message.customKey}`;
                                
                                const response = await fetch(message.customUrl, {
                                    method: 'POST',
                                    headers: headers,
                                    body: JSON.stringify({
                                        model: message.modelName,
                                        messages: [{ role: 'user', content: 'hi' }]
                                    }),
                                    signal: controller.signal as any
                                });
                                clearTimeout(timeoutId);
                                if (response.ok) vscode.window.showInformationMessage(`✅ Custom API 連線成功！`);
                                else throw new Error(`HTTP ${response.status} - ${await response.text()}`);
                            }
                        } catch (error: any) {
                            vscode.window.showErrorMessage(`❌ 連線失敗: ${error.message}`);
                            this.webview?.postMessage({ command: 'appendLog', text: `[錯誤] 連線測試失敗: ${error.message}` });
                        }
                    });
                    break;
                }

                case 'abortTest': {
                    vscode.commands.executeCommand('llm-unit-test.abortTest');
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
                if (file.startsWith('.') && file !== '.py' && file.length > 1) {return;} // skip hidden folders
                if (ignoredDirs.has(file)) {return;}
                
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
            const config = vscode.workspace.getConfiguration('llmUnitTest');
            const baseUrl = config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434');
            const response = await fetch(`${baseUrl}/api/tags`);
            if (response.ok) {
                const data = await response.json() as any;
                if (data && data.models) {
                    return data.models.map((m: any) => m.name);
                }
            }
        } catch (e) {
            console.warn('Ollama not running or unreachable');
        }
        return [];
    }
}