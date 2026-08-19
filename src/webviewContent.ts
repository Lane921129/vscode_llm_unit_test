export function getWebviewContent(t: (key: string, ...args: any[]) => string, currentLang: string = 'auto', currentStrategy: string = 'auto', ollamaBaseUrl: string = 'http://127.0.0.1:11434') {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('ui.title')}</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
        h3 { border-bottom: 1px solid var(--vscode-editorGroup-border); padding-bottom: 5px; }
        
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
            height: 300px;
            resize: vertical;
            font-family: 'Consolas', monospace;
            font-size: 12px;
            white-space: pre-wrap;
        }
    </style>
</head>
<body>
    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-editorGroup-border); padding-bottom: 5px; margin-bottom: 10px;">
        <h3 style="border: none; margin: 0; padding: 0;">${t('ui.title')}</h3>
        <select id="lang-select" style="width: auto; padding: 2px 5px; margin: 0; font-size: 11px;">
            <option value="auto" ${currentLang === 'auto' ? 'selected' : ''}>Auto (VS Code)</option>
            <option value="zh-tw" ${currentLang === 'zh-tw' ? 'selected' : ''}>繁體中文</option>
            <option value="en" ${currentLang === 'en' ? 'selected' : ''}>English</option>
        </select>
    </div>
    
    <details open>
        <summary>${t('ui.modelSettings')}</summary>
        <div class="content">
            <label>${t('ui.env')}</label>
            <select id="env-type">
                <option value="cloud">${t('ui.envCloud')}</option>
                <option value="local">${t('ui.envLocal')}</option>
                <option value="custom">${t('ui.envCustom')}</option>
            </select>
            
            <div id="cloud-ui">
                <label>${t('ui.apiKey')}</label>
                <div class="flex-row">
                    <select id="api-key-select"><option value="">-- Loading --</option></select>
                </div>
                
                <div class="flex-row" style="margin-top: 5px;">
                    <input type="text" id="new-key-name" placeholder="Label">
                    <input type="password" id="new-key-value" placeholder="Key">
                    <button id="btn-save-key" style="margin-top:0; width:60px; flex-shrink:0;">Save</button>
                    <button id="btn-del-key" style="margin-top:0; width:40px; flex-shrink:0; background:#a82a2a;">Del</button>
                    <button id="btn-test-cloud" style="margin-top:0; width:40px; flex-shrink:0; background:#007acc;">${t('ui.testConnection')}</button>
                </div>
            </div>

            <div id="local-ui" style="display:none;">
                <label>${t('ui.ollamaUrl')}</label>
                <div class="flex-row">
                    <input type="text" id="ollama-url" value="${ollamaBaseUrl}" placeholder="http://127.0.0.1:11434">
                    <button id="btn-save-ollama-url" style="width:50px; flex-shrink:0;">${t('ui.saveConfig')}</button>
                </div>
                
                <label style="margin-top:5px;">${t('ui.modelName')}</label>
                <div class="flex-row">
                    <select id="model-select" style="flex:1;"><option value="">-- Loading --</option></select>
                    <button id="btn-test-local" style="margin-top:0; width:40px; flex-shrink:0; background:#007acc;">${t('ui.testConnection')}</button>
                </div>
                <button id="btn-refresh-models" style="width:100%;">🔄 Refresh Models</button>
            </div>

            <div id="custom-ui" style="display:none;">
                <label>${t('ui.customApi')}</label>
                <select id="custom-api-select"><option value="">-- Select --</option></select>
                
                <label style="margin-top:5px;">${t('ui.label')}</label>
                <input type="text" id="custom-name" placeholder="Label">
                
                <label>API Base URL</label>
                <input type="text" id="custom-url" placeholder="https://api.openai.com/v1/chat/completions">
                
                <label>${t('ui.modelName')}</label>
                <input type="text" id="custom-model" placeholder="gpt-4o">
                
                <label>${t('ui.apiKey')}</label>
                <input type="password" id="custom-key" placeholder="Bearer Token">
                
                <div class="flex-row">
                    <button id="btn-save-custom" style="flex:1;">💾 Save</button>
                    <button id="btn-test-custom" style="flex:0.8; background:#007acc;">🔗 ${t('ui.testConnection')}</button>
                    <button id="btn-del-custom" style="flex:0.8; background:#a82a2a;">🗑️ Del</button>
                </div>
            </div>
        </div>
    </details>

    <details open>
        <summary>${t('ui.testConfig')}</summary>
        <div class="content">
            <label>⚡ 並行執行緒數 (Concurrency Workers)</label>
            <select id="concurrency-select" style="margin-bottom: 8px;">
                <option value="auto" selected>Auto（依模型規模自動調配）</option>
                <option value="1">1（串行模式 - 適合小顯存 Local 模型）</option>
                <option value="2">2 Workers</option>
                <option value="3">3 Workers</option>
                <option value="4">4 Workers</option>
            </select>
            <label>🧠 ${t('ui.promptStrategy')}</label>
            <select id="prompt-strategy" style="margin-bottom: 8px;">
                <option value="auto"     ${currentStrategy === 'auto'  ? 'selected' : ''}>Auto — 依模型自動路由</option>
                <option value="tier1"    ${currentStrategy === 'tier1' ? 'selected' : ''}>Tier 1 — 2–3B (填空法)</option>
                <option value="tier2"    ${currentStrategy === 'tier2' ? 'selected' : ''}>Tier 2 — 7–13B (Ground-Truth)</option>
                <option value="tier3"    ${currentStrategy === 'tier3' ? 'selected' : ''}>Tier 3 — 34–70B (Mock Scaffold)</option>
                <option value="tier4"    ${currentStrategy === 'tier4' ? 'selected' : ''}>Tier 4 — 100B+/Cloud (全自主)</option>
            </select>

            <label>📂 ${t('ui.projectPath')}</label>
            <div class="flex-row">
                <input type="text" id="project-path" readonly placeholder="${t('ui.projectPath')}">
                <button id="btn-browse-proj" style="width:40px; flex-shrink:0;">...</button>
            </div>
            
            <label>📂 ${t('ui.outputDir')}</label>
            <div class="flex-row">
                <input type="text" id="output-path" readonly placeholder="Default">
                <button id="btn-browse-out" style="width:40px; flex-shrink:0;">...</button>
            </div>
            
            <div style="border-top:1px solid var(--vscode-editorGroup-border); margin-top:8px; padding-top:8px;">
                <label style="margin-top:0;">${t('ui.maxLoops')}</label>
                <input type="number" id="max-loop" value="3" min="1">
                
                <label>${t('ui.mutpyTimeout')}</label>
                <input type="number" id="mutpy-timeout" value="5" min="1" style="width:100%;">

                <label>${t('ui.apiTimeout')}</label>
                <input type="number" id="timeout-sec" value="60" min="10" max="300" style="width:100%;">
            </div>
        </div>
    </details>

    <details open>
        <summary>${t('ui.testTarget')}</summary>
        <div class="content">
            <label>${t('ui.file')}</label>
            <select id="file-select"><option value="">-- ${t('ui.file')} --</option></select>
            
            <label style="margin-top:8px;">${t('ui.function')}</label>
            <select id="func-select"><option value="">-- All --</option></select>
            
            <div class="flex-row" style="margin-top:15px; justify-content:space-between; gap:10px;">
                <button id="btn-run" style="flex:1;">${t('ui.runBtn')}</button>
                <button id="btn-abort" style="flex:1; background:#a82a2a; color:white; display:none;">${t('ui.abortBtn')}</button>
            </div>

            <hr style="width: 100%; border: 1px solid var(--vscode-editorGroup-border); margin: 15px 0 5px 0;">
            <label>📁 ${t('ui.batchScope')}</label>
            <div class="flex-row">
                <input type="text" id="batch-path" readonly placeholder="Workspace">
                <button id="btn-browse-batch" style="width:40px; flex-shrink:0;">...</button>
            </div>
            
            <button id="btn-batch-run" style="margin-top:10px; width:100%;">▶️ Batch Run</button>
        </div>
    </details>

    <details open>
        <summary>${t('ui.coverageDashboard')}</summary>
        <div class="content">
            <!-- 顯示模式切換按鈕 -->
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <div style="display:inline-flex; border:1px solid var(--vscode-editorGroup-border); border-radius:3px; overflow:hidden;">
                    <button type="button" id="btn-mode-flat" style="margin:0; padding:3px 8px; font-size:11px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; cursor:pointer;" onclick="setViewMode('flat')">📄 平鋪模式</button>
                    <button type="button" id="btn-mode-grouped" style="margin:0; padding:3px 8px; font-size:11px; background:transparent; color:var(--vscode-foreground); border:none; cursor:pointer;" onclick="setViewMode('grouped')">📁 檔案分組</button>
                </div>
                <div id="grouped-tools" style="display:none; gap:4px;">
                    <button type="button" style="margin:0; padding:2px 6px; font-size:10px;" onclick="setAllGroupsOpen(true)">全部展開</button>
                    <button type="button" style="margin:0; padding:2px 6px; font-size:10px;" onclick="setAllGroupsOpen(false)">全部折疊</button>
                </div>
            </div>

            <!-- 平鋪模式表格 -->
            <table id="coverage-table" style="width:100%; border-collapse:collapse; text-align:left;">
                <thead style="border-bottom:1px solid var(--vscode-editorGroup-border);"><tr>
                    <th style="padding:5px; width:30px; text-align:center;"><input type="checkbox" id="select-all"></th>
                    <th style="padding:5px;">${t('ui.columnFile')}</th>
                    <th style="padding:5px;">突變分數 / 覆蓋率</th>
                    <th style="padding:5px;">Status</th>
                </tr></thead>
                <tbody id="coverage-tbody">
                    <tr><td colspan="4" style="padding:10px; text-align:center; opacity:0.5;">${t('ui.noCoverageData')}</td></tr>
                </tbody>
            </table>

            <!-- 分組模式容器 -->
            <div id="grouped-container" style="display:none; flex-direction:column; gap:6px;"></div>
            
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
                <button id="btn-delete-selected" style="background:#a82a2a; color:white;">${t('ui.batchDeleteSelected')}</button>
                <span id="results-count" style="font-size:11px; opacity:0.7;">0 項結果</span>
            </div>
        </div>
    </details>

    <details>
        <summary>${t('ui.systemLogs')}</summary>
        <div class="content">
            <textarea id="log-area" readonly placeholder="Logs..."></textarea>
            <button id="btn-clear-log" style="margin-top:5px;">Clear Logs</button>
        </div>
    </details>

    <script>
        const vscode = acquireVsCodeApi();
        let currentKeys = {};
        let currentCustomKeys = {};
        let lastTestedProjectPath = '';
        const resultsMap = new Map();
        let currentViewMode = 'flat';

        const i18n = {
            noCoverageData: "${t('ui.noCoverageData')}",
            runBtn: "${t('ui.runBtn')}",
            batchRunBtn: "▶️ Batch Run"
        };

        vscode.postMessage({ command: 'getInitialData' });

        function setViewMode(mode) {
            currentViewMode = mode;
            const btnFlat = document.getElementById('btn-mode-flat');
            const btnGrouped = document.getElementById('btn-mode-grouped');
            const groupedTools = document.getElementById('grouped-tools');
            const table = document.getElementById('coverage-table');
            const groupedContainer = document.getElementById('grouped-container');

            if (mode === 'flat') {
                btnFlat.style.background = 'var(--vscode-button-background)';
                btnFlat.style.color = 'var(--vscode-button-foreground)';
                btnGrouped.style.background = 'transparent';
                btnGrouped.style.color = 'var(--vscode-foreground)';
                if (groupedTools) groupedTools.style.display = 'none';
                if (table) table.style.display = 'table';
                if (groupedContainer) groupedContainer.style.display = 'none';
            } else {
                btnGrouped.style.background = 'var(--vscode-button-background)';
                btnGrouped.style.color = 'var(--vscode-button-foreground)';
                btnFlat.style.background = 'transparent';
                btnFlat.style.color = 'var(--vscode-foreground)';
                if (groupedTools) groupedTools.style.display = 'flex';
                if (table) table.style.display = 'none';
                if (groupedContainer) groupedContainer.style.display = 'flex';
            }
            renderDashboard();
        }

        function setAllGroupsOpen(open) {
            document.querySelectorAll('#grouped-container details.file-group').forEach(d => d.open = open);
        }

        function escapeHtml(text) {
            return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function getScoreBadge(score, coverage) {
            const scoreNum = parseFloat(score);
            const scoreColor = score === '失敗' ? '#c75050'
                : score === '測試中' ? '#1f6feb'
                : isNaN(scoreNum) ? '#888'
                : scoreNum >= 80 ? '#2ea043'
                : scoreNum >= 50 ? '#d29922'
                : '#c75050';
            const scoreBadge = '<span class="badge score-badge" style="background:' + scoreColor + '; color:#fff; padding:2px 7px; border-radius:4px; font-size:11px; font-weight:600;">' + score + '</span>';
            const covBadge = coverage
                ? '<br><span style="background:#1565c0; color:#fff; padding:1px 6px; border-radius:4px; font-size:10px; margin-top:3px; display:inline-block;">\uD83D\uDCCA ' + coverage + '</span>'
                : '';
            return scoreBadge + covBadge;
        }

        function toggleItemCheck(id, checked) {
            const item = resultsMap.get(id);
            if (item) item.checked = checked;
        }

        function renderDashboard() {
            const countSpan = document.getElementById('results-count');
            if (countSpan) countSpan.textContent = resultsMap.size + ' 項結果';

            if (currentViewMode === 'flat') {
                renderFlatView();
            } else {
                renderGroupedView();
            }
        }

        function renderFlatView() {
            const tbody = document.getElementById('coverage-tbody') || document.querySelector('#coverage-table tbody');
            if (!tbody) return;
            if (resultsMap.size === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="padding:10px; text-align:center; opacity:0.5;">' + i18n.noCoverageData + '</td></tr>';
                return;
            }
            tbody.innerHTML = '';
            resultsMap.forEach(item => {
                const tr = tbody.insertRow();
                const cellCheck = tr.insertCell(0);
                cellCheck.style.textAlign = 'center';
                cellCheck.innerHTML = '<input type="checkbox" class="row-sel" ' + (item.checked ? 'checked' : '') + ' onchange="toggleItemCheck(\\'' + item.id + '\\', this.checked)">';

                const cellFile = tr.insertCell(1);
                cellFile.innerHTML = '<strong>' + escapeHtml(item.fileName) + '</strong>';

                const cellScore = tr.insertCell(2);
                cellScore.innerHTML = getScoreBadge(item.score, item.coverage);

                const cellStatus = tr.insertCell(3);
                cellStatus.textContent = item.reason || '';

                Array.from(tr.cells).forEach(c => c.style.padding = '5px');
            });
        }

        function renderGroupedView() {
            const container = document.getElementById('grouped-container');
            if (!container) return;
            if (resultsMap.size === 0) {
                container.innerHTML = '<div style="padding:10px; text-align:center; opacity:0.5;">' + i18n.noCoverageData + '</div>';
                return;
            }

            // 按檔案分組
            const groups = new Map();
            resultsMap.forEach(item => {
                const f = item.file || '其他';
                if (!groups.has(f)) groups.set(f, []);
                groups.get(f).push(item);
            });

            container.innerHTML = '';
            groups.forEach((items, fileName) => {
                const details = document.createElement('details');
                details.className = 'file-group';
                details.open = true;
                details.style.marginBottom = '6px';
                details.style.border = '1px solid var(--vscode-editorGroup-border)';
                details.style.borderRadius = '4px';

                const summary = document.createElement('summary');
                summary.style.display = 'flex';
                summary.style.justifyContent = 'space-between';
                summary.style.alignItems = 'center';
                summary.style.padding = '6px 8px';
                summary.style.cursor = 'pointer';
                summary.style.background = 'var(--vscode-sideBarSectionHeader-background)';
                summary.innerHTML = '<span style="font-weight:600;">📁 ' + escapeHtml(fileName) + ' <small style="opacity:0.7; font-weight:normal;">(' + items.length + ' 個函式)</small></span>';
                details.appendChild(summary);

                const subTable = document.createElement('table');
                subTable.style.width = '100%';
                subTable.style.borderCollapse = 'collapse';
                subTable.style.fontSize = '12px';

                items.forEach(item => {
                    const tr = subTable.insertRow();
                    const cCheck = tr.insertCell(0);
                    cCheck.style.width = '30px';
                    cCheck.style.textAlign = 'center';
                    cCheck.innerHTML = '<input type="checkbox" class="row-sel" ' + (item.checked ? 'checked' : '') + ' onchange="toggleItemCheck(\\'' + item.id + '\\', this.checked)">';

                    const cFunc = tr.insertCell(1);
                    cFunc.style.padding = '5px';
                    const displayFuncName = item.func ? item.func + '()' : item.fileName;
                    cFunc.innerHTML = '<span style="color:var(--vscode-symbolIcon-functionForeground, #dcdcaa); font-weight:500;">🔹 ' + escapeHtml(displayFuncName) + '</span>';

                    const cScore = tr.insertCell(2);
                    cScore.style.padding = '5px';
                    cScore.innerHTML = getScoreBadge(item.score, item.coverage);

                    const cStatus = tr.insertCell(3);
                    cStatus.style.padding = '5px';
                    cStatus.textContent = item.reason || '';
                });

                details.appendChild(subTable);
                container.appendChild(details);
            });
        }

        document.getElementById('select-all').addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            resultsMap.forEach(item => item.checked = isChecked);
            renderDashboard();
        });

        document.getElementById('btn-delete-selected').addEventListener('click', () => {
            const toDelete = [];
            resultsMap.forEach((item, id) => {
                if (item.checked) toDelete.push(id);
            });
            toDelete.forEach(id => resultsMap.delete(id));
            document.getElementById('select-all').checked = false;
            renderDashboard();
        });

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'setModels': document.getElementById('model-select').innerHTML = '<option value="">-- Select Model --</option>' + msg.models.map(m => \`<option value="\${m}">\${m}</option>\`).join(''); break;
                case 'setApiKeys': currentKeys = msg.keys; const keys = Object.keys(msg.keys); document.getElementById('api-key-select').innerHTML = '<option value="">-- Select Key --</option>' + keys.map(k => \`<option value="\${k}">\${k}</option>\`).join(''); break;
                case 'setFiles': document.getElementById('file-select').innerHTML = '<option value="">-- Select File --</option>' + msg.files.map(f => \`<option value="\${f.path}">\${f.name}</option>\`).join(''); break;
                case 'setFunctions': document.getElementById('func-select').innerHTML = '<option value="">-- All --</option>' + msg.funcs.map(f => \`<option value="\${f}">\${f}()</option>\`).join(''); break;
                case 'setProjectPath': document.getElementById('project-path').value = msg.path; if (!document.getElementById('batch-path').value) document.getElementById('batch-path').value = msg.path; break;
                case 'setBatchPath': document.getElementById('batch-path').value = msg.path; break;
                case 'setOutputPath': document.getElementById('output-path').value = msg.path; break;
                case 'appendLog': const log = document.getElementById('log-area'); log.value += (log.value ? '\\n' : '') + msg.text; log.scrollTop = log.scrollHeight; break;
                case 'updateCoverage': {
                    const fileName = msg.fileName;
                    let file = msg.file || '';
                    let func = msg.func || '';
                    if (!file && fileName.includes(':')) {
                        const parts = fileName.split(':');
                        file = parts[0];
                        func = parts.slice(1).join(':');
                    } else if (!file) {
                        file = fileName;
                    }
                    resultsMap.set(fileName, {
                        id: fileName,
                        file: file,
                        func: func,
                        fileName: fileName,
                        score: msg.score,
                        coverage: msg.coverage,
                        reason: msg.reason,
                        checked: resultsMap.get(fileName)?.checked || false
                    });
                    renderDashboard();
                    break;
                }
                case 'setCustomKeys':
                    currentCustomKeys = msg.keys;
                    const ckeys = Object.keys(msg.keys);
                    document.getElementById('custom-api-select').innerHTML = '<option value="">-- Select --</option>' + ckeys.map(k => '<option value="' + k + '">' + k + '</option>').join('');
                    break;
                case 'analysisFinished':
                    const runBtn = document.getElementById('btn-run');
                    const batchRunBtn = document.getElementById('btn-batch-run');
                    if (runBtn) {
                        runBtn.disabled = false;
                        runBtn.innerText = i18n.runBtn;
                    }
                    if (batchRunBtn) {
                        batchRunBtn.disabled = false;
                        batchRunBtn.innerText = i18n.batchRunBtn;
                    }
                    const abortBtn = document.getElementById('btn-abort');
                    if (abortBtn) abortBtn.style.display = 'none';
                    break;
            }
        });

        document.getElementById('lang-select').onchange = (e) => {
            vscode.postMessage({ command: 'setLanguage', lang: e.target.value });
        };
        
        document.getElementById('prompt-strategy').onchange = (e) => {
            vscode.postMessage({ command: 'setPromptStrategy', strategy: e.target.value });
        };

        document.getElementById('btn-save-ollama-url').onclick = () => {
            const url = document.getElementById('ollama-url').value;
            vscode.postMessage({ command: 'saveOllamaUrl', url });
        };

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

        document.getElementById('btn-test-cloud').onclick = () => {
            const modelName = document.getElementById('api-key-select').value;
            if(!modelName) return vscode.postMessage({ command: 'appendLog', text: 'Please select a Cloud API Key.' });
            vscode.postMessage({ command: 'testConnection', envType: 'cloud', modelName });
        };
        document.getElementById('btn-test-local').onclick = () => {
            const modelName = document.getElementById('model-select').value;
            if(!modelName) return vscode.postMessage({ command: 'appendLog', text: 'Please select a Local model.' });
            vscode.postMessage({ command: 'testConnection', envType: 'local', modelName });
        };
        document.getElementById('btn-test-custom').onclick = () => {
            const customUrl = document.getElementById('custom-url').value;
            const modelName = document.getElementById('custom-model').value;
            const customKey = document.getElementById('custom-key').value;
            if(!customUrl || !modelName) return vscode.postMessage({ command: 'appendLog', text: 'Please provide Custom API URL and Model Name.' });
            vscode.postMessage({ command: 'testConnection', envType: 'custom', customUrl, modelName, customKey });
        };

        document.getElementById('btn-run').onclick = () => {
            const { envType, modelName } = getStartParams();
            const filePath = document.getElementById('file-select').value;
            
            if(!envType || !modelName || !filePath) {
                vscode.postMessage({ command: 'appendLog', text: 'Please select Env, Model, and File.' });
                return;
            }

            document.getElementById('btn-run').disabled = true;
            document.getElementById('btn-batch-run').disabled = true;
            document.getElementById('btn-run').innerText = '⏳ Testing...';
            document.getElementById('btn-abort').style.display = 'block';

            const currentProj = document.getElementById('project-path').value;
            if (lastTestedProjectPath && lastTestedProjectPath !== currentProj) {
                const tbody = document.querySelector('#coverage-table tbody');
                tbody.innerHTML = '<tr><td colspan="4" style="padding:10px; text-align:center; opacity:0.5;">' + i18n.noCoverageData + '</td></tr>';
            }
            lastTestedProjectPath = currentProj;

            vscode.postMessage({
                command: 'startAnalysis',
                envType, modelName, filePath,
                ollamaUrl: document.getElementById('ollama-url').value,
                funcName: document.getElementById('func-select').value,
                promptStrategy: document.getElementById('prompt-strategy').value,
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
                vscode.postMessage({ command: 'appendLog', text: 'Please select Env, Model, and Batch Path.' });
                return;
            }

            document.getElementById('btn-run').disabled = true;
            document.getElementById('btn-batch-run').disabled = true;
            document.getElementById('btn-batch-run').innerText = '⏳ Batch Testing...';
            document.getElementById('btn-abort').style.display = 'block';

            const currentProj = batchPath;
            if (lastTestedProjectPath && lastTestedProjectPath !== currentProj) {
                const tbody = document.querySelector('#coverage-table tbody');
                tbody.innerHTML = '<tr><td colspan="4" style="padding:10px; text-align:center; opacity:0.5;">' + i18n.noCoverageData + '</td></tr>';
            }
            lastTestedProjectPath = currentProj;

            vscode.postMessage({
                command: 'startBatchAnalysis',
                envType, modelName, batchPath,
                ollamaUrl: document.getElementById('ollama-url').value,
                promptStrategy: document.getElementById('prompt-strategy').value,
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