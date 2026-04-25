import * as vscode from 'vscode';
import * as fs from 'fs';
import { getWebviewContent } from './webviewContent';

export class MutationViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mutation-test-view';
    public webview?: vscode.Webview;

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this.webview = webviewView.webview;
        this.webview.options = { enableScripts: true };

        // 直接調用外包的 HTML
        this.webview.html = getWebviewContent();

        this.webview.onDidReceiveMessage(async (message) => {
            const config = vscode.workspace.getConfiguration('llmUnitTest');

            switch (message.command) {
                case 'getInitialData': {
                    // 初始化流程：發送模型、API Keys、專案檔案
                    const models = await this.fetchLocalModels();
                    const keys = config.get<Record<string, string>>('apiKeys', {});
                    const files = await this.findPythonFiles();
                    const savedPath = config.get<string>('outputPath', '');
                    
                    this.webview?.postMessage({ command: 'setModels', models });
                    this.webview?.postMessage({ command: 'setApiKeys', keys });
                    this.webview?.postMessage({ command: 'setFiles', files });
                    if(savedPath) 
                        {this.webview?.postMessage({ command: 'setOutputPath', path: savedPath });}
                    break;
                }

                case 'browseFolder': {
                    // 使用大括號解決 Cannot redeclare block-scoped variable 'options'
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: '選擇輸出資料夾'
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const folderPath = fileUri[0].fsPath;
                        config.update('outputPath', folderPath, true);
                        this.webview?.postMessage({ command: 'setOutputPath', path: folderPath });
                    }
                    break;
                }

                case 'getFunctions': {
                    const funcs = await this.findPythonFunctions(message.filePath);
                    this.webview?.postMessage({ command: 'setFunctions', funcs });
                    break;
                }

                case 'updateApiKey': {
                    const config = vscode.workspace.getConfiguration('llmUnitTest');
                    // 使用解構賦值複製一份，避免引用問題
                    let currentKeys = { ...config.get<Record<string, string>>('apiKeys', {}) };

                    // 處理更新（改名邏輯）
                    if (message.oldName && message.oldName !== message.newName) {
                        delete currentKeys[message.oldName];
                    }
                    currentKeys[message.newName] = message.key;
                    
                    // 強制更新設定
                    await config.update('apiKeys', currentKeys, true);
                    
                    // 💡 關鍵：存完後立刻主動把最新清單「推回」前端，不要等前端來要
                    this.webview?.postMessage({ command: 'setApiKeys', keys: currentKeys });
                    vscode.window.showInformationMessage(`✅ 已存檔：${message.newName}`);
                    break;
                }

                case 'deleteApiKey': {
                    const config = vscode.workspace.getConfiguration('llmUnitTest');
                    let currentKeys = { ...config.get<Record<string, string>>('apiKeys', {}) };

                    if (currentKeys[message.name]) {
                        delete currentKeys[message.name];
                        await config.update('apiKeys', currentKeys, true);
                        
                        // 同樣要主動推回最新狀態
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
    private async findPythonFiles(): Promise<{name: string, path: string}[]> {
        const uris = await vscode.workspace.findFiles('**/*.py', '**/node_modules/**');
        return uris.map(uri => ({
            name: vscode.workspace.asRelativePath(uri),
            path: uri.fsPath
        }));
    }

    private async findPythonFunctions(filePath: string): Promise<string[]> {
        if (!fs.existsSync(filePath)){ return [];}
        const content = fs.readFileSync(filePath, 'utf-8');
        // 用 Regex 簡單抓取 Python 的 def 函式名稱
        const regex = /^def\s+([a-zA-Z0-9_]+)\s*\(/gm;
        let match;
        const funcs = [];
        while ((match = regex.exec(content)) !== null) {
            funcs.push(match[1]);
        }
        return funcs;
    }

    private async fetchLocalModels() {
    try {
        // 增加一個超時處理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
        clearTimeout(timeoutId);

        const data = await res.json() as any;
        // 如果 data.models 存在，就回傳，否則回傳空陣列
        return (data.models || []).map((m: any) => m.name);
    } catch (e) {
        console.error('Ollama 讀取失敗', e);
        return ['Ollama連線失敗 (請確認已啟動)'];
    }
}

    
}