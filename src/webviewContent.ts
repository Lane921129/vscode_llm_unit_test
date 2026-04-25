export function getWebviewContent() {
    return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <style>
        /* ... 你的 CSS 保持不變 ... */
        body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
        details { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 8px; background: var(--vscode-sideBar-background); }
        summary { padding: 8px; cursor: pointer; font-weight: bold; font-size: 12px; outline: none; }
        .content { padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
        select, input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 5px; margin-top: 4px; }
        .flex-row { display: flex; gap: 4px; margin-top: 6px; }
        button { cursor: pointer; padding: 6px; border: none; border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        #log-area { width: 100%; height: 180px; background: #1e1e1e; color: #4af626; font-family: monospace; font-size: 11px; padding: 8px; margin-top: 5px; resize: vertical; border: 1px solid var(--vscode-panel-border); }
    </style>
</head>
<body>
    <details open>
        <summary>⚙️ 基礎與路徑設定</summary>
        <div class="content">
            <label>模型環境</label>
            <select id="env-type">
                <option value="local">🖥️ 本地 Ollama</option>
                <option value="cloud">☁️ 雲端 API</option>
            </select>
            
            <div id="local-ui" style="margin-top:8px;">
                <label>本地模型：</label>
                <select id="model-select"><option>讀取中...</option></select>
            </div>

            <div id="cloud-ui" style="display:none; margin-top:8px;">
                <label>API Key 管理：</label>
                <div class="flex-row">
                    <select id="api-key-select"><option value="">-- 選擇 Key --</option></select>
                    <button id="btn-del-key" style="background:#a82a2a; color:white;">🗑️</button>
                </div>
                <button id="btn-edit-key" style="width:100%; margin-top:5px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);">➕ 新增 / ✏️ 編輯</button>
                
                <div id="api-edit-area" style="display:none; margin-top:8px; border:1px dashed #555; padding:8px;">
                    <label id="edit-title">新增 API Key</label>
                    <input type="text" id="api-name" placeholder="名稱 (例: Gemini)">
                    <input type="password" id="api-val" placeholder="API Key">
                    <div class="flex-row">
                        <button id="btn-save-key" style="flex:2">確定</button>
                        <button id="btn-cancel-key" style="flex:1">取消</button>
                    </div>
                </div>
            </div>

            <label style="margin-top:10px;">📂 輸出資料夾</label>
            <div class="flex-row">
                <input type="text" id="output-path" readonly placeholder="請選擇路徑">
                <button id="btn-browse">...</button>
            </div>
        </div>
    </details>

    <button id="start-test" style="width:100%; padding:12px; font-weight:bold; margin-top:10px; background: var(--vscode-button-background); color: white; border:none;">
        🚀 執行自動化測試循環
    </button>

    <details>
        <summary>📝 系統日誌</summary>
        <div class="content"><textarea id="log-area" readonly></textarea></div>
    </details>

    <script>
        const vscode = acquireVsCodeApi();
        let currentKeys = {};
        let editingOldName = null; // 只保留一個宣告

        // 接收訊息
        window.addEventListener('message', event => {
            const msg = event.data;
            switch(msg.command) {
                case 'setModels':
                    document.getElementById('model-select').innerHTML = msg.models.map(m => \`<option value="\${m}">\${m}</option>\`).join('');
                    break;
                case 'setApiKeys':
                    currentKeys = msg.keys;
                    const keys = Object.keys(msg.keys);
                    document.getElementById('api-key-select').innerHTML = '<option value="">-- 選擇 Key --</option>' + keys.map(k => \`<option value="\${k}">\${k}</option>\`).join('');
                    document.getElementById('api-edit-area').style.display = 'none';
                    break;
                case 'setFiles':
                    document.getElementById('file-select').innerHTML = '<option value="">-- 選擇檔案 --</option>' + msg.files.map(f => \`<option value="\${f.path}">\${f.name}</option>\`).join('');
                    break;
                case 'setFunctions':
                    document.getElementById('func-select').innerHTML = '<option value="">-- 測試整份檔案 --</option>' + msg.funcs.map(f => \`<option value="\${f}">\${f}()</option>\`).join('');
                    break;
                case 'setOutputPath':
                    document.getElementById('output-path').value = msg.path;
                    break;
                case 'appendLog':
                    const log = document.getElementById('log-area');
                    log.value += '\\n' + msg.text;
                    log.scrollTop = log.scrollHeight;
                    break;
            }
        });

        // UI 切換邏輯 (本地/雲端)
        document.getElementById('env-type').onchange = (e) => {
            const isLocal = e.target.value === 'local';
            document.getElementById('local-ui').style.display = isLocal ? 'block' : 'none';
            document.getElementById('cloud-ui').style.display = isLocal ? 'none' : 'block';
        };

        // 按鈕點擊發送
        document.getElementById('btn-browse').onclick = () => vscode.postMessage({ command: 'browseFolder' });
        
        document.getElementById('file-select').onchange = (e) => {
            if(e.target.value) vscode.postMessage({ command: 'getFunctions', filePath: e.target.value });
        };

        document.getElementById('btn-edit-key').onclick = () => {
            const sel = document.getElementById('api-key-select').value;
            const area = document.getElementById('api-edit-area');
            area.style.display = 'block';
            if(sel) {
                editingOldName = sel;
                document.getElementById('api-name').value = sel;
                document.getElementById('edit-title').innerText = '✏️ 更新 API Key';
            } else {
                editingOldName = null;
                document.getElementById('api-name').value = '';
                document.getElementById('edit-title').innerText = '➕ 新增 API Key';
            }
        };

        document.getElementById('btn-save-key').onclick = () => {
            const newName = document.getElementById('api-name').value.trim();
            const key = document.getElementById('api-val').value.trim();
            if(newName && key) vscode.postMessage({ command: 'updateApiKey', oldName: editingOldName, newName: newName, key: key });
        };

        document.getElementById('btn-del-key').onclick = () => {
            const name = document.getElementById('api-key-select').value;
            if(name && confirm(\`確定要刪除 \${name} 嗎？\`)) vscode.postMessage({ command: 'deleteApiKey', name: name });
        };

        document.getElementById('btn-cancel-key').onclick = () => document.getElementById('api-edit-area').style.display = 'none';

        document.getElementById('start-test').onclick = () => {
            vscode.postMessage({
                command: 'startAnalysis',
                envType: document.getElementById('env-type').value,
                modelName: document.getElementById('env-type').value === 'local' ? document.getElementById('model-select').value : document.getElementById('api-key-select').value,
                filePath: document.getElementById('file-select').value,
                funcName: document.getElementById('func-select').value,
                maxLoops: parseInt(document.getElementById('max-loop').value),
                outputPath: document.getElementById('output-path').value
            });
        };

        window.onload = () => { vscode.postMessage({ command: 'getInitialData' }); };
    </script>
</body>
</html>`;
}