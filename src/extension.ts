import * as vscode from 'vscode';
import { MutationViewProvider } from './SidebarProvider';
import { getSystemPrompt, getUserPrompt } from './promptProvider';
import * as path from 'path';
import * as fs from 'fs';
import { exec, ChildProcess } from 'child_process';

let currentAbortController: AbortController | null = null;
let currentMutpyProcess: ChildProcess | null = null;
let isAborted = false;

interface AnalysisParams {
    envType: 'local' | 'cloud' | 'custom';
    modelName: string;
    filePath: string;
    funcName: string;
    maxLoops: number;
    mutpyTimeout?: number;
    timeoutSeconds: number;
    outputPath: string;
    customUrl?: string;
    customKey?: string;
}

interface AstContext {
    name: string;
    args: string[];
    docstring: string;
    calls: string[];
    code: string;
    error?: string;
}

export function activate(context: vscode.ExtensionContext) {
    const sidebarProvider = new MutationViewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MutationViewProvider.viewType, sidebarProvider)
    );

    const runTestCmd = vscode.commands.registerCommand(
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
                    log(`[系統] 在目錄 ${params.batchPath} 中找不到任何 Python 檔案。`);
                    return;
                }

                log(`[系統] 開始批次測試，共找到 ${pyFiles.length} 個 Python 檔案。`);
                for (let i = 0; i < pyFiles.length; i++) {
                    if (isAborted) {
                        log(`[系統] ⚠️ 批次測試已由使用者強制中止。`);
                        break;
                    }
                    const file = pyFiles[i];
                    log(`\n======================================================`);
                    log(`[系統] 正在處理批次檔案 (${i+1}/${pyFiles.length}): ${file}`);
                    log(`======================================================`);
                    const singleParams: AnalysisParams = { ...params, filePath: file, funcName: '' };
                    await executeSingleFileAnalysis(singleParams, log, sidebarProvider);
                }
                log(`\n[系統] 🎉 批次自動化測試執行完畢！`);
            } catch (error) {
                log(`[錯誤] 批次執行發生錯誤: ${error}`);
            } finally {
                sidebarProvider.webview?.postMessage({ command: 'analysisFinished' });
            }
        }
    );

    const abortTestCmd = vscode.commands.registerCommand('llm-unit-test.abortTest', () => {
        if (!isAborted) {
            isAborted = true;
            if (currentAbortController) {currentAbortController.abort();}
            if (currentMutpyProcess) {
                exec(`taskkill /pid ${currentMutpyProcess.pid} /T /F`);
                currentMutpyProcess.kill();
            }
        }
    });

    context.subscriptions.push(runTestCmd, runBatchCmd, abortTestCmd);
}

async function extractAstContext(
    targetPath: string,
    funcName: string,
    baseDir: string
): Promise<AstContext | null> {
    return new Promise((resolve) => {
        const pythonScript = path.join(__dirname, '..', 'python_scripts', 'ast_extractor.py');
        const outputPath = path.join(baseDir, 'ast_context.json');

        const cmd = `python "${pythonScript}" "${targetPath}" "${funcName}" "${outputPath}"`;

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                resolve({ error: stdout || stderr, name: "", args: [], docstring: "", calls: [], code: "" });
                return;
            }
            if (fs.existsSync(outputPath)) {
                try {
                    const data = fs.readFileSync(outputPath, 'utf8');
                    resolve(JSON.parse(data));
                } catch {
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
    });
}

function sanitizeLlmResponse(rawCode: string): string {
    let cleanCode = rawCode.trim();
    if (cleanCode.includes("```python")) {
        const match = cleanCode.match(/\`\`\`python([\s\S]*?)\`\`\`/);
        if (match) {
            cleanCode = match[1].trim();
        }
    } else if (cleanCode.includes("```")) {
        const match = cleanCode.match(/\`\`\`([\s\S]*?)\`\`\`/);
        if (match) {
            cleanCode = match[1].trim();
        }
    }
    return cleanCode;
}

function parseSurvivedMutants(mutpyResult: string): string {
    const lines = mutpyResult.split('\n');
    let isSurvivedSection = false;
    const survivedList: string[] = [];

    for (const line of lines) {
        if (line.includes('Survived mutants (')) {
            isSurvivedSection = true;
            continue;
        }
        if (isSurvivedSection) {
            if (line.trim() === '' || line.startsWith('[-]')) {
                break;
            }
            survivedList.push(line.trim());
        }
    }
    return survivedList.join('\n');
}

async function executeSingleFileAnalysis(params: AnalysisParams, log: (text: string) => void, sidebarProvider: MutationViewProvider) {
    let currentLoop = 1;
    let mutationScore = 0;

    if (!params.filePath || !fs.existsSync(params.filePath)) {
        log('[錯誤] 找不到目標檔案路徑');
        return;
    }

    let survivedMutants = "";
    let finalReportMarkdown = `# 突變測試與修復分析報告\n\n- **目標檔案**: ${params.filePath}\n- **測試函式**: ${params.funcName || '全檔案'}\n- **日期**: ${new Date().toLocaleString()}\n\n`;

    while (currentLoop <= params.maxLoops && mutationScore < 100) {
        if (isAborted) {
            log(`[系統] ⚠️ 測試已由使用者強制中止。`);
            break;
        }
        log(`\n--- 🔄 第 ${currentLoop} 輪開始 ---`);
        finalReportMarkdown += `## 第 ${currentLoop} 輪測試\n`;

        let targetCode: string;
        try {
            targetCode = fs.readFileSync(params.filePath, 'utf-8');
        } catch {
            log('[錯誤] 讀取檔案失敗');
            return;
        }

        const baseDir = params.outputPath || path.dirname(params.filePath);
        
        // 修正檔案名稱包含 funcName, loop, date
        const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '_');
        const safeFuncName = params.funcName || 'file';
        const baseName = path.basename(params.filePath, '.py');
        const testPath = path.join(baseDir, `test_${baseName}_${safeFuncName}_loop${currentLoop}_${dateStr}.py`);
        const reportDir = path.join(baseDir, `report_${baseName}_${safeFuncName}_loop${currentLoop}_${dateStr}`);

        let astContext: AstContext | null = null;
        if (params.funcName) {
            log(`[AST] 正在解析函式 \`${params.funcName}\` 的結構與依賴...`);
            astContext = await extractAstContext(params.filePath, params.funcName, baseDir);
            if (astContext && !astContext.error) {log(`[AST] 解析完成！已擷取函式特徵與依賴。`);}
            else {log(`[AST] 解析遇到問題或找不到指定函式，將退回全域分析模式。`);}
        }

        const systemPrompt = getSystemPrompt(currentLoop, survivedMutants);
        const userPrompt = getUserPrompt(params.filePath, params.funcName, targetCode, astContext);

        try {
            let apiUrl = "";
            let bodyData = {};
            let headers: Record<string, string> = { 'Content-Type': 'application/json' };

            if (params.envType === 'local') {
                apiUrl = 'http://127.0.0.1:11434/api/generate';
                bodyData = { model: params.modelName, system: systemPrompt, prompt: userPrompt, stream: false };
                log(`[LLM] 正在呼叫本地模型推論中... (模型: ${params.modelName})`);
            } else if (params.envType === 'custom') {
                apiUrl = params.customUrl || 'https://api.openai.com/v1/chat/completions';
                bodyData = { 
                    model: params.modelName, 
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ]
                };
                if (params.customKey) {
                    headers['Authorization'] = `Bearer ${params.customKey}`;
                }
                log(`[LLM] 正在透過自訂 API 請求雲端模型... (模型: ${params.modelName})`);
            } else {
                const config = vscode.workspace.getConfiguration('llmUnitTest');
                const keys = config.get<Record<string, string>>('apiKeys', {});
                const actualKey = keys[params.modelName];
                apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.modelName)}:generateContent?key=${actualKey}`;
                bodyData = { contents: [{ parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }] };
                log(`[LLM] 正在透過 API 請求雲端模型... (模型: ${params.modelName})`);
            }
            
            currentAbortController = new AbortController();
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(bodyData),
                signal: currentAbortController.signal
            });
            currentAbortController = null;

            if (isAborted) {throw new Error("使用者強制中止");}

            log(`[LLM] 網路請求已返回，正在檢查回應狀態...`);
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`API 伺服器錯誤 (HTTP ${response.status}): ${errText}`);
            }

            const resJson = await response.json() as Record<string, unknown>;
            log(`[LLM] 呼叫成功！正在萃取回傳的程式碼片段...`);
            let rawCode = "";

            if (params.envType === 'local') {
                rawCode = (resJson as { response?: string }).response || "";
            } else if (params.envType === 'custom') {
                const choices = (resJson as any).choices;
                if (choices && choices[0]?.message?.content) {
                    rawCode = choices[0].message.content;
                } else if ((resJson as any).error) {
                    throw new Error((resJson as any).error.message || "自訂 API 呼叫失敗");
                } else {
                    throw new Error("無法解析的 API 回傳格式: " + JSON.stringify(resJson));
                }
            } else {
                const candidates = (resJson as any).candidates;
                if (candidates && candidates[0]?.content?.parts?.[0]?.text) {
                    rawCode = candidates[0].content.parts[0].text;
                } else if ((resJson as any).error) {
                    throw new Error((resJson as any).error.message || "Gemini 呼叫失敗");
                } else {
                    throw new Error("無法解析的 API 回傳格式: " + JSON.stringify(resJson));
                }
            }

            const sanitizedCode = sanitizeLlmResponse(rawCode);
            if (!sanitizedCode) {throw new Error("模型產生的程式碼內容為空");}

            log(`[系統] 準備將生成的測試程式碼存檔...`);
            fs.writeFileSync(testPath, sanitizedCode, 'utf8');
            log(`[系統] 測試腳本已存檔至: ${testPath}`);

            log(`[MutPy] 正在建構突變測試指令...`);
            log(`[MutPy] 正式啟動分析 (系統超時限制: ${params.timeoutSeconds}秒) ... 這可能會花費數十秒，請稍候！`);

            if (isAborted) {throw new Error("使用者強制中止");}

            const mutpyResult = await new Promise<string>((resolve, reject) => {
                const timeoutArg = params.mutpyTimeout ? `--timeout ${params.mutpyTimeout}` : '';
                const cmd = `chcp 65001 && python -m mutpy --target "${params.filePath}" --unit-test "${testPath}" --report-html "${reportDir}" ${timeoutArg}`;
                currentMutpyProcess = exec(cmd, { timeout: params.timeoutSeconds * 1000, killSignal: 'SIGTERM' }, (error, stdout, stderr) => {
                    currentMutpyProcess = null;
                    if (isAborted) {return reject(new Error("使用者強制中止"));}
                    if (error && error.killed) {return reject(new Error(`系統執行超時 (超過 ${params.timeoutSeconds} 秒)`));}
                    
                    if (error) {
                        resolve(`[MutPy 系統錯誤訊息]\n${error.message}\n[Stderr]\n${stderr}\n[Stdout]\n${stdout}`);
                    } else {
                        resolve(stdout || stderr || "無輸出內容");
                    }
                });
            });

            log(`[MutPy] 突變分析執行完畢！正在解析報告與分數...`);
            log(`--- 突變測試原生輸出 ---\n${mutpyResult}\n------------------------`);
            finalReportMarkdown += `### 執行日誌摘要\n\n\`\`\`text\n${mutpyResult.substring(0, 500)}${mutpyResult.length > 500 ? '...' : ''}\n\`\`\`\n\n`;
            
            const scoreMatch = mutpyResult.match(/Mutation score \[([\d.]+) %\]/);
            let reasonStr = "";
            if (scoreMatch) {
                mutationScore = parseFloat(scoreMatch[1]);
                log(`[分析] 本輪突變分數：${mutationScore}%`);
                finalReportMarkdown += `- **突變分數**: ${mutationScore}%\n`;
            } else {
                log(`[錯誤] 無法解析突變分數！可能 MutPy 執行失敗或環境中未安裝 mutpy。`);
                reasonStr = "MutPy 解析失敗";
                finalReportMarkdown += `- **突變分數**: 解析失敗\n`;
                if (!fs.existsSync(path.join(reportDir, 'index.html'))) {
                    vscode.window.showErrorMessage(`⚠️ MutPy 測試報告產生失敗，請確認您的終端機能夠正常執行 python -m mutpy，並查看日誌中的 stderr 錯誤。`);
                }
            }

            survivedMutants = parseSurvivedMutants(mutpyResult);
            if (survivedMutants) {
                log(`[弱點分析] 本輪存活變異體資訊已擷取，將於下一輪優化進行 Assert 強化：\n${survivedMutants}`);
                reasonStr = survivedMutants.split('\n')[0] + (survivedMutants.split('\n').length > 1 ? "..." : "");
                finalReportMarkdown += `#### 存活的變異體\n\`\`\`text\n${survivedMutants}\n\`\`\`\n`;
            } else {
                log(`[分析] 本輪無存活變異體，或分析結果已達最優。`);
                if (mutationScore >= 100) {reasonStr = "通過";}
                finalReportMarkdown += `- **存活變異體**: 無\n`;
            }

            sidebarProvider.webview?.postMessage({
                command: 'updateCoverage',
                fileName: path.basename(params.filePath),
                score: mutationScore ? `${mutationScore}%` : 'N/A',
                reason: reasonStr
            });

            if (fs.existsSync(path.join(reportDir, 'index.html'))) {
                vscode.env.openExternal(vscode.Uri.file(path.join(reportDir, 'index.html')));
            }

            if (mutationScore >= 100) {
                log(`[優化] 突變分數已達到 100%，自我修復成功！`);
                break;
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (message !== "使用者強制中止") {log(`[錯誤] 執行中斷: ${message}`);}
            finalReportMarkdown += `\n**執行中斷**: ${message}\n`;
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

    const baseDir = params.outputPath || path.dirname(params.filePath);
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '_');
    const safeFuncName = params.funcName || 'file';
    const baseName = path.basename(params.filePath, '.py');
    const finalReportPath = path.join(baseDir, `summary_${baseName}_${safeFuncName}_${dateStr}.md`);
    fs.writeFileSync(finalReportPath, finalReportMarkdown, 'utf8');
    log(`[系統] 測試彙整報告已產出: ${finalReportPath}`);
    
    const doc = await vscode.workspace.openTextDocument(finalReportPath);
    await vscode.window.showTextDocument(doc, { preview: false });
}

async function findPythonFilesInDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
        const list = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const item of list) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
                if (['.git', 'node_modules', 'env', '.env', 'venv', '.venv', '.pytest_cache', '__pycache__'].includes(item.name)) {continue;}
                results.push(...await findPythonFilesInDir(fullPath));
            } else if (item.name.endsWith('.py')) {
                results.push(fullPath);
            }
        }
    } catch { }
    return results;
}

export function deactivate() {}