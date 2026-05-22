const fs = require('fs');

// Patch webviewContent.ts
let webview = fs.readFileSync('src/webviewContent.ts', 'utf8');

// 1. UI changes
webview = webview.replace('<summary>⚙️ 基礎設定 (資料夾路徑)</summary>', '<summary>⚙️ 基礎設定</summary>');
webview = webview.replace('<label style="margin-top:10px;">📂 測試結果輸出資料夾</label>', '<label>📂 測試結果輸出資料夾</label>');
webview = webview.replace('</details>\n\n    <details open>\n        <summary>🎯 測試目標</summary>', 
    '<label>超時限制 (秒)</label>\n            <input type="number" id="timeout-sec" value="60" min="10" max="300" style="width:100%;">\n            \n            <div class="flex-row" style="margin-top:15px; justify-content:space-between; gap:10px;">\n                <button id="btn-run" style="flex:1;">🚀 開始自動化突變測試</button>\n                <button id="btn-abort" style="flex:1; background:#a82a2a; color:white; display:none;">🛑 中止測試</button>\n            </div>\n        </div>\n    </details>\n\n    <details open>\n        <summary>🎯 測試目標</summary>');
webview = webview.replace('<label style="margin-top:8px;">單次執行超時限制 (秒)</label>\n            <input type="number" id="timeout-sec" value="60" min="10">\n        </div>\n    </details>', '</div>\n    </details>');
webview = webview.replace('<button id="start-test" style="margin-top:10px; width:100%; font-size:13px; padding:10px 0;">🚀 執行自動化測試循環</button>\n\n    <details>', '<details>');

const oldTable = `<summary>📊 檔案覆蓋率 explorer</summary>
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
            </table>`;
const newTable = `<summary>📊 檔案覆蓋率與結果</summary>
        <div class="content">
            <label>📁 批次測試範圍</label>
            <div class="flex-row">
                <input type="text" id="batch-path" readonly placeholder="預設: 整個專案">
                <button id="btn-browse-batch" style="width:40px; flex-shrink:0;">...</button>
            </div>
            
            <button id="btn-batch-run" style="margin-top:10px; width:100%; background:var(--vscode-button-secondaryBackground, #3a3d3e); color:var(--vscode-button-secondaryForeground, #ffffff);">▶️ 執行批次自動化測試 (範圍內所有檔案)</button>

            <table id="coverage-table" style="margin-top:15px; width:100%; border-collapse:collapse; text-align:left;">
                <thead style="border-bottom:1px solid var(--vscode-editorGroup-border);"><tr>
                    <th style="padding:5px;">資料夾/檔案名稱</th>
                    <th style="padding:5px;">突變分數</th>
                    <th style="padding:5px;">狀態 / 原因</th>
                </tr></thead>
                <tbody><tr><td colspan="3" style="padding:10px; text-align:center; opacity:0.5;">尚無測試數據</td></tr></tbody>
            </table>`;
webview = webview.replace(oldTable, newTable);

// 2. JS Handlers
webview = webview.replace(/case 'setProjectPath':\s+document\.getElementById\('project-path'\)\.value = msg\.path;\s+break;/,
    `case 'setProjectPath': document.getElementById('project-path').value = msg.path; if (!document.getElementById('batch-path').value) document.getElementById('batch-path').value = msg.path; break;
                case 'setBatchPath': document.getElementById('batch-path').value = msg.path; break;`);

webview = webview.replace(/case 'updateCoverage':[\s\S]*?break;/, `case 'updateCoverage':
                    const tbody = document.querySelector('#coverage-table tbody');
                    let existingRow = Array.from(tbody.querySelectorAll('tr')).find(row => row.cells[0]?.textContent === msg.fileName);
                    if (existingRow) { 
                        existingRow.cells[1].innerHTML = '<span class="badge score-badge">' + msg.score + '</span>'; 
                        existingRow.cells[2].textContent = msg.reason || '';
                    } else { 
                        if (tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent.includes('尚無數據')) tbody.innerHTML = ''; 
                        const newRow = tbody.insertRow(); 
                        newRow.insertCell(0).textContent = msg.fileName; 
                        newRow.insertCell(1).innerHTML = '<span class="badge score-badge">' + msg.score + '</span>'; 
                        newRow.insertCell(2).textContent = msg.reason || '';
                        Array.from(newRow.cells).forEach(c => c.style.padding = '5px');
                    }
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
                    break;`);

webview = webview.replace(/document\.getElementById\('btn-browse-out'\)\.onclick = \(\) => vscode\.postMessage\(\{ command: 'browseFolder' \}\);/,
    `document.getElementById('btn-browse-out').onclick = () => vscode.postMessage({ command: 'browseFolder' });
        document.getElementById('btn-browse-batch').onclick = () => vscode.postMessage({ command: 'browseBatchFolder' });`);

webview = webview.replace(/document\.getElementById\('start-test'\)\.onclick = \(\) => \{[\s\S]*?\}\);\s*\};/, `document.getElementById('btn-abort').onclick = () => vscode.postMessage({ command: 'abortTest' });
        
        document.getElementById('btn-run').onclick = () => {
            const envType = document.getElementById('env-type').value;
            const modelName = envType === 'local' ? document.getElementById('model-select').value : document.getElementById('api-key-select').value;
            const filePath = document.getElementById('file-select').value;
            
            if(!envType || !modelName || !filePath) {
                vscode.postMessage({ command: 'appendLog', text: '[錯誤] 請確認環境、模型與目標檔案皆已選擇。' });
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
                timeoutSeconds: parseInt(document.getElementById('timeout-sec').value),
                outputPath: document.getElementById('output-path').value
            });
        };

        document.getElementById('btn-batch-run').onclick = () => {
            const envType = document.getElementById('env-type').value;
            const modelName = envType === 'local' ? document.getElementById('model-select').value : document.getElementById('api-key-select').value;
            let batchPath = document.getElementById('batch-path').value || document.getElementById('project-path').value;
            
            if(!envType || !modelName || !batchPath) {
                vscode.postMessage({ command: 'appendLog', text: '[錯誤] 請確認環境、模型與批次測試資料夾皆已設定。' });
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
                timeoutSeconds: parseInt(document.getElementById('timeout-sec').value),
                outputPath: document.getElementById('output-path').value
            });
        };`);

fs.writeFileSync('src/webviewContent.ts', webview);
console.log('WebviewContent updated.');

// Patch extension.ts
let ext = fs.readFileSync('src/extension.ts', 'utf8');

// replace exec with exec, ChildProcess and add state vars
ext = ext.replace("import { exec } from 'child_process';", 
`import { exec, ChildProcess } from 'child_process';

let currentAbortController: AbortController | null = null;
let currentMutpyProcess: ChildProcess | null = null;
let isAborted = false;`);

const extOldCmd = `    const runTestCmd = vscode.commands.registerCommand(
        'llm-unit-test.runCaptureAndTest',
        async (params: AnalysisParams) => {
            const log = (text: string) =>
                sidebarProvider.webview?.postMessage({ command: 'appendLog', text });

            let currentLoop = 1;
            let mutationScore = 0;

            if (!params.filePath || !fs.existsSync(params.filePath)) {
                log('[錯誤] 找不到目標檔案路徑');
                return;
            }

            let survivedMutants = "";

            while (currentLoop <= params.maxLoops && mutationScore < 100) {
                log(\`\\n--- 🔄 第 \${currentLoop} 輪開始 ---\`);

                // 每輪重新讀取目標程式碼（使用者可能在迴圈執行期間修改了檔案）
                let targetCode: string;
                try {
                    targetCode = fs.readFileSync(params.filePath, 'utf-8');
                } catch {
                    log('[錯誤] 讀取檔案失敗');
                    return;
                }

                // 定義路徑
                const baseDir = params.outputPath || path.dirname(params.filePath);
                const testPath = path.join(baseDir, \`test_loop_\${currentLoop}.py\`);
                const reportDir = path.join(baseDir, \`report_loop_\${currentLoop}\`);

                // 呼叫 Python AST 擷取函式特徵與依賴
                let astContext: AstContext | null = null;
                if (params.funcName) {
                    log(\`[AST] 正在解析函式 \\\`\${params.funcName}\\\` 的結構與依賴...\`);
                    astContext = await extractAstContext(params.filePath, params.funcName, baseDir);
                }

                // 建立 Prompt
                const systemPrompt = getSystemPrompt(currentLoop, survivedMutants);
                const userPrompt = getUserPrompt(params.filePath, params.funcName, targetCode, astContext);

                try {
                    // LLM 呼叫分流
                    let apiUrl = "";
                    let bodyData = {};

                    if (params.envType === 'local') {
                        apiUrl = 'http://127.0.0.1:11434/api/generate';
                        bodyData = {
                            model: params.modelName,
                            system: systemPrompt,
                            prompt: userPrompt,
                            stream: false
                        };
                    } else {
                        const config = vscode.workspace.getConfiguration('llmUnitTest');
                        const keys = config.get<Record<string, string>>('apiKeys', {});
                        const actualKey = keys[params.modelName];
                        // 使用動態模型名稱而非硬編碼
                        apiUrl = \`https://generativelanguage.googleapis.com/v1beta/models/\${encodeURIComponent(params.modelName)}:generateContent?key=\${actualKey}\`;
                        bodyData = { contents: [{ parts: [{ text: systemPrompt + "\\n\\n" + userPrompt }] }] };
                    }

                    log(\`[LLM] 正在呼叫模型: \${params.modelName}\`);
                    const response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(bodyData)
                    });

                    if (!response.ok) {
                        const errText = await response.text();
                        throw new Error(\`API 伺服器錯誤 (HTTP \${response.status}): \${errText}\`);
                    }

                    const resJson = await response.json() as Record<string, unknown>;
                    let rawCode = "";

                    if (params.envType === 'local') {
                        rawCode = (resJson as { response?: string }).response || "";
                    } else {
                        const candidates = resJson.candidates as Array<{
                            content?: { parts?: Array<{ text?: string }> };
                        }> | undefined;
                        if (candidates && candidates[0]?.content?.parts?.[0]?.text) {
                            rawCode = candidates[0].content.parts[0].text;
                        } else if (resJson.error) {
                            const err = resJson.error as { message?: string };
                            throw new Error(err.message || "Gemini 呼叫失敗");
                        } else {
                            throw new Error("無法解析的 API 回傳格式: " + JSON.stringify(resJson));
                        }
                    }

                    const sanitizedCode = sanitizeLlmResponse(rawCode);
                    if (!sanitizedCode) {
                        throw new Error("模型產生的程式碼內容為空");
                    }

                    fs.writeFileSync(testPath, sanitizedCode, 'utf8');
                    log(\`[系統] 測試腳本已存檔: \${path.basename(testPath)}\`);

                    // 呼叫 MutPy 並產生 HTML 報告（路徑加引號防止空白斷裂）
                    log(\`[MutPy] 啟動突變分析 (超時限制: \${params.timeoutSeconds}秒)，報告輸出至: \${reportDir}\`);

                    const mutpyResult = await new Promise<string>((resolve, reject) => {
                        const cmd = \`chcp 65001 && python -m mutpy --target "\${params.filePath}" --unit-test "\${testPath}" --report-html "\${reportDir}"\`;

                        const child = exec(cmd, { timeout: params.timeoutSeconds * 1000, killSignal: 'SIGTERM' }, (error, stdout, stderr) => {
                            if (error && error.killed) {
                                reject(new Error(\`突變測試超時 (超過 \${params.timeoutSeconds} 秒)\`));
                            } else {
                                resolve(stdout || stderr || "無輸出內容");
                            }
                        });
                    });

                    log(\`[MutPy 執行結果]\\n\${mutpyResult}\`);

                    // 解析分數與存活突變體
                    const scoreMatch = mutpyResult.match(/Mutation score \\[([\\d.]+) %\\]/);
                    if (scoreMatch) {
                        mutationScore = parseFloat(scoreMatch[1]);
                        log(\`[分析] 本輪突變分數：\${mutationScore}%\`);

                        // 主動將突變分數同步回 Webview 的表格顯示
                        sidebarProvider.webview?.postMessage({
                            command: 'updateCoverage',
                            fileName: path.basename(params.filePath),
                            score: \`\${mutationScore}%\`
                        });
                    }

                    // 更新存活變異體資訊供下一輪使用
                    survivedMutants = parseSurvivedMutants(mutpyResult);
                    if (survivedMutants) {
                        log(\`[弱點分析] 本輪存活變異體資訊已擷取，將於下一輪優化進行 Assert 強化：\\n\${survivedMutants}\`);
                    } else {
                        log(\`[分析] 本輪無存活變異體，或分析結果已達最優。\`);
                    }

                    // 自動開啟 HTML 報告
                    if (fs.existsSync(path.join(reportDir, 'index.html'))) {
                        vscode.env.openExternal(vscode.Uri.file(path.join(reportDir, 'index.html')));
                    }

                    if (mutationScore >= 100) {
                        log(\`[優化] 突變分數已達到 100%，自我修復成功！\`);
                        break;
                    }

                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    log(\`[錯誤] 執行中斷: \${message}\`);
                    break;
                }
                currentLoop++;
            }
        }
    );`;

const extNewCmd = `    const runTestCmd = vscode.commands.registerCommand(
        'llm-unit-test.runCaptureAndTest',
        async (params: AnalysisParams) => {
            isAborted = false;
            const log = (text: string) => sidebarProvider.webview?.postMessage({ command: 'appendLog', text });
            await executeSingleFileAnalysis(params, log, sidebarProvider);
            sidebarProvider.webview?.postMessage({ command: 'analysisFinished' });
        }
    );

    interface BatchAnalysisParams extends Omit<AnalysisParams, 'filePath' | 'funcName'> {
        batchPath: string;
    }

    const runBatchCmd = vscode.commands.registerCommand(
        'llm-unit-test.runBatchAnalysis',
        async (params: BatchAnalysisParams) => {
            isAborted = false;
            const log = (text: string) => sidebarProvider.webview?.postMessage({ command: 'appendLog', text });
            try {
                const pyFiles = await findPythonFilesInDir(params.batchPath);
                if (pyFiles.length === 0) {
                    log(\`[系統] 在目錄 \${params.batchPath} 中找不到任何 Python 檔案。\`);
                    return;
                }

                log(\`[系統] 開始批次測試，共找到 \${pyFiles.length} 個 Python 檔案。\`);
                for (let i = 0; i < pyFiles.length; i++) {
                    if (isAborted) {
                        log(\`[系統] ⚠️ 批次測試已由使用者強制中止。\`);
                        break;
                    }
                    const file = pyFiles[i];
                    log(\`\\n======================================================\`);
                    log(\`[系統] 正在處理批次檔案 (\${i+1}/\${pyFiles.length}): \${file}\`);
                    log(\`======================================================\`);
                    const singleParams: AnalysisParams = { ...params, filePath: file, funcName: '' };
                    await executeSingleFileAnalysis(singleParams, log, sidebarProvider);
                }
                log(\`\\n[系統] 🎉 批次自動化測試執行完畢！\`);
            } catch (error) {
                log(\`[錯誤] 批次執行發生錯誤: \${error}\`);
            } finally {
                sidebarProvider.webview?.postMessage({ command: 'analysisFinished' });
            }
        }
    );

    const abortTestCmd = vscode.commands.registerCommand('llm-unit-test.abortTest', () => {
        if (!isAborted) {
            isAborted = true;
            if (currentAbortController) currentAbortController.abort();
            if (currentMutpyProcess) {
                exec(\`taskkill /pid \${currentMutpyProcess.pid} /T /F\`);
                currentMutpyProcess.kill();
            }
        }
    });`;
    
ext = ext.replace(extOldCmd, extNewCmd);
ext = ext.replace("context.subscriptions.push(runTestCmd);", "context.subscriptions.push(runTestCmd, runBatchCmd, abortTestCmd);");

const extHelperCode = `

async function executeSingleFileAnalysis(params: AnalysisParams, log: (text: string) => void, sidebarProvider: MutationViewProvider) {
    let currentLoop = 1;
    let mutationScore = 0;

    if (!params.filePath || !fs.existsSync(params.filePath)) {
        log('[錯誤] 找不到目標檔案路徑');
        return;
    }

    let survivedMutants = "";

    while (currentLoop <= params.maxLoops && mutationScore < 100) {
        if (isAborted) {
            log(\`[系統] ⚠️ 測試已由使用者強制中止。\`);
            break;
        }
        log(\`\\n--- 🔄 第 \${currentLoop} 輪開始 ---\`);

        let targetCode: string;
        try {
            targetCode = fs.readFileSync(params.filePath, 'utf-8');
        } catch {
            log('[錯誤] 讀取檔案失敗');
            return;
        }

        const baseDir = params.outputPath || path.dirname(params.filePath);
        const testPath = path.join(baseDir, \`test_loop_\${currentLoop}.py\`);
        const reportDir = path.join(baseDir, \`report_loop_\${currentLoop}\`);

        let astContext: AstContext | null = null;
        if (params.funcName) {
            log(\`[AST] 正在解析函式 \\\`\${params.funcName}\\\` 的結構與依賴...\`);
            astContext = await extractAstContext(params.filePath, params.funcName, baseDir);
            if (astContext && !astContext.error) log(\`[AST] 解析完成！已擷取函式特徵與依賴。\`);
            else log(\`[AST] 解析遇到問題或找不到指定函式，將退回全域分析模式。\`);
        }

        const systemPrompt = getSystemPrompt(currentLoop, survivedMutants);
        const userPrompt = getUserPrompt(params.filePath, params.funcName, targetCode, astContext);

        try {
            let apiUrl = "";
            let bodyData = {};

            if (params.envType === 'local') {
                apiUrl = 'http://127.0.0.1:11434/api/generate';
                bodyData = { model: params.modelName, system: systemPrompt, prompt: userPrompt, stream: false };
            } else {
                const config = vscode.workspace.getConfiguration('llmUnitTest');
                const keys = config.get<Record<string, string>>('apiKeys', {});
                const actualKey = keys[params.modelName];
                apiUrl = \`https://generativelanguage.googleapis.com/v1beta/models/\${encodeURIComponent(params.modelName)}:generateContent?key=\${actualKey}\`;
                bodyData = { contents: [{ parts: [{ text: systemPrompt + "\\n\\n" + userPrompt }] }] };
            }

            log(\`[LLM] 正在準備呼叫模型: \${params.modelName} ... (網路請求中，請耐心等候)\`);
            
            currentAbortController = new AbortController();
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyData),
                signal: currentAbortController.signal
            });
            currentAbortController = null;

            if (isAborted) throw new Error("使用者強制中止");

            log(\`[LLM] 網路請求已返回，正在檢查回應狀態...\`);
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(\`API 伺服器錯誤 (HTTP \${response.status}): \${errText}\`);
            }

            const resJson = await response.json() as Record<string, unknown>;
            log(\`[LLM] 呼叫成功！正在萃取回傳的程式碼片段...\`);
            let rawCode = "";

            if (params.envType === 'local') {
                rawCode = (resJson as { response?: string }).response || "";
            } else {
                const candidates = resJson.candidates as Array<{ content?: { parts?: Array<{ text?: string }> }; }> | undefined;
                if (candidates && candidates[0]?.content?.parts?.[0]?.text) {
                    rawCode = candidates[0].content.parts[0].text;
                } else if (resJson.error) {
                    const err = resJson.error as { message?: string };
                    throw new Error(err.message || "Gemini 呼叫失敗");
                } else {
                    throw new Error("無法解析的 API 回傳格式: " + JSON.stringify(resJson));
                }
            }

            const sanitizedCode = sanitizeLlmResponse(rawCode);
            if (!sanitizedCode) throw new Error("模型產生的程式碼內容為空");

            log(\`[系統] 準備將生成的測試程式碼存檔...\`);
            fs.writeFileSync(testPath, sanitizedCode, 'utf8');
            log(\`[系統] 測試腳本已存檔至: \${testPath}\`);

            log(\`[MutPy] 正在建構突變測試指令...\`);
            log(\`[MutPy] 正式啟動分析 (超時限制: \${params.timeoutSeconds}秒) ... 這可能會花費數十秒，請稍候！\`);

            if (isAborted) throw new Error("使用者強制中止");

            const mutpyResult = await new Promise<string>((resolve, reject) => {
                const cmd = \`chcp 65001 && python -m mutpy --target "\${params.filePath}" --unit-test "\${testPath}" --report-html "\${reportDir}"\`;
                currentMutpyProcess = exec(cmd, { timeout: params.timeoutSeconds * 1000, killSignal: 'SIGTERM' }, (error, stdout, stderr) => {
                    currentMutpyProcess = null;
                    if (isAborted) return reject(new Error("使用者強制中止"));
                    if (error && error.killed) return reject(new Error(\`突變測試超時 (超過 \${params.timeoutSeconds} 秒)\`));
                    resolve(stdout || stderr || "無輸出內容");
                });
            });

            log(\`[MutPy] 突變分析執行完畢！正在解析報告與分數...\`);
            log(\`--- 突變測試原生輸出 --- \\n\${mutpyResult}\\n------------------------\`);

            const scoreMatch = mutpyResult.match(/Mutation score \\[([\\d.]+) %\\]/);
            let reasonStr = "";
            if (scoreMatch) {
                mutationScore = parseFloat(scoreMatch[1]);
                log(\`[分析] 本輪突變分數：\${mutationScore}%\`);
            } else {
                log(\`[錯誤] 無法解析突變分數！可能 MutPy 執行失敗或環境中未安裝 mutpy。\`);
                reasonStr = "MutPy 解析失敗";
                if (!fs.existsSync(path.join(reportDir, 'index.html'))) {
                    vscode.window.showErrorMessage(\`⚠️ MutPy 測試報告產生失敗，請確認您的終端機能夠正常執行 python -m mutpy，且程式碼語法正確。\`);
                }
            }

            survivedMutants = parseSurvivedMutants(mutpyResult);
            if (survivedMutants) {
                log(\`[弱點分析] 本輪存活變異體資訊已擷取，將於下一輪優化進行 Assert 強化：\\n\${survivedMutants}\`);
                reasonStr = survivedMutants.split('\\n')[0] + (survivedMutants.split('\\n').length > 1 ? "..." : "");
            } else {
                log(\`[分析] 本輪無存活變異體，或分析結果已達最優。\`);
                if (mutationScore >= 100) reasonStr = "通過";
            }

            sidebarProvider.webview?.postMessage({
                command: 'updateCoverage',
                fileName: path.basename(params.filePath),
                score: mutationScore ? \`\${mutationScore}%\` : 'N/A',
                reason: reasonStr
            });

            if (fs.existsSync(path.join(reportDir, 'index.html'))) {
                vscode.env.openExternal(vscode.Uri.file(path.join(reportDir, 'index.html')));
            }

            if (mutationScore >= 100) {
                log(\`[優化] 突變分數已達到 100%，自我修復成功！\`);
                break;
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (message !== "使用者強制中止") log(\`[錯誤] 執行中斷: \${message}\`);
            sidebarProvider.webview?.postMessage({
                command: 'updateCoverage',
                fileName: path.basename(params.filePath),
                score: '失敗',
                reason: message.includes('CUDA') ? 'VRAM 不足' : '執行異常'
            });
            break;
        }
        currentLoop++;
    }
}

async function findPythonFilesInDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
        const list = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const item of list) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
                if (['.git', 'node_modules', 'env', '.env', 'venv', '.venv', '.pytest_cache', '__pycache__'].includes(item.name)) continue;
                results.push(...await findPythonFilesInDir(fullPath));
            } else if (item.name.endsWith('.py')) {
                results.push(fullPath);
            }
        }
    } catch { }
    return results;
}
`;

ext = ext.replace("export function deactivate() {}", extHelperCode + "\nexport function deactivate() {}");
fs.writeFileSync('src/extension.ts', ext);
console.log('Extension updated.');
