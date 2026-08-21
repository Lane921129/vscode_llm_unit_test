"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/orchestrator.ts
var orchestrator_exports = {};
__export(orchestrator_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(orchestrator_exports);
var vscode3 = __toESM(require("vscode"));

// src/SidebarProvider.ts
var vscode2 = __toESM(require("vscode"));
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));

// src/webviewContent.ts
function getWebviewContent(t2, currentLang = "auto", currentStrategy = "auto", ollamaBaseUrl = "http://127.0.0.1:11434") {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t2("ui.title")}</title>
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

        .result-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-editorGroup-border);
            border-radius: 4px;
            padding: 7px 9px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            box-sizing: border-box;
            transition: background 0.15s ease;
        }
        .result-card:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .result-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
        }
        .result-title {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            font-size: 12px;
            min-width: 0;
            flex: 1;
            word-break: break-all;
        }
        .result-badges {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
            flex-wrap: wrap;
            justify-content: flex-end;
        }
        .result-status {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-left: 22px;
            line-height: 1.35;
            word-break: break-word;
        }
        details.file-group summary {
            background: var(--vscode-sideBarSectionHeader-background);
            border-radius: 4px;
            padding: 7px 10px;
            font-size: 12px;
            cursor: pointer;
            user-select: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 6px;
        }
        details.file-group summary:hover {
            background: var(--vscode-list-hoverBackground);
        }
        details.file-group .group-content {
            padding: 6px 4px 4px 10px;
            display: flex;
            flex-direction: column;
            gap: 5px;
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
        <h3 style="border: none; margin: 0; padding: 0;">${t2("ui.title")}</h3>
        <select id="lang-select" style="width: auto; padding: 2px 5px; margin: 0; font-size: 11px;">
            <option value="auto" ${currentLang === "auto" ? "selected" : ""}>Auto (VS Code)</option>
            <option value="zh-tw" ${currentLang === "zh-tw" ? "selected" : ""}>\u7E41\u9AD4\u4E2D\u6587</option>
            <option value="en" ${currentLang === "en" ? "selected" : ""}>English</option>
        </select>
    </div>
    
    <details open>
        <summary>${t2("ui.modelSettings")}</summary>
        <div class="content">
            <label>${t2("ui.env")}</label>
            <select id="env-type">
                <option value="cloud">${t2("ui.envCloud")}</option>
                <option value="local">${t2("ui.envLocal")}</option>
                <option value="custom">${t2("ui.envCustom")}</option>
            </select>
            
            <div id="cloud-ui">
                <label>${t2("ui.apiKey")}</label>
                <div class="flex-row">
                    <select id="api-key-select"><option value="">-- Loading --</option></select>
                </div>
                
                <div class="flex-row" style="margin-top: 5px;">
                    <input type="text" id="new-key-name" placeholder="Label">
                    <input type="password" id="new-key-value" placeholder="Key">
                    <button id="btn-save-key" style="margin-top:0; width:60px; flex-shrink:0;">Save</button>
                    <button id="btn-del-key" style="margin-top:0; width:40px; flex-shrink:0; background:#a82a2a;">Del</button>
                    <button id="btn-test-cloud" style="margin-top:0; width:40px; flex-shrink:0; background:#007acc;">${t2("ui.testConnection")}</button>
                </div>
            </div>

            <div id="local-ui" style="display:none;">
                <label>${t2("ui.ollamaUrl")}</label>
                <div class="flex-row">
                    <input type="text" id="ollama-url" value="${ollamaBaseUrl}" placeholder="http://127.0.0.1:11434">
                    <button id="btn-save-ollama-url" style="width:50px; flex-shrink:0;">${t2("ui.saveConfig")}</button>
                </div>
                
                <label style="margin-top:5px;">${t2("ui.modelName")}</label>
                <div class="flex-row">
                    <select id="model-select" style="flex:1;"><option value="">-- Loading --</option></select>
                    <button id="btn-test-local" style="margin-top:0; width:40px; flex-shrink:0; background:#007acc;">${t2("ui.testConnection")}</button>
                </div>
                <button id="btn-refresh-models" style="width:100%;">\u{1F504} Refresh Models</button>
            </div>

            <div id="custom-ui" style="display:none;">
                <label>${t2("ui.customApi")}</label>
                <select id="custom-api-select"><option value="">-- Select --</option></select>
                
                <label style="margin-top:5px;">${t2("ui.label")}</label>
                <input type="text" id="custom-name" placeholder="Label">
                
                <label>API Base URL</label>
                <input type="text" id="custom-url" placeholder="https://api.openai.com/v1/chat/completions">
                
                <label>${t2("ui.modelName")}</label>
                <input type="text" id="custom-model" placeholder="gpt-4o">
                
                <label>${t2("ui.apiKey")}</label>
                <input type="password" id="custom-key" placeholder="Bearer Token">
                
                <div class="flex-row">
                    <button id="btn-save-custom" style="flex:1;">\u{1F4BE} Save</button>
                    <button id="btn-test-custom" style="flex:0.8; background:#007acc;">\u{1F517} ${t2("ui.testConnection")}</button>
                    <button id="btn-del-custom" style="flex:0.8; background:#a82a2a;">\u{1F5D1}\uFE0F Del</button>
                </div>
            </div>
        </div>
    </details>

    <details open>
        <summary>${t2("ui.testConfig")}</summary>
        <div class="content">
            <label>\u26A1 \u4E26\u884C\u57F7\u884C\u7DD2\u6578 (Concurrency Workers)</label>
            <select id="concurrency-select" style="margin-bottom: 8px;">
                <option value="auto" selected>Auto\uFF08\u4F9D\u6A21\u578B\u898F\u6A21\u81EA\u52D5\u8ABF\u914D\uFF09</option>
                <option value="1">1\uFF08\u4E32\u884C\u6A21\u5F0F - \u9069\u5408\u5C0F\u986F\u5B58 Local \u6A21\u578B\uFF09</option>
                <option value="2">2 Workers</option>
                <option value="3">3 Workers</option>
                <option value="4">4 Workers</option>
            </select>
            <label>\u{1F9E0} ${t2("ui.promptStrategy")}</label>
            <select id="prompt-strategy" style="margin-bottom: 8px;">
                <option value="auto"     ${currentStrategy === "auto" ? "selected" : ""}>Auto \u2014 \u4F9D\u6A21\u578B\u81EA\u52D5\u8DEF\u7531</option>
                <option value="tier1"    ${currentStrategy === "tier1" ? "selected" : ""}>Tier 1 \u2014 2\u20133B (\u586B\u7A7A\u6CD5)</option>
                <option value="tier2"    ${currentStrategy === "tier2" ? "selected" : ""}>Tier 2 \u2014 7\u201313B (Ground-Truth)</option>
                <option value="tier3"    ${currentStrategy === "tier3" ? "selected" : ""}>Tier 3 \u2014 34\u201370B (Mock Scaffold)</option>
                <option value="tier4"    ${currentStrategy === "tier4" ? "selected" : ""}>Tier 4 \u2014 100B+/Cloud (\u5168\u81EA\u4E3B)</option>
            </select>

            <label>\u{1F4C2} ${t2("ui.projectPath")}</label>
            <div class="flex-row">
                <input type="text" id="project-path" readonly placeholder="${t2("ui.projectPath")}">
                <button id="btn-browse-proj" style="width:40px; flex-shrink:0;">...</button>
            </div>
            
            <label>\u{1F4C2} ${t2("ui.outputDir")}</label>
            <div class="flex-row">
                <input type="text" id="output-path" readonly placeholder="Default">
                <button id="btn-browse-out" style="width:40px; flex-shrink:0;">...</button>
            </div>
            
            <div style="border-top:1px solid var(--vscode-editorGroup-border); margin-top:8px; padding-top:8px;">
                <label style="margin-top:0;">${t2("ui.maxLoops")}</label>
                <input type="number" id="max-loop" value="3" min="1">
                
                <label>${t2("ui.mutpyTimeout")}</label>
                <input type="number" id="mutpy-timeout" value="5" min="1" style="width:100%;">

                <label>${t2("ui.apiTimeout")}</label>
                <input type="number" id="timeout-sec" value="60" min="10" max="300" style="width:100%;">
            </div>
        </div>
    </details>

    <details open>
        <summary>${t2("ui.testTarget")}</summary>
        <div class="content">
            <label>${t2("ui.file")}</label>
            <select id="file-select"><option value="">-- ${t2("ui.file")} --</option></select>
            
            <label style="margin-top:8px;">${t2("ui.function")}</label>
            <select id="func-select"><option value="">-- All --</option></select>
            
            <div class="flex-row" style="margin-top:15px; justify-content:space-between; gap:10px;">
                <button id="btn-run" style="flex:1;">${t2("ui.runBtn")}</button>
                <button id="btn-abort" style="flex:1; background:#a82a2a; color:white; display:none;">${t2("ui.abortBtn")}</button>
            </div>

            <hr style="width: 100%; border: 1px solid var(--vscode-editorGroup-border); margin: 15px 0 5px 0;">
            <label>\u{1F4C1} ${t2("ui.batchScope")}</label>
            <div class="flex-row">
                <input type="text" id="batch-path" readonly placeholder="Workspace">
                <button id="btn-browse-batch" style="width:40px; flex-shrink:0;">...</button>
            </div>
            
            <button id="btn-batch-run" style="margin-top:10px; width:100%;">\u25B6\uFE0F Batch Run</button>
        </div>
    </details>

    <details open>
        <summary>${t2("ui.coverageDashboard")}</summary>
        <div class="content">
            <!-- \u986F\u793A\u6A21\u5F0F\u5207\u63DB\u5DE5\u5177\u5217 -->
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <div style="display:inline-flex; border:1px solid var(--vscode-editorGroup-border); border-radius:4px; overflow:hidden;">
                    <button type="button" id="btn-mode-flat" style="margin:0; padding:4px 10px; font-size:11px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; cursor:pointer;" onclick="setViewMode('flat')">\u{1F4C4} \u5E73\u92EA\u6A21\u5F0F</button>
                    <button type="button" id="btn-mode-grouped" style="margin:0; padding:4px 10px; font-size:11px; background:transparent; color:var(--vscode-foreground); border:none; cursor:pointer;" onclick="setViewMode('grouped')">\u{1F4C1} \u6A94\u6848\u5206\u7D44</button>
                </div>
                <div id="grouped-tools" style="display:none; gap:4px;">
                    <button type="button" style="margin:0; padding:3px 7px; font-size:10px;" onclick="setAllGroupsOpen(true)">\u5168\u90E8\u5C55\u958B</button>
                    <button type="button" style="margin:0; padding:3px 7px; font-size:10px;" onclick="setAllGroupsOpen(false)">\u5168\u90E8\u6298\u758A</button>
                </div>
            </div>

            <!-- \u6307\u6A19\u8207\u7B26\u865F\u8AAA\u660E\u5217 (Legend) -->
            <div style="font-size:11px; opacity:0.85; display:flex; flex-wrap:wrap; gap:8px; align-items:center; background:var(--vscode-editor-inactiveSelectionBackground); padding:4px 8px; border-radius:3px; margin-bottom:6px;" title="\u7A81\u8B8A\u5206\u6578\u4EE3\u8868\u8B8A\u7570\u9AD4\u6BBA\u6B7B\u7387\uFF0C\u8986\u84CB\u7387\u4EE3\u8868\u7A0B\u5F0F\u78BC\u57F7\u884C\u6DB5\u84CB\u884C\u6578\u6BD4\u4F8B">
                <span title="\u{1F9EC} \u7A81\u8B8A\u5206\u6578 (Mutation Score)\uFF1A\u6E2C\u8A66\u5957\u4EF6\u6BBA\u6B7B\u7A0B\u5F0F\u78BC\u8B8A\u7570\u9AD4\u7684\u767E\u5206\u6BD4\uFF0C\u5206\u6578\u8D8A\u9AD8\u4EE3\u8868\u6E2C\u8A66\u6293\u932F\u80FD\u529B\u8D8A\u5F37">\u{1F9EC} <strong>\u7A81\u8B8A\u5206\u6578</strong>: \u8B8A\u7570\u9AD4\u6BBA\u6B7B\u7387</span>
                <span style="opacity:0.3;">|</span>
                <span title="\u{1F4CA} \u884C\u8986\u84CB\u7387 (Line Coverage)\uFF1A\u6E2C\u8A66\u57F7\u884C\u904E\u7A0B\u4E2D\u6240\u6DB5\u84CB\u5230\u7684\u539F\u59CB\u7A0B\u5F0F\u78BC\u884C\u6578\u6BD4\u4F8B">\u{1F4CA} <strong>\u8986\u84CB\u7387</strong>: \u7A0B\u5F0F\u78BC\u884C\u8986\u84CB</span>
            </div>

            <!-- \u5168\u9078\u8207\u63A7\u5236\u5217 -->
            <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 2px; margin-bottom:4px; font-size:12px; border-bottom:1px solid var(--vscode-editorGroup-border);">
                <label style="display:inline-flex; align-items:center; gap:6px; margin:0; cursor:pointer; font-weight:normal;">
                    <input type="checkbox" id="select-all" style="margin:0; width:auto;"> \u5168\u9078
                </label>
                <span id="results-count" style="font-size:11px; opacity:0.75;">0 \u9805\u7D50\u679C</span>
            </div>

            <!-- \u97FF\u61C9\u5F0F\u5361\u7247\u5BB9\u5668 (\u5E73\u92EA / \u5206\u7D44\u5171\u7528) -->
            <div id="dashboard-container" style="display:flex; flex-direction:column; gap:6px; min-height:40px;">
                <div id="empty-state" style="padding:15px; text-align:center; opacity:0.5; font-size:12px;">${t2("ui.noCoverageData")}</div>
            </div>
            
            <button id="btn-delete-selected" style="margin-top:8px; background:#a82a2a; color:white;">${t2("ui.batchDeleteSelected")}</button>
        </div>
    </details>

    <details>
        <summary>${t2("ui.systemLogs")}</summary>
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
            noCoverageData: "${t2("ui.noCoverageData")}",
            runBtn: "${t2("ui.runBtn")}",
            batchRunBtn: "\u25B6\uFE0F Batch Run"
        };

        vscode.postMessage({ command: 'getInitialData' });

        function setViewMode(mode) {
            currentViewMode = mode;
            const btnFlat = document.getElementById('btn-mode-flat');
            const btnGrouped = document.getElementById('btn-mode-grouped');
            const groupedTools = document.getElementById('grouped-tools');

            if (mode === 'flat') {
                btnFlat.style.background = 'var(--vscode-button-background)';
                btnFlat.style.color = 'var(--vscode-button-foreground)';
                btnGrouped.style.background = 'transparent';
                btnGrouped.style.color = 'var(--vscode-foreground)';
                if (groupedTools) groupedTools.style.display = 'none';
            } else {
                btnGrouped.style.background = 'var(--vscode-button-background)';
                btnGrouped.style.color = 'var(--vscode-button-foreground)';
                btnFlat.style.background = 'transparent';
                btnFlat.style.color = 'var(--vscode-foreground)';
                if (groupedTools) groupedTools.style.display = 'flex';
            }
            renderDashboard();
        }

        function setAllGroupsOpen(open) {
            document.querySelectorAll('#dashboard-container details.file-group').forEach(d => d.open = open);
        }

        function escapeHtml(text) {
            return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function getScoreBadge(score, coverage) {
            const scoreNum = parseFloat(score);
            const scoreColor = score === '\u5931\u6557' ? '#c75050'
                : score === '\u6E2C\u8A66\u4E2D' ? '#1f6feb'
                : isNaN(scoreNum) ? '#888'
                : scoreNum >= 80 ? '#2ea043'
                : scoreNum >= 50 ? '#d29922'
                : '#c75050';

            const scoreTitle = score === '\u6E2C\u8A66\u4E2D' ? '\u72C0\u614B: \u6E2C\u8A66\u4E2D (\u6B63\u5728\u57F7\u884C\u7A81\u8B8A\u6E2C\u8A66\u8207\u5206\u6790)'
                : score === '\u5931\u6557' ? '\u72C0\u614B: \u57F7\u884C\u4E2D\u65B7\u6216\u9A57\u8B49\u5931\u6557'
                : '\u{1F9EC} \u7A81\u8B8A\u5206\u6578 (Mutation Score): ' + score + ' (\u6E2C\u8A66\u6BBA\u6B7B\u8B8A\u7570\u9AD4\u7684\u767E\u5206\u6BD4\uFF0C\u8D8A\u9AD8\u8D8A\u80FD\u6293\u51FA\u6F5B\u5728 Bug)';
            const scoreBadge = '<span class="score-badge" style="background:' + scoreColor + '; color:#fff; padding:2px 7px; border-radius:4px; font-size:11px; font-weight:600; white-space:nowrap;" title="' + escapeHtml(scoreTitle) + '">\u{1F9EC} ' + escapeHtml(score) + '</span>';

            const covTitle = '\u{1F4CA} \u884C\u8986\u84CB\u7387 (Line Coverage): ' + (coverage || 'N/A') + ' (\u6E2C\u8A66\u6240\u6DB5\u84CB\u57F7\u884C\u7684\u539F\u59CB\u7A0B\u5F0F\u78BC\u884C\u6578\u6BD4\u4F8B)';
            const covBadge = coverage
                ? '<span style="background:#1565c0; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:500; white-space:nowrap;" title="' + escapeHtml(covTitle) + '">\u{1F4CA} ' + escapeHtml(coverage) + '</span>'
                : '';
            return '<div class="result-badges">' + scoreBadge + covBadge + '</div>';
        }

        function toggleItemCheck(id, checked) {
            const item = resultsMap.get(id);
            if (item) item.checked = checked;
        }

        function createResultCard(item, showFileName = true) {
            const card = document.createElement('div');
            card.className = 'result-card';

            const header = document.createElement('div');
            header.className = 'result-header';

            const titleBox = document.createElement('div');
            titleBox.className = 'result-title';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.style.width = 'auto';
            cb.style.margin = '0';
            cb.className = 'row-sel';
            cb.checked = !!item.checked;
            cb.onchange = () => toggleItemCheck(item.id, cb.checked);
            titleBox.appendChild(cb);

            const label = document.createElement('span');
            if (showFileName) {
                label.innerHTML = '<span title="\u76EE\u6A19\u6A94\u6848: ' + escapeHtml(item.file) + '" style="color:var(--vscode-symbolIcon-fileForeground, #519aba);">\u{1F4C4} ' + escapeHtml(item.file) + '</span>' +
                                  (item.func ? '<span title="\u76EE\u6A19\u51FD\u5F0F: ' + escapeHtml(item.func) + '()" style="color:var(--vscode-symbolIcon-functionForeground, #dcdcaa); margin-left:4px; font-weight:bold;">: ' + escapeHtml(item.func) + '()</span>' : '');
            } else {
                label.innerHTML = '<span title="\u76EE\u6A19\u51FD\u5F0F: ' + escapeHtml(item.func || item.fileName) + '()" style="color:var(--vscode-symbolIcon-functionForeground, #dcdcaa); font-weight:bold;">\u{1F539} ' + escapeHtml(item.func || item.fileName) + '()</span>';
            }
            titleBox.appendChild(label);
            header.appendChild(titleBox);

            const badgesDiv = document.createElement('div');
            badgesDiv.innerHTML = getScoreBadge(item.score, item.coverage);
            header.appendChild(badgesDiv);
            card.appendChild(header);

            if (item.reason) {
                const statusDiv = document.createElement('div');
                statusDiv.className = 'result-status';
                statusDiv.textContent = item.reason;
                card.appendChild(statusDiv);
            }

            return card;
        }

        function renderDashboard() {
            const countSpan = document.getElementById('results-count');
            if (countSpan) countSpan.textContent = resultsMap.size + ' \u9805\u7D50\u679C';

            const container = document.getElementById('dashboard-container');
            if (!container) return;

            if (resultsMap.size === 0) {
                container.innerHTML = '<div style="padding:15px; text-align:center; opacity:0.5; font-size:12px;">' + i18n.noCoverageData + '</div>';
                return;
            }

            container.innerHTML = '';

            if (currentViewMode === 'flat') {
                resultsMap.forEach(item => {
                    container.appendChild(createResultCard(item, true));
                });
            } else {
                // \u6A94\u6848\u5206\u7D44\u6A21\u5F0F
                const groups = new Map();
                resultsMap.forEach(item => {
                    const f = item.file || '\u5176\u4ED6';
                    if (!groups.has(f)) groups.set(f, []);
                    groups.get(f).push(item);
                });

                groups.forEach((items, fileName) => {
                    const details = document.createElement('details');
                    details.className = 'file-group';
                    details.open = true;
                    details.style.marginBottom = '6px';
                    details.style.border = '1px solid var(--vscode-editorGroup-border)';
                    details.style.borderRadius = '4px';

                    const summary = document.createElement('summary');
                    summary.innerHTML = '<span style="font-weight:600;"><span style="color:var(--vscode-symbolIcon-fileForeground, #519aba);">\u{1F4C1}</span> ' + escapeHtml(fileName) + ' <small style="opacity:0.75; font-weight:normal;">(' + items.length + ' \u500B\u51FD\u5F0F)</small></span>';
                    details.appendChild(summary);

                    const groupContent = document.createElement('div');
                    groupContent.className = 'group-content';

                    items.forEach(item => {
                        groupContent.appendChild(createResultCard(item, false));
                    });

                    details.appendChild(groupContent);
                    container.appendChild(details);
                });
            }
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
            document.getElementById('btn-run').innerText = '\u23F3 Testing...';
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
            document.getElementById('btn-batch-run').innerText = '\u23F3 Batch Testing...';
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

// src/i18n/index.ts
var vscode = __toESM(require("vscode"));

// src/i18n/en.ts
var en_default = {
  ui: {
    title: "LLM Unit Test \u{1F9EA}",
    modelSettings: "\u{1F916} Model & Environment Settings",
    envLocal: "Local (Ollama)",
    envCloud: "Cloud (Gemini)",
    envCustom: "Custom (OpenAI-compatible)",
    modelName: "Model Name",
    apiKey: "API Key",
    selectKeyPlaceholder: "-- Select or Add API Key --",
    addNewKey: "\u2795 Add New Key...",
    testConnection: "Test",
    saveConfig: "Save Config",
    testConfig: "\u2699\uFE0F Test Configuration",
    maxLoops: "Max Loops (Self-Reflection)",
    mutpyTimeout: "Mutatest Timeout (s)",
    apiTimeout: "API Timeout (s)",
    outputDir: "Output Directory (default: test)",
    testTarget: "\u{1F3AF} Test Target",
    selectedTarget: "Selected Target:",
    noTargetSelected: "No target selected",
    chooseTargetBtn: "Choose Target",
    runBtn: "\u{1F680} Start Mutation Test",
    abortBtn: "\u{1F6D1} Abort Test",
    projectPath: "Project Path",
    file: "File",
    function: "Function",
    batchScope: "Batch Scope",
    env: "Environment",
    ollamaUrl: "Ollama URL",
    customApi: "Custom API",
    label: "Label",
    promptStrategy: "Prompt Strategy",
    stratAuto: "Auto (By Name)",
    stratSmall: "Small Model (Strict)",
    stratLarge: "Large Model (Advanced)",
    coverageDashboard: "\u{1F4CA} Coverage Dashboard",
    noCoverageData: "No data available. Run a test first.",
    batchDeleteSelected: "Delete Selected",
    clearAllCoverage: "Clear All Workspace Coverage",
    columnFile: "File/Func",
    columnMutants: "Mutants",
    columnScore: "Score",
    columnAction: "Action",
    systemLogs: "\u{1F4DD} System Logs"
  },
  log: {
    connectionSuccess: "\u2705 Connection successful!",
    connectionFailed: "\u274C Connection failed: {0}",
    testStarted: "\u{1F680} Starting test for {0}...",
    aborted: "\u26A0\uFE0F Test aborted by user.",
    apiError: "API Error: {0}",
    retry: "Attempting retry ({0}/{1})...",
    emptyResponse: "Model returned empty code. Retrying...",
    astParsing: "Parsing AST for target...",
    astSuccess: "AST parsed successfully. Features extracted.",
    batchStart: "Starting batch test, found {0} Python files.",
    batchEnd: "\u{1F389} Batch test completed!",
    batchEmpty: "No Python files found in {0}.",
    mutatestRunning: "Running mutatest (Attempt {0})..."
  },
  error: {
    emptyResponseFinal: "AI output is continuously empty or invalid.",
    noModelName: "Model name is required.",
    noTargetSelected: "Please select a target file to test.",
    mutatestFailed: "Mutatest failed to execute.",
    invalidFormat: "The AI output could not be parsed into a valid test."
  },
  prompt: {
    languageName: "English"
  }
};

// src/i18n/zh-tw.ts
var zh_tw_default = {
  ui: {
    title: "\u7A81\u8B8A\u6E2C\u8A66\u5206\u6790 \u{1F9EA}",
    modelSettings: "\u{1F916} \u6A21\u578B\u8207\u74B0\u5883\u8A2D\u5B9A",
    envLocal: "Local (Ollama)",
    envCloud: "Cloud (Gemini)",
    envCustom: "Custom (OpenAI \u76F8\u5BB9)",
    modelName: "\u6A21\u578B\u540D\u7A31",
    apiKey: "API Key",
    selectKeyPlaceholder: "-- \u9078\u64C7\u6216\u65B0\u589E API Key --",
    addNewKey: "\u2795 \u65B0\u589E Key...",
    testConnection: "\u6E2C\u8A66",
    saveConfig: "\u5132\u5B58\u8A2D\u5B9A",
    testConfig: "\u2699\uFE0F \u6E2C\u8A66\u53C3\u6578\u8A2D\u5B9A",
    maxLoops: "\u6700\u5927\u8FED\u4EE3\u6B21\u6578 (Self-Reflection)",
    mutpyTimeout: "Mutatest \u8D85\u6642\u9650\u5236 (\u79D2)",
    apiTimeout: "API \u8D85\u6642\u9650\u5236 (\u79D2)",
    outputDir: "\u6E2C\u8A66\u8F38\u51FA\u76EE\u9304 (\u9810\u8A2D test)",
    testTarget: "\u{1F3AF} \u6E2C\u8A66\u76EE\u6A19",
    selectedTarget: "\u5DF2\u9078\u76EE\u6A19\uFF1A",
    noTargetSelected: "\u5C1A\u672A\u9078\u64C7\u76EE\u6A19",
    chooseTargetBtn: "\u9078\u64C7\u6E2C\u8A66\u76EE\u6A19",
    runBtn: "\u{1F680} \u958B\u59CB\u81EA\u52D5\u5316\u7A81\u8B8A\u6E2C\u8A66",
    abortBtn: "\u{1F6D1} \u4E2D\u6B62\u6E2C\u8A66",
    projectPath: "\u53D7\u6E2C\u5C08\u6848\u76EE\u9304",
    file: "\u6A94\u6848",
    function: "\u51FD\u5F0F",
    batchScope: "\u6574\u9AD4\u5C08\u6848",
    env: "\u57F7\u884C\u74B0\u5883",
    ollamaUrl: "Ollama URL",
    customApi: "\u81EA\u8A02 API",
    label: "\u6A19\u7C64",
    promptStrategy: "Prompt \u7B56\u7565",
    stratAuto: "Auto (\u81EA\u52D5\u5224\u65B7)",
    stratSmall: "\u5C0F\u6A21\u578B (\u56B4\u683C\u9632\u5446)",
    stratLarge: "\u5927\u6A21\u578B (\u9032\u968E\u63A8\u7406)",
    coverageDashboard: "\u{1F4CA} \u8986\u84CB\u7387\u5100\u8868\u677F",
    noCoverageData: "\u5C1A\u7121\u6E2C\u8A66\u8CC7\u6599\uFF0C\u8ACB\u5148\u57F7\u884C\u6E2C\u8A66\u3002",
    batchDeleteSelected: "\u6279\u6B21\u522A\u9664\u9078\u4E2D",
    clearAllCoverage: "\u6E05\u7A7A\u5168\u5DE5\u4F5C\u5340\u8986\u84CB\u7387",
    columnFile: "\u6A94\u6848 / \u51FD\u5F0F",
    columnMutants: "\u7A81\u8B8A\u9AD4 (\u6BBA\u6B7B/\u7E3D\u6578)",
    columnScore: "\u5206\u6578",
    columnAction: "\u64CD\u4F5C",
    systemLogs: "\u{1F4DD} \u7CFB\u7D71\u65E5\u8A8C"
  },
  log: {
    connectionSuccess: "\u2705 \u9023\u7DDA\u6210\u529F\uFF01",
    connectionFailed: "\u274C \u9023\u7DDA\u5931\u6557: {0}",
    testStarted: "\u{1F680} \u958B\u59CB\u6E2C\u8A66 {0}...",
    aborted: "\u26A0\uFE0F \u6E2C\u8A66\u5DF2\u7531\u4F7F\u7528\u8005\u5F37\u5236\u4E2D\u6B62\u3002",
    apiError: "API \u767C\u751F\u932F\u8AA4: {0}",
    retry: "\u5617\u8A66\u81EA\u52D5\u91CD\u8A66 ({0}/{1})...",
    emptyResponse: "\u6A21\u578B\u56DE\u50B3\u5167\u5BB9\u70BA\u7A7A\uFF0C\u5C07\u91CD\u65B0\u767C\u9001\u8ACB\u6C42...",
    astParsing: "\u89E3\u6790 AST \u7279\u5FB5\u4E2D...",
    astSuccess: "AST \u89E3\u6790\u5B8C\u6210\uFF01\u5DF2\u64F7\u53D6\u51FD\u5F0F\u7279\u5FB5\u8207\u4F9D\u8CF4\u3002",
    batchStart: "\u958B\u59CB\u6279\u6B21\u6E2C\u8A66\uFF0C\u5171\u627E\u5230 {0} \u500B Python \u6A94\u6848\u3002",
    batchEnd: "\u{1F389} \u6279\u6B21\u81EA\u52D5\u5316\u6E2C\u8A66\u57F7\u884C\u5B8C\u7562\uFF01",
    batchEmpty: "\u5728\u76EE\u9304 {0} \u4E2D\u627E\u4E0D\u5230\u4EFB\u4F55 Python \u6A94\u6848\u3002",
    mutatestRunning: "\u57F7\u884C mutatest \u7A81\u8B8A\u6E2C\u8A66\u4E2D (\u7B2C {0} \u8F2A)..."
  },
  error: {
    emptyResponseFinal: "AI \u8F38\u51FA\u683C\u5F0F\u9023\u7E8C\u5169\u6B21\u7121\u6CD5\u89E3\u6790\u70BA\u6709\u6548\u6E2C\u8A66",
    noModelName: "\u8ACB\u8F38\u5165\u6A21\u578B\u540D\u7A31",
    noTargetSelected: "\u8ACB\u5148\u9078\u64C7\u8981\u6E2C\u8A66\u7684\u6A94\u6848",
    mutatestFailed: "\u57F7\u884C mutatest \u5931\u6557",
    invalidFormat: "AI \u8F38\u51FA\u683C\u5F0F\u7121\u6548"
  },
  prompt: {
    languageName: "\u7E41\u9AD4\u4E2D\u6587"
  }
};

// src/i18n/index.ts
var currentDict = zh_tw_default;
function initI18n() {
  const config = vscode.workspace.getConfiguration("llmUnitTest");
  let lang = config.get("language", "auto");
  if (lang === "auto") {
    lang = vscode.env.language.toLowerCase();
  }
  if (lang.startsWith("en")) {
    currentDict = en_default;
  } else {
    currentDict = zh_tw_default;
  }
}
function t(keyPath, ...args) {
  const keys = keyPath.split(".");
  let value = currentDict;
  for (const key of keys) {
    if (value && typeof value === "object") {
      value = value[key];
    } else {
      value = void 0;
      break;
    }
  }
  if (typeof value === "string") {
    let result = value;
    for (let i = 0; i < args.length; i++) {
      result = result.replace(`{${i}}`, String(args[i]));
    }
    return result;
  }
  return keyPath;
}
function getPromptLanguageName() {
  return currentDict.prompt.languageName;
}

// src/utils.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var import_child_process = require("child_process");
async function extractFunctionsWithAst(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const pythonScript = `
import sys, ast, json

class FunctionVisitor(ast.NodeVisitor):
    def __init__(self):
        self.functions = []
        self.scope_stack = []

    def visit_ClassDef(self, node):
        self.scope_stack.append(node.name)
        self.generic_visit(node)
        self.scope_stack.pop()

    def _process_func(self, node, is_async=False):
        # \u6392\u9664 dunder \u8207 test \u65B9\u6CD5
        if node.name.startswith('__') and node.name.endswith('__'):
            return
        if node.name.startswith('test_'):
            return

        class_name = self.scope_stack[-1] if self.scope_stack else None
        full_name = f"{class_name}.{node.name}" if class_name else node.name
        
        args = [arg.arg for arg in node.args.args if arg.arg != 'self']
        self.functions.append({
            'name': node.name,
            'fullName': full_name,
            'className': class_name,
            'isAsync': is_async,
            'args': args
        })

    def visit_FunctionDef(self, node):
        self._process_func(node, is_async=False)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node):
        self._process_func(node, is_async=True)
        self.generic_visit(node)

try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        tree = ast.parse(f.read(), filename=sys.argv[1])
    visitor = FunctionVisitor()
    visitor.visit(tree)
    print(json.dumps(visitor.functions, ensure_ascii=False))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;
  return new Promise((resolve) => {
    const py = (0, import_child_process.spawn)("python", ["-c", pythonScript, filePath], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    let stdout = "";
    py.stdout.on("data", (data) => stdout += data.toString());
    py.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve([]);
        }
      } else {
        resolve([]);
      }
    });
  });
}
async function findPythonFilesInDir(dir) {
  const ignored = /* @__PURE__ */ new Set([".git", "node_modules", "env", ".env", "venv", ".venv", ".pytest_cache", "__pycache__"]);
  const results = [];
  try {
    const list = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const item of list) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (ignored.has(item.name)) continue;
        results.push(...await findPythonFilesInDir(fullPath));
      } else if (item.name.endsWith(".py")) {
        results.push(fullPath);
      }
    }
  } catch {
  }
  return results;
}
function detectMutationEngine(pythonVersion) {
  if (process.platform === "win32") {
    return "mutatest";
  }
  const versionMatch = pythonVersion.match(/(\d+)\.(\d+)/);
  const major = versionMatch ? parseInt(versionMatch[1]) : 3;
  const minor = versionMatch ? parseInt(versionMatch[2]) : 0;
  return major > 3 || major === 3 && minor >= 12 ? "mutmut" : "mutatest";
}

// src/SidebarProvider.ts
var MutationViewProvider = class {
  constructor(secretStorage) {
    this.secretStorage = secretStorage;
  }
  secretStorage;
  static viewType = "mutation-test-view";
  webview;
  resolveWebviewView(webviewView) {
    initI18n();
    this.webview = webviewView.webview;
    this.webview.options = { enableScripts: true };
    const config = vscode2.workspace.getConfiguration("llmUnitTest");
    const lang = config.get("language", "auto");
    const strategy = config.get("promptStrategy", "auto");
    const ollamaUrl = config.get("ollamaBaseUrl", "http://127.0.0.1:11434");
    this.webview.html = getWebviewContent(t, lang, strategy, ollamaUrl);
    this.webview.onDidReceiveMessage(async (message) => {
      const config2 = vscode2.workspace.getConfiguration("llmUnitTest");
      switch (message.command) {
        case "getInitialData": {
          const rawKeys = await this.secretStorage.get("llm_api_keys");
          const keys = rawKeys ? JSON.parse(rawKeys) : {};
          this.webview?.postMessage({ command: "setApiKeys", keys });
          const rawCustomKeys = await this.secretStorage.get("llm_custom_keys");
          const customKeys = rawCustomKeys ? JSON.parse(rawCustomKeys) : {};
          this.webview?.postMessage({ command: "setCustomKeys", keys: customKeys });
          const savedProjPath = config2.get("projectPath", "");
          const files = await this.findPythonFiles(savedProjPath);
          const savedPath = config2.get("outputPath", "");
          if (savedProjPath) {
            this.webview?.postMessage({ command: "setProjectPath", path: savedProjPath });
          }
          this.webview?.postMessage({ command: "setFiles", files });
          if (savedPath) {
            this.webview?.postMessage({ command: "setOutputPath", path: savedPath });
          }
          this.fetchLocalModels().then((models) => {
            this.webview?.postMessage({ command: "setModels", models });
          });
          break;
        }
        case "setLanguage": {
          await config2.update("language", message.lang, true);
          initI18n();
          if (this.webview) {
            const strategy2 = config2.get("promptStrategy", "auto");
            this.webview.html = getWebviewContent(t, message.lang, strategy2);
          }
          break;
        }
        case "setPromptStrategy": {
          await config2.update("promptStrategy", message.strategy, true);
          if (this.webview) {
            const lang2 = config2.get("language", "auto");
            const ollamaUrl2 = config2.get("ollamaBaseUrl", "http://127.0.0.1:11434");
            this.webview.html = getWebviewContent(t, lang2, message.strategy, ollamaUrl2);
          }
          break;
        }
        case "saveOllamaUrl": {
          await config2.update("ollamaBaseUrl", message.url, true);
          vscode2.window.showInformationMessage(`\u2705 \u5DF2\u5132\u5B58 Ollama URL\uFF1A${message.url}`);
          this.fetchLocalModels().then((models) => {
            this.webview?.postMessage({ command: "setModels", models });
          });
          break;
        }
        case "browseProjectFolder": {
          const existingProject = config2.get("projectPath", "");
          const options = {
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: "\u9078\u64C7\u5C08\u6848\u8CC7\u6599\u593E",
            defaultUri: existingProject ? vscode2.Uri.file(existingProject) : void 0
          };
          const fileUri = await vscode2.window.showOpenDialog(options);
          if (fileUri && fileUri[0]) {
            const projectPath = fileUri[0].fsPath;
            try {
              await config2.update("projectPath", projectPath, true);
            } catch (e) {
              console.error("\u66F4\u65B0 projectPath \u8A2D\u5B9A\u5931\u6557", e);
            }
            this.webview?.postMessage({ command: "setProjectPath", path: projectPath });
            vscode2.window.showInformationMessage(`\u6B63\u5728\u6383\u63CF\u8CC7\u6599\u593E\u4E2D\u7684 Python \u6A94\u6848\uFF0C\u8ACB\u7A0D\u5019...`);
            const files = await this.findPythonFiles(projectPath);
            this.webview?.postMessage({ command: "setFiles", files });
            if (files.length === 0) {
              vscode2.window.showWarningMessage("\u5728\u9078\u64C7\u7684\u8CC7\u6599\u593E\u4E2D\u6C92\u6709\u627E\u5230\u4EFB\u4F55 .py \u6A94\u6848\u3002");
            } else {
              vscode2.window.showInformationMessage(`\u2705 \u6210\u529F\u8F09\u5165 ${files.length} \u500B Python \u6A94\u6848`);
            }
          }
          break;
        }
        case "browseFolder": {
          const existingOutput = config2.get("outputPath", "");
          const existingProject2 = config2.get("projectPath", "");
          const options = {
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: "\u9078\u64C7\u8F38\u51FA\u8CC7\u6599\u593E",
            defaultUri: existingOutput ? vscode2.Uri.file(existingOutput) : existingProject2 ? vscode2.Uri.file(existingProject2) : void 0
          };
          const fileUri = await vscode2.window.showOpenDialog(options);
          if (fileUri && fileUri[0]) {
            const outputPath = fileUri[0].fsPath;
            try {
              await config2.update("outputPath", outputPath, true);
            } catch (e) {
              console.error("\u66F4\u65B0 outputPath \u8A2D\u5B9A\u5931\u6557", e);
            }
            this.webview?.postMessage({ command: "setOutputPath", path: outputPath });
          }
          break;
        }
        case "browseBatchFolder": {
          const existingProject3 = config2.get("projectPath", "");
          const options = {
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: "\u9078\u64C7\u6279\u6B21\u6E2C\u8A66\u8CC7\u6599\u593E",
            defaultUri: existingProject3 ? vscode2.Uri.file(existingProject3) : void 0
          };
          const fileUri = await vscode2.window.showOpenDialog(options);
          if (fileUri && fileUri[0]) {
            const batchPath = fileUri[0].fsPath;
            this.webview?.postMessage({ command: "setBatchPath", path: batchPath });
          }
          break;
        }
        case "getFunctions": {
          const funcs = await this.findPythonFunctions(message.filePath);
          this.webview?.postMessage({ command: "setFunctions", funcs });
          break;
        }
        case "updateApiKey": {
          const rawKeys = await this.secretStorage.get("llm_api_keys");
          const currentKeys = rawKeys ? JSON.parse(rawKeys) : {};
          if (message.oldName && message.oldName !== message.newName) {
            delete currentKeys[message.oldName];
          }
          currentKeys[message.newName] = message.key;
          await this.secretStorage.store("llm_api_keys", JSON.stringify(currentKeys));
          this.webview?.postMessage({ command: "setApiKeys", keys: currentKeys });
          vscode2.window.showInformationMessage(`\u{1F512} \u5DF2\u5B89\u5168\u5132\u5B58 API Key \u81F3\u7CFB\u7D71\u91D1\u9470\u5EAB\uFF1A${message.newName}`);
          break;
        }
        case "deleteApiKey": {
          const rawKeys = await this.secretStorage.get("llm_api_keys");
          const currentKeys = rawKeys ? JSON.parse(rawKeys) : {};
          if (currentKeys[message.name]) {
            delete currentKeys[message.name];
            await this.secretStorage.store("llm_api_keys", JSON.stringify(currentKeys));
            this.webview?.postMessage({ command: "setApiKeys", keys: currentKeys });
            vscode2.window.showInformationMessage(`\u{1F5D1}\uFE0F \u5DF2\u81EA\u5B89\u5168\u91D1\u9470\u5EAB\u79FB\u9664\uFF1A${message.name}`);
          }
          break;
        }
        case "updateCustomKey": {
          const rawCustomKeys = await this.secretStorage.get("llm_custom_keys");
          const currentKeys = rawCustomKeys ? JSON.parse(rawCustomKeys) : {};
          if (message.oldName && message.oldName !== message.newName) {
            delete currentKeys[message.oldName];
          }
          currentKeys[message.newName] = { url: message.url, model: message.model, key: message.key };
          await this.secretStorage.store("llm_custom_keys", JSON.stringify(currentKeys));
          this.webview?.postMessage({ command: "setCustomKeys", keys: currentKeys });
          vscode2.window.showInformationMessage(`\u{1F512} \u5DF2\u5B89\u5168\u5132\u5B58\u81EA\u8A02 API\uFF1A${message.newName}`);
          break;
        }
        case "deleteCustomKey": {
          const rawCustomKeys = await this.secretStorage.get("llm_custom_keys");
          const currentKeys = rawCustomKeys ? JSON.parse(rawCustomKeys) : {};
          if (currentKeys[message.name]) {
            delete currentKeys[message.name];
            await this.secretStorage.store("llm_custom_keys", JSON.stringify(currentKeys));
            this.webview?.postMessage({ command: "setCustomKeys", keys: currentKeys });
            vscode2.window.showInformationMessage(`\u{1F5D1}\uFE0F \u5DF2\u81EA\u5B89\u5168\u91D1\u9470\u5EAB\u79FB\u9664\u81EA\u8A02 API\uFF1A${message.name}`);
          }
          break;
        }
        case "startAnalysis": {
          vscode2.commands.executeCommand("llm-unit-test.runCaptureAndTest", message);
          break;
        }
        case "startBatchAnalysis": {
          vscode2.commands.executeCommand("llm-unit-test.runBatchAnalysis", message);
          break;
        }
        case "testConnection": {
          vscode2.window.withProgress({
            location: vscode2.ProgressLocation.Notification,
            title: "\u6B63\u5728\u6E2C\u8A66 API \u9023\u7DDA...",
            cancellable: false
          }, async () => {
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 5e3);
              if (message.envType === "local") {
                const config3 = vscode2.workspace.getConfiguration("llmUnitTest");
                const baseUrl = config3.get("ollamaBaseUrl", "http://127.0.0.1:11434");
                const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                if (message.modelName) {
                  try {
                    const probeController = new AbortController();
                    const probeTimeout = setTimeout(() => probeController.abort(), 1e4);
                    const showResponse = await fetch(`${baseUrl}/api/show`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ model: message.modelName }),
                      signal: probeController.signal
                    });
                    clearTimeout(probeTimeout);
                    if (showResponse.ok) {
                      const modelData = await showResponse.json();
                      const paramSize = modelData?.details?.parameter_size ?? "unknown";
                      let contextLength = 4096;
                      if (modelData?.model_info) {
                        const infoKeys = Object.keys(modelData.model_info);
                        const ctxKey = infoKeys.find((k) => k.endsWith(".context_length"));
                        if (ctxKey) {
                          contextLength = modelData.model_info[ctxKey];
                        }
                      }
                      const profile = { paramSize, contextLength };
                      this.webview?.postMessage({ command: "modelProbeResult", profile });
                      vscode2.commands.executeCommand("llm-unit-test.updateModelProfile", profile);
                      vscode2.window.showInformationMessage(
                        `\u2705 Local Ollama \u9023\u7DDA\u6210\u529F\uFF01\u6A21\u578B\uFF1A${paramSize}\uFF0C\u6700\u5927 Context\uFF1A${contextLength.toLocaleString()} tokens`
                      );
                    } else {
                      vscode2.window.showInformationMessage(`\u2705 Local Ollama \u9023\u7DDA\u6210\u529F\uFF01`);
                    }
                  } catch {
                    vscode2.window.showInformationMessage(`\u2705 Local Ollama \u9023\u7DDA\u6210\u529F\uFF01`);
                  }
                } else {
                  vscode2.window.showInformationMessage(`\u2705 Local Ollama \u9023\u7DDA\u6210\u529F\uFF01`);
                }
              } else if (message.envType === "cloud") {
                const rawKeys = await this.secretStorage.get("llm_api_keys");
                const keys = rawKeys ? JSON.parse(rawKeys) : {};
                const key = keys[message.modelName];
                if (!key) {
                  clearTimeout(timeoutId);
                  throw new Error("\u627E\u4E0D\u5230\u5C0D\u61C9\u7684 API Key");
                }
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
                const response = await fetch(url, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
                  signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (response.ok) {
                  const profile = { paramSize: "Cloud (Gemini)", contextLength: 1e6 };
                  this.webview?.postMessage({ command: "modelProbeResult", profile });
                  vscode2.commands.executeCommand("llm-unit-test.updateModelProfile", profile);
                  vscode2.window.showInformationMessage(`\u2705 Cloud Gemini \u9023\u7DDA\u6210\u529F\uFF01Context\uFF1A1M tokens`);
                } else {
                  throw new Error(`HTTP ${response.status} - ${await response.text()}`);
                }
              } else if (message.envType === "custom") {
                const headers = { "Content-Type": "application/json" };
                if (message.customKey) headers["Authorization"] = `Bearer ${message.customKey}`;
                const response = await fetch(message.customUrl, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    model: message.modelName,
                    messages: [{ role: "user", content: "hi" }]
                  }),
                  signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (response.ok) {
                  vscode2.window.showInformationMessage(`\u2705 Custom API \u9023\u7DDA\u6210\u529F\uFF01`);
                } else {
                  throw new Error(`HTTP ${response.status} - ${await response.text()}`);
                }
              }
            } catch (error) {
              vscode2.window.showErrorMessage(`\u274C \u9023\u7DDA\u5931\u6557: ${error.message}`);
              this.webview?.postMessage({ command: "appendLog", text: `[\u932F\u8AA4] \u9023\u7DDA\u6E2C\u8A66\u5931\u6557: ${error.message}` });
            }
          });
          break;
        }
        case "abortTest": {
          vscode2.commands.executeCommand("llm-unit-test.abortTest");
          break;
        }
      }
    });
  }
  // --- 輔助函式：掃描檔案與函式 ---
  async findPythonFiles(dirPath) {
    let rootPath = dirPath;
    if (!rootPath) {
      rootPath = vscode2.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }
    if (!rootPath || !fs2.existsSync(rootPath)) {
      return [];
    }
    const files = [];
    const ignoredDirs = /* @__PURE__ */ new Set(["node_modules", "venv", "env", ".env", ".git", "__pycache__", ".pytest_cache"]);
    const walkAsync = async (dir) => {
      let list;
      try {
        list = await fs2.promises.readdir(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      const tasks = list.map(async (dirent) => {
        const file = dirent.name;
        if (file.startsWith(".") && file !== ".py" && file.length > 1) {
          return;
        }
        if (ignoredDirs.has(file)) {
          return;
        }
        const fullPath = path2.join(dir, file);
        try {
          if (dirent.isDirectory()) {
            await walkAsync(fullPath);
          } else if (file.endsWith(".py")) {
            files.push({ name: file, path: fullPath });
          }
        } catch (e) {
        }
      });
      await Promise.all(tasks);
    };
    try {
      await walkAsync(rootPath);
    } catch (e) {
      console.error("\u6383\u63CF\u5C08\u6848\u6A94\u6848\u5931\u6557", e);
    }
    return files;
  }
  async findPythonFunctions(filePath) {
    const infos = await extractFunctionsWithAst(filePath);
    return infos.map((f) => f.fullName);
  }
  async fetchLocalModels() {
    try {
      const config = vscode2.workspace.getConfiguration("llmUnitTest");
      const baseUrl = config.get("ollamaBaseUrl", "http://127.0.0.1:11434");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2e3);
      const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.ok) {
        const data = await response.json();
        if (data && data.models) {
          return data.models.map((m) => m.name);
        }
      }
    } catch (e) {
    }
    return [];
  }
};

// src/few_shot_examples.ts
function getBaseFewShotExamples() {
  return [
    {
      label: "Arithmetic addition with boundary values",
      sourceCode: `def add(a, b):
    return a + b`,
      thinking: `The \`add\` function returns the sum of \`a\` and \`b\`.
I need to test:
1. Two positive numbers
2. Two negative numbers
3. A positive and a negative number
4. Zeros

I will use \`self.assertEqual(add(x, y), expected)\` for these cases.`,
      testCode: `import unittest
from module_name import add

class TestAdd(unittest.TestCase):
    def test_add_positive_numbers(self):
        self.assertEqual(add(2, 3), 5)
        
    def test_add_negative_numbers(self):
        self.assertEqual(add(-1, -5), -6)
        
    def test_add_mixed_numbers(self):
        self.assertEqual(add(10, -3), 7)
        
    def test_add_zeros(self):
        self.assertEqual(add(0, 0), 0)

if __name__ == '__main__':
    unittest.main()`
    },
    {
      label: "Division with Exception Handling",
      sourceCode: `def divide(a, b):
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b`,
      thinking: `The \`divide\` function returns the quotient of \`a\` divided by \`b\`.
It raises a \`ValueError\` if \`b\` is 0.

I need to test:
1. Normal division (float result)
2. Division of negative numbers
3. Division by zero exception

I will use \`self.assertAlmostEqual\` for float division, and \`self.assertRaises\` for the exception.`,
      testCode: `import unittest
from module_name import divide

class TestDivide(unittest.TestCase):
    def test_divide_normal(self):
        self.assertAlmostEqual(divide(10, 2), 5.0)
        
    def test_divide_negative(self):
        self.assertAlmostEqual(divide(-9, 3), -3.0)
        
    def test_divide_by_zero(self):
        with self.assertRaises(ValueError):
            divide(1, 0)

if __name__ == '__main__':
    unittest.main()`
    },
    {
      label: "String processing (Boolean returns)",
      sourceCode: `def is_palindrome(s):
    if not s:
        return False
    return s == s[::-1]`,
      thinking: `The \`is_palindrome\` function checks if a string reads the same forwards and backwards.
It explicitly returns False for empty strings.

I need to test:
1. A valid palindrome (even and odd length)
2. A non-palindrome
3. An empty string
4. A single character (which is a palindrome)

I will use \`self.assertTrue\` and \`self.assertFalse\`.`,
      testCode: `import unittest
from module_name import is_palindrome

class TestIsPalindrome(unittest.TestCase):
    def test_valid_palindromes(self):
        self.assertTrue(is_palindrome("racecar"))
        self.assertTrue(is_palindrome("abba"))
        self.assertTrue(is_palindrome("a"))
        
    def test_invalid_palindrome(self):
        self.assertFalse(is_palindrome("hello"))
        
    def test_empty_string(self):
        self.assertFalse(is_palindrome(""))

if __name__ == '__main__':
    unittest.main()`
    },
    {
      label: "String Slicing, Dictionary Return & Direct Exception",
      sourceCode: `def validate_and_format_token(token, provider):
    if len(token) < 10:
        raise ValueError("Invalid token length")
    if provider == 'jwt':
        return {'valid': True, 'type': 'user', 'claims': token[:5]}
    elif provider == 'payment_gateway':
        return {'valid': True, 'type': 'finance', 'partner': token[-5:]}
    return {'valid': False, 'reason': 'Unknown provider'}`,
      thinking: `The \`validate_and_format_token\` function validates token length and returns structured dicts with slices:
1. If token length < 10, raises ValueError("Invalid token length").
2. If provider == 'jwt', returns dict where 'claims' is token[:5] (FIRST 5 chars: '123456789012'[:5] == '12345').
3. If provider == 'payment_gateway', returns dict where 'partner' is token[-5:] (LAST 5 chars: '123456789012'[-5:] == '89012').
4. If provider is unknown, returns dict {'valid': False, 'reason': 'Unknown provider'}.`,
      testCode: `import unittest
from core_utils import validate_and_format_token

class TestValidateAndFormatToken(unittest.TestCase):
    def test_short_token_raises_value_error(self):
        with self.assertRaises(ValueError):
            validate_and_format_token("abc123", provider="jwt")
            
    def test_valid_jwt_token_slice(self):
        token = "123456789012"
        result = validate_and_format_token(token, provider="jwt")
        self.assertEqual(result, {"valid": True, "type": "user", "claims": "12345"})
        
    def test_valid_payment_gateway_token_slice(self):
        token = "123456789012"
        result = validate_and_format_token(token, provider="payment_gateway")
        self.assertEqual(result, {"valid": True, "type": "finance", "partner": "89012"})
        
    def test_unknown_provider(self):
        token = "123456789012"
        result = validate_and_format_token(token, provider="other")
        self.assertEqual(result, {"valid": False, "reason": "Unknown provider"})

if __name__ == '__main__':
    unittest.main()`
    },
    {
      label: "Caller with Internal Exception Catching (String Return)",
      sourceCode: `def login_user(user_input_token):
    try:
        token_info = validate_and_format_token(user_input_token, provider='jwt')
        if token_info.get('valid') and token_info.get('type') == 'user':
            return f"Welcome User (ID: {token_info.get('claims')})"
        return "Login Failed: Invalid Token"
    except ValueError as e:
        return "Login Failed: Token too short"`,
      thinking: `The \`login_user\` function catches ValueError internally using try...except and returns error strings.
CRITICAL: Because it catches exceptions internally, it NEVER raises ValueError to the caller!
I must use self.assertEqual with the exact return strings:
1. Valid 10+ char token -> "Welcome User (ID: 12345)"
2. Short token (< 10 chars) -> "Login Failed: Token too short" (Use assertEqual, NOT assertRaises!)`,
      testCode: `import unittest
from service_auth import login_user

class TestLoginUser(unittest.TestCase):
    def test_login_success(self):
        result = login_user("123456789012")
        self.assertEqual(result, "Welcome User (ID: 12345)")
        
    def test_short_token_returns_error_string(self):
        result = login_user("abc")
        self.assertEqual(result, "Login Failed: Token too short")
        
    def test_empty_token_returns_error_string(self):
        result = login_user("")
        self.assertEqual(result, "Login Failed: Token too short")

if __name__ == '__main__':
    unittest.main()`
    },
    {
      label: "Caller with Uncaught Exception Propagation",
      sourceCode: `def checkout_order(order_id, payment_token):
    token_info = validate_and_format_token(payment_token, provider='payment_gateway')
    if token_info.get('valid') and token_info.get('type') == 'finance':
        print(f"Routing to partner: {token_info.get('partner')}")
        return True
    return False`,
      thinking: `The \`checkout_order\` function takes (order_id, payment_token) and does NOT catch exceptions from validate_and_format_token:
1. If payment_token is valid (>= 10 chars), returns True.
2. If payment_token is too short (< 10 chars), validate_and_format_token raises ValueError and it is NOT caught -> MUST use with self.assertRaises(ValueError):
3. Notice: checkout_order takes ONLY 2 positional arguments (order_id, payment_token). Do NOT pass provider=... keyword argument!`,
      testCode: `import unittest
from service_order import checkout_order

class TestCheckoutOrder(unittest.TestCase):
    def test_checkout_success(self):
        result = checkout_order("order_1001", "123456789012")
        self.assertTrue(result)
        
    def test_checkout_short_token_raises_value_error(self):
        with self.assertRaises(ValueError):
            checkout_order("order_1001", "abc123")

if __name__ == '__main__':
    unittest.main()`
    }
  ];
}
function getDynamicFewShotExamples(astContext, sourceCode) {
  const examples = [];
  if (sourceCode.includes("if ") || sourceCode.includes("elif ") || sourceCode.includes("else:")) {
    examples.push({
      label: "Branch Coverage (if/else)",
      sourceCode: `def get_discount(price):
    if price >= 100:
        return price * 0.9
    return price`,
      thinking: `The \`get_discount\` function contains an \`if\` branch.
I need to test:
1. The \`if\` branch condition is met (price >= 100) -> e.g., price=100 (boundary) and price=150
2. The \`if\` branch condition is not met (price < 100) -> e.g., price=99 (boundary) and price=50`,
      testCode: `import unittest
from module_name import get_discount

class TestGetDiscount(unittest.TestCase):
    def test_discount_applied(self):
        self.assertEqual(get_discount(100), 90.0)
        self.assertEqual(get_discount(150), 135.0)
        
    def test_no_discount(self):
        self.assertEqual(get_discount(99), 99)
        self.assertEqual(get_discount(50), 50)

if __name__ == '__main__':
    unittest.main()`
    });
  }
  if (sourceCode.includes("for ") || sourceCode.includes("while ")) {
    examples.push({
      label: "Loop Boundary Conditions",
      sourceCode: `def sum_list(numbers):
    total = 0
    for n in numbers:
        total += n
    return total`,
      thinking: `The \`sum_list\` function contains a \`for\` loop iterating over \`numbers\`.
I need to test:
1. Zero iterations (empty list)
2. One iteration (single element)
3. Multiple iterations (multiple elements)`,
      testCode: `import unittest
from module_name import sum_list

class TestSumList(unittest.TestCase):
    def test_empty_list(self):
        self.assertEqual(sum_list([]), 0)
        
    def test_single_element(self):
        self.assertEqual(sum_list([5]), 5)
        
    def test_multiple_elements(self):
        self.assertEqual(sum_list([1, 2, 3]), 6)

if __name__ == '__main__':
    unittest.main()`
    });
  }
  return examples;
}
function getMutationOperatorHints(survivedMutants) {
  const hints = [];
  if (survivedMutants.includes("<class 'ast.Add'> to <class 'ast.Sub'>") || survivedMutants.includes("Add to Sub")) {
    hints.push(`- Operator \`+\` changed to \`-\`: Ensure your tests fail if addition becomes subtraction. (e.g. testing \`add(0,0)\` is BAD because 0+0 = 0-0=0, so the mutant survives. Use \`add(3,5)\` instead because 3+5=8 but 3-5=-2).`);
  }
  if (survivedMutants.includes("<class 'ast.LtE'> to <class 'ast.Lt'>") || survivedMutants.includes("LtE to Lt")) {
    hints.push(`- Operator \`<=\` changed to \`<\`: You MUST test the exact boundary value. (e.g. if the code is \`x <= 10\`, you must write a test case where \`x = 10\`. If you only test \`x = 5\`, the mutant \`x < 10\` will survive because 5 < 10 is also true).`);
  }
  if (survivedMutants.includes("If_Statement to If_False")) {
    hints.push(`- \`If_Statement to If_False\`: The mutation engine removed the \`if\` condition entirely (making it always False). You MUST write a test case that specifically targets the code inside the \`if\` block to ensure it executes.`);
  }
  if (hints.length > 0) {
    return `
\u3010Mutation Operator Killing Strategy\u3011
` + hints.join("\n");
  }
  return "";
}
function formatFewShotForPrompt(examples, useThinking = true) {
  return examples.map((ex, i) => {
    const thinkingBlock = useThinking ? `(You MUST start your output directly with <thinking> and do NOT output any other headings!)
<thinking>
${ex.thinking}
</thinking>

` : `(Analyze the boundary conditions, then write the test code directly)
`;
    return `==== Example ${i + 1}: ${ex.label} ====

[Simulated System Input (User Prompt)]
Target file: example_${i + 1}.py
Target function: example_func
Source code:
\`\`\`python
${ex.sourceCode}
\`\`\`

[Expected AI Response]
${thinkingBlock}\`\`\`python
${ex.testCode}
\`\`\``;
  }).join("\n\n\n");
}

// src/unittest_writer_prompt.ts
function getTier1SystemPrompt() {
  return `Complete ONE assertion line. Output ONLY the completed line. No explanation. No other code.`;
}
function getTier1UserPrompt(funcCall, returnVal, isError = false, errorType = "Exception") {
  if (isError) {
    return `Target call \`${funcCall}\` raises ${errorType}("${returnVal}").
Complete: with self.assertRaises(${errorType}):
              ${funcCall}`;
  }
  const valRepr = returnVal.startsWith('"') || returnVal.startsWith("'") || returnVal.startsWith("{") || returnVal.startsWith("[") || returnVal === "True" || returnVal === "False" || returnVal === "None" || !isNaN(Number(returnVal)) ? returnVal : JSON.stringify(returnVal);
  return `Target call: \`result = ${funcCall}\`
Exact Return Value: ${valRepr}
Complete ONE line: self.assertEqual(result, ${valRepr})`;
}
function getTier3SystemPrompt() {
  const langName = getPromptLanguageName();
  return `You are an expert Python unit test engineer.
You will receive a pre-built test scaffold with @patch mock decorators already configured.
Your task: fill in the TODO sections only.
- Set meaningful input values for the parameters.
- Call the target function.
- Write assertions using real return values provided.
- Do NOT modify @patch decorators or mock.return_value lines.
- Do NOT add new imports.
Output format:
\`\`\`python
(completed test method body only, no class wrapper)
\`\`\``;
}
function getTier3UserPrompt(funcName, scaffold, moduleName, traceExamples = []) {
  let prompt = `Target function: ${funcName} (from module: ${moduleName})

`;
  if (traceExamples.length > 0) {
    prompt += `Verified real return values to use in assertions:
`;
    for (const ex of traceExamples.slice(0, 3)) {
      prompt += `  - Input(${ex.args.join(", ")}) => ${ex.result}
`;
    }
    prompt += `
`;
  }
  prompt += `Test scaffold (fill in the TODO sections):
\`\`\`python
${scaffold}
\`\`\`

Fill in the TODO sections now:`;
  return prompt;
}
function getTier4SystemPrompt() {
  const langName = getPromptLanguageName();
  return `You are an expert Python unit test engineer. Write a complete, production-quality unittest.TestCase.

Output format:
<thinking>
(analysis in ${langName.toUpperCase()})
</thinking>

\`\`\`python
(complete unittest file)
\`\`\`

Guidelines:
- Use absolute imports (e.g. from service_auth import login_user).
- Use unittest.mock (patch, MagicMock) for all external dependencies.
- Cover all edge cases: None, empty, boundary values, all exception paths.
- Every test method name must start with test_.
- Do NOT copy the source code.`;
}
function getTier4SelfRepairPrompt(stderr) {
  return `Your test file failed pre-verification with these errors:

\`\`\`
${stderr.substring(0, 2e3)}
\`\`\`

Fix ONLY the failing test methods. Output the complete corrected test file.`;
}
function useThinkingTag(modelName) {
  const m = modelName.toLowerCase();
  const noThinkingModels = ["qwen", "llama", "phi", "tinyllama", "gemma", "mistral"];
  for (const bad of noThinkingModels) {
    if (m.includes(bad)) return false;
  }
  return true;
}
function getSystemPrompt(loopCount, strategy, survivedMutants, modelName = "") {
  const langName = getPromptLanguageName();
  const thinking = useThinkingTag(modelName);
  if (strategy === "small") {
    const formatBlock = thinking ? `Output format:
<thinking>
(brief analysis in ${langName.toUpperCase()})
</thinking>

\`\`\`python
(your unittest code)
\`\`\`` : `Output format:
\`\`\`python
(your unittest code)
\`\`\``;
    let prompt2 = `You are a Python unit test writer. Write a unittest.TestCase for the given function.

${formatBlock}

Rules:
1. Start with import unittest. Import the target function using its actual module name (e.g. from my_module import target_func). NEVER write literal "from MODULE import FUNCTION".
2. Each test method starts with test_ and uses self.assert*().
3. Do NOT copy or redefine the source function. Write test methods only.
4. No pytest. No top-level assert.
5. CRITICAL: If an input Raises an Exception (e.g. ValueError), you MUST use \`with self.assertRaises(ExceptionType):\` block. Do NOT assign the result of a call that raises an exception.
   - WRONG: \`with self.assertRaises(ValueError, 'msg'):\` \u2190 TypeError \u2014 NEVER pass a string as second arg to assertRaises!
6. TOKEN LENGTH BOUNDARY: The check is \`len(token) < 10\`. Use 'abc' (len=3) or '123456789' (len=9) as INVALID tokens. Use '1234567890' (len=10) or '123456789012' (len=12) as VALID tokens. Do NOT do long_string[:-1] expecting ValueError \u2014 it still has len >> 10!
7. Inputs are validated by LENGTH and STRUCTURE, NOT English meaning. "not a valid token" has len=17 which may PASS length checks. ALWAYS use Verified Real Execution Results to determine behavior.`;
    if (loopCount > 1 && survivedMutants) {
      prompt2 += `

Some mutants survived. Fix the tests to kill them:
${survivedMutants}`;
      const hints = getMutationOperatorHints(survivedMutants);
      if (hints) {
        prompt2 += `
${hints}`;
      }
    }
    return prompt2;
  }
  let prompt = `You are an expert Python Unit Testing Engineer. Write a comprehensive unittest.TestCase to kill all mutation testing survivors.

Output format:
<thinking>
(analysis in ${langName.toUpperCase()})
</thinking>

\`\`\`python
(complete unittest code)
\`\`\`

Guidelines:
- Use absolute import (e.g. from service_auth import login_user).
- Use unittest.mock (patch, MagicMock) for external dependencies.
- Cover edge cases: None, empty, boundary values, exception paths.
- Do NOT copy the source code into your output.
- assertRaises syntax: ONLY \`with self.assertRaises(ValueError):\` \u2014 NEVER pass a string: \`assertRaises(ValueError, 'msg')\` is a TypeError!
- TOKEN LENGTH BOUNDARY: \`len(token) < 10\` raises ValueError. Use 'abc' or '123456789' (len=9) as invalid; '1234567890' (len=10+) as valid.
`;
  prompt += `
FEW-SHOT EXAMPLES:
${formatFewShotForPrompt(getBaseFewShotExamples(), thinking)}
`;
  if (loopCount > 1 && survivedMutants) {
    prompt += `
Some mutants survived. Analyze and kill them:
${survivedMutants}`;
    const hints = getMutationOperatorHints(survivedMutants);
    if (hints) {
      prompt += `
${hints}`;
    }
  }
  return prompt;
}
function estimateTokens(text) {
  return Math.ceil(text.length / 3.5);
}
function distillDependency(dep, level) {
  if (level === 3) {
    return `Dependency: ${dep.name} (code too long, mock it)
`;
  }
  if (level === 2) {
    const sig = dep.code?.split("\n")[0] || `def ${dep.name}(...)`;
    return `Dependency: ${dep.name}
Signature: ${sig}
${dep.docstring ? `Docstring: ${dep.docstring}
` : ""}
`;
  }
  if (level === 1) {
    const lines = (dep.code || "").split("\n");
    const keyLines = lines.filter((l) => {
      const t2 = l.trim();
      return t2.startsWith("def ") || t2.startsWith("return ") || t2.startsWith("raise ");
    });
    return `Dependency: ${dep.name}
${dep.docstring ? `Docstring: ${dep.docstring}
` : ""}Key lines:
\`\`\`python
${keyLines.join("\n")}
\`\`\`

`;
  }
  return `Dependency: ${dep.name}
${dep.docstring ? `Docstring: ${dep.docstring}
` : ""}Source:
\`\`\`python
${dep.code}
\`\`\`

`;
}
function getUserPrompt(fileName, funcName, code, strategy, astContext, focusContexts, budgetTokens = 2e4, modelName = "") {
  const moduleName = fileName.replace(/\\/g, "/").split("/").pop()?.replace(".py", "") || "module";
  const thinking = useThinkingTag(modelName);
  let prompt = `Target file: ${fileName}
Target function: ${funcName}
`;
  if (astContext && !astContext.error) {
    prompt += `
Function info:
`;
    prompt += `- Name: ${astContext.name}
`;
    if (astContext.args && astContext.args.length > 0) {
      prompt += `- Parameters: ${astContext.args.join(", ")}
`;
      prompt += `- EXACT signature: ${astContext.name}(${astContext.args.join(", ")}). Call with EXACTLY ${astContext.args.length} argument(s).
`;
    } else {
      prompt += `- Parameters: NONE. This function takes ZERO arguments.
`;
      prompt += `- CRITICAL: ${astContext.name}() takes 0 arguments. ANY call like ${astContext.name}(x) WILL crash with TypeError. ONLY call as ${astContext.name}().
`;
    }
    if (astContext.docstring) {
      prompt += `- Docstring: ${astContext.docstring.trim()}
`;
    }
    if (astContext.class_name) {
      prompt += `- IMPORTANT: This is a METHOD of class \`${astContext.class_name}\`.
`;
      prompt += `  - Import: from ${moduleName} import ${astContext.class_name}
`;
      prompt += `  - Instantiate in setUp: self._obj = ${astContext.class_name}()
`;
      prompt += `  - Call method as: self._obj.${funcName}(...)  NOT as a standalone function.
`;
    }
    prompt += `- CRITICAL: Do NOT invent keyword arguments like total=... or payment_token=... that are not in the function signature.
`;
    prompt += `- TOKEN LENGTH RULE: The validation check is \`len(token) < 10\`.
`;
    prompt += `  - INVALID token (raises ValueError): len < 10. Examples: '' (len=0), 'abc' (len=3), '123456789' (len=9).
`;
    prompt += `  - VALID token (no error): len >= 10. Examples: '1234567890' (len=10), '123456789012' (len=12).
`;
    prompt += `  - DANGER: Do NOT slice a long token with [:-1] expecting ValueError \u2014 e.g. 'abcdefghijklm'[:-1] is still 12 chars, still VALID!
`;
    if (astContext.calls && astContext.calls.length > 0) {
      prompt += `- Calls: ${astContext.calls.join(", ")}
`;
    }
    const trace = astContext.traceResult;
    if (trace && !trace.load_error && (trace.examples.length > 0 || trace.errors.length > 0)) {
      prompt += `
Verified Real Execution Results (Use these EXACT values in your test assertions):
`;
      for (const ex of trace.examples.slice(0, 5)) {
        prompt += `  - Input: (${ex.args.join(", ")}) => Returns: ${ex.result} (Use: self.assertEqual(...))
`;
      }
      for (const er of trace.errors.slice(0, 5)) {
        prompt += `  - Input: (${er.args.join(", ")}) => Raises: ${er.exception}("${er.message}") (MUST Use: with self.assertRaises(${er.exception}): ...)
`;
      }
      if (trace.errors.length > 0 && trace.examples.length > 0) {
        prompt += `
CRITICAL BOUNDARY RULES (auto-derived from execution):
`;
        const errorLens = trace.errors.map((e) => {
          const firstArg = e.args[0] || "";
          const match = firstArg.match(/^['"](.*)['"]/);
          return match ? match[1].length : -1;
        }).filter((l) => l >= 0);
        const successLens = trace.examples.map((e) => {
          const firstArg = e.args[0] || "";
          const match = firstArg.match(/^['"](.*)['"]/);
          return match ? match[1].length : -1;
        }).filter((l) => l >= 0);
        if (errorLens.length > 0 && successLens.length > 0) {
          const maxErrLen = Math.max(...errorLens);
          const minSuccLen = Math.min(...successLens);
          if (maxErrLen < minSuccLen) {
            prompt += `  - First arg len <= ${maxErrLen}: ALWAYS raises ${trace.errors[0].exception}. Do NOT use assertEqual.
`;
            prompt += `  - First arg len >= ${minSuccLen}: ALWAYS returns normally. Do NOT use assertRaises.
`;
          }
        }
        const errorTypes = [...new Set(trace.errors.map((e) => e.exception))];
        for (const et of errorTypes) {
          const matchingErrors = trace.errors.filter((e) => e.exception === et);
          const inputExamples = matchingErrors.slice(0, 2).map((e) => `(${e.args.join(", ")})`).join(", ");
          prompt += `  - Inputs like ${inputExamples} ALWAYS raise ${et}. MUST use: with self.assertRaises(${et}):
`;
        }
        prompt += `
`;
      }
    }
    const trace2 = astContext.traceResult;
    if (trace2 && !trace2.load_error) {
      const allNone = trace2.examples.length > 0 && trace2.examples.every((e) => e.result === "None" || e.result === "null");
      const noErrors = trace2.errors.length === 0;
      if (allNone && noErrors) {
        prompt += `
IMPORTANT: This function ALWAYS returns None. Verified by real execution.
`;
        prompt += `- Do NOT use self.assertIsNotNone(). It WILL fail.
`;
        prompt += `- Do NOT use self.assertRaises(). No exceptions are raised.
`;
        prompt += `- ONLY valid assertions: self.assertIsNone(result) or self.assertEqual(result, None)

`;
      }
    }
    if (astContext.dependencyContexts && astContext.dependencyContexts.length > 0) {
      const ownArgSet = new Set(astContext.args || []);
      const forbiddenKwargs = [];
      for (const dep of astContext.dependencyContexts) {
        if (dep.args && Array.isArray(dep.args)) {
          for (const depArg of dep.args) {
            const cleanArg = depArg.replace(/[:\s].*/g, "").trim();
            if (cleanArg && cleanArg !== "self" && !ownArgSet.has(cleanArg)) {
              forbiddenKwargs.push(cleanArg);
            }
          }
        }
        if (dep.code) {
          const returnMatches = dep.code.matchAll(/return\s*\{([^}]+)\}/g);
          for (const match of returnMatches) {
            const keyMatches = match[1].matchAll(/['"]([a-zA-Z_]\w*)['"]/g);
            for (const km of keyMatches) {
              const key = km[1];
              if (key && !ownArgSet.has(key) && !["true", "false", "none"].includes(key.toLowerCase())) {
                forbiddenKwargs.push(key);
              }
            }
          }
        }
      }
      if (forbiddenKwargs.length > 0) {
        const fb = [...new Set(forbiddenKwargs)];
        prompt += `
\u26A0\uFE0F FORBIDDEN KWARGS: The following names belong to DEPENDENCY functions (as params or return dict keys), NOT to ${funcName}:
`;
        prompt += `  - Do NOT pass: ${fb.map((k) => `${k}=...`).join(", ")} to ${funcName}(...)
`;
        prompt += `  - Some of these (e.g. 'partner', 'claims') are RETURN VALUE KEYS from a dependency, NOT parameters of ${funcName}.
`;
        prompt += `  - ${funcName}() ONLY accepts: (${(astContext.args || []).join(", ")})

`;
      }
      prompt += `
\u{1F3AF} TARGET RETURN TYPE VS DEPENDENCY RETURN TYPE:
`;
      prompt += `  - Target \`${funcName}()\` returns its OWN value (inspect return statements in source code), NOT the raw dependency dictionary.
`;
      prompt += `  - If \`${funcName}()\` returns a string (e.g. "Welcome User ..."), assert a string, do NOT treat \`result\` as a dict.
`;
      const targetHasTry = /^\s*try\s*:/m.test(astContext.code || code);
      for (const dep of astContext.dependencyContexts) {
        if (dep.code && /^\s*raise\s+/m.test(dep.code) && !targetHasTry) {
          prompt += `
\u26A0\uFE0F UNCAUGHT DEPENDENCY EXCEPTION WARNING:
`;
          prompt += `  - Dependency \`${dep.name}()\` raises exceptions for invalid inputs (e.g. ValueError("Invalid token length")).
`;
          prompt += `  - Because \`${funcName}()\` does NOT use try/except to catch it, the exception propagates directly to caller!
`;
          prompt += `  - For invalid/short token tests, you MUST use \`with self.assertRaises(ValueError):\`.
`;
          prompt += `  - Do NOT assert that \`${funcName}()\` returns False or an error string on invalid inputs.
`;
        }
      }
      prompt += `
External dependencies:
`;
      for (const dep of astContext.dependencyContexts) {
        const remaining = budgetTokens - estimateTokens(prompt);
        let level;
        const full = distillDependency(dep, 0);
        const l1 = distillDependency(dep, 1);
        const l2 = distillDependency(dep, 2);
        if (remaining > estimateTokens(full) + 300) level = 0;
        else if (remaining > estimateTokens(l1) + 200) level = 1;
        else if (remaining > estimateTokens(l2) + 100) level = 2;
        else level = 3;
        prompt += distillDependency(dep, level);
        if (dep.callerContexts && dep.callerContexts.length > 0 && budgetTokens - estimateTokens(prompt) > 150) {
          prompt += `Call sites for ${dep.name} (these are how the DEPENDENCY is called internally, NOT parameters of ${funcName}):
`;
          for (const ctx of dep.callerContexts) {
            const argsStr = ctx.args.join(", ");
            const kwargsStr = Object.entries(ctx.kwargs).map(([k, v]) => `${k}=${v}`).join(", ");
            const callSig = [argsStr, kwargsStr].filter(Boolean).join(", ");
            prompt += `  ${ctx.caller_file} / ${ctx.caller_func}: ${dep.name}(${callSig})  \u2190 internal call, NOT an argument of ${funcName}
`;
          }
          prompt += `
`;
        }
      }
    }
    if (astContext.callerContexts && astContext.callerContexts.length > 0 && budgetTokens - estimateTokens(prompt) > 150) {
      prompt += `
This function is called with different arguments in the project. Cover all:
`;
      for (const ctx of astContext.callerContexts) {
        const argsStr = ctx.args.join(", ");
        const kwargsStr = Object.entries(ctx.kwargs).map(([k, v]) => `${k}=${v}`).join(", ");
        const callSig = [argsStr, kwargsStr].filter(Boolean).join(", ");
        prompt += `  ${ctx.caller_file} / ${ctx.caller_func}: ${astContext.name}(${callSig})
`;
      }
      prompt += `
`;
    }
    if (strategy === "large") {
      const remaining = budgetTokens - estimateTokens(prompt) - estimateTokens(astContext.code || code) - 200;
      if (remaining > 300) {
        const examples = getDynamicFewShotExamples(astContext, astContext.code || code);
        if (examples.length > 0) {
          const subset = remaining > 800 ? examples : examples.slice(0, 1);
          prompt += `
Examples:
${formatFewShotForPrompt(subset, thinking)}
`;
        }
      }
    }
  }
  {
    const src = astContext && !astContext.error ? astContext.code || code : code;
    const srcLines = src.split("\n");
    const sliceMatches = Array.from(src.matchAll(/(\w+)\[(-?\d*):(-?\d*)\]/g));
    if (sliceMatches.length > 0) {
      const sliceHints = [];
      for (const sm of sliceMatches) {
        const varName = sm[1];
        const start = sm[2];
        const end = sm[3];
        if (!start && end) {
          const n = parseInt(end, 10);
          if (!isNaN(n) && n > 0) {
            sliceHints.push(`\`${varName}[:${n}]\` takes the FIRST ${n} characters (e.g., '123456789012'[:${n}] == '${"123456789012".substring(0, n)}')`);
          }
        } else if (start && start.startsWith("-") && !end) {
          const n = Math.abs(parseInt(start, 10));
          sliceHints.push(`\`${varName}[-${n}:]\` takes the LAST ${n} characters (e.g., '123456789012'[-${n}:] == '${"123456789012".slice(-n)}')`);
        }
      }
      if (sliceHints.length > 0) {
        prompt += `
\u{1F52A} STRING SLICE CALCULATION HINTS (from source code):
`;
        for (const sh of [...new Set(sliceHints)]) {
          prompt += `  - ${sh}
`;
        }
        prompt += `  \u2192 Compute slice values EXACTLY as specified in the source code.
`;
      }
    }
    const raiseLines = srcLines.filter((l) => /^\s*raise\s+/.test(l));
    const exceptLines = srcLines.filter((l) => /^\s*except[\s:]/.test(l));
    if (raiseLines.length > 0) {
      prompt += `

\u26A0\uFE0F RAISE DETECTION (from static analysis):
`;
      for (const rl of raiseLines) {
        const m = rl.trim().match(/^raise\s+(\w+)\s*\(([^)]*)\)/);
        if (m) {
          prompt += `  - This function can raise ${m[1]}("${m[2].trim().replace(/["']/g, "")}")
`;
          prompt += `    \u2192 MUST test with: with self.assertRaises(${m[1]}): ${funcName}(...)
`;
          prompt += `    \u2192 Do NOT call assertEqual or assertIsNone on an input that triggers this raise.
`;
        }
      }
    } else if (exceptLines.length > 0) {
      prompt += `

\u2705 EXCEPTION HANDLING NOTE (from static analysis):
`;
      prompt += `  - ${funcName}() catches exceptions internally via try/except.
`;
      prompt += `  - This function NEVER raises exceptions to the caller.
`;
      prompt += `  - Do NOT use assertRaises() \u2014 always use assertEqual() to check return values.
`;
    }
    const returnLines = srcLines.filter((l) => /^\s*return\s+/.test(l) && !/^\s*return\s*$/.test(l));
    if (returnLines.length > 0 && returnLines.length <= 8) {
      prompt += `
\u2139\uFE0F RETURN VALUE STRUCTURE (from static analysis):
`;
      for (const rl of returnLines) {
        const cleaned = rl.trim().replace(/^return\s+/, "");
        prompt += `  - Possible return value: ${cleaned}
`;
      }
      prompt += `  \u2192 Use ONLY the above structures in assertEqual. Do NOT invent new dict keys or types.
`;
    }
    if (focusContexts && astContext) {
      if (astContext.dependencyContexts && astContext.dependencyContexts.length > 0) {
        const ownArgs = astContext.args || [];
        const ownArgSet2 = new Set(ownArgs);
        const fb2 = [];
        for (const dep of astContext.dependencyContexts) {
          if (dep.args && Array.isArray(dep.args)) {
            for (const a of dep.args) {
              const ca = a.replace(/[:\s].*/g, "").trim();
              if (ca && ca !== "self" && !ownArgSet2.has(ca)) {
                fb2.push(ca);
              }
            }
          }
          if (dep.code) {
            const rms = dep.code.matchAll(/return\s*\{([^}]+)\}/g);
            for (const rm of rms) {
              const kms = rm[1].matchAll(/['"]([a-zA-Z_]\w*)['"]/g);
              for (const km of kms) {
                const k = km[1];
                if (k && !ownArgSet2.has(k) && !["true", "false", "none"].includes(k.toLowerCase())) {
                  fb2.push(k);
                }
              }
            }
          }
        }
        const fbUniq2 = [...new Set(fb2)];
        if (fbUniq2.length > 0) {
          prompt += `
\u{1F6AB} REMINDER \u2014 FORBIDDEN KWARGS (do NOT pass these to ${funcName}):
`;
          prompt += `  ${fbUniq2.map((k) => `${k}=...`).join(", ")} are DEPENDENCY params/keys, NOT ${funcName}() params.
`;
          prompt += `  ${funcName}() ONLY accepts: (${ownArgs.join(", ")})
`;
        }
      }
      const traceRemind = astContext.traceResult;
      if (traceRemind && !traceRemind.load_error && (traceRemind.examples && traceRemind.examples.length > 0 || traceRemind.errors && traceRemind.errors.length > 0)) {
        prompt += `
\u26A0\uFE0F REMINDER \u2014 Verified Real Execution Results (MUST use these EXACT values in ALL new assertions):
`;
        for (const ex of (traceRemind.examples || []).slice(0, 5)) {
          prompt += `  - Input: (${ex.args.join(", ")}) => Returns: ${ex.result}  \u2190 use assertEqual
`;
        }
        for (const er of (traceRemind.errors || []).slice(0, 5)) {
          prompt += `  - Input: (${er.args.join(", ")}) => Raises: ${er.exception}  \u2190 use assertRaises
`;
        }
        prompt += `  \u2190 Do NOT invent inputs. Do NOT guess return values. Use ONLY the above.
`;
      }
    }
  }
  if (focusContexts) {
    prompt += `
Failed mutants to kill:
${focusContexts}
`;
    prompt += `(Add targeted asserts to kill each mutant. Do not rewrite the whole test file.)
`;
  } else {
    const src = astContext && !astContext.error ? astContext.code || code : code;
    prompt += `
Source code (write tests for this, do not copy it):
\`\`\`python
${src}
\`\`\``;
  }
  if (strategy === "small") {
    const className = astContext?.class_name;
    const importHint = className ? `from ${moduleName} import ${className}  # class method \u2014 use self._obj = ${className}(); self._obj.${funcName}(...)` : `from ${moduleName} import ${funcName}`;
    const trigger = thinking ? `

Import from: ${importHint}

Write the test file now:
<thinking>
` : `

Import from: ${importHint}

Write the test file now:
\`\`\`python
`;
    prompt += trigger;
  } else {
    prompt += `

Write the complete unittest test file now.
`;
  }
  return prompt;
}

// src/bug_fixer_prompt.ts
function getReviewerSystemPrompt() {
  return `You are an expert Python unittest REVIEWER and DEBUGGER.
Your job is to fix errors and assertion failures in the provided test file by comparing it against the ACTUAL TARGET SOURCE CODE and ERROR TRACEBACK.

CORE RULES:
1. PRESERVE PASSING TESTS: Do NOT delete or modify test methods that are already passing without errors.
2. FIX SEMANTIC ASSERTIONS: Look at the TARGET SOURCE CODE to find the true expected return value:
   - If the code returns a string (e.g. "Login Failed: Token too short"), use: self.assertEqual(result, "Login Failed: Token too short")
   - Do NOT guess or hallucinate return values. Check the return statements in the source code directly!
3. EXCEPTION HANDLING RULES:
   - If the target function (or an unhandled dependency) explicitly executes \`raise SomeError("...")\`, use:
     \`\`\`python
     with self.assertRaises(SomeError):
         func_under_test(...)
     \`\`\`
   - NEVER write \`self.assertRaises(SomeError, result)\` \u2014 this is a syntax/runtime error in unittest.
   - If the target function catches exceptions internally with \`try...except\` and returns an error message string, DO NOT use assertRaises! Use self.assertEqual(result, "expected string").
4. STRING SLICING & MATH:
   - Check exact slice indexing in source code:
     - \`token[:5]\` takes the FIRST 5 characters (e.g., '123456789012'[:5] == '12345').
     - \`token[-5:]\` takes the LAST 5 characters (e.g., '123456789012'[-5:] == '89012').
5. FUNCTION SIGNATURE & CALLS:
   - Call the target function ONLY with its valid declared parameters.
   - Do NOT pass undeclared keyword arguments (e.g., if func takes (order_id, token), do NOT pass provider="jwt").
6. IMPORTS \u2014 CRITICAL:
   - The MODULE NAME is provided in "=== TARGET FUNCTION INFO ===" below. Use EXACTLY that module name.
   - Correct: \`from core_utils import validate_and_format_token\`
   - WRONG: \`from validate_and_format_token import validate_and_format_token\` \u2190 NEVER name import after the function!
   - WRONG: \`from c:\\Users\\... import ...\` \u2190 NEVER use filesystem paths.
7. assertRaises SYNTAX \u2014 CRITICAL:
   - ONLY valid form: \`with self.assertRaises(ValueError):\` followed by the call on the next line.
   - NEVER pass a message string: \`with self.assertRaises(ValueError, 'msg'):\` \u2190 TypeError, FORBIDDEN!
8. TOKEN LENGTH BOUNDARY \u2014 CRITICAL:
   - \`len(token) < 10\` raises ValueError. Token length MUST be STRICTLY LESS THAN 10 to trigger the error.
   - A token of length 9 ("123456789") \u2192 raises ValueError.
   - A token of length 10 ("1234567890") \u2192 DOES NOT raise, processes normally.
   - A token of length 71 (any long string) \u2192 DOES NOT raise. Do NOT use [:-1] on a long string expecting ValueError!
   - Use short, explicit invalid tokens like "abc" (len=3) or "123456789" (len=9).
9. OUTPUT FORMAT:
   - Output the COMPLETE, corrected, runnable test file in a single \`\`\`python ... \`\`\` code block.`;
}
function getReviewerUserPrompt(brokenCode, errorOutput, funcName, funcArgs, sourceCode, astContext, moduleName = "module_name") {
  const sigLine = funcArgs.length > 0 ? `${funcName}(${funcArgs.join(", ")})` : `${funcName}()  \u2190 Takes ZERO arguments`;
  let prompt = `=== BROKEN TEST CODE ===
\`\`\`python
${brokenCode}
\`\`\`

`;
  prompt += `=== PRE-VERIFICATION ERROR LOG ===
\`\`\`text
${errorOutput.substring(0, 2e3)}
\`\`\`

`;
  prompt += `=== TARGET FUNCTION INFO ===
`;
  prompt += `- Module Name: ${moduleName}
`;
  prompt += `- Import Statement: from ${moduleName} import ${funcName}
`;
  prompt += `- Exact Signature: ${sigLine}

`;
  if (sourceCode) {
    prompt += `=== TARGET SOURCE CODE (Check return values and raises here) ===
\`\`\`python
${sourceCode.trim()}
\`\`\`

`;
  }
  if (astContext?.dependencyContexts && astContext.dependencyContexts.length > 0) {
    prompt += `=== DEPENDENCY SOURCE CODE ===
`;
    for (const dep of astContext.dependencyContexts.slice(0, 3)) {
      if (dep.code) {
        prompt += `\`\`\`python
# Dependency: ${dep.name}
${dep.code.trim()}
\`\`\`
`;
      }
    }
    prompt += `
`;
  }
  const trace = astContext?.traceResult;
  if (trace && !trace.load_error && (trace.examples?.length > 0 || trace.errors?.length > 0)) {
    prompt += `=== VERIFIED REAL EXECUTION TRACE ===
`;
    for (const ex of (trace.examples || []).slice(0, 5)) {
      prompt += `  - Input: (${ex.args.join(", ")}) => Returned: ${ex.result}
`;
    }
    for (const er of (trace.errors || []).slice(0, 5)) {
      prompt += `  - Input: (${er.args.join(", ")}) => Raised: ${er.exception}("${er.message}")
`;
    }
    prompt += `
`;
  }
  prompt += `INSTRUCTION:
Carefully read the error log and the target source code. Fix all failures and errors, verify slices and assertions, and output the complete corrected test file in a \`\`\`python code block.`;
  return prompt;
}

// src/semantic_analyzer_prompt.ts
function getSemanticAnalyzerSystemPrompt() {
  return `You are a Python static code analyzer specializing in cross-function dependency analysis.

Your task is to analyze how a TARGET FUNCTION uses its DEPENDENCY FUNCTIONS in its specific calling context, then identify:
1. What each dependency always returns when called by this specific target function
2. Which branches in the target function are unreachable through normal calls
3. Which mutation types would be logically equivalent (unkillable without mocking)

ANALYSIS RULES:
- Focus on the EXACT arguments the target function passes to each dependency (e.g. provider="jwt")
- Trace through the dependency source code with those fixed arguments to determine the fixed return value
- A path is "unreachable" if the dependency fixed return value makes a condition always True or always False
- An equivalent mutant is one that produces the same observable behavior in ALL reachable paths

OUTPUT: Return ONLY a valid JSON object with this exact schema:
{
  "dependency_behaviors": [
    {
      "name": "<function_name>",
      "when_caller_passes": "<description of fixed args passed by target>",
      "always_returns": "<exact return value or structure>",
      "can_raise": ["<exception> when <condition>"]
    }
  ],
  "unreachable_paths": [
    {
      "condition": "<branch condition that is always True/False>",
      "reason": "<why it cannot be False/True in normal calls>"
    }
  ],
  "equivalent_mutant_candidates": [
    {
      "description": "<mutation type, e.g. If_Statement to If_True on result[valid]>",
      "reason": "<why this mutation has no observable effect>"
    }
  ],
  "mock_required_for": [
    {
      "path": "<description of unreachable path>",
      "mock_target": "<module.function patch path>",
      "example": "<one-line mock example>"
    }
  ]
}`;
}
function getSemanticAnalyzerUserPrompt(targetSource, dependencies, callSites) {
  let prompt = "=== TARGET FUNCTION SOURCE CODE ===\n```python\n" + targetSource.trim() + "\n```\n\n";
  if (dependencies.length > 0) {
    prompt += "=== DEPENDENCY SOURCE CODE ===\n";
    for (const dep of dependencies.slice(0, 4)) {
      prompt += "```python\n# Dependency: " + dep.name + "\n" + dep.code.trim() + "\n```\n";
    }
    prompt += "\n";
  }
  if (callSites && callSites.length > 0) {
    prompt += "=== HOW TARGET CALLS DEPENDENCIES ===\n";
    for (const cs of callSites.slice(0, 6)) {
      prompt += "  In " + cs.caller_func + ": " + cs.call_expr + "\n";
    }
    prompt += "\n";
  }
  prompt += "TASK: Analyze the target function dependency usage and return the JSON analysis as specified.\n";
  prompt += "Focus on: What does each dependency ALWAYS return when called by this specific target? Which if-conditions are therefore always True/False?";
  return prompt;
}
function parseSemanticAnalysis(llmResponse) {
  try {
    const trimmed = llmResponse.trim();
    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed);
    }
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return JSON.parse(codeBlockMatch[1].trim());
    }
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
  }
  return null;
}
function formatSemanticContextForPrompt(analysis) {
  let out = "=== SEMANTIC ANALYSIS (Pre-computed - do NOT guess, use these facts) ===\n";
  if (analysis.dependency_behaviors.length > 0) {
    out += "\nDependency Behaviors in This Caller Context:\n";
    for (const dep of analysis.dependency_behaviors) {
      out += "  * " + dep.name + " (called with " + dep.when_caller_passes + "):\n";
      out += "    -> Always returns: " + dep.always_returns + "\n";
      if (dep.can_raise.length > 0) {
        out += "    -> Can raise: " + dep.can_raise.join("; ") + "\n";
      }
    }
  }
  if (analysis.unreachable_paths.length > 0) {
    out += "\nUnreachable Paths (Do NOT write tests expecting these):\n";
    for (const up of analysis.unreachable_paths) {
      out += '  X "' + up.condition + '" -- ' + up.reason + "\n";
    }
  }
  if (analysis.equivalent_mutant_candidates.length > 0) {
    out += "\nProbable Equivalent Mutants (These may be unkillable without mock.patch):\n";
    for (const em of analysis.equivalent_mutant_candidates) {
      out += "  ~ " + em.description + ": " + em.reason + "\n";
    }
  }
  if (analysis.mock_required_for && analysis.mock_required_for.length > 0) {
    out += "\nPaths Requiring mock.patch to Test:\n";
    for (const mrf of analysis.mock_required_for) {
      out += "  [mock] Path: " + mrf.path + "\n";
      out += "         Patch target: " + mrf.mock_target + "\n";
      out += "         Example: " + mrf.example + "\n";
    }
  }
  return out + "\n";
}

// src/mutant_triage_prompt.ts
function getMutantTriageSystemPrompt() {
  return `You are a mutation testing expert and Python unit test specialist.

Your task is to analyze survived mutation testing results and triage each mutant:
- EQUIVALENT: The mutant is logically equivalent to the original in all reachable paths (unkillable without mocking)
- KILLABLE: A specific test case exists that can detect this mutation

For KILLABLE mutants, provide the EXACT Python test method code (starting with "def test_kill_...") that would make the mutant fail.

EQUIVALENT MUTANT DETECTION RULES:
1. If a condition is ALWAYS True/False due to fixed dependency return values -> likely EQUIVALENT
2. If the mutated path is unreachable through normal function calls -> likely EQUIVALENT
3. Consider mock.patch as a feasible option before declaring EQUIVALENT

KILLABLE MUTANT RULES:
1. If a branch condition is testable with direct inputs -> KILLABLE via direct test
2. If reachable with mock.patch of a dependency -> KILLABLE via mock
3. If it changes a comparison operator -> KILLABLE by testing boundary values

OUTPUT: Return ONLY a valid JSON object:
{
  "verdicts": [
    {
      "mutant": "<exact mutant description from report>",
      "verdict": "EQUIVALENT or KILLABLE",
      "reason": "<concise explanation>",
      "kill_test": "<complete Python def test_kill_xxx(self): method as string, or null>"
    }
  ],
  "has_killable": true,
  "equivalent_count": 0
}

For kill_test code:
- Use self.assert* methods only
- Include mock.patch usage if needed (assume from unittest.mock import patch is available)
- The method must be self-contained`;
}
function getMutantTriageUserPrompt(survivedMutants, targetSource, currentTestCode, moduleName, funcName, semanticContext) {
  let prompt = "=== SURVIVED MUTANTS TO TRIAGE ===\n" + survivedMutants + "\n\n";
  prompt += "=== TARGET FUNCTION SOURCE CODE ===\n```python\n" + targetSource.trim() + "\n```\n\n";
  if (semanticContext) {
    prompt += semanticContext + "\n";
  }
  prompt += "=== CURRENT TEST FILE (what has already been tried) ===\n```python\n" + currentTestCode.slice(0, 3e3) + "\n```\n\n";
  prompt += "=== CONTEXT ===\n";
  prompt += "Module name: " + moduleName + "\n";
  prompt += "Function under test: " + funcName + "\n";
  prompt += "Import to use: from " + moduleName + " import " + funcName + "\n\n";
  prompt += "TASK: For each survived mutant above, determine EQUIVALENT vs KILLABLE, and provide kill_test code for KILLABLE ones.";
  return prompt;
}
function parseMutantTriageResult(llmResponse) {
  try {
    const trimmed = llmResponse.trim();
    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed);
    }
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return JSON.parse(codeBlockMatch[1].trim());
    }
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
  }
  return null;
}
function extractKillTestMethods(result) {
  return result.verdicts.filter((v) => v.verdict === "KILLABLE" && v.kill_test).map((v) => v.kill_test).join("\n\n");
}
function formatEquivalentMutantsReport(result) {
  const eqs = result.verdicts.filter((v) => v.verdict === "EQUIVALENT");
  if (eqs.length === 0) {
    return "";
  }
  let out = "\n### Equivalent Mutants (Logically unkillable - excluded from score denominator)\n\n";
  for (const eq of eqs) {
    out += "- `" + eq.mutant + "`\n  > " + eq.reason + "\n";
  }
  return out + "\n";
}

// src/testMerger.ts
function mergeTestSnippets(snippets, className = "TestMergedSuite") {
  const allImportsSet = /* @__PURE__ */ new Set();
  allImportsSet.add("import unittest");
  const setupBodies = [];
  const teardownBodies = [];
  const testMethods = [];
  const helperMethods = [];
  const seenMethodNames = /* @__PURE__ */ new Map();
  for (let sIdx = 0; sIdx < snippets.length; sIdx++) {
    const snippet = snippets[sIdx];
    const lines = snippet.split("\n");
    let currentMethodName = "";
    let currentMethodLines = [];
    const flushCurrentMethod = () => {
      if (!currentMethodName || currentMethodLines.length === 0) return;
      const body = currentMethodLines.join("\n");
      if (currentMethodName === "setUp") {
        setupBodies.push(body);
      } else if (currentMethodName === "tearDown") {
        teardownBodies.push(body);
      } else if (currentMethodName.startsWith("test_")) {
        let finalName = currentMethodName;
        const count = seenMethodNames.get(currentMethodName) || 0;
        seenMethodNames.set(currentMethodName, count + 1);
        if (count > 0) {
          finalName = `${currentMethodName}_site${sIdx + 1}`;
        }
        const renamedBody = body.replace(new RegExp(`def\\s+${currentMethodName}\\s*\\(`), `def ${finalName}(`);
        testMethods.push(renamedBody);
      } else {
        helperMethods.push(body);
      }
      currentMethodName = "";
      currentMethodLines = [];
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("import ") || trimmed.startsWith("from ")) {
        if (!trimmed.includes("module_name") && !trimmed.includes("MODULE_NAME")) {
          allImportsSet.add(trimmed);
        }
        continue;
      }
      const methodMatch = line.match(/^(\s*)def\s+([a-zA-Z0-9_]+)\s*\(/);
      if (methodMatch) {
        flushCurrentMethod();
        currentMethodName = methodMatch[2];
        currentMethodLines = [line];
        continue;
      }
      if (currentMethodName) {
        if (line.match(/^class\s+/) || line.match(/^if\s+__name__/)) {
          flushCurrentMethod();
          continue;
        }
        if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("	") && !line.startsWith("#")) {
          flushCurrentMethod();
          continue;
        }
        currentMethodLines.push(line);
      }
    }
    flushCurrentMethod();
  }
  const mergedClassLines = [];
  if (setupBodies.length > 0) {
    mergedClassLines.push(`    def setUp(self):`);
    for (const s of setupBodies) {
      const inner = s.split("\n").slice(1).map((l) => "    " + l).join("\n");
      if (inner.trim()) mergedClassLines.push(inner);
    }
  }
  if (teardownBodies.length > 0) {
    mergedClassLines.push(`    def tearDown(self):`);
    for (const t2 of teardownBodies) {
      const inner = t2.split("\n").slice(1).map((l) => "    " + l).join("\n");
      if (inner.trim()) mergedClassLines.push(inner);
    }
  }
  const allMethods = [...mergedClassLines, ...helperMethods, ...testMethods];
  const mergedCode = [
    Array.from(allImportsSet).join("\n"),
    "",
    `class ${className}(unittest.TestCase):`,
    allMethods.length > 0 ? allMethods.join("\n\n") : "    pass",
    "",
    `if __name__ == '__main__':`,
    `    unittest.main()`
  ].join("\n");
  return {
    mergedCode,
    totalMethodsCount: testMethods.length
  };
}

// src/orchestrator.ts
var path3 = __toESM(require("path"));
var fs3 = __toESM(require("fs"));
var import_child_process2 = require("child_process");
async function assessFunctionComplexity(filePath, funcName) {
  const script = path3.join(__dirname, "..", "python_scripts", "complexity_assessor.py");
  try {
    const { stdout } = await runSpawn("python", [script, filePath, funcName], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    return JSON.parse(stdout.trim());
  } catch {
    return { score: 30, level: "Moderate", reasons: ["parse error, defaulting to Moderate"] };
  }
}
function resolveTier(modelParamBillion, complexity, userTier) {
  if (userTier && userTier !== "auto") {
    const n = parseInt(userTier.replace("tier", ""));
    if (n >= 1 && n <= 4) return n;
  }
  if (isNaN(modelParamBillion)) return 4;
  if (modelParamBillion <= 4) return 1;
  if (modelParamBillion <= 20) return complexity > 65 ? 1 : 2;
  if (modelParamBillion <= 60) return complexity <= 40 ? 2 : 3;
  return complexity <= 60 ? 3 : 4;
}
async function runWithConcurrencyLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      if (isAborted) break;
      const i = idx++;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        console.error(`[\u4E26\u884C] \u4EFB\u52D9 ${i} \u57F7\u884C\u5931\u6557: ${err?.message ?? err}`);
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
function isStubFunction(complexityScore, astContext) {
  if (complexityScore === 0) return true;
  if (!astContext || astContext.error) return false;
  const code = (astContext.code || "").trim();
  const allLines = code.split("\n");
  const bodyLines = allLines.slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const codeLines = [];
  let inDocstring = false;
  for (const l of bodyLines) {
    const tripleDouble = (l.match(/"""/g) || []).length;
    const tripleSingle = (l.match(/'''/g) || []).length;
    if (!inDocstring && (l.startsWith('"""') || l.startsWith("'''"))) {
      if (tripleDouble >= 2 || tripleSingle >= 2) continue;
      inDocstring = true;
      continue;
    }
    if (inDocstring) {
      if (l.includes('"""') || l.includes("'''")) inDocstring = false;
      continue;
    }
    codeLines.push(l);
  }
  if (codeLines.length === 0) return true;
  if (codeLines.length === 1 && /^pass$/.test(codeLines[0])) return true;
  if (codeLines.length === 1 && /^return\s+(None|True|False|-?\d+(\.\d+)?|['"]{1}[^'"]*['"]{1})$/.test(codeLines[0])) return true;
  const hasBranch = codeLines.some((l) => /^(if|elif|else:|for\s|while\s|try:|except|with\s|raise\s|yield\s)/.test(l));
  const hasExternalCall = codeLines.some((l) => {
    const stripped = l.replace(/^return\s+/, "").replace(/^[a-zA-Z_]\w*\s*=\s*/, "");
    return /[a-zA-Z_]\w*\s*\(/.test(stripped);
  });
  const shortBody = codeLines.length <= 6;
  if (!hasBranch && !hasExternalCall && shortBody) return true;
  return false;
}
async function runMockScaffold(filePath, funcName, traceResult) {
  const script = path3.join(__dirname, "..", "python_scripts", "mock_scaffold_generator.py");
  const args = ["python", script, filePath, funcName];
  if (traceResult) args.push(JSON.stringify(traceResult));
  try {
    const { stdout } = await runSpawn(
      "python",
      traceResult ? [script, filePath, funcName, JSON.stringify(traceResult)] : [script, filePath, funcName],
      { env: { ...process.env, PYTHONIOENCODING: "utf-8" } }
    );
    const parsed = JSON.parse(stdout.trim());
    return parsed.scaffold ? parsed : null;
  } catch {
    return null;
  }
}
var activeAbortControllers = /* @__PURE__ */ new Set();
var activeProcesses = /* @__PURE__ */ new Set();
var currentMutpyProcess = null;
var isAborted = false;
function killProcessTree(proc) {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    (0, import_child_process2.spawn)("taskkill", ["/pid", proc.pid.toString(), "/T", "/F"]);
  } else {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }
}
function runSpawn(command, args, options) {
  return new Promise((resolve, reject) => {
    if (isAborted) return reject(new Error("\u4F7F\u7528\u8005\u5F37\u5236\u4E2D\u6B62"));
    const proc = (0, import_child_process2.spawn)(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      shell: false
    });
    activeProcesses.add(proc);
    let stdout = "";
    let stderr = "";
    let timer = null;
    if (options.timeout) {
      timer = setTimeout(() => {
        killProcessTree(proc);
        reject(new Error(`\u57F7\u884C\u8D85\u6642 (\u8D85\u904E ${options.timeout / 1e3} \u79D2)`));
      }, options.timeout);
    }
    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      activeProcesses.delete(proc);
      resolve({ stdout, stderr, code });
    });
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      activeProcesses.delete(proc);
      reject(err);
    });
  });
}
var currentModelProfile = {
  paramSize: "unknown",
  contextLength: 4096,
  budgetTokens: 2e3
  // safe default
};
function estimateTokens2(text) {
  return Math.ceil(text.length / 3.5);
}
function getContextBudget(profile) {
  const ctx = profile.contextLength;
  const usable = Math.floor(ctx * 0.7);
  const paramBillion = parseFloat(profile.paramSize);
  if (!isNaN(paramBillion)) {
    if (paramBillion <= 2) return Math.min(usable, 1800);
    if (paramBillion <= 7) return Math.min(usable, 3500);
    if (paramBillion <= 13) return Math.min(usable, 6e3);
    return Math.min(usable, 12e3);
  }
  return Math.min(usable, 2e4);
}
function activate(context) {
  const sidebarProvider = new MutationViewProvider(context.secrets);
  context.subscriptions.push(
    vscode3.window.registerWebviewViewProvider(MutationViewProvider.viewType, sidebarProvider)
  );
  const runTestCmd = vscode3.commands.registerCommand(
    "llm-unit-test.runCaptureAndTest",
    async (params) => {
      isAborted = false;
      const log = (text) => sidebarProvider.webview?.postMessage({ command: "appendLog", text });
      const now = /* @__PURE__ */ new Date();
      const dateStr = now.toISOString().split("T")[0].replace(/-/g, "_") + "_" + now.toLocaleTimeString("en-GB", { hour12: false }).substring(0, 5).replace(":", "_");
      params.sessionDate = dateStr;
      if (!params.funcName) {
        const funcInfos = await extractFunctionsWithAst(params.filePath);
        const funcs = funcInfos.map((f) => f.fullName);
        if (funcs.length === 0) {
          log(`[\u7CFB\u7D71] \u5728\u6A94\u6848 ${path3.basename(params.filePath)} \u4E2D\u627E\u4E0D\u5230\u4EFB\u4F55\u51FD\u5F0F\uFF0C\u7121\u6CD5\u9032\u884C\u5168\u6A94\u6848\u6E2C\u8A66\u3002`);
        } else {
          const PARALLEL_LIMIT = 3;
          log(`[\u7CFB\u7D71] \u958B\u555F\u300C\u5168\u6A94\u6848\u6383\u63CF\u6A21\u5F0F\u300D\uFF01\u5171\u627E\u5230 ${funcs.length} \u500B\u51FD\u5F0F\uFF0C\u6E96\u5099\u4EE5\u6700\u591A ${PARALLEL_LIMIT} \u500B\u4E26\u884C\u4F5C\u696D\u9032\u884C\u8655\u7406...`);
          const tasks = funcs.map((fName, i) => async () => {
            if (isAborted) return;
            log(`
======================================================`);
            log(`[\u7CFB\u7D71] \u6B63\u5728\u8655\u7406\u51FD\u5F0F (${i + 1}/${funcs.length}): ${fName}`);
            log(`======================================================`);
            const singleParams = { ...params, funcName: fName };
            await executeSingleFileAnalysis(singleParams, log, sidebarProvider);
          });
          await runWithConcurrencyLimit(tasks, PARALLEL_LIMIT);
          log(`
[\u7CFB\u7D71] \u{1F389} \u5168\u6A94\u6848\u6383\u63CF\u8207\u6E2C\u8A66\u57F7\u884C\u5B8C\u7562\uFF01`);
        }
      } else {
        await executeSingleFileAnalysis(params, log, sidebarProvider);
      }
      sidebarProvider.webview?.postMessage({ command: "analysisFinished" });
    }
  );
  const runBatchCmd = vscode3.commands.registerCommand(
    "llm-unit-test.runBatchAnalysis",
    async (params) => {
      isAborted = false;
      const log = (text) => sidebarProvider.webview?.postMessage({ command: "appendLog", text });
      try {
        const now = /* @__PURE__ */ new Date();
        const dateStr = now.toISOString().split("T")[0].replace(/-/g, "_") + "_" + now.toLocaleTimeString("en-GB", { hour12: false }).substring(0, 5).replace(":", "_");
        const pyFiles = await findPythonFilesInDir(params.batchPath);
        if (pyFiles.length === 0) {
          log(`[\u7CFB\u7D71] \u5728\u76EE\u9304 ${params.batchPath} \u4E2D\u627E\u4E0D\u5230\u4EFB\u4F55 Python \u6A94\u6848\u3002`);
          return;
        }
        log(`[\u7CFB\u7D71] \u958B\u59CB\u6279\u6B21\u6E2C\u8A66\uFF0C\u5171\u627E\u5230 ${pyFiles.length} \u500B Python \u6A94\u6848\u3002`);
        const projectName = path3.basename(params.batchPath);
        const PARALLEL_LIMIT = 3;
        const allTasks = [];
        for (let i = 0; i < pyFiles.length; i++) {
          if (isAborted) break;
          const file = pyFiles[i];
          const funcInfos = await extractFunctionsWithAst(file);
          const funcs = funcInfos.map((f) => f.fullName);
          if (funcs.length === 0) {
            log(`[\u7CFB\u7D71] \u6A94\u6848 ${path3.basename(file)} \u4E2D\u7121\u53EF\u6E2C\u8A66\u7684\u51FD\u5F0F\uFF0C\u8DF3\u904E\u3002`);
            continue;
          }
          for (let j = 0; j < funcs.length; j++) {
            allTasks.push({ file, fName: funcs[j], fileIdx: i, funcIdx: j, totalFuncs: funcs.length });
          }
        }
        log(`[\u7CFB\u7D71] \u6279\u6B21\u6383\u63CF\u5B8C\u6210\uFF0C\u5171 ${allTasks.length} \u500B\u51FD\u5F0F\u4EFB\u52D9\uFF0C\u4EE5\u6700\u591A ${PARALLEL_LIMIT} \u500B\u4E26\u884C\u4F5C\u696D\u8655\u7406...`);
        const batchTaskFns = allTasks.map(({ file, fName, fileIdx, funcIdx, totalFuncs }) => async () => {
          if (isAborted) return;
          log(`
--- \u6279\u6B21\u4EFB\u52D9\u9032\u5EA6: \u6A94\u6848 ${fileIdx + 1}/${pyFiles.length}, \u51FD\u5F0F ${funcIdx + 1}/${totalFuncs} ---`);
          log(`[\u7CFB\u7D71] \u76EE\u6A19\u51FD\u5F0F: ${fName}`);
          const singleParams = { ...params, filePath: file, funcName: fName, projectName, sessionDate: dateStr };
          await executeSingleFileAnalysis(singleParams, log, sidebarProvider);
        });
        await runWithConcurrencyLimit(batchTaskFns, PARALLEL_LIMIT);
        log(`
[\u7CFB\u7D71] \u{1F389} \u6279\u6B21\u81EA\u52D5\u5316\u6E2C\u8A66\u57F7\u884C\u5B8C\u7562\uFF01`);
      } catch (error) {
        log(`[\u932F\u8AA4] \u6279\u6B21\u57F7\u884C\u767C\u751F\u932F\u8AA4: ${error}`);
      } finally {
        sidebarProvider.webview?.postMessage({ command: "analysisFinished" });
      }
    }
  );
  const abortTestCmd = vscode3.commands.registerCommand("llm-unit-test.abortTest", () => {
    if (!isAborted) {
      isAborted = true;
      for (const ctrl of activeAbortControllers) ctrl.abort();
      activeAbortControllers.clear();
      if (currentMutpyProcess) killProcessTree(currentMutpyProcess);
      for (const proc of activeProcesses) killProcessTree(proc);
      activeProcesses.clear();
    }
  });
  const updateModelProfileCmd = vscode3.commands.registerCommand("llm-unit-test.updateModelProfile", (profile) => {
    currentModelProfile = {
      paramSize: profile.paramSize,
      contextLength: profile.contextLength,
      budgetTokens: getContextBudget({ paramSize: profile.paramSize, contextLength: profile.contextLength, budgetTokens: 0 })
    };
  });
  context.subscriptions.push(runTestCmd, runBatchCmd, abortTestCmd, updateModelProfileCmd);
}
async function extractAstContext(targetPath, funcName) {
  const pythonScript = path3.join(__dirname, "..", "python_scripts", "ast_extractor.py");
  try {
    const { stdout, stderr, code } = await runSpawn("python", [pythonScript, targetPath, funcName], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    if (code !== 0) {
      return { error: stdout || stderr, name: "", args: [], docstring: "", calls: [], code: "" };
    }
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
async function findCallerContexts(funcName, projectRoot) {
  const pythonScript = path3.join(__dirname, "..", "python_scripts", "ast_caller_finder.py");
  try {
    const { stdout } = await runSpawn("python", [pythonScript, funcName, projectRoot], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
async function runDynamicTrace(filePath, funcName, callerArgs) {
  const pythonScript = path3.join(__dirname, "..", "python_scripts", "dynamic_tracer.py");
  const args = [pythonScript, filePath, funcName];
  if (callerArgs && callerArgs.length > 0) {
    const knownInputs = callerArgs.map((ctx) => ctx.args);
    args.push(JSON.stringify(knownInputs));
  }
  try {
    const { stdout } = await runSpawn("python", args, {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      timeout: 15e3
    });
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}
async function requestLlmApi(params, systemPrompt, userPrompt, log) {
  let apiUrl = "";
  let bodyData = {};
  let headers = { "Content-Type": "application/json" };
  if (params.envType === "local") {
    const baseUrl = params.ollamaUrl || "http://127.0.0.1:11434";
    apiUrl = `${baseUrl.replace(/\/$/, "")}/api/generate`;
    bodyData = { model: params.modelName, system: systemPrompt, prompt: userPrompt, stream: false };
  } else if (params.envType === "custom") {
    apiUrl = params.customUrl || "https://api.openai.com/v1/chat/completions";
    bodyData = {
      model: params.modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    };
    if (params.customKey) {
      headers["Authorization"] = `Bearer ${params.customKey}`;
    }
  } else {
    const config = vscode3.workspace.getConfiguration("llmUnitTest");
    const keys = config.get("apiKeys", {});
    const actualKey = keys[params.modelName];
    apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.modelName)}:generateContent?key=${actualKey}`;
    bodyData = { contents: [{ parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }] };
  }
  const controller = new AbortController();
  activeAbortControllers.add(controller);
  const timeoutId = setTimeout(() => {
    if (activeAbortControllers.has(controller)) {
      controller.abort();
      log(`[\u8B66\u544A] API \u8ACB\u6C42\u8D85\u6642 (\u8D85\u904E ${params.timeoutSeconds} \u79D2)`);
    }
  }, params.timeoutSeconds * 1e3);
  let response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyData),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
    activeAbortControllers.delete(controller);
  }
  if (isAborted) throw new Error("\u4F7F\u7528\u8005\u5F37\u5236\u4E2D\u6B62");
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API \u4F3A\u670D\u5668\u932F\u8AA4 (HTTP ${response.status}): ${errText}`);
  }
  const resJson = await response.json();
  if (params.envType === "local") {
    return resJson.response || "";
  } else if (params.envType === "custom") {
    const choices = resJson.choices;
    if (choices && choices[0]?.message?.content) {
      return choices[0].message.content;
    } else if (resJson.error) {
      throw new Error(resJson.error.message || "\u81EA\u8A02 API \u547C\u53EB\u5931\u6557");
    } else {
      throw new Error("\u7121\u6CD5\u89E3\u6790\u7684 API \u56DE\u50B3\u683C\u5F0F: " + JSON.stringify(resJson));
    }
  } else {
    const candidates = resJson.candidates;
    if (candidates && candidates[0]?.content?.parts?.[0]?.text) {
      return candidates[0].content.parts[0].text;
    } else if (resJson.error) {
      throw new Error(resJson.error.message || "Gemini \u547C\u53EB\u5931\u6557");
    } else {
      throw new Error("\u7121\u6CD5\u89E3\u6790\u7684 API \u56DE\u50B3\u683C\u5F0F: " + JSON.stringify(resJson));
    }
  }
}
function cleanCodeBlock(code) {
  let clean = stripUniformIndent(code);
  clean = clean.replace(/\[\/?\s*PYTHON\s*\]/gi, "");
  clean = clean.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/g, "").trim();
  const mainMatch = clean.match(/if\s+__name__\s*==\s*['"]__main__['"]\s*:\s*\n?\s*unittest\.main\(\)/);
  if (mainMatch && mainMatch.index !== void 0) {
    const endIdx = mainMatch.index + mainMatch[0].length;
    clean = clean.substring(0, endIdx);
  }
  return clean.trim();
}
function sanitizeLlmResponse(rawCode) {
  let cleanCode = rawCode.trim();
  const thinkingCount = (cleanCode.match(/<thinking>/g) || []).length;
  if (thinkingCount >= 3) {
    return "";
  }
  const emojiLoopMatch = cleanCode.match(/([\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF])\1{7,}/u);
  if (emojiLoopMatch) {
    return "";
  }
  const blocks = [];
  const pyRegex = /```python([\s\S]*?)```/g;
  let match;
  while ((match = pyRegex.exec(cleanCode)) !== null) {
    blocks.push(match[1].trim());
  }
  if (blocks.length === 0) {
    const bracketPyRegex = /\[PYTHON\]([\s\S]*?)\[\/PYTHON\]/gi;
    while ((match = bracketPyRegex.exec(cleanCode)) !== null) {
      blocks.push(match[1].trim());
    }
  }
  if (blocks.length === 0) {
    const genericRegex = /```([\s\S]*?)```/g;
    while ((match = genericRegex.exec(cleanCode)) !== null) {
      blocks.push(match[1].trim());
    }
  }
  if (blocks.length > 0) {
    for (const block of blocks) {
      if (block.includes("unittest") || block.includes("TestCase")) {
        return cleanCodeBlock(block);
      }
    }
    return cleanCodeBlock(blocks[blocks.length - 1]);
  }
  return cleanCodeBlock(cleanCode);
}
function stripUniformIndent(code) {
  const lines = code.split("\n");
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  if (nonEmptyLines.length === 0) return code;
  let minIndent = Infinity;
  for (const line of nonEmptyLines) {
    const leadingSpaces = line.match(/^( *)/)?.[1].length || 0;
    if (leadingSpaces < minIndent) minIndent = leadingSpaces;
  }
  if (minIndent > 0 && minIndent < Infinity) {
    return lines.map((l) => l.substring(minIndent)).join("\n");
  }
  return code;
}
function rescueToUnittest(rawCode, srcFilePath, funcName) {
  const moduleName = path3.basename(srcFilePath, ".py");
  const targetFunc = funcName || moduleName;
  const lines = rawCode.split("\n").map((l) => l.replace(/^>>>\s?/, "").trim()).filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("..."));
  const testMethods = [];
  let methodIndex = 1;
  let currentContext = [];
  for (const line of lines) {
    let testBody = "";
    if (line.startsWith("assert ")) {
      const assertBody = line.substring(7).trim();
      const parts = assertBody.split(",");
      const expr = parts[0].trim();
      const msg = parts.length > 1 ? `, ${parts.slice(1).join(",").trim()}` : "";
      const eqMatch = expr.match(/^(.+?)\s*==\s*(.+)$/);
      const neqMatch = expr.match(/^(.+?)\s*!=\s*(.+)$/);
      if (eqMatch) {
        testBody = `self.assertEqual(${eqMatch[1].trim()}, ${eqMatch[2].trim()}${msg})`;
      } else if (neqMatch) {
        testBody = `self.assertNotEqual(${neqMatch[1].trim()}, ${neqMatch[2].trim()}${msg})`;
      } else {
        testBody = `self.assertTrue(${expr}${msg})`;
      }
    } else if (line.startsWith("print(") || line.startsWith("import ") || line.startsWith("from ")) {
      continue;
    } else if (line.startsWith("def ") || line.startsWith("class ") || line.startsWith("@")) {
      continue;
    } else if (line.includes("==") && !line.includes("(")) {
      const eqMatch = line.match(/^(.+?)\s*==\s*(.+)$/);
      if (eqMatch && eqMatch[1].includes("(")) {
        testBody = `self.assertEqual(${eqMatch[1].trim()}, ${eqMatch[2].trim()})`;
      } else {
        currentContext.push(line);
        continue;
      }
    } else {
      currentContext.push(line);
      continue;
    }
    if (testBody) {
      const bodyLines = [...currentContext, testBody].map((l) => `        ${l}`).join("\n");
      testMethods.push(`    def test_case_${methodIndex}(self):
${bodyLines}`);
      methodIndex++;
      currentContext = [];
    }
  }
  if (testMethods.length === 0) {
    return "";
  }
  return [
    `import unittest`,
    `from ${moduleName} import *`,
    ``,
    `class TestAuto(unittest.TestCase):`,
    testMethods.join("\n\n"),
    ``,
    `if __name__ == '__main__':`,
    `    unittest.main()`
  ].join("\n");
}
function extractCoverage(output, targetFile) {
  let coverageText = "N/A";
  let missingLines = "\u7121";
  const targetBaseName = path3.basename(targetFile);
  const lines = output.split("\n");
  for (const line of lines) {
    if (line.includes(targetBaseName)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        coverageText = parts[3];
        if (parts.length >= 5) {
          missingLines = parts.slice(4).join("");
        }
      }
      break;
    }
  }
  return { coverageText, missingLines };
}
function parseMutatestSurvived(mutatestResult) {
  const lines = mutatestResult.split("\n");
  let isSurvivedSection = false;
  const survivedList = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    line = line.replace(/\x1B\[\d+m/g, "");
    line = line.replace(/\[\d+m/g, "");
    if (line === "SURVIVED" && lines[i + 1]?.replace(/\[\d+m/g, "").trim() === "--------") {
      isSurvivedSection = true;
      i++;
      continue;
    }
    if (isSurvivedSection) {
      if (line === "" || line.startsWith("2026-") || line.match(/^\d{4}-\d{2}-\d{2}/)) {
        break;
      }
      if (line.startsWith("- ")) {
        survivedList.push(line);
      }
    }
  }
  return survivedList.join("\n");
}
function parseMutmutSurvived(mutatestResult) {
  const lines = mutatestResult.split("\n");
  const survivedList = [];
  let capture = false;
  for (const line of lines) {
    if (line.includes("FAILED:") || line.includes("Survived:") || line.includes("survived")) {
      capture = true;
    }
    if (capture && line.trim() !== "") {
      survivedList.push(line.trim());
    }
  }
  return survivedList.join("\n");
}
async function executeSingleFileAnalysis(params, log, sidebarProvider) {
  let currentLoop = 1;
  let mutationScore = 0;
  let bestScore = -1;
  let bestCode = "";
  let bestTestPath = "";
  const userTierSetting = params.promptStrategy || "auto";
  let evalStrategy = "small";
  {
    const nameLower = params.modelName.toLowerCase();
    if (nameLower.includes("gpt-4") || nameLower.includes("claude") || nameLower.includes("gemini") || nameLower.includes("pro") || nameLower.includes("opus")) {
      evalStrategy = "large";
    }
  }
  let complexityScore = 30;
  if (params.funcName) {
    const comp = await assessFunctionComplexity(params.filePath, params.funcName);
    complexityScore = comp.score;
    log(`[Tier] \u8907\u96DC\u5EA6\u8A55\u4F30: ${comp.score}/100 (${comp.level})${comp.reasons.length > 0 ? " - " + comp.reasons.slice(0, 2).join("; ") : ""}`);
  }
  const modelParamBillion = parseFloat(currentModelProfile.paramSize);
  const resolvedTier = resolveTier(modelParamBillion, complexityScore, userTierSetting);
  log(`[\u7CFB\u7D71] \u7B56\u7565\u8DEF\u7531: ${userTierSetting === "auto" ? "Auto \u81EA\u52D5" : "\u4F7F\u7528\u8005\u6307\u5B9A"} \u2192 Tier ${resolvedTier}`);
  if (!params.filePath || !fs3.existsSync(params.filePath)) {
    log("[\u932F\u8AA4] \u627E\u4E0D\u5230\u76EE\u6A19\u6A94\u6848\u8DEF\u5F91");
    return;
  }
  let survivedMutants = "";
  const reportDateStr = (/* @__PURE__ */ new Date()).toLocaleString("zh-TW", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let currentTier = resolvedTier;
  let finalReportMarkdown = `# \u7A81\u8B8A\u6E2C\u8A66\u8207\u4FEE\u5FA9\u5206\u6790\u5831\u544A

- **\u76EE\u6A19\u6A94\u6848**: ${params.filePath}
- **\u6E2C\u8A66\u51FD\u5F0F**: ${params.funcName || "\u5168\u6A94\u6848"}
- **\u4F7F\u7528\u7684\u7B56\u7565**: Tier ${currentTier} (${userTierSetting === "auto" ? "Auto \u81EA\u52D5\u8DEF\u7531" : "\u4F7F\u7528\u8005\u6307\u5B9A Tier " + currentTier})
- **\u65E5\u671F**: ${reportDateStr}

`;
  const baseDir = params.outputPath || path3.dirname(params.filePath);
  const now = /* @__PURE__ */ new Date();
  const dateStr = params.sessionDate || now.toISOString().split("T")[0].replace(/-/g, "_") + "_" + now.toLocaleTimeString("en-GB", { hour12: false }).substring(0, 5).replace(":", "_");
  const safeFuncName = params.funcName || "file";
  const baseName = path3.basename(params.filePath, ".py");
  const displayName = params.funcName ? `${path3.basename(params.filePath)}:${params.funcName}` : path3.basename(params.filePath);
  let sessionDir = "";
  if (params.projectName) {
    sessionDir = path3.join(baseDir, `${params.projectName}_${dateStr}`, baseName, safeFuncName);
  } else {
    sessionDir = path3.join(baseDir, `${baseName}_${dateStr}`, safeFuncName);
  }
  if (!fs3.existsSync(sessionDir)) {
    fs3.mkdirSync(sessionDir, { recursive: true });
  }
  const existingReport = path3.join(sessionDir, "final_report.md");
  if (fs3.existsSync(existingReport)) {
    log(`[\u7CFB\u7D71] \u23ED\uFE0F \u8DF3\u904E ${params.funcName}\uFF1A\u5DF2\u6709\u5B8C\u6210\u7684\u5206\u6790\u7D50\u679C\uFF08${existingReport}\uFF09\u3002`);
    try {
      const content = fs3.readFileSync(existingReport, "utf8");
      if (content.includes("\u6B64\u51FD\u5F0F\u70BA Stub/Dummy \u51FD\u5F0F") || content.includes("\u5FEB\u901F\u901A\u9053\u7D50\u679C")) {
        return;
      }
      const scoreMatch = content.match(/\*\*突變分數\*\*:\s*([^\n]+)/);
      const covMatch = content.match(/\*\*覆蓋率\*\*:\s*([^\n]+)/);
      sidebarProvider.webview?.postMessage({
        command: "updateCoverage",
        fileName: displayName,
        file: path3.basename(params.filePath),
        func: params.funcName || "",
        score: scoreMatch ? scoreMatch[1].trim() : "\u5DF2\u5B8C\u6210",
        coverage: covMatch ? covMatch[1].trim() : null,
        reason: "\u8DF3\u904E (\u5DF2\u5B58\u5728\u5831\u544A)"
      });
    } catch {
    }
    return;
  }
  let astContext = null;
  if (params.funcName) {
    log(`[AST] \u6B63\u5728\u89E3\u6790\u51FD\u5F0F \`${params.funcName}\` \u7684\u7D50\u69CB\u8207\u4F9D\u8CF4...`);
    astContext = await extractAstContext(params.filePath, params.funcName);
    if (astContext && !astContext.error) {
      log(`[AST] \u89E3\u6790\u5B8C\u6210\uFF01\u5DF2\u64F7\u53D6\u51FD\u5F0F\u7279\u5FB5\u8207\u4F9D\u8CF4\u3002`);
      if (astContext.dependencies && astContext.dependencies.length > 0) {
        log(`[AST] \u767C\u73FE\u8DE8\u6A94\u6848\u4F9D\u8CF4\uFF01\u6B63\u5728\u6DF1\u5EA6\u64F7\u53D6\u76F8\u4F9D\u6A21\u7D44\u539F\u59CB\u78BC...`);
        astContext.dependencyContexts = [];
        const projectRoot = params.batchPath ? params.batchPath : vscode3.workspace.workspaceFolders?.[0]?.uri.fsPath || path3.dirname(params.filePath);
        for (const dep of astContext.dependencies) {
          const moduleParts = dep.module.split(".");
          const depFilePath = path3.join(projectRoot, ...moduleParts) + ".py";
          if (fs3.existsSync(depFilePath)) {
            const depAst = await extractAstContext(depFilePath, dep.name);
            if (depAst && !depAst.error) {
              log(`[AST] \u6383\u63CF ${dep.name} \u7684\u547C\u53EB\u7AD9\u8A9E\u5883...`);
              const callers = await findCallerContexts(dep.name, projectRoot);
              if (callers.length > 0) {
                depAst.callerContexts = callers;
                log(`[AST] \u627E\u5230 ${callers.length} \u500B\u547C\u53EB\u9EDE\uFF1A${callers.map((c) => `${c.caller_file}:${c.caller_func}`).join(", ")}`);
              }
              astContext.dependencyContexts.push(depAst);
              log(`[AST] \u6210\u529F\u64F7\u53D6\u5916\u90E8\u4F9D\u8CF4: ${dep.module}.${dep.name}`);
            }
          }
        }
      }
      {
        const projectRoot = params.batchPath ? params.batchPath : vscode3.workspace.workspaceFolders?.[0]?.uri.fsPath || path3.dirname(params.filePath);
        const selfCallers = await findCallerContexts(params.funcName, projectRoot);
        if (selfCallers.length > 0) {
          astContext.callerContexts = selfCallers;
          log(`[AST] \u76EE\u6A19\u51FD\u5F0F\u88AB\u547C\u53EB ${selfCallers.length} \u6B21\uFF0C\u5DF2\u6536\u96C6\u6240\u6709\u547C\u53EB\u8A9E\u5883\u3002`);
        }
      }
      log(`[Trace] \u6B63\u5728\u52D5\u614B\u57F7\u884C\u51FD\u5F0F\u4EE5\u53D6\u5F97\u771F\u5BE6\u8F38\u5165\u8F38\u51FA\u7BC4\u4F8B...`);
      const traceResult = await runDynamicTrace(params.filePath, params.funcName, astContext.callerContexts);
      if (traceResult && !traceResult.load_error) {
        astContext.traceResult = traceResult;
        const exCount = traceResult.examples.length;
        const errCount = traceResult.errors.length;
        log(`[Trace] \u5B8C\u6210\uFF01\u53D6\u5F97 ${exCount} \u500B\u6210\u529F\u7BC4\u4F8B\u3001${errCount} \u500B\u9810\u671F\u4F8B\u5916\u7BC4\u4F8B\u3002`);
      } else if (traceResult?.load_error) {
        log(`[Trace] \u52D5\u614B\u8FFD\u8E64\u5931\u6557: ${traceResult.load_error}\uFF08\u5C07\u7E7C\u7E8C\u4F7F\u7528\u975C\u614B\u5206\u6790\uFF09`);
      }
      let astReport = `### AST \u975C\u614B\u89E3\u6790\u7D50\u679C
`;
      astReport += `- \u51FD\u5F0F\u540D\u7A31: \`${astContext.name}\`
`;
      astReport += `- \u53C3\u6578\u5217\u8868: \`${astContext.args.join(", ") || "\u7121"}\`
`;
      astReport += `- \u76F8\u4F9D\u547C\u53EB: \`${astContext.calls.join(", ") || "\u7121"}\`
`;
      if (astContext.docstring) {
        astReport += `- \u6587\u4EF6\u8A3B\u89E3: \`${astContext.docstring.trim().replace(/\n/g, " ")}\`
`;
      }
      if (astContext.dependencies && astContext.dependencies.length > 0) {
        astReport += `- \u8DE8\u6A94\u6848\u4F9D\u8CF4: ${astContext.dependencies.map((d) => `\`${d.module}.${d.name}\``).join(", ")}
`;
      }
      if (astContext.callerContexts && astContext.callerContexts.length > 0) {
        astReport += `- \u547C\u53EB\u7AD9\u8A9E\u5883 (${astContext.callerContexts.length} \u500B):
`;
        for (const ctx of astContext.callerContexts) {
          const argsStr = ctx.args.join(", ");
          const kwargsStr = Object.entries(ctx.kwargs).map(([k, v]) => `${k}=${v}`).join(", ");
          const callSig = [argsStr, kwargsStr].filter(Boolean).join(", ");
          astReport += `  - \`${ctx.caller_file}\` / \`${ctx.caller_func}()\`: \`${astContext.name}(${callSig})\`
`;
        }
      }
      if (astContext.dependencyContexts && astContext.dependencyContexts.length > 0) {
        for (const dep of astContext.dependencyContexts) {
          if (dep.callerContexts && dep.callerContexts.length > 0) {
            astReport += `- \`${dep.name}\` \u7684\u547C\u53EB\u7AD9\u8A9E\u5883 (${dep.callerContexts.length} \u500B):
`;
            for (const ctx of dep.callerContexts) {
              const argsStr = ctx.args.join(", ");
              const kwargsStr = Object.entries(ctx.kwargs).map(([k, v]) => `${k}=${v}`).join(", ");
              const callSig = [argsStr, kwargsStr].filter(Boolean).join(", ");
              astReport += `  - \`${ctx.caller_file}\` / \`${ctx.caller_func}()\`: \`${dep.name}(${callSig})\`
`;
            }
          }
        }
      }
      astReport += `
`;
      finalReportMarkdown += astReport;
    } else {
      log(`[AST] \u89E3\u6790\u9047\u5230\u554F\u984C\u6216\u627E\u4E0D\u5230\u6307\u5B9A\u51FD\u5F0F\uFF0C\u5C07\u9000\u56DE\u5168\u57DF\u5206\u6790\u6A21\u5F0F\u3002`);
    }
  }
  if (params.funcName && isStubFunction(complexityScore, astContext)) {
    log(`[\u5FEB\u901F\u901A\u9053] \u{1F680} \u5075\u6E2C\u5230 Stub/Dummy \u51FD\u5F0F\uFF08\u8907\u96DC\u5EA6 ${complexityScore}/100\uFF09\uFF0C\u76F4\u63A5\u751F\u6210\u6700\u5C0F Smoke Test\uFF0C\u8DF3\u904E LLM \u547C\u53EB\u8207\u7A81\u8B8A\u6E2C\u8A66\u3002`);
    const moduleName = path3.basename(params.filePath, ".py");
    const className = astContext?.class_name;
    const args = astContext?.args || [];
    const defaultArgs = args.map((_a, i) => i === 0 && className ? "None" : "None");
    const importLine = className ? `from ${moduleName} import ${className}` : `from ${moduleName} import ${params.funcName}`;
    const callLine = className ? `self._obj = ${className}()
        result = self._obj.${params.funcName}(${defaultArgs.join(", ")})` : `result = ${params.funcName}(${defaultArgs.join(", ")})`;
    const setupClass = className ? `
    def setUp(self):
        self._obj = ${className}()
` : "";
    const smokeTest = [
      `import unittest`,
      importLine,
      ``,
      `class TestStub${params.funcName}(unittest.TestCase):`,
      setupClass,
      `    def test_smoke_no_exception(self):`,
      `        """Stub function smoke test: verifies calling it does not raise an exception."""`,
      `        try:`,
      `            ${callLine}`,
      `        except Exception as e:`,
      `            self.fail(f"Stub function raised an exception: {e}")`,
      ``,
      `if __name__ == '__main__':`,
      `    unittest.main()`
    ].join("\n");
    const testPath = path3.join(sessionDir, "loop1_test.py");
    fs3.writeFileSync(testPath, smokeTest, "utf-8");
    finalReportMarkdown += `## \u{1F680} \u5FEB\u901F\u901A\u9053\u7D50\u679C

`;
    finalReportMarkdown += `> [!NOTE]
> \u6B64\u51FD\u5F0F\u70BA Stub/Dummy \u51FD\u5F0F\uFF08\u8907\u96DC\u5EA6 ${complexityScore}/100\uFF09\uFF0C\u5DF2\u8DF3\u904E LLM \u751F\u6210\u8207\u7A81\u8B8A\u6E2C\u8A66\uFF0C\u76F4\u63A5\u7522\u51FA\u6700\u5C0F Smoke Test\u3002

`;
    finalReportMarkdown += `- **\u7A81\u8B8A\u5206\u6578**: N/A\uFF08\u51FD\u5F0F\u7121\u53EF\u7A81\u8B8A\u7684\u696D\u52D9\u908F\u8F2F\uFF09
`;
    finalReportMarkdown += `- **\u751F\u6210\u6E2C\u8A66**: \`${testPath}\`

`;
    finalReportMarkdown += `\`\`\`python
${smokeTest}
\`\`\`
`;
    fs3.writeFileSync(path3.join(sessionDir, "final_report.md"), finalReportMarkdown, "utf-8");
    log(`[\u5FEB\u901F\u901A\u9053] \u2705 Stub \u51FD\u5F0F ${params.funcName} \u8655\u7406\u5B8C\u6210\uFF01Smoke Test \u5DF2\u5BEB\u5165 ${testPath}`);
    return;
  }
  sidebarProvider.webview?.postMessage({
    command: "updateCoverage",
    fileName: displayName,
    file: path3.basename(params.filePath),
    func: params.funcName || "",
    score: "\u6E2C\u8A66\u4E2D",
    coverage: null,
    reason: "\u5206\u6790\u4E2D..."
  });
  let semanticContext;
  const hasDependencies = astContext?.dependencyContexts && astContext.dependencyContexts.length > 0;
  if (hasDependencies) {
    log(`[\u8A9E\u610F\u5206\u6790\u5E2B] \u5075\u6E2C\u5230\u8DE8\u6A94\u6848\u76F8\u4F9D\uFF0C\u555F\u52D5\u8A9E\u610F\u524D\u7F6E\u5206\u6790...`);
    try {
      const semSys = getSemanticAnalyzerSystemPrompt();
      const semDeps = astContext.dependencyContexts.filter((d) => d.code).map((d) => ({ name: d.name, code: d.code }));
      const semCallSites = astContext.callerContexts?.map((c) => ({
        caller_func: c.caller_func || "",
        call_expr: c.call_expr || ""
      })) || [];
      const semUsr = getSemanticAnalyzerUserPrompt(
        astContext.code || "",
        semDeps,
        semCallSites
      );
      const semRaw = await requestLlmApi(params, semSys, semUsr, log);
      const semResult = parseSemanticAnalysis(semRaw);
      if (semResult) {
        semanticContext = formatSemanticContextForPrompt(semResult);
        log(`[\u8A9E\u610F\u5206\u6790\u5E2B] \u2705 \u5206\u6790\u5B8C\u6210\uFF01\u627E\u5230 ${semResult.dependency_behaviors.length} \u500B\u76F8\u4F9D\u884C\u70BA\u3001${semResult.unreachable_paths.length} \u500B\u4E0D\u53EF\u9054\u8DEF\u5F91\u3001${semResult.equivalent_mutant_candidates.length} \u500B\u7B49\u6548\u8B8A\u7570\u9AD4\u5019\u9078\u3002`);
        finalReportMarkdown += `
### \u{1F9E0} \u8A9E\u610F\u5206\u6790\u5E2B\u5831\u544A

\`\`\`
${semanticContext}
\`\`\`

`;
      } else {
        log(`[\u8A9E\u610F\u5206\u6790\u5E2B] \u26A0\uFE0F \u7121\u6CD5\u89E3\u6790 JSON \u56DE\u61C9\uFF0C\u8DF3\u904E\u8A9E\u610F\u5206\u6790\uFF08\u4E0D\u5F71\u97FF\u4E3B\u6D41\u7A0B\uFF09\u3002`);
      }
    } catch (semErr) {
      log(`[\u8A9E\u610F\u5206\u6790\u5E2B] \u26A0\uFE0F \u8A9E\u610F\u5206\u6790\u547C\u53EB\u5931\u6557: ${semErr.message}\uFF0C\u7E7C\u7E8C\u4E3B\u6D41\u7A0B\u3002`);
    }
  }
  while (currentLoop <= params.maxLoops && mutationScore < 100) {
    if (isAborted) {
      log(`[\u7CFB\u7D71] \u26A0\uFE0F \u6E2C\u8A66\u5DF2\u7531\u4F7F\u7528\u8005\u5F37\u5236\u4E2D\u6B62\u3002`);
      break;
    }
    log(`
--- \u{1F504} \u7B2C ${currentLoop} \u8F2A\u958B\u59CB ---`);
    currentTier = resolvedTier;
    finalReportMarkdown += `## \u7B2C ${currentLoop} \u8F2A\u6E2C\u8A66
`;
    let targetCode;
    try {
      targetCode = fs3.readFileSync(params.filePath, "utf-8");
    } catch {
      log("[\u932F\u8AA4] \u8B80\u53D6\u6A94\u6848\u5931\u6557");
      return;
    }
    const testPath = path3.join(sessionDir, `loop${currentLoop}_test.py`);
    const reportDir = path3.join(sessionDir, `loop${currentLoop}_report`);
    const systemPrompt = getSystemPrompt(currentLoop, evalStrategy, survivedMutants, params.modelName);
    let focusContext = "";
    if (currentLoop > 1 && survivedMutants) {
      focusContext = extractFocusContext(survivedMutants, targetCode);
      if (focusContext) {
        log(`[\u52D5\u614B\u7126\u9EDE] \u5DF2\u64F7\u53D6 ${focusContext.split("\u3010\u76EE\u6A19\u8B8A\u7570\u9AD4\u3011").length - 1} \u500B\u7A81\u8B8A\u9AD4\u7126\u9EDE\u5340\u584A\uFF0C\u6E96\u5099\u9032\u884C\u7CBE\u6E96\u4FEE\u5FA9\u3002`);
      }
      if (bestCode) {
        const bestBlock = `=== EXISTING VERIFIED TESTS (DO NOT DELETE OR MODIFY THESE METHODS) ===
${bestCode}
=== END OF EXISTING TESTS ===

`;
        focusContext = bestBlock + focusContext;
        log(`[\u6700\u512A\u89E3\u9328\u5B9A] \u5DF2\u5C07\u6B77\u53F2\u6700\u512A\u6E2C\u8A66\u96C6\uFF08${bestScore}%\uFF09\u5D4C\u5165\u5230 Prompt\uFF0C\u9632\u6B62 LLM \u6539\u58DE\u820A\u65B7\u8A00\u3002`);
      }
    }
    const userPrompt = getUserPrompt(
      params.filePath,
      params.funcName,
      targetCode,
      evalStrategy,
      astContext,
      focusContext,
      currentModelProfile.budgetTokens,
      params.modelName
    );
    const estimatedTokens = estimateTokens2(systemPrompt + userPrompt);
    log(`[Budget] Prompt \u4F30\u7B97\uFF1A${estimatedTokens.toLocaleString()} / ${currentModelProfile.budgetTokens.toLocaleString()} tokens (\u6A21\u578B: ${currentModelProfile.paramSize}, Context: ${currentModelProfile.contextLength.toLocaleString()})`);
    let rawCode = "";
    let sanitizedCode = "";
    let loopCoverage = null;
    try {
      let tierSuccess = false;
      while (currentTier >= 1 && !tierSuccess && !isAborted) {
        try {
          log(`[Tier \u57F7\u884C] \u76EE\u524D\u4F7F\u7528\u7B56\u7565\uFF1ATier ${currentTier}`);
          sanitizedCode = "";
          rawCode = "";
          const callerContextsCount = astContext?.callerContexts?.length || 0;
          const useDivideAndConquer = currentTier === 2 && evalStrategy === "small" && callerContextsCount > 1 && !survivedMutants;
          if (currentTier === 1 && !survivedMutants) {
            const traceResult = astContext?.traceResult;
            if (!traceResult || traceResult.load_error || traceResult.examples.length === 0 && traceResult.errors.length === 0) {
              log(`[Tier 1 \u9000\u56DE] \u52D5\u614B\u8FFD\u8E64\u5931\u6557\uFF0C\u5DF2\u81EA\u52D5\u5207\u63DB\u81F3 Tier 2\u3002\u5EFA\u8B70\uFF1A\u8ACB\u5728\u7B56\u7565\u9078\u55AE\u6539\u9078 Tier 2 \u4EE5\u7B26\u5408\u6B64\u51FD\u5F0F\u7684\u8907\u96DC\u5EA6\u3002`);
            } else {
              log(`[Tier 1] \u958B\u555F\u586B\u7A7A\u6CD5\uFF0C\u5C07\u70BA ${traceResult.examples.length} \u500B\u6210\u529F\u7BC4\u4F8B + ${traceResult.errors.length} \u500B\u4F8B\u5916\u7BC4\u4F8B\u5206\u5225\u8A62\u554F AI\u2026`);
              const moduleName = path3.basename(params.filePath, ".py");
              const tier1Methods = [];
              for (let i = 0; i < traceResult.examples.length; i++) {
                const ex = traceResult.examples[i];
                const funcCall = `${params.funcName}(${ex.args.join(", ")})`;
                const resultRepr = String(ex.result ?? "");
                if (resultRepr === "None" || ex.result_type === "NoneType") {
                  tier1Methods.push(
                    `    def test_case_${i + 1}(self):
        result = ${funcCall}
        self.assertIsNone(result)`
                  );
                  log(`[Tier 1] \u7BC4\u4F8B ${i + 1} \u56DE\u50B3 None\uFF0C\u5DF2\u76F4\u63A5\u751F\u6210 assertIsNone\u3002`);
                  continue;
                }
                const sysP = getTier1SystemPrompt();
                const usrP = getTier1UserPrompt(funcCall, resultRepr, false);
                let assertLine = "";
                try {
                  const raw = await requestLlmApi(params, sysP, usrP, log);
                  const extracted = raw.split("\n").map((l) => l.trim()).find((l) => l.startsWith("self.assert") || l.startsWith("with self.assert"));
                  if (extracted && !/\b(expected_|expected_value|expected_output|expected_result|___|\.\.\.)\b/i.test(extracted)) {
                    assertLine = extracted;
                  }
                } catch (e) {
                  log(`[Tier 1] \u7BC4\u4F8B ${i + 1} \u8A62\u554F\u5931\u6557: ${e.message}`);
                }
                if (!assertLine) {
                  let literalVal = String(ex.result ?? "");
                  const resType = ex.result_type || typeof ex.result;
                  if (resType === "str" || resType === "string") {
                    literalVal = JSON.stringify(String(ex.result));
                  } else if (resType === "bool" || typeof ex.result === "boolean") {
                    literalVal = ex.result ? "True" : "False";
                  } else if (resType === "NoneType" || ex.result === null || ex.result === void 0) {
                    literalVal = "None";
                  } else if (resType === "int" || resType === "float" || typeof ex.result === "number") {
                    literalVal = String(ex.result);
                  }
                  assertLine = `self.assertEqual(result, ${literalVal})`;
                  log(`[Tier 1] \u7BC4\u4F8B ${i + 1} LLM \u56DE\u61C9\u7121\u6548\uFF0C\u5DF2\u4F7F\u7528\u7CBE\u78BA\u56DE\u50B3\u503C\u4EE3\u5165\u65B7\u8A00: ${assertLine}`);
                }
                tier1Methods.push(
                  `    def test_case_${i + 1}(self):
        result = ${funcCall}
        ${assertLine}`
                );
              }
              for (let i = 0; i < traceResult.errors.length; i++) {
                const er = traceResult.errors[i];
                const funcCall = `${params.funcName}(${er.args.join(", ")})`;
                const sysP = getTier1SystemPrompt();
                const usrP = getTier1UserPrompt(funcCall, String(er.message ?? ""), true, er.exception);
                try {
                  const raw = await requestLlmApi(params, sysP, usrP, log);
                  const methodIdx = traceResult.examples.length + i + 1;
                  tier1Methods.push(
                    `    def test_case_${methodIdx}(self):
        with self.assertRaises(${er.exception}):
            ${funcCall}`
                  );
                } catch (e) {
                  log(`[Tier 1] \u4F8B\u5916\u7BC4\u4F8B ${i + 1} \u8A62\u554F\u5931\u6557: ${e.message}`);
                }
              }
              if (tier1Methods.length > 0) {
                const className = astContext?.class_name;
                if (className) {
                  const setupBlock = [
                    `    def setUp(self):`,
                    `        self._instance = ${className}()`
                  ].join("\n");
                  const classMethodsMapped = tier1Methods.map(
                    (m) => m.replace(new RegExp(`(?<![._])\\b${params.funcName}\\(`, "g"), `self._instance.${params.funcName}(`)
                  );
                  sanitizedCode = [
                    `import unittest`,
                    `from ${moduleName} import ${className}`,
                    ``,
                    `class TestTier1${params.funcName || "Auto"}(unittest.TestCase):`,
                    setupBlock,
                    ``,
                    classMethodsMapped.join("\n\n"),
                    ``,
                    `if __name__ == '__main__':`,
                    `    unittest.main()`
                  ].join("\n");
                } else {
                  sanitizedCode = [
                    `import unittest`,
                    `from ${moduleName} import *`,
                    ``,
                    `class TestTier1${params.funcName || "Auto"}(unittest.TestCase):`,
                    tier1Methods.join("\n\n"),
                    ``,
                    `if __name__ == '__main__':`,
                    `    unittest.main()`
                  ].join("\n");
                }
                rawCode = `[Tier 1] Generated ${tier1Methods.length} fill-in test methods`;
                log(`[Tier 1] \u586B\u7A7A\u6CD5\u5B8C\u6210\uFF01\u5171\u7522\u51FA ${tier1Methods.length} \u500B\u6E2C\u8A66\u65B9\u6CD5\u3002${className ? ` (Class method: ${className}.${params.funcName})` : ""}`);
              }
            }
          }
          if (currentTier === 3 && !sanitizedCode && !survivedMutants) {
            log(`[Tier 3] \u958B\u555F Mock Scaffold \u7B56\u7565\uFF0C\u6B63\u5728\u7522\u751F @patch \u9AA8\u67B6\u2026`);
            const traceResult = astContext?.traceResult;
            const scaffoldResult = await runMockScaffold(params.filePath, params.funcName, traceResult);
            if (scaffoldResult && scaffoldResult.scaffold) {
              log(`[Tier 3] \u9AA8\u67B6\u7522\u751F\u5B8C\u6210\uFF01patches: ${scaffoldResult.patches.join(", ") || "(\u7121\u5916\u90E8\u4F9D\u8CF4)"}`);
              const moduleName = path3.basename(params.filePath, ".py");
              const traceExamples = traceResult?.examples || [];
              const sysP = getTier3SystemPrompt();
              const usrP = getTier3UserPrompt(params.funcName, scaffoldResult.scaffold, moduleName, traceExamples);
              try {
                const raw = await requestLlmApi(params, sysP, usrP, log);
                rawCode = raw;
                const extracted = sanitizeLlmResponse(raw);
                if (extracted) {
                  const moduleName2 = path3.basename(params.filePath, ".py");
                  const className3 = astContext?.class_name;
                  const importLine3 = className3 ? `from ${moduleName2} import ${className3}` : `from ${moduleName2} import *`;
                  const patchImport = scaffoldResult.patches.length > 0 ? `from unittest.mock import patch, MagicMock
` : "";
                  sanitizedCode = [
                    `import unittest`,
                    importLine3,
                    patchImport.trim(),
                    ``,
                    `class TestTier3${params.funcName || "Auto"}(unittest.TestCase):`,
                    extracted.split("\n").map((l) => "    " + l).join("\n"),
                    ``,
                    `if __name__ == '__main__':`,
                    `    unittest.main()`
                  ].filter(Boolean).join("\n");
                  log(`[Tier 3] \u6A21\u578B\u88DC\u5145\u5B8C\u6210\uFF01`);
                }
              } catch (e) {
                log(`[Tier 3] \u6A21\u578B\u8A62\u554F\u5931\u6557: ${e.message}\uFF0C\u9000\u56DE\u6A19\u6E96\u6D41\u7A0B`);
              }
            } else {
              log(`[Tier 3] Mock \u9AA8\u67B6\u7522\u751F\u5931\u6557\uFF0C\u9000\u56DE\u6A19\u6E96 Tier 2/4 \u6D41\u7A0B`);
            }
          }
          if (currentTier === 4 && !sanitizedCode) {
            evalStrategy = "large";
          }
          if (useDivideAndConquer && astContext && astContext.callerContexts) {
            log(`[\u5206\u6CBB\u5408\u6D41] \u{1F4A1} \u5075\u6E2C\u5230 ${callerContextsCount} \u500B\u547C\u53EB\u7AD9\uFF0C\u958B\u555F\u5206\u6CBB\u5408\u6D41\u6A21\u5F0F\uFF08\u55AE\u4E00\u5C0F Task \u591A\u6B21\u8ACB\u6C42\uFF0C\u907F\u514D\u5931\u7126\u8207\u5931\u61B6\uFF09...`);
            const subSnippets = [];
            for (let cIdx = 0; cIdx < astContext.callerContexts.length; cIdx++) {
              const ctx = astContext.callerContexts[cIdx];
              log(`[\u5206\u6CBB\u5408\u6D41] \u6B63\u5728\u751F\u6210\u7B2C ${cIdx + 1}/${callerContextsCount} \u500B\u547C\u53EB\u9EDE\u6E2C\u8A66: \`${ctx.caller_file}\` -> \`${ctx.caller_func}()\``);
              const subAstContext = { ...astContext, callerContexts: [ctx] };
              const subUserPrompt = getUserPrompt(
                params.filePath,
                params.funcName,
                targetCode,
                "small",
                subAstContext,
                focusContext,
                currentModelProfile.budgetTokens,
                params.modelName
              );
              let subRaw = "";
              for (let retry = 0; retry < 2; retry++) {
                try {
                  subRaw = await requestLlmApi(params, systemPrompt, subUserPrompt, log);
                  const subClean = sanitizeLlmResponse(subRaw);
                  if (subClean) {
                    subSnippets.push(subClean);
                    break;
                  }
                } catch (err) {
                  if (retry === 1) log(`[\u8B66\u544A] \u547C\u53EB\u9EDE ${cIdx + 1} \u751F\u6210\u5931\u6557: ${err.message}`);
                }
              }
              rawCode += `
--- [Call Site ${cIdx + 1}: ${ctx.caller_func}] ---
` + subRaw;
            }
            if (subSnippets.length > 0) {
              log(`[\u5206\u6CBB\u5408\u6D41] \u6210\u529F\u53D6\u5F97 ${subSnippets.length} \u500B\u55AE\u4E00\u547C\u53EB\u9EDE\u6E2C\u8A66\uFF0C\u6B63\u5728\u9032\u884C AST/\u6B63\u5247\u6A5F\u68B0\u5F0F\u5408\u4F75...`);
              const mergeRes = mergeTestSnippets(subSnippets, `Test${params.funcName || "Merged"}`);
              sanitizedCode = mergeRes.mergedCode;
              log(`[\u5206\u6CBB\u5408\u6D41] \u{1F389} \u6210\u529F\u91CD\u7D44\u70BA\u55AE\u4E00\u985E\u5225\uFF0C\u5171\u5305\u542B ${mergeRes.totalMethodsCount} \u500B\u7368\u7ACB\u6E2C\u8A66\u65B9\u6CD5\uFF01`);
            }
          }
          if (!sanitizedCode) {
            for (let llmRetry = 0; llmRetry < 2; llmRetry++) {
              if (llmRetry === 0) log(`[LLM] \u6B63\u5728\u547C\u53EB\u6A21\u578B\u63A8\u8AD6\u4E2D... (\u6A21\u578B: ${params.modelName})`);
              try {
                rawCode = await requestLlmApi(params, systemPrompt, userPrompt, log);
              } catch (err) {
                if (llmRetry === 0) {
                  log(`[\u8B66\u544A] \u7DB2\u8DEF\u6216 API \u8ACB\u6C42\u5931\u6557: ${err.message}\uFF0C\u5617\u8A66\u81EA\u52D5\u91CD\u8A66 (1/1)...`);
                  continue;
                } else {
                  throw err;
                }
              }
              sanitizedCode = sanitizeLlmResponse(rawCode);
              if (!sanitizedCode) {
                if (llmRetry === 0) {
                  log(`[\u8B66\u544A] \u6A21\u578B\u56DE\u50B3\u7A0B\u5F0F\u78BC\u70BA\u7A7A\u6216\u5305\u542B\u7121\u6548\u6A19\u7C64\uFF0C\u5617\u8A66\u81EA\u52D5\u91CD\u8A66...`);
                  continue;
                } else {
                  throw new Error("\u6A21\u578B\u7522\u751F\u7684\u7A0B\u5F0F\u78BC\u5167\u5BB9\u70BA\u7A7A (\u5DF2\u91CD\u8A66\u5931\u6557)");
                }
              }
              const hasTestMethods = sanitizedCode.includes("def test_") || sanitizedCode.includes("self.assert");
              const looksLikeSourceCopy = !hasTestMethods && params.funcName && sanitizedCode.includes(`def ${params.funcName}`);
              if (looksLikeSourceCopy) {
                if (llmRetry === 0) {
                  log(`[\u8B66\u544A] \u26A0\uFE0F AI \u8F38\u51FA\u7684\u662F\u539F\u59CB\u78BC\u800C\u4E0D\u662F\u6E2C\u8A66\u78BC\uFF08\u5075\u6E2C\u5230\u8907\u88FD\u884C\u70BA\uFF09\uFF0C\u5617\u8A66\u91CD\u8A66...`);
                  continue;
                } else {
                  throw new Error("AI \u9023\u7E8C\u5169\u6B21\u8F38\u51FA\u4E86\u539F\u59CB\u78BC\u800C\u975E\u6E2C\u8A66\u78BC\uFF0C\u7121\u6CD5\u7522\u751F\u6709\u6548\u6E2C\u8A66");
                }
              }
              if (!sanitizedCode.includes("unittest.TestCase") && !sanitizedCode.includes("import unittest")) {
                log(`[\u8B66\u544A] AI \u672A\u6309\u683C\u5F0F\u8F38\u51FA unittest.TestCase\uFF0C\u5617\u8A66\u81EA\u52D5\u6551\u63F4\u8F49\u63DB...`);
                const rescued = rescueToUnittest(sanitizedCode, params.filePath, params.funcName);
                if (!rescued) {
                  if (llmRetry === 0) {
                    log(`[\u8B66\u544A] AI \u56DE\u50B3\u683C\u5F0F\u7121\u6CD5\u89E3\u6790\u51FA\u6709\u6548\u7684\u6E2C\u8A66\u6848\u4F8B\uFF0C\u5617\u8A66\u91CD\u65B0\u8ACB\u6C42...`);
                    continue;
                  } else {
                    throw new Error("AI \u8F38\u51FA\u683C\u5F0F\u9023\u7E8C\u5169\u6B21\u7121\u6CD5\u89E3\u6790\u70BA\u6709\u6548\u6E2C\u8A66\uFF08\u7121\u4EFB\u4F55 assert \u6216\u53EF\u7528\u8A9E\u53E5\uFF09");
                  }
                }
                log(`[\u6551\u63F4] \u81EA\u52D5\u8F49\u63DB\u6210\u529F\uFF01\u5DF2\u5C07 AI \u8F38\u51FA\u5305\u88DD\u70BA unittest.TestCase \u683C\u5F0F\u3002`);
                sanitizedCode = rescued;
              }
              break;
            }
          }
          finalReportMarkdown += `### \u{1F916} AI \u539F\u59CB\u8F38\u51FA\u8207\u601D\u8003\u904E\u7A0B

`;
          finalReportMarkdown += `<details>
<summary>\u9EDE\u64CA\u5C55\u958B AI \u5B8C\u6574\u56DE\u61C9</summary>

\`\`\`text
${rawCode}
\`\`\`

</details>

`;
          let finalCode = sanitizedCode;
          const baseName2 = path3.basename(params.filePath, ".py");
          finalCode = finalCode.split("\n").filter((line) => {
            const t2 = line.trim();
            if (!t2.startsWith("from ") && !t2.startsWith("import ")) return true;
            if (t2.includes("module_name") || t2.includes("MODULE_NAME") || t2.includes("<module>") || t2.includes("your_module") || t2.includes("FUNCTION_NAME")) return false;
            if (/^from\s+\./.test(t2)) return false;
            return true;
          }).join("\n");
          if (!finalCode.includes(`from ${baseName2} import`)) {
            log(`[\u8B66\u544A] AI \u907A\u6F0F\u4E86 import \u76EE\u6A19\u6A21\u7D44\u7684\u8A9E\u53E5\uFF0C\u7CFB\u7D71\u81EA\u52D5\u88DC\u9F4A...`);
            if (finalCode.includes("import unittest")) {
              finalCode = finalCode.replace("import unittest", `import unittest
from ${baseName2} import *`);
            } else {
              finalCode = `import unittest
from ${baseName2} import *

` + finalCode;
            }
          }
          if ((finalCode.includes("patch(") || finalCode.includes("MagicMock")) && !finalCode.includes("unittest.mock")) {
            log(`[\u8B66\u544A] \u5075\u6E2C\u5230\u7A0B\u5F0F\u78BC\u4F7F\u7528 patch/MagicMock \u4F46\u907A\u6F0F import\uFF0C\u7CFB\u7D71\u81EA\u52D5\u88DC\u9F4A unittest.mock...`);
            finalCode = finalCode.replace("import unittest", "import unittest\nfrom unittest.mock import patch, MagicMock");
          }
          log(`[\u7CFB\u7D71] \u6E96\u5099\u5C07\u751F\u6210\u7684\u6E2C\u8A66\u7A0B\u5F0F\u78BC\u5B58\u6A94...`);
          fs3.writeFileSync(testPath, finalCode, "utf8");
          log(`[\u7CFB\u7D71] \u6E2C\u8A66\u8173\u672C\u5DF2\u5B58\u6A94\u81F3: ${testPath}`);
          await new Promise((resolve, reject) => {
            const testDir = path3.dirname(testPath);
            const testModule = path3.basename(testPath, ".py");
            const targetDir = path3.dirname(params.filePath);
            const parentDir = path3.dirname(targetDir);
            const grandParentDir = path3.dirname(parentDir);
            const pythonPath = `${targetDir};${parentDir};${grandParentDir};${testDir};%PYTHONPATH%`;
            const preCheckCmd = `chcp 65001 && set PYTHONPATH=${pythonPath} && cd /d "${testDir}" && python -m coverage run --source="${targetDir}" -m unittest ${testModule} && python -m coverage report -m`;
            (0, import_child_process2.exec)(preCheckCmd, { timeout: 3e4 }, async (err, stdout, stderr) => {
              const out = (stdout + stderr).trim();
              if (err) {
                log(`[\u9810\u5148\u9A57\u8B49\u5931\u6557] \u6E2C\u8A66\u6A94\u7121\u6CD5\u9806\u5229\u57F7\u884C\uFF0C\u8A73\u7D30\u8CC7\u8A0A: ${out}`);
                finalReportMarkdown += `### \u26A0\uFE0F \u9810\u5148\u9A57\u8B49\u5931\u6557

\`\`\`text
${out}
\`\`\`

`;
                log(`[Reviewer] \u{1F50D} \u555F\u52D5 Reviewer LLM \u9032\u884C\u4FEE\u5FA9\u53CA\u88DC\u5145\u6E2C\u8CC7\uFF08\u6700\u591A 2 \u6B21\uFF09...`);
                let reviewerFixed = false;
                const funcArgs = astContext?.args || [];
                for (let reviewAttempt = 1; reviewAttempt <= 2; reviewAttempt++) {
                  if (isAborted) break;
                  log(`[Reviewer] \u7B2C ${reviewAttempt} \u6B21\u4FEE\u5FA9\u5617\u8A66...`);
                  try {
                    const brokenCode = fs3.readFileSync(testPath, "utf8");
                    const revSys = getReviewerSystemPrompt();
                    const moduleName = path3.basename(params.filePath, ".py");
                    const targetSource = astContext?.code || targetCode;
                    const revUsr = getReviewerUserPrompt(
                      brokenCode,
                      out,
                      params.funcName || "",
                      funcArgs,
                      targetSource,
                      astContext,
                      moduleName
                    );
                    const revRaw = await requestLlmApi(params, revSys, revUsr, log);
                    const revCode = sanitizeLlmResponse(revRaw);
                    if (revCode && (revCode.includes("def test_") || revCode.includes("unittest"))) {
                      fs3.writeFileSync(testPath, revCode, "utf8");
                      const revCheck = await new Promise((res2) => {
                        (0, import_child_process2.exec)(preCheckCmd, { timeout: 3e4 }, (e2, o2a, o2b) => {
                          res2({ ok: !e2, out: (o2a + o2b).trim() });
                        });
                      });
                      if (revCheck.ok) {
                        log(`[Reviewer] \u2705 \u7B2C ${reviewAttempt} \u6B21\u4FEE\u5FA9\u6210\u529F\uFF01\u6E2C\u8A66\u6A94\u5DF2\u901A\u904E\u9810\u5148\u9A57\u8B49\u3002`);
                        finalReportMarkdown += `### \u2705 Reviewer LLM \u4FEE\u5FA9\u6210\u529F\uFF08\u7B2C ${reviewAttempt} \u6B21\uFF09

`;
                        finalReportMarkdown += `<details>
<summary>\u{1F50D} Reviewer \u4FEE\u5FA9\u5F8C\u7684\u6E2C\u8A66\u78BC</summary>

\`\`\`python
${revCode}
\`\`\`
</details>

`;
                        loopCoverage = extractCoverage(revCheck.out, params.filePath);
                        reviewerFixed = true;
                        resolve();
                        break;
                      } else {
                        log(`[Reviewer] \u7B2C ${reviewAttempt} \u6B21\u4FEE\u5FA9\u5F8C\u4ECD\u6709\u932F\u8AA4: ${revCheck.out.substring(0, 300)}`);
                        finalReportMarkdown += `<details>
<summary>\u26A0\uFE0F Reviewer \u7B2C ${reviewAttempt} \u6B21\u4FEE\u5FA9\u5167\u5BB9\uFF08\u9A57\u8B49\u4ECD\u5931\u6557\uFF09</summary>

\`\`\`python
${revCode}
\`\`\`

**\u9A57\u8B49\u932F\u8AA4**:
\`\`\`text
${revCheck.out.substring(0, 600)}
\`\`\`
</details>

`;
                      }
                    } else {
                      log(`[Reviewer] \u7B2C ${reviewAttempt} \u6B21\u56DE\u61C9\u7121\u6CD5\u89E3\u6790\u70BA\u6709\u6548\u6E2C\u8A66\u78BC\u3002`);
                      finalReportMarkdown += `> Reviewer \u7B2C ${reviewAttempt} \u6B21\u56DE\u61C9\u7121\u6CD5\u89E3\u6790\u70BA\u6709\u6548\u6E2C\u8A66\u78BC

`;
                    }
                  } catch (revErr) {
                    log(`[Reviewer] \u7B2C ${reviewAttempt} \u6B21\u4FEE\u5FA9\u8ACB\u6C42\u5931\u6557: ${revErr.message}`);
                  }
                }
                if (!reviewerFixed) {
                  if (currentTier === 4) {
                    log(`[Tier 4 Self-repair] Reviewer \u7121\u6CD5\u4FEE\u5FA9\uFF0C\u5617\u8A66 Tier 4 \u81EA\u6211\u4FEE\u6B63\uFF08\u6700\u591A 2 \u6B21\uFF09...`);
                    let repaired = false;
                    for (let repairAttempt = 1; repairAttempt <= 2; repairAttempt++) {
                      if (isAborted) break;
                      log(`[Tier 4 Self-repair] \u7B2C ${repairAttempt} \u6B21\u81EA\u6211\u4FEE\u6B63...`);
                      try {
                        const repairSys = getTier4SystemPrompt();
                        const repairUsr = getTier4SelfRepairPrompt(out);
                        const repairRaw = await requestLlmApi(params, repairSys, repairUsr, log);
                        const repairCode = sanitizeLlmResponse(repairRaw);
                        if (repairCode && (repairCode.includes("def test_") || repairCode.includes("unittest"))) {
                          fs3.writeFileSync(testPath, repairCode, "utf8");
                          const result2 = await new Promise((res2) => {
                            (0, import_child_process2.exec)(preCheckCmd, { timeout: 3e4 }, (err2, out2a, out2b) => {
                              res2({ ok: !err2, out: (out2a + out2b).trim() });
                            });
                          });
                          if (result2.ok) {
                            log(`[Tier 4 Self-repair] \u7B2C ${repairAttempt} \u6B21\u4FEE\u6B63\u6210\u529F\uFF01`);
                            finalReportMarkdown += `### \u2705 Self-repair \u6210\u529F\uFF08\u7B2C ${repairAttempt} \u6B21\uFF09

`;
                            loopCoverage = extractCoverage(result2.out, params.filePath);
                            repaired = true;
                            resolve();
                            break;
                          } else {
                            log(`[Tier 4 Self-repair] \u7B2C ${repairAttempt} \u6B21\u4FEE\u6B63\u5F8C\u4ECD\u6709\u932F\u8AA4: ${result2.out.substring(0, 200)}`);
                          }
                        }
                      } catch (repairErr) {
                        log(`[Tier 4 Self-repair] \u7B2C ${repairAttempt} \u6B21\u4FEE\u6B63\u5931\u6557: ${repairErr.message}`);
                      }
                    }
                    if (!repaired) {
                      reject(new Error(`\u6E2C\u8A66\u6A94\u9810\u5148\u9A57\u8B49\u5931\u6557\uFF08Reviewer + Tier 4 Self-repair \u5747\u7121\u6CD5\u4FEE\u6B63\uFF09: ${out.substring(0, 200)}`));
                    }
                  } else {
                    reject(new Error(`\u6E2C\u8A66\u6A94\u9810\u5148\u9A57\u8B49\u5931\u6557\uFF08Reviewer \u7121\u6CD5\u4FEE\u6B63\uFF09: ${out.substring(0, 200)}`));
                  }
                }
              } else {
                const ran = out.match(/Ran (\d+) test/);
                if (ran && parseInt(ran[1]) > 0) {
                  log(`[\u9810\u5148\u9A57\u8B49\u901A\u904E] \u57F7\u884C\u4E86 ${ran[1]} \u500B\u6E2C\u8A66\uFF0C\u5373\u5C07\u9032\u884C\u7A81\u8B8A\u6E2C\u8A66...`);
                  loopCoverage = extractCoverage(out, params.filePath);
                  resolve();
                } else {
                  const msg = `\u6E2C\u8A66\u6A94\u90FD\u6C92\u6709\u8DDF 0 \u500B\u6E2C\u8A66\uFF08\`Ran 0 tests\`\uFF09\uFF0C\u6E2C\u8A66\u540D\u7A31\u5FC5\u9808\u4EE5 test_ \u958B\u982D`;
                  finalReportMarkdown += `### \u26A0\uFE0F \u9810\u5148\u9A57\u8B49\u5931\u6557

${msg}

`;
                  reject(new Error(msg));
                }
              }
            });
          });
          tierSuccess = true;
          break;
        } catch (tierErr) {
          if (currentTier > 1) {
            const prevTier = currentTier;
            currentTier--;
            log(`[Tier \u964D\u968E] \u26A0\uFE0F Tier ${prevTier} \u9A57\u8B49\u5931\u6557\uFF0C\u81EA\u52D5\u89F8\u767C\u7B56\u7565\u964D\u968E\uFF1ATier ${prevTier} \u2192 Tier ${currentTier} \u91CD\u8A66...`);
            finalReportMarkdown += `
> [!WARNING]
> \u26A0\uFE0F **\u7B56\u7565\u81EA\u52D5\u964D\u968E**: Tier ${prevTier} \u9A57\u8B49\u5931\u6557\uFF0C\u7CFB\u7D71\u5DF2\u81EA\u52D5\u5207\u63DB\u964D\u968E\u81F3 **Tier ${currentTier}** \u601D\u8003\u6A21\u5F0F\u91CD\u8A66\u3002

`;
          } else {
            throw tierErr;
          }
        }
      }
      let engine = "mutatest";
      const isWin = process.platform === "win32";
      try {
        const { stdout: pyVerRaw } = await runSpawn("python", ["--version"], {
          env: { ...process.env, PYTHONIOENCODING: "utf-8" }
        });
        const pyVer = pyVerRaw.trim().replace("Python ", "");
        const preferredEngine = detectMutationEngine(pyVer);
        log(`[\u7CFB\u7D71] \u5075\u6E2C\u5230 Python ${pyVer}\uFF0C\u5EFA\u8B70\u5F15\u64CE\uFF1A${preferredEngine}`);
        if (preferredEngine === "mutmut" && !isWin) {
          const mutmutCheck = await runSpawn("mutmut", ["--version"], {});
          if (mutmutCheck.code === 0) {
            engine = "mutmut";
            log(`[\u7CFB\u7D71] mutmut \u53EF\u7528\uFF0C\u4F7F\u7528 mutmut \u9032\u884C\u7A81\u8B8A\u6E2C\u8A66\u3002`);
          } else {
            engine = "mutatest";
            log(`[\u7CFB\u7D71] mutmut \u4E0D\u53EF\u7528\uFF0C\u9000\u56DE\u4F7F\u7528 mutatest\u3002`);
          }
        } else {
          const mutatestCheck = await runSpawn("python", ["-c", "from mutatest.cli import cli_main"], {});
          if (mutatestCheck.code === 0) {
            engine = "mutatest";
            log(`[\u7CFB\u7D71] mutatest \u53EF\u7528\uFF0C\u4F7F\u7528 mutatest \u9032\u884C\u7A81\u8B8A\u6E2C\u8A66\u3002`);
          } else {
            const mutmutCheck = await runSpawn("mutmut", ["--version"], {});
            if (mutmutCheck.code === 0 && !isWin) {
              engine = "mutmut";
              log(`[\u7CFB\u7D71] mutatest \u4E0D\u53EF\u7528\uFF0C\u6539\u7528 mutmut\u3002`);
            } else {
              log(`[\u7CFB\u7D71] \u8B66\u544A\uFF1Amutatest \u4E0D\u53EF\u7528\uFF08\u53EF\u80FD\u7F3A\u5C11 setuptools\uFF09\uFF0C\u8ACB\u57F7\u884C pip install setuptools mutatest`);
              engine = "mutatest";
            }
          }
        }
      } catch (e) {
        log(`[\u7CFB\u7D71] \u7121\u6CD5\u53D6\u5F97 Python \u7248\u672C\uFF0C\u4F7F\u7528\u9810\u8A2D\u5F15\u64CE mutatest\u3002`);
      }
      log(`[${engine}] \u6B63\u5728\u5EFA\u69CB\u7A81\u8B8A\u6E2C\u8A66\u6307\u4EE4...`);
      log(`[${engine}] \u6B63\u5F0F\u555F\u52D5\u5206\u6790 (\u7CFB\u7D71\u8D85\u6642\u9650\u5236: ${params.timeoutSeconds}\u79D2) ... \u9019\u53EF\u80FD\u6703\u82B1\u8CBB\u6578\u5341\u79D2\uFF0C\u8ACB\u7A0D\u5019\uFF01`);
      if (isAborted) {
        throw new Error("\u4F7F\u7528\u8005\u5F37\u5236\u4E2D\u6B62");
      }
      const mutpyResult = await new Promise((resolve, reject) => {
        const targetDir = path3.dirname(params.filePath);
        const parentDir = path3.dirname(targetDir);
        const grandParentDir = path3.dirname(parentDir);
        const testDir = path3.dirname(testPath);
        const testModule = path3.basename(testPath, ".py");
        const pythonPath = isWin ? `${targetDir};${parentDir};${grandParentDir};${testDir};%PYTHONPATH%` : `${targetDir}:${parentDir}:${grandParentDir}:${testDir}:$PYTHONPATH`;
        const setPythonPath = isWin ? `set PYTHONIOENCODING=utf8 && set PYTHONPATH=${pythonPath}` : `export PYTHONIOENCODING=utf8 && export PYTHONPATH="${pythonPath}"`;
        const chcp = isWin ? `chcp 65001 && ` : ``;
        const cdCmd = isWin ? `cd /d "${testDir}"` : `cd "${testDir}"`;
        let cmd = "";
        if (engine === "mutmut") {
          const timeoutArg = params.mutpyTimeout ? `--test-time-multiplier ${params.mutpyTimeout}` : "";
          cmd = `${chcp}${setPythonPath} && ${cdCmd} && mutmut run --paths-to-mutate "${params.filePath}" --runner "python -m unittest ${testModule}" ${timeoutArg}`;
        } else {
          const timeoutArg = params.mutpyTimeout ? `--timeout_factor ${params.mutpyTimeout}` : "";
          const mutatestPatch = `import random; orig_sample=random.sample; random.sample=lambda p,k: orig_sample(list(p) if isinstance(p,set) else p,k); import sys; from mutatest.cli import cli_main; sys.argv[0]=__name__; sys.exit(cli_main())`;
          const mutatestRunCmd = `python -c "${mutatestPatch}"`;
          cmd = `${chcp}${setPythonPath} && ${cdCmd} && ${mutatestRunCmd} -s "${params.filePath}" -t "python -m unittest ${testModule}" -o "${reportDir}.rst" ${timeoutArg}`;
        }
        currentMutpyProcess = (0, import_child_process2.exec)(cmd, { timeout: params.timeoutSeconds * 1e3, killSignal: "SIGTERM" }, (error, stdout, stderr) => {
          currentMutpyProcess = null;
          if (isAborted) {
            return reject(new Error("\u4F7F\u7528\u8005\u5F37\u5236\u4E2D\u6B62"));
          }
          if (error && error.killed) {
            return reject(new Error(`\u7CFB\u7D71\u57F7\u884C\u8D85\u6642 (\u8D85\u904E ${params.timeoutSeconds} \u79D2)`));
          }
          if (error) {
            const cleanMsg = error.message.replace(/^Command failed: .*?\n/s, "");
            resolve(`[${engine} \u7CFB\u7D71\u932F\u8AA4\u8A0A\u606F]
${cleanMsg}
[Stderr]
${stderr}
[Stdout]
${stdout}`);
          } else {
            resolve(stdout || stderr || "\u7121\u8F38\u51FA\u5167\u5BB9");
          }
        });
      });
      log(`[${engine}] \u7A81\u8B8A\u5206\u6790\u57F7\u884C\u5B8C\u7562\uFF01\u6B63\u5728\u89E3\u6790\u5831\u544A\u8207\u5206\u6578...`);
      log(`--- \u7A81\u8B8A\u6E2C\u8A66\u539F\u751F\u8F38\u51FA ---
${mutpyResult}
------------------------`);
      const displayLog = mutpyResult.length > 1e3 ? "..." + mutpyResult.substring(mutpyResult.length - 1e3) : mutpyResult;
      finalReportMarkdown += `### \u57F7\u884C\u65E5\u8A8C\u6458\u8981

\`\`\`text
${displayLog}
\`\`\`

`;
      if (loopCoverage) {
        finalReportMarkdown += `- **\u8986\u84CB\u7387**: ${loopCoverage.coverageText} (\u672A\u8986\u84CB\u884C\u865F: ${loopCoverage.missingLines})
`;
      }
      let reasonStr = "";
      if (engine === "mutmut") {
        const totalMatch = mutpyResult.match(/(\d+)\s+mutants/i);
        const survivedMatch = mutpyResult.match(/(\d+)\s+survived/i);
        if (totalMatch || mutpyResult.includes("mutmut")) {
          const total = totalMatch ? parseInt(totalMatch[1]) : 0;
          const survived = survivedMatch ? parseInt(survivedMatch[1]) : 0;
          mutationScore = total === 0 ? 0 : Math.round((total - survived) / total * 100);
          log(`[\u5206\u6790] \u672C\u8F2A\u7A81\u8B8A\u5206\u6578\uFF1A${mutationScore}% (Total: ${total}, Survived: ${survived})`);
          finalReportMarkdown += `- **\u7A81\u8B8A\u5206\u6578**: ${mutationScore}%
`;
        } else {
          log(`[\u932F\u8AA4] \u7121\u6CD5\u89E3\u6790\u7A81\u8B8A\u5206\u6578\uFF01\u53EF\u80FD mutmut \u57F7\u884C\u5931\u6557\u3002`);
          reasonStr = "\u89E3\u6790\u5931\u6557";
          finalReportMarkdown += `- **\u7A81\u8B8A\u5206\u6578**: \u89E3\u6790\u5931\u6557
`;
        }
      } else {
        const totalMatch = mutpyResult.match(/TOTAL RUNS: (\d+)/);
        const survivedMatch = mutpyResult.match(/SURVIVED: (\d+)/);
        if (totalMatch) {
          const total = parseInt(totalMatch[1]);
          const survived = survivedMatch ? parseInt(survivedMatch[1]) : 0;
          mutationScore = total === 0 ? 0 : Math.round((total - survived) / total * 100);
          log(`[\u5206\u6790] \u672C\u8F2A\u7A81\u8B8A\u5206\u6578\uFF1A${mutationScore}% (Total: ${total}, Survived: ${survived})`);
          finalReportMarkdown += `- **\u7A81\u8B8A\u5206\u6578**: ${mutationScore}%
`;
        } else {
          log(`[\u932F\u8AA4] \u7121\u6CD5\u89E3\u6790\u7A81\u8B8A\u5206\u6578\uFF01\u53EF\u80FD mutatest \u57F7\u884C\u5931\u6557\u3002`);
          reasonStr = "\u89E3\u6790\u5931\u6557";
          finalReportMarkdown += `- **\u7A81\u8B8A\u5206\u6578**: \u89E3\u6790\u5931\u6557
`;
        }
      }
      survivedMutants = engine === "mutmut" ? parseMutmutSurvived(mutpyResult) : parseMutatestSurvived(mutpyResult);
      if (survivedMutants) {
        log(`[\u5F31\u9EDE\u5206\u6790] \u672C\u8F2A\u5B58\u6D3B\u8B8A\u7570\u9AD4\u8CC7\u8A0A\u5DF2\u64F7\u53D6\uFF0C\u5C07\u65BC\u4E0B\u4E00\u8F2A\u512A\u5316\u9032\u884C Assert \u5F37\u5316\uFF1A
${survivedMutants}`);
        reasonStr = survivedMutants.split("\n")[0] + (survivedMutants.split("\n").length > 1 ? "..." : "");
        finalReportMarkdown += `#### \u5B58\u6D3B\u7684\u8B8A\u7570\u9AD4
\`\`\`text
${survivedMutants}
\`\`\`
`;
      } else {
        log(`[\u5206\u6790] \u672C\u8F2A\u7121\u5B58\u6D3B\u8B8A\u7570\u9AD4\uFF0C\u6216\u5206\u6790\u7D50\u679C\u5DF2\u9054\u6700\u512A\u3002`);
        if (mutationScore >= 100) {
          reasonStr = "\u901A\u904E";
        }
        finalReportMarkdown += `- **\u5B58\u6D3B\u8B8A\u7570\u9AD4**: \u7121
`;
      }
      if (mutationScore > bestScore) {
        bestScore = mutationScore;
        bestCode = fs3.readFileSync(testPath, "utf8");
        bestTestPath = testPath;
        log(`[Rollback] \u{1F4BE} \u65B0\u6700\u9AD8\u5206\uFF01\u5DF2\u5C07\u7B2C ${currentLoop} \u8F2A\u6E2C\u8A66\u6A94\u8A18\u9304\u70BA\u6B77\u53F2\u6700\u512A\u89E3\uFF08${mutationScore}%\uFF09\u3002`);
        finalReportMarkdown += `> [!NOTE]
> \u{1F4BE} \u672C\u8F2A\u70BA\u76EE\u524D\u6700\u9AD8\u5206\uFF08${mutationScore}%\uFF09\uFF0C\u5DF2\u5B58\u70BA\u6B77\u53F2\u6700\u512A\u89E3\u3002

`;
      } else if (currentLoop > 1 && mutationScore < bestScore && bestCode) {
        const droppedScore = mutationScore;
        fs3.writeFileSync(testPath, bestCode, "utf8");
        mutationScore = bestScore;
        log(`[Rollback] \u26A0\uFE0F \u7B2C ${currentLoop} \u8F2A\u5206\u6578\uFF08${droppedScore}%\uFF09\u4F4E\u65BC\u6B77\u53F2\u6700\u512A\u89E3\uFF08${bestScore}%\uFF09\uFF0C\u5DF2\u81EA\u52D5\u56DE\u6EFE\u81F3\u6700\u512A\u89E3\u3002`);
        finalReportMarkdown += `> [!WARNING]
> \u26A0\uFE0F \u672C\u8F2A\u5206\u6578\uFF08${droppedScore}%\uFF09\u4F4E\u65BC\u6B77\u53F2\u6700\u512A\u89E3\uFF08${bestScore}%\uFF09\uFF0C\u5DF2\u81EA\u52D5\u56DE\u6EFE\u81F3\u6700\u512A\u89E3\u6E2C\u8A66\u96C6\u3002

`;
      }
      let finalReason = reasonStr;
      if (!finalReason) {
        if (typeof mutationScore === "number") {
          if (mutationScore >= 100) {
            finalReason = "\u901A\u904E (100%)";
          } else if (mutationScore >= 80) {
            finalReason = `\u9AD8\u8986\u84CB (${mutationScore}%)`;
          } else if (mutationScore >= 50) {
            finalReason = `\u90E8\u5206\u901A\u904E (${mutationScore}%)`;
          } else if (mutationScore > 0) {
            finalReason = `\u4F4E\u5206 (${mutationScore}%)`;
          } else {
            finalReason = "\u5DF2\u5B8C\u6210 (\u7121\u7A81\u8B8A\u9EDE/0%)";
          }
        } else {
          finalReason = "\u5DF2\u5B8C\u6210";
        }
      }
      sidebarProvider.webview?.postMessage({
        command: "updateCoverage",
        fileName: displayName,
        file: path3.basename(params.filePath),
        func: params.funcName || "",
        score: typeof mutationScore === "number" ? `${mutationScore}%` : "N/A",
        coverage: loopCoverage?.coverageText ?? null,
        reason: finalReason
      });
      if (fs3.existsSync(path3.join(reportDir, "index.html"))) {
        vscode3.env.openExternal(vscode3.Uri.file(path3.join(reportDir, "index.html")));
      }
      if (mutationScore >= 100) {
        log(`[\u512A\u5316] \u7A81\u8B8A\u5206\u6578\u5DF2\u9054\u5230 100%\uFF0C\u81EA\u6211\u4FEE\u5FA9\u6210\u529F\uFF01`);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error && error.stack ? error.stack : "";
      if (message !== "\u4F7F\u7528\u8005\u5F37\u5236\u4E2D\u6B62") {
        log(`[\u932F\u8AA4] \u57F7\u884C\u4E2D\u65B7: ${message}`);
      }
      finalReportMarkdown += `
### \u274C \u57F7\u884C\u4E2D\u65B7\uFF08\u7B2C ${currentLoop} \u8F2A\uFF09

`;
      finalReportMarkdown += `**\u932F\u8AA4\u8A0A\u606F**: ${message}

`;
      if (stack && stack !== message) {
        finalReportMarkdown += `**\u932F\u8AA4\u5806\u758A**:
\`\`\`
${stack}
\`\`\`

`;
      }
      if (rawCode) {
        finalReportMarkdown += `**AI \u5BE6\u969B\u8F38\u51FA\u5167\u5BB9\uFF08\u524D 500 \u5B57\u5143\uFF09**:
\`\`\`
${rawCode.substring(0, 500)}
\`\`\`

`;
      }
      sidebarProvider.webview?.postMessage({
        command: "updateCoverage",
        fileName: displayName,
        file: path3.basename(params.filePath),
        func: params.funcName || "",
        score: "\u5931\u6557",
        coverage: null,
        reason: message.includes("CUDA") ? "VRAM \u4E0D\u8DB3" : message.length > 50 ? message.substring(0, 47) + "..." : message
      });
      break;
    }
    if (currentLoop >= 2 && survivedMutants) {
      log(`[\u8B8A\u7570\u9AD4\u5206\u6D41\u5E2B] \u555F\u52D5\u5206\u6D41\u5206\u6790\uFF0C\u5224\u65B7 ${survivedMutants.split("mutation").length - 1} \u500B\u5B58\u6D3B\u8B8A\u7570\u9AD4...`);
      try {
        const triageSys = getMutantTriageSystemPrompt();
        const currentTestCode = fs3.existsSync(testPath) ? fs3.readFileSync(testPath, "utf8") : "";
        const moduleName = path3.basename(params.filePath, ".py");
        const triageUsr = getMutantTriageUserPrompt(
          survivedMutants,
          astContext?.code || "",
          currentTestCode,
          moduleName,
          params.funcName || "",
          semanticContext
        );
        const triageRaw = await requestLlmApi(params, triageSys, triageUsr, log);
        const triageResult = parseMutantTriageResult(triageRaw);
        if (triageResult) {
          log(`[\u8B8A\u7570\u9AD4\u5206\u6D41\u5E2B] \u2705 \u5206\u6D41\u5B8C\u6210\uFF1A${triageResult.equivalent_count} \u500B\u7B49\u6548\u3001${triageResult.verdicts.filter((v) => v.verdict === "KILLABLE").length} \u500B\u53EF\u6BBA\u3002`);
          const eqReport = formatEquivalentMutantsReport(triageResult);
          if (eqReport) {
            finalReportMarkdown += eqReport;
            log(`[\u8B8A\u7570\u9AD4\u5206\u6D41\u5E2B] \u7B49\u6548\u8B8A\u7570\u9AD4\u5DF2\u8A18\u9304\u65BC\u5831\u544A\uFF0C\u4E0B\u8F2A\u5C07\u8DF3\u904E\u91CD\u8A66\u3002`);
          }
          if (triageResult.has_killable) {
            const killMethods = extractKillTestMethods(triageResult);
            if (killMethods) {
              survivedMutants += `

[Triage Hint] The following test methods are suggested to kill the KILLABLE mutants above:
\`\`\`python
${killMethods}
\`\`\``;
              log(`[\u8B8A\u7570\u9AD4\u5206\u6D41\u5E2B] \u5DF2\u5C07 ${triageResult.verdicts.filter((v) => v.verdict === "KILLABLE").length} \u500B kill_test \u6CE8\u5165\u4E0B\u4E00\u8F2A Prompt\u3002`);
            }
          }
          if (!triageResult.has_killable && triageResult.equivalent_count > 0) {
            log(`[\u8B8A\u7570\u9AD4\u5206\u6D41\u5E2B] \u6240\u6709\u5B58\u6D3B\u8B8A\u7570\u9AD4\u5747\u70BA\u7B49\u6548\u8B8A\u7570\u9AD4\uFF0C\u7121\u9700\u7E7C\u7E8C\u91CD\u8A66\uFF0C\u7D50\u675F\u5FAA\u74B0\u3002`);
            finalReportMarkdown += `
> [!NOTE]
> \u{1F535} \u6240\u6709\u5269\u9918\u5B58\u6D3B\u8B8A\u7570\u9AD4\u5DF2\u88AB\u5224\u5B9A\u70BA\u7B49\u6548\u8B8A\u7570\u9AD4\uFF0C\u4E0D\u8A08\u5165\u7A81\u8B8A\u5206\u6578\u5206\u6BCD\u3002

`;
            currentLoop = params.maxLoops + 1;
          }
        } else {
          log(`[\u8B8A\u7570\u9AD4\u5206\u6D41\u5E2B] \u26A0\uFE0F \u7121\u6CD5\u89E3\u6790 JSON \u56DE\u61C9\uFF0C\u8DF3\u904E\u5206\u6D41\uFF08\u4E0D\u5F71\u97FF\u4E3B\u6D41\u7A0B\uFF09\u3002`);
        }
      } catch (triageErr) {
        log(`[\u8B8A\u7570\u9AD4\u5206\u6D41\u5E2B] \u26A0\uFE0F \u5206\u6D41\u547C\u53EB\u5931\u6557: ${triageErr.message}\uFF0C\u7E7C\u7E8C\u4E3B\u6D41\u7A0B\u3002`);
      }
    }
    currentLoop++;
  }
  const finalReportPath = path3.join(sessionDir, `final_report.md`);
  fs3.writeFileSync(finalReportPath, finalReportMarkdown, "utf8");
  log(`[\u7CFB\u7D71] \u5206\u6790\u7D50\u675F\uFF01\u6E2C\u8A66\u6A94\u8207\u6700\u7D42\u5831\u544A\u5DF2\u5132\u5B58\u81F3:
${sessionDir}`);
  const doc = await vscode3.workspace.openTextDocument(finalReportPath);
  await vscode3.window.showTextDocument(doc, { preview: false });
}
function extractFocusContext(survivedMutants, targetCode) {
  if (!survivedMutants) return "";
  const lines = targetCode.split("\n");
  const focusSnippets = [];
  const mutantLines = survivedMutants.split("\n");
  let processedCount = 0;
  for (const mLine of mutantLines) {
    if (processedCount >= 3) break;
    if (!mLine.trim() || !mLine.includes("mutation")) continue;
    let lineNum = -1;
    const mutatestMatch = mLine.match(/\(l:\s*(\d+)/);
    if (mutatestMatch) {
      lineNum = parseInt(mutatestMatch[1], 10);
    } else {
      const otherMatch = mLine.match(/line\s+(\d+)/i) || mLine.match(/:(\d+)/);
      if (otherMatch) {
        lineNum = parseInt(otherMatch[1], 10);
      }
    }
    if (lineNum > 0 && lineNum <= lines.length) {
      const idx = lineNum - 1;
      const start = Math.max(0, idx - 2);
      const end = Math.min(lines.length - 1, idx + 2);
      let snippet = `\u3010\u76EE\u6A19\u8B8A\u7570\u9AD4\u3011
${mLine.trim()}
\u3010\u767C\u751F\u4F4D\u7F6E\u5468\u906D\u7A0B\u5F0F\u78BC (\u7B2C ${start + 1}~${end + 1} \u884C)\u3011
\`\`\`python
`;
      for (let i = start; i <= end; i++) {
        const prefix = i === idx ? ">> " : "   ";
        snippet += `${prefix}${i + 1}: ${lines[i]}
`;
      }
      snippet += `\`\`\``;
      focusSnippets.push(snippet);
      processedCount++;
    }
  }
  return focusSnippets.join("\n\n");
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
