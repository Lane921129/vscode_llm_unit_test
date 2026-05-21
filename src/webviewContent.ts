export function getWebviewContent() {
    return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LLM 突變測試</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
        h3 { border-bottom: 1px solid var(--vscode-editorGroup-border); padding-bottom: 5px; }
        
        /* 摺疊面板樣式 */
        details {
            margin-bottom: 10px;
            border: 1px solid var(--vscode-editorGroup-border);
            border-radius: 4px;
            background-color: var(--vscode-editor-background);
        }
        summary {
            padding: 8px;
            cursor: pointer;
            font-weight: bold;
            background-color: var(--vscode-sideBarSectionHeader-background);
            user-select: none;
            outline: none;
        }
        summary:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .content {
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 5px;
        }

        label { margin-top: 5px; font-weight: 500; font-size: 13px; }
        input, select, textarea {
            width: 100%;
            padding: 5px;
            margin-top: 3px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            box-sizing: border-box;
            border-radius: 2px;
        }
        button {
            margin-top: 10px;
            padding: 6px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
            border-radius: 2px;
        }
        button:hover { background: var(--vscode-button-hoverBackground); }
        
        .flex-row {
            display: flex;
            gap: 5px;
            align-items: center;
            width: 100%;
        }
        
        /* 檔案覆蓋率表格 */
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 5px;
            font-size: 13px;
        }
        th, td {
            border: 1px solid var(--vscode-editorGroup-border);
            padding: 5px;
            text-align: left;
        }
        th {
            background-color: var(--vscode-sideBarSectionHeader-background);
        }
        .score-badge {
            background: #238636;
            color: white;
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: bold;
        }

        #log-area {
            height: 150px;
            resize: vertical;
            font-family: 'Consolas', monospace;
            font-size: 12px;
            white-space: pre-wrap;
        }
    </style>
</head>
<body>
    <h3>🧪 LLM 突變測試與修復</h3>
    
    <details open>
        <summary>🤖 模型與環境設定</summary>
        <div class="content">
            <label>執行環境</label>
            <select id="env-type">
                <option value="cloud">雲端 (Gemini API)</option>
                <option value="local">本地 (Ollama)</option>
                <option value="custom">自訂 (OpenAI 相容)</option>
            </select>
            
            <div id="cloud-ui">
                <label>選擇 API Key</label>
                <div class="flex-row">
                    <select id="api-key-select"><option value="">-- 載入中 --</option></select>
                </div>
                
                <div class="flex-row" style="margin-top: 5px;">
                    <input type="text" id="new-key-name" placeholder="標籤 (例: Gemini-Pro)">
                    <input type="password" id="new-key-value" placeholder="輸入 API Key">
                    <button id="btn-save-key" style="margin-top:0; width:60px; flex-shrink:0;">儲存</button>
                    <button id="btn-del-key" style="margin-top:0; width:40px; flex-shrink:0; background:#a82a2a;">刪除</button>
                </div>
            </div>

            <div id="local-ui" style="display:none;">
                <label>本地模型 (Ollama)</label>
                <select id="model-select"><option value="">-- 載入中 --</option></select>
                <button id="btn-refresh-models" style="width:100%;">🔄 重新整理模型</button>
            </div>

            <div id="custom-ui" style="display:none;">
                <label>選擇自訂 API 設定</label>
                <select id="custom-api-select"><option value="">-- 請選擇或新增 --</option></select>
                
                <label style="margin-top:5px;">標籤 (例: GPT-4o 或 實驗室 vLLM)</label>
                <input type="text" id="custom-name" placeholder="設定標籤名稱">
                
                <label>API Base URL</label>
                <input type="text" id="custom-url" placeholder="例: https://api.openai.com/v1/chat/completions">
                
                <label>模型名稱 (Model)</label>
                <input type="text" id="custom-model" placeholder="例: gpt-4o">
                
                <label>API Key (選填)</label>
                <input type="password" id="custom-key" placeholder="Bearer Token">
                
                <div class="flex-row">
                    <button id="btn-save-custom" style="flex:1;">💾 儲存</button>
                    <button id="btn-del-custom" style="flex:0.5; background:#a82a2a;">🗑️ 刪除</button>
                </div>
            </div>
        </div>
    </details>

    <details open>
        <summary>⚙️ 基礎設定</summary>
        <div class="content">
            <label>📂 測試專案資料夾</label>
            <div class="flex-row">
                <input type="text" id="project-path" readonly placeholder="請選擇專案目錄">
                <button id="btn-browse-proj" style="width:40px; flex-shrink:0;">...</button>
            </div>
            
            <label>📂 測試結果輸出資料夾</label>
            <div class="flex-row">
                <input type="text" id="output-path" readonly placeholder="預設與目標檔案同目錄">
                <button id="btn-browse-out" style="width:40px; flex-shrink:0;">...</button>
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
            
            <label>突變測試時間</label>
            <input type="number" id="mutpy-timeout" value="5" min="1" style="width:100%;">

            <label>超時限制 (秒)</label>
            <input type="number" id="timeout-sec" value="60" min="10" max="300" style="width:100%;">
            
            <div class="flex-row" style="margin-top:15px; justify-content:space-between; gap:10px;">
                <button id="btn-run" style="flex:1;">🚀 開始自動化突變測試</button>
                <button id="btn-abort" style="flex:1; background:#a82a2a; color:white; display:none;">🛑 中止測試</button>
            </div>
        </div>
    </details>

    <details open>
        <summary>📊 檔案覆蓋率與結果</summary>
        <div class="content">
            <label>📁 批次測試範圍</label>
            <div class="flex-row">
                <input type="text" id="batch-path" readonly placeholder="預設: 整個專案">
                <button id="btn-browse-batch" style="width:40px; flex-shrink:0;">...</button>
            </div>
            
            <button id="btn-batch-run" style="margin-top:10px; width:100%;">▶️ 執行批次自動化測試 (範圍內所有檔案)</button>

            <table id="coverage-table" style="margin-top:15px; width:100%; border-collapse:collapse; text-align:left;">
                <thead style="border-bottom:1px solid var(--vscode-editorGroup-border);"><tr>
                    <th style="padding:5px;">資料夾/檔案名稱</th>
                    <th style="padding:5px;">突變分數</th>
                    <th style="padding:5px;">狀態 / 原因</th>
                </tr></thead>
                <tbody><tr><td colspan="3" style="padding:10px; text-align:center; opacity:0.5;">尚無測試數據</td></tr></tbody>
            </table>
        </div>
    </details>

    <details>
        <summary>📝 系統日誌</summary>
        <div class="content">
            <textarea id="log-area" readonly placeholder="系統分析日誌將顯示於此..."></textarea>
            <button id="btn-clear-log" style="margin-top:5px;">清除日誌</button>
        </div>
    </details>

    <script>
        const vscode = acquireVsCodeApi();
        let currentKeys = {};

        let currentCustomKeys = {};

        // 載入初始資料
        vscode.postMessage({ command: 'getInitialData' });

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'setModels': document.getElementById('model-select').innerHTML = '<option value="">-- 選擇模型 --</option>' + msg.models.map(m => \`<option value="\${m}">\${m}</option>\`).join(''); break;
                case 'setApiKeys': currentKeys = msg.keys; const keys = Object.keys(msg.keys); document.getElementById('api-key-select').innerHTML = '<option value="">-- 選擇 Key --</option>' + keys.map(k => \`<option value="\${k}">\${k}</option>\`).join(''); break;
                case 'setFiles': document.getElementById('file-select').innerHTML = '<option value="">-- 選擇檔案 --</option>' + msg.files.map(f => \`<option value="\${f.path}">\${f.name}</option>\`).join(''); break;
                case 'setFunctions': document.getElementById('func-select').innerHTML = '<option value="">-- 一鍵測試全部 (此檔案) --</option>' + msg.funcs.map(f => \`<option value="\${f}">\${f}()</option>\`).join(''); break;
                case 'setProjectPath': document.getElementById('project-path').value = msg.path; if (!document.getElementById('batch-path').value) document.getElementById('batch-path').value = msg.path; break;
                case 'setBatchPath': document.getElementById('batch-path').value = msg.path; break;
                case 'setOutputPath': document.getElementById('output-path').value = msg.path; break;
                case 'appendLog': const log = document.getElementById('log-area'); log.value += (log.value ? '\\n' : '') + msg.text; log.scrollTop = log.scrollHeight; break;
                case 'updateCoverage':
                    const tbody = document.querySelector('#coverage-table tbody');
                    let existingRow = Array.from(tbody.querySelectorAll('tr')).find(row => row.cells[0]?.textContent === msg.fileName);
                    if (existingRow) { 
                        existingRow.cells[1].innerHTML = \`<span class="badge score-badge">\${msg.score}</span>\`; 
                        existingRow.cells[2].textContent = msg.reason || '';
                    } else { 
                        if (tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent.includes('尚無數據')) tbody.innerHTML = ''; 
                        const newRow = tbody.insertRow(); 
                        newRow.insertCell(0).textContent = msg.fileName; 
                        newRow.insertCell(1).innerHTML = \`<span class="badge score-badge">\${msg.score}</span>\`; 
                        newRow.insertCell(2).textContent = msg.reason || '';
                        Array.from(newRow.cells).forEach(c => c.style.padding = '5px');
                    }
                    break;
                case 'setCustomKeys':
                    currentCustomKeys = msg.keys;
                    const ckeys = Object.keys(msg.keys);
                    document.getElementById('custom-api-select').innerHTML = '<option value="">-- 請選擇或新增 --</option>' + ckeys.map(k => '<option value="' + k + '">' + k + '</option>').join('');
                    break;
                case 'analysisFinished':
                    const runBtn = document.getElementById('btn-run');
                    const batchRunBtn = document.getElementById('btn-batch-run');
                    if (runBtn) {
                        runBtn.disabled = false;
                        runBtn.innerText = '🚀 開始自動化突變測試';
                    }
                    if (batchRunBtn) {
                        batchRunBtn.disabled = false;
                        batchRunBtn.innerText = '▶️ 執行批次自動化測試 (範圍內所有檔案)';
                    }
                    const abortBtn = document.getElementById('btn-abort');
                    if (abortBtn) abortBtn.style.display = 'none';
                    break;
            }
        });

        document.getElementById('env-type').onchange = (e) => {
            const val = e.target.value;
            document.getElementById('local-ui').style.display = val === 'local' ? 'block' : 'none';
            document.getElementById('cloud-ui').style.display = val === 'cloud' ? 'block' : 'none';
            document.getElementById('custom-ui').style.display = val === 'custom' ? 'block' : 'none';
        };

        document.getElementById('btn-browse-proj').onclick = () => vscode.postMessage({ command: 'browseProjectFolder' });
        document.getElementById('btn-browse-out').onclick = () => vscode.postMessage({ command: 'browseFolder' });
        document.getElementById('btn-browse-batch').onclick = () => vscode.postMessage({ command: 'browseBatchFolder' });
        
        document.getElementById('file-select').onchange = (e) => { 
            if(e.target.value) vscode.postMessage({ command: 'getFunctions', filePath: e.target.value }); 
        };

        document.getElementById('btn-save-key').onclick = () => {
            const newName = document.getElementById('new-key-name').value;
            const newValue = document.getElementById('new-key-value').value;
            const oldName = document.getElementById('api-key-select').value;
            if (newName && newValue) vscode.postMessage({ command: 'updateApiKey', oldName, newName, key: newValue });
        };
        document.getElementById('btn-del-key').onclick = () => {
            const name = document.getElementById('api-key-select').value;
            if (name) vscode.postMessage({ command: 'deleteApiKey', name });
        };
        document.getElementById('api-key-select').onchange = (e) => {
            const name = e.target.value;
            document.getElementById('new-key-name').value = name || '';
            document.getElementById('new-key-value').value = currentKeys[name] || '';
        };

        document.getElementById('btn-refresh-models').onclick = () => vscode.postMessage({ command: 'getInitialData' });
        document.getElementById('btn-clear-log').onclick = () => document.getElementById('log-area').value = '';

        document.getElementById('custom-api-select').onchange = (e) => {
            const name = e.target.value;
            const data = currentCustomKeys[name] || {url: '', model: '', key: ''};
            document.getElementById('custom-name').value = name || '';
            document.getElementById('custom-url').value = data.url || '';
            document.getElementById('custom-model').value = data.model || '';
            document.getElementById('custom-key').value = data.key || '';
        };

        document.getElementById('btn-save-custom').onclick = () => {
            const newName = document.getElementById('custom-name').value;
            const url = document.getElementById('custom-url').value;
            const model = document.getElementById('custom-model').value;
            const key = document.getElementById('custom-key').value;
            const oldName = document.getElementById('custom-api-select').value;
            if (newName && url && model) vscode.postMessage({ command: 'updateCustomKey', oldName, newName, url, model, key });
        };

        document.getElementById('btn-del-custom').onclick = () => {
            const name = document.getElementById('custom-api-select').value;
            if (name) vscode.postMessage({ command: 'deleteCustomKey', name });
        };

        document.getElementById('btn-abort').onclick = () => vscode.postMessage({ command: 'abortTest' });
        
        const getStartParams = () => {
            const envType = document.getElementById('env-type').value;
            let modelName = '';
            if (envType === 'local') modelName = document.getElementById('model-select').value;
            else if (envType === 'cloud') modelName = document.getElementById('api-key-select').value;
            else if (envType === 'custom') modelName = document.getElementById('custom-model').value;

            return { envType, modelName };
        };

        document.getElementById('btn-run').onclick = () => {
            const { envType, modelName } = getStartParams();
            const filePath = document.getElementById('file-select').value;
            
            if(!envType || !modelName || !filePath) {
                vscode.postMessage({ command: 'appendLog', text: '[錯誤] 請確認環境、模型與目標檔案皆已填妥。' });
                return;
            }

            document.getElementById('btn-run').disabled = true;
            document.getElementById('btn-batch-run').disabled = true;
            document.getElementById('btn-run').innerText = '⏳ 測試進行中...';
            document.getElementById('btn-abort').style.display = 'block';

            vscode.postMessage({
                command: 'startAnalysis',
                envType, modelName, filePath,
                funcName: document.getElementById('func-select').value,
                maxLoops: parseInt(document.getElementById('max-loop').value),
                mutpyTimeout: parseInt(document.getElementById('mutpy-timeout').value),
                timeoutSeconds: parseInt(document.getElementById('timeout-sec').value),
                outputPath: document.getElementById('output-path').value,
                customUrl: document.getElementById('custom-url').value,
                customKey: document.getElementById('custom-key').value
            });
        };

        document.getElementById('btn-batch-run').onclick = () => {
            const { envType, modelName } = getStartParams();
            let batchPath = document.getElementById('batch-path').value || document.getElementById('project-path').value;
            
            if(!envType || !modelName || !batchPath) {
                vscode.postMessage({ command: 'appendLog', text: '[錯誤] 請確認環境、模型與批次測試資料夾皆已填妥。' });
                return;
            }

            document.getElementById('btn-run').disabled = true;
            document.getElementById('btn-batch-run').disabled = true;
            document.getElementById('btn-batch-run').innerText = '⏳ 批次測試進行中...';
            document.getElementById('btn-abort').style.display = 'block';

            vscode.postMessage({
                command: 'startBatchAnalysis',
                envType, modelName, batchPath,
                maxLoops: parseInt(document.getElementById('max-loop').value),
                mutpyTimeout: parseInt(document.getElementById('mutpy-timeout').value),
                timeoutSeconds: parseInt(document.getElementById('timeout-sec').value),
                outputPath: document.getElementById('output-path').value,
                customUrl: document.getElementById('custom-url').value,
                customKey: document.getElementById('custom-key').value
            });
        };
    </script>
</body>
</html>`;
}