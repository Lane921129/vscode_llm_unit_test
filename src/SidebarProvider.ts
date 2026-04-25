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

    private _getHtmlForWebview() {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
                    /* 摺疊標籤樣式 */
                    details { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 10px; background: var(--vscode-sideBar-background); }
                    summary { padding: 10px; cursor: pointer; font-weight: bold; font-size: 12px; outline: none; }
                    summary:hover { background: var(--vscode-list-hoverBackground); }
                    .content { padding: 10px; border-top: 1px solid var(--vscode-panel-border); }
                    
                    /* 表格樣式 (用於顯示覆蓋率) */
                    table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 5px; }
                    th, td { text-align: left; padding: 4px; border-bottom: 1px solid var(--vscode-panel-border); }
                    .progress-bar { height: 4px; background: #333; border-radius: 2px; margin-top: 2px; }
                    .progress-fill { height: 100%; background: #4af626; }
                    
                    /* 輸入與按鈕 */
                    input, select, button { width: 100%; box-sizing: border-box; margin-top: 5px; }
                    .path-box { display: flex; gap: 5px; }
                    .btn-small { flex: 0 0 auto; width: auto; padding: 2px 8px; }
                </style>
            </head>
            <body>
                <details open>
                    <summary>⚙️ 基礎設定</summary>
                    <div class="content">
                        <label>模型環境</label>
                        <select id="env-type"><option value="local">本地 Ollama</option><option value="cloud">雲端 API</option></select>
                        <div id="local-ui"><select id="model-select"></select></div>
                        
                        <label style="margin-top:10px; display:block;">輸出路徑</label>
                        <div class="path-box">
                            <input type="text" id="output-path" readonly placeholder="請選擇輸出資料夾">
                            <button id="btn-browse" class="btn-small">...</button>
                        </div>
                    </div>
                </details>

                <details>
                    <summary>🎯 測試目標與策略</summary>
                    <div class="content">
                        <select id="file-select"><option value="">-- 選擇檔案 --</option></select>
                        <select id="func-select"><option value="">-- 測試整份檔案 --</option></select>
                        <label style="margin-top:10px; display:block;">最大循環次數</label>
                        <input type="number" id="max-loop" value="3">
                    </div>
                </details>

                <details open>
                    <summary>📊 檔案覆蓋率 explorer</summary>
                    <div class="content">
                        <table id="coverage-table">
                            <thead><tr><th>檔案</th><th>覆蓋率</th></tr></thead>
                            <tbody>
                                <tr>
                                    <td>main.py</td>
                                    <td>
                                        85%
                                        <div class="progress-bar"><div class="progress-fill" style="width: 85%;"></div></div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </details>

                <button id="start-test" style="background: var(--vscode-button-background); color: white; padding: 10px; font-weight: bold; border: none; margin-top: 10px; cursor: pointer;">
                    🚀 執行自動化測試
                </button>

                <details>
                    <summary>📝 系統日誌</summary>
                    <div class="content">
                        <textarea id="log-area" style="width:100%; height:200px; background:#1e1e1e; color:#4af626; font-size:10px;" readonly></textarea>
                    </div>
                </details>

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    // 點擊瀏覽資料夾
                    document.getElementById('btn-browse').onclick = () => {
                        vscode.postMessage({ command: 'browseFolder' });
                    };

                    // 接收大腦更新路徑或覆蓋率
                    window.addEventListener('message', event => {
                        const msg = event.data;
                        if (msg.command === 'setOutputPath') {
                            document.getElementById('output-path').value = msg.path;
                        } else if (msg.command === 'updateCoverage') {
                            // 這裡可以寫一段 JS 把表格 tbody 重新渲染
                        }
                    });

                    // (其餘 startAnalysis 等指令保持不變...)
                </script>
            </body>
            </html>
        `;
    }
}