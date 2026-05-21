export function getWebviewContent() {
    return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <style>
        :root {
            --primary: #007acc;
            --primary-hover: #0062a3;
            --bg-card: #252526;
            --border-color: #3c3c3c;
            --text-muted: #cccccc;
            --success: #4af626;
        }
        body { 
            font-family: var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif); 
            padding: 12px; 
            color: var(--vscode-foreground, #cccccc);
            background-color: var(--vscode-sideBar-background, #1e1e1e);
            margin: 0;
            line-height: 1.4;
        }
        details { 
            border: 1px solid var(--border-color); 
            border-radius: 6px; 
            margin-bottom: 12px; 
            background: var(--bg-card); 
            box-shadow: 0 4px 6px rgba(0,0,0,0.15);
            overflow: hidden;
            transition: border-color 0.2s;
        }
        details:hover {
            border-color: var(--primary);
        }
        summary { 
            padding: 10px 12px; 
            cursor: pointer; 
            font-weight: 600; 
            font-size: 13px; 
            outline: none; 
            background: rgba(255,255,255,0.02);
            user-select: none;
        }
        .content { 
            padding: 12px; 
            border-top: 1px solid var(--border-color); 
            background: var(--vscode-sideBar-background);
        }
        label {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-muted);
            font-weight: bold;
            display: block;
            margin-top: 8px;
        }
        select, input { 
            width: 100%; 
            box-sizing: border-box; 
            background: var(--vscode-input-background, #2c2c2c); 
            color: var(--vscode-input-foreground, #cccccc); 
            border: 1px solid var(--vscode-input-border, #3c3c3c); 
            border-radius: 4px;
            padding: 8px; 
            margin-top: 6px; 
            font-size: 12px;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        select:focus, input:focus {
            border-color: var(--primary);
            outline: none;
            box-shadow: 0 0 4px rgba(0, 122, 204, 0.4);
        }
        .flex-row { 
            display: flex; 
            gap: 6px; 
            margin-top: 8px; 
        }
        button { 
            cursor: pointer; 
            padding: 8px 12px; 
            border: none; 
            border-radius: 4px; 
            background: var(--vscode-button-background, #007acc); 
            color: var(--vscode-button-foreground, #ffffff); 
            font-weight: 600; 
            font-size: 12px;
            transition: background-color 0.2s, transform 0.1s;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground, #0062a3);
        }
        button:active {
            transform: scale(0.98);
        }
        #log-area { 
            width: 100%; 
            height: 200px; 
            background: #141414; 
            color: var(--success); 
            font-family: 'Consolas', 'Courier New', monospace; 
            font-size: 11px; 
            padding: 10px; 
            margin-top: 6px; 
            resize: vertical; 
            border: 1px solid var(--border-color); 
            border-radius: 4px;
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.5);
            line-height: 1.5;
        }
        table { 
            width: 100%; 
            border-collapse: collapse; 
            font-size: 12px; 
            margin-top: 8px; 
        }
        th {
            background: rgba(255,255,255,0.03);
            font-weight: 600;
            color: var(--text-muted);
            border-bottom: 2px solid var(--border-color);
        }
        th, td { 
            text-align: left; 
            padding: 8px 10px; 
            border-bottom: 1px solid var(--border-color); 
        }
        tr:hover {
            background: rgba(255,255,255,0.01);
        }
        .badge {
            display: inline-block;
            padding: 2px 6px;
            font-size: 10px;
            font-weight: bold;
            border-radius: 10px;
            text-align: center;
        }
        .score-badge {
            background: rgba(74, 246, 38, 0.15);
            color: var(--success);
            border: 1px solid rgba(74, 246, 38, 0.3);
        }
        /* Modal dialog styling */
        .modal {
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(4px);
        }
        .modal-content {
            background-color: var(--bg-card);
            padding: 20px;
            border: 1px solid var(--border-color);
            border-radius: 8px;
            width: 85%;
            max-width: 300px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.4);
            animation: modalFadeIn 0.2s ease-out;
        }
        @keyframes modalFadeIn {
            from { opacity: 0; transform: scale(0.95); }
            to { opacity: 1; transform: scale(1); }
        }
    </style>
</head>
<body>
    <details open>
        <summary>⚙️ 基礎與路徑設定</summary>
        <div class="content">
            <label>模型環境</label>
            <select id="env-type"><option value="local">🖥️ 本地 Ollama</option><option value="cloud">☁️ 雲端 API</option></select>
            
            <div id="local-ui" style="margin-top:8px;">
                <label>本地模型：</label>
                <select id="model-select"><option>讀取中...</option></select>
            </div>
            
            <div id="cloud-ui" style="display:none; margin-top:8px;">
                <label>API Key：</label>
                <div class="flex-row">
                    <select id="api-key-select"><option value="">-- 選擇 Key --</option></select>
                    <button id="btn-del-key" style="background:#a82a2a; flex-shrink:0; width:40px;">🗑️</button>
                </div>
                <button id="btn-edit-key" style="margin-top:8px; width:100%; background:var(--vscode-button-secondaryBackground, #3a3d3e); color:var(--vscode-button-secondaryForeground, #ffffff);">➕ 新增 / ✏️ 編輯密鑰</button>
            </div>
            
            <label style="margin-top:10px;">📂 輸出資料夾</label>
            <div class="flex-row">
                <input type="text" id="output-path" readonly placeholder="預設與目標檔案同目錄">
                <button id="btn-browse" style="width:40px; flex-shrink:0;">...</button>
            </div>
        </div>
    </details>

    <details open>
        <summary>🎯 測試目標</summary>
        <div class="content">
            <label>選擇檔案</label>
            <select id="file-select"><option value="">-- 選擇檔案 --</option></select>
            
            <label style="margin-top:8px;">選擇函式</label>
            <select id="func-select"><option value="">-- 測試整份檔案 --</option></select>
            
            <label style="margin-top:8px;">最大循環次數</label>
            <input type="number" id="max-loop" value="3" min="1">
            
            <label style="margin-top:8px;">單次執行超時限制 (秒)</label>
            <input type="number" id="timeout-sec" value="60" min="10">
        </div>
    </details>

    <details open>
        <summary>📊 檔案覆蓋率 explorer</summary>
        <div class="content">
            <table id="coverage-table">
                <thead>
                    <tr>
                        <th>檔案</th>
                        <th>突變分數</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td colspan="2" style="text-align:center; opacity:0.5; font-style:italic;">尚無數據</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </details>

    <button id="start-test" style="margin-top:10px; width:100%; font-size:13px; padding:10px 0;">🚀 執行自動化測試循環</button>

    <details>
        <summary>📝 系統日誌</summary>
        <div class="content">
            <textarea id="log-area" readonly placeholder="系統分析日誌將顯示於此..."></textarea>
        </div>
    </details>

    <!-- Modal for API Keys -->
    <div id="key-modal" class="modal" style="display:none;">
        <div class="modal-content">
            <h3 style="margin-top:0; font-size:15px; border-bottom:1px solid var(--border-color); padding-bottom:8px;">🔑 密鑰管理</h3>
            <label>模型名稱 (如 gemini-2.0-flash)</label>
            <input type="text" id="modal-model-name" placeholder="請輸入模型代號">
            <label style="margin-top:10px; display:block;">API Key</label>
            <input type="password" id="modal-api-key" placeholder="請輸入 API 金鑰">
            <div class="flex-row" style="margin-top:16px; justify-content: flex-end;">
                <button id="modal-cancel" style="background:var(--vscode-button-secondaryBackground, #3a3d3e); color:var(--vscode-button-secondaryForeground, #ffffff);">取消</button>
                <button id="modal-save" style="background:var(--vscode-button-background, #007acc);">💾 儲存</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentKeys = {};

        window.onload = () => { 
            vscode.postMessage({ command: 'getInitialData' }); 
        };

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
                    log.value += (log.value ? '\\n' : '') + msg.text;
                    log.scrollTop = log.scrollHeight;
                    break;
                case 'updateCoverage':
                    const tbody = document.querySelector('#coverage-table tbody');
                    let existingRow = Array.from(tbody.querySelectorAll('tr')).find(row => row.cells[0]?.textContent === msg.fileName);
                    if (existingRow) {
                        existingRow.cells[1].innerHTML = \`<span class="badge score-badge">\${msg.score}</span>\`;
                    } else {
                        if (tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent.includes('尚無數據')) {
                            tbody.innerHTML = '';
                        }
                        const newRow = tbody.insertRow();
                        const cellFile = newRow.insertCell(0);
                        const cellScore = newRow.insertCell(1);
                        cellFile.textContent = msg.fileName;
                        cellScore.innerHTML = \`<span class="badge score-badge">\${msg.score}</span>\`;
                    }
                    break;
            }
        });

        document.getElementById('env-type').onchange = (e) => {
            const isLocal = e.target.value === 'local';
            document.getElementById('local-ui').style.display = isLocal ? 'block' : 'none';
            document.getElementById('cloud-ui').style.display = isLocal ? 'none' : 'block';
        };

        document.getElementById('btn-browse').onclick = () => vscode.postMessage({ command: 'browseFolder' });
        
        document.getElementById('file-select').onchange = (e) => { 
            if(e.target.value) {
                vscode.postMessage({ command: 'getFunctions', filePath: e.target.value }); 
            } else {
                document.getElementById('func-select').innerHTML = '<option value="">-- 測試整份檔案 --</option>';
            }
        };

        // --- 密鑰管理按鈕與 Modal 邏輯 ---
        const modal = document.getElementById('key-modal');
        const modalModel = document.getElementById('modal-model-name');
        const modalKey = document.getElementById('modal-api-key');
        let editingOldName = null;

        document.getElementById('btn-edit-key').onclick = () => {
            const select = document.getElementById('api-key-select');
            const selectedVal = select.value;
            if (selectedVal) {
                editingOldName = selectedVal;
                modalModel.value = selectedVal;
                modalKey.value = currentKeys[selectedVal] || '';
            } else {
                editingOldName = null;
                modalModel.value = '';
                modalKey.value = '';
            }
            modal.style.display = 'flex';
        };

        document.getElementById('btn-del-key').onclick = () => {
            const select = document.getElementById('api-key-select');
            const selectedVal = select.value;
            if (selectedVal) {
                if (confirm(\`確定要刪除 \${selectedVal} 的密鑰嗎？\`)) {
                    vscode.postMessage({ command: 'deleteApiKey', name: selectedVal });
                }
            } else {
                alert('請先選擇要刪除的密鑰！');
            }
        };

        document.getElementById('modal-cancel').onclick = () => {
            modal.style.display = 'none';
        };

        document.getElementById('modal-save').onclick = () => {
            const modelName = modalModel.value.trim();
            const apiKey = modalKey.value.trim();
            if (!modelName || !apiKey) {
                alert('請填寫模型名稱與密鑰內容！');
                return;
            }
            vscode.postMessage({
                command: 'updateApiKey',
                oldName: editingOldName,
                newName: modelName,
                key: apiKey
            });
            modal.style.display = 'none';
        };

        // 點擊 Modal 外部亦可取消
        window.onclick = (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        };

        document.getElementById('start-test').onclick = () => {
            const fileSelect = document.getElementById('file-select');
            if (!fileSelect.value) {
                alert('請先選擇目標 Python 檔案！');
                return;
            }
            vscode.postMessage({
                command: 'startAnalysis',
                envType: document.getElementById('env-type').value,
                modelName: document.getElementById('env-type').value === 'local' ? document.getElementById('model-select').value : document.getElementById('api-key-select').value,
                filePath: fileSelect.value,
                funcName: document.getElementById('func-select').value,
                maxLoops: parseInt(document.getElementById('max-loop').value),
                timeoutSeconds: parseInt(document.getElementById('timeout-sec').value),
                outputPath: document.getElementById('output-path').value
            });
        };
    </script>
</body>
</html>
`;
}