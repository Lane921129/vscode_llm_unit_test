import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewContent } from './webviewContent';
import { initI18n, t } from './i18n';
import { extractFunctionsWithAst } from './utils';

export class MutationViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mutation-test-view';
    public webview?: vscode.Webview;

    constructor(private readonly secretStorage: vscode.SecretStorage) {}

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
                    const rawKeys = await this.secretStorage.get('llm_api_keys');
                    const keys: Record<string, string> = rawKeys ? JSON.parse(rawKeys) : {};
                    this.webview?.postMessage({ command: 'setApiKeys', keys });

                    const rawCustomKeys = await this.secretStorage.get('llm_custom_keys');
                    const customKeys: Record<string, any> = rawCustomKeys ? JSON.parse(rawCustomKeys) : {};
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
                    const existingProject = config.get<string>('projectPath', '');
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: '選擇專案資料夾',
                        defaultUri: existingProject ? vscode.Uri.file(existingProject) : undefined
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
                    const existingOutput = config.get<string>('outputPath', '');
                    const existingProject2 = config.get<string>('projectPath', '');
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: '選擇輸出資料夾',
                        defaultUri: existingOutput
                            ? vscode.Uri.file(existingOutput)
                            : existingProject2 ? vscode.Uri.file(existingProject2) : undefined
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
                    const existingProject3 = config.get<string>('projectPath', '');
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: '選擇批次測試資料夾',
                        defaultUri: existingProject3 ? vscode.Uri.file(existingProject3) : undefined
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
                    const rawKeys = await this.secretStorage.get('llm_api_keys');
                    const currentKeys: Record<string, string> = rawKeys ? JSON.parse(rawKeys) : {};
                    if (message.oldName && message.oldName !== message.newName) {
                        delete currentKeys[message.oldName];
                    }
                    currentKeys[message.newName] = message.key;
                    await this.secretStorage.store('llm_api_keys', JSON.stringify(currentKeys));
                    this.webview?.postMessage({ command: 'setApiKeys', keys: currentKeys });
                    vscode.window.showInformationMessage(`🔒 已安全儲存 API Key 至系統金鑰庫：${message.newName}`);
                    break;
                }

                case 'deleteApiKey': {
                    const rawKeys = await this.secretStorage.get('llm_api_keys');
                    const currentKeys: Record<string, string> = rawKeys ? JSON.parse(rawKeys) : {};
                    if (currentKeys[message.name]) {
                        delete currentKeys[message.name];
                        await this.secretStorage.store('llm_api_keys', JSON.stringify(currentKeys));
                        this.webview?.postMessage({ command: 'setApiKeys', keys: currentKeys });
                        vscode.window.showInformationMessage(`🗑️ 已自安全金鑰庫移除：${message.name}`);
                    }
                    break;
                }

                case 'updateCustomKey': {
                    const rawCustomKeys = await this.secretStorage.get('llm_custom_keys');
                    const currentKeys: Record<string, any> = rawCustomKeys ? JSON.parse(rawCustomKeys) : {};
                    if (message.oldName && message.oldName !== message.newName) {
                        delete currentKeys[message.oldName];
                    }
                    currentKeys[message.newName] = { url: message.url, model: message.model, key: message.key };
                    await this.secretStorage.store('llm_custom_keys', JSON.stringify(currentKeys));
                    this.webview?.postMessage({ command: 'setCustomKeys', keys: currentKeys });
                    vscode.window.showInformationMessage(`🔒 已安全儲存自訂 API：${message.newName}`);
                    break;
                }

                case 'deleteCustomKey': {
                    const rawCustomKeys = await this.secretStorage.get('llm_custom_keys');
                    const currentKeys: Record<string, any> = rawCustomKeys ? JSON.parse(rawCustomKeys) : {};
                    if (currentKeys[message.name]) {
                        delete currentKeys[message.name];
                        await this.secretStorage.store('llm_custom_keys', JSON.stringify(currentKeys));
                        this.webview?.postMessage({ command: 'setCustomKeys', keys: currentKeys });
                        vscode.window.showInformationMessage(`🗑️ 已自安全金鑰庫移除自訂 API：${message.name}`);
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
                                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                                // 🔍 Model Probe: 查詢模型詳細資訊
                                if (message.modelName) {
                                    try {
                                        const probeController = new AbortController();
                                        const probeTimeout = setTimeout(() => probeController.abort(), 10000);
                                        const showResponse = await fetch(`${baseUrl}/api/show`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ model: message.modelName }),
                                            signal: probeController.signal as any
                                        });
                                        clearTimeout(probeTimeout);

                                        if (showResponse.ok) {
                                            const modelData = await showResponse.json() as any;
                                            const paramSize: string = modelData?.details?.parameter_size ?? 'unknown';
                                            
                                            // 嘗試從 model_info 取得 context_length（key 不固定，需搜尋）
                                            let contextLength = 4096; // 預設值
                                            if (modelData?.model_info) {
                                                const infoKeys = Object.keys(modelData.model_info);
                                                const ctxKey = infoKeys.find(k => k.endsWith('.context_length'));
                                                if (ctxKey) {
                                                    contextLength = modelData.model_info[ctxKey];
                                                }
                                            }

                                            const profile = { paramSize, contextLength };
                                            // 傳送探針結果給 webview 顯示
                                            this.webview?.postMessage({ command: 'modelProbeResult', profile });
                                            // 同時傳給 extension 主程式
                                            vscode.commands.executeCommand('llm-unit-test.updateModelProfile', profile);
                                            vscode.window.showInformationMessage(
                                                `✅ Local Ollama 連線成功！模型：${paramSize}，最大 Context：${contextLength.toLocaleString()} tokens`
                                            );
                                        } else {
                                            vscode.window.showInformationMessage(`✅ Local Ollama 連線成功！`);
                                        }
                                    } catch {
                                        // 探針失敗不影響主流程
                                        vscode.window.showInformationMessage(`✅ Local Ollama 連線成功！`);
                                    }
                                } else {
                                    vscode.window.showInformationMessage(`✅ Local Ollama 連線成功！`);
                                }
                            } else if (message.envType === 'cloud') {
                                const rawKeys = await this.secretStorage.get('llm_api_keys');
                                const keys: Record<string, string> = rawKeys ? JSON.parse(rawKeys) : {};
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
                                if (response.ok) {
                                    // Cloud Gemini: 使用已知 context window 大小
                                    const profile = { paramSize: 'Cloud (Gemini)', contextLength: 1000000 };
                                    this.webview?.postMessage({ command: 'modelProbeResult', profile });
                                    vscode.commands.executeCommand('llm-unit-test.updateModelProfile', profile);
                                    vscode.window.showInformationMessage(`✅ Cloud Gemini 連線成功！Context：1M tokens`);
                                } else {
                                    throw new Error(`HTTP ${response.status} - ${await response.text()}`);
                                }
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
                                if (response.ok) {
                                    vscode.window.showInformationMessage(`✅ Custom API 連線成功！`);
                                } else {
                                    throw new Error(`HTTP ${response.status} - ${await response.text()}`);
                                }
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
        const infos = await extractFunctionsWithAst(filePath);
        return infos.map(f => f.fullName);
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