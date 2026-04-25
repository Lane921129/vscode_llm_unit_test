export function getWebviewContent() {
    return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
        details { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 8px; background: var(--vscode-sideBar-background); }
        summary { padding: 8px; cursor: pointer; font-weight: bold; font-size: 12px; outline: none; }
        .content { padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
        select, input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 5px; margin-top: 4px; }
        .flex-row { display: flex; gap: 4px; margin-top: 6px; }
        button { width: 100%; cursor: pointer; padding: 10px; border: none; border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: bold; }
        #log-area { width: 100%; height: 180px; background: #1e1e1e; color: #4af626; font-family: monospace; font-size: 11px; padding: 8px; margin-top: 5px; resize: vertical; border: 1px solid var(--vscode-panel-border); }
        table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 5px; }
        th, td { text-align: left; padding: 4px; border-bottom: 1px solid var(--vscode-panel-border); }
    </style>
</head>
<body>
    <details open>
        <summary>⚙️ 基礎與路徑設定</summary>
        <div class="content">
            <label>模型環境</label>
            <select id="env-type"><option value="local">🖥️ 本地 Ollama</option><option value="cloud">☁️ 雲端 API</option></select>
            <div id="local-ui" style="margin-top:8px;"><label>本地模型：</label><select id="model-select"><option>讀取中...</option></select></div>
            <div id="cloud-ui" style="display:none; margin-top:8px;">
                <label>API Key：</label>
                <div class="flex-row"><select id="api-key-select"><option value="">-- 選擇 Key --</option></select><button id="btn-del-key" style="background:#a82a2a; width:40px;">🗑️</button></div>
                <button id="btn-edit-key" style="margin-top:5px; background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);">➕ 新增 / ✏️ 編輯</button>
            </div>
            <label style="margin-top:10px;">📂 輸出資料夾</label>
            <div class="flex-row"><input type="text" id="output-path" readonly><button id="btn-browse" style="width:40px;">...</button></div>
        </div>
    </details>

    <details open>
        <summary>🎯 測試目標</summary>
        <div class="content">
            <label>選擇檔案</label><select id="file-select"><option value="">-- 選擇檔案 --</option></select>
            <label>選擇函式</label><select id="func-select"><option value="">-- 測試整份檔案 --</option></select>
            <label style="margin-top:8px;">最大循環次數</label><input type="number" id="max-loop" value="3" min="1">
        </div>
    </details>

    <details>
        <summary>📊 檔案覆蓋率 explorer</summary>
        <div class="content">
            <table id="coverage-table"><thead><tr><th>檔案</th><th>覆蓋率</th></tr></thead><tbody><tr><td colspan="2" style="text-align:center; opacity:0.5;">尚無數據</td></tr></tbody></table>
        </div>
    </details>

    <button id="start-test" style="margin-top:10px;">🚀 執行自動化測試循環</button>

    <details>
        <summary>📝 系統日誌</summary>
        <div class="content"><textarea id="log-area" readonly></textarea></div>
    </details>

    <script>
        const vscode = acquireVsCodeApi();
        let currentKeys = {};
        let editingOldName = null; // 修正：只宣告一次

        window.onload = () => { vscode.postMessage({ command: 'getInitialData' }); };

        window.addEventListener('message', event => {
            const msg = event.data;
            switch(msg.command) {
                case 'setModels': document.getElementById('model-select').innerHTML = msg.models.map(m => \`<option value="\${m}">\${m}</option>\`).join(''); break;
                case 'setApiKeys':
                    currentKeys = msg.keys;
                    const keys = Object.keys(msg.keys);
                    document.getElementById('api-key-select').innerHTML = '<option value="">-- 選擇 Key --</option>' + keys.map(k => \`<option value="\${k}">\${k}</option>\`).join('');
                    break;
                case 'setFiles': document.getElementById('file-select').innerHTML = '<option value="">-- 選擇檔案 --</option>' + msg.files.map(f => \`<option value="\${f.path}">\${f.name}</option>\`).join(''); break;
                case 'setFunctions': document.getElementById('func-select').innerHTML = '<option value="">-- 測試整份檔案 --</option>' + msg.funcs.map(f => \`<option value="\${f}">\${f}()</option>\`).join(''); break;
                case 'setOutputPath': document.getElementById('output-path').value = msg.path; break;
                case 'appendLog':
                    const log = document.getElementById('log-area');
                    log.value += '\\n' + msg.text;
                    log.scrollTop = log.scrollHeight;
                    break;
            }
        });

        document.getElementById('env-type').onchange = (e) => {
            const isLocal = e.target.value === 'local';
            document.getElementById('local-ui').style.display = isLocal ? 'block' : 'none';
            document.getElementById('cloud-ui').style.display = isLocal ? 'none' : 'block';
        };

        document.getElementById('btn-browse').onclick = () => vscode.postMessage({ command: 'browseFolder' });
        document.getElementById('file-select').onchange = (e) => { if(e.target.value) vscode.postMessage({ command: 'getFunctions', filePath: e.target.value }); };
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
    </script>
</body>
</html>`;
}