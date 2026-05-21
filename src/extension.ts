import * as vscode from 'vscode';
import { MutationViewProvider } from './SidebarProvider';
import { getSystemPrompt, getUserPrompt } from './promptProvider';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

/** 前端傳入的分析參數介面 */
interface AnalysisParams {
    envType: 'local' | 'cloud';
    modelName: string;
    filePath: string;
    funcName: string;
    maxLoops: number;
    timeoutSeconds: number;
    outputPath: string;
}

/** Python AST 擷取結果介面 */
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
                log(`\n--- 🔄 第 ${currentLoop} 輪開始 ---`);

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
                const testPath = path.join(baseDir, `test_loop_${currentLoop}.py`);
                const reportDir = path.join(baseDir, `report_loop_${currentLoop}`);

                // 呼叫 Python AST 擷取函式特徵與依賴
                let astContext: AstContext | null = null;
                if (params.funcName) {
                    log(`[AST] 正在解析函式 \`${params.funcName}\` 的結構與依賴...`);
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
                        apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.modelName)}:generateContent?key=${actualKey}`;
                        bodyData = { contents: [{ parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }] };
                    }

                    log(`[LLM] 正在呼叫模型: ${params.modelName}`);
                    const response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(bodyData)
                    });

                    if (!response.ok) {
                        const errText = await response.text();
                        throw new Error(`API 伺服器錯誤 (HTTP ${response.status}): ${errText}`);
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
                    log(`[系統] 測試腳本已存檔: ${path.basename(testPath)}`);

                    // 呼叫 MutPy 並產生 HTML 報告（路徑加引號防止空白斷裂）
                    log(`[MutPy] 啟動突變分析 (超時限制: ${params.timeoutSeconds}秒)，報告輸出至: ${reportDir}`);

                    const mutpyResult = await new Promise<string>((resolve, reject) => {
                        const cmd = `chcp 65001 && python -m mutpy --target "${params.filePath}" --unit-test "${testPath}" --report-html "${reportDir}"`;

                        const child = exec(cmd, { timeout: params.timeoutSeconds * 1000, killSignal: 'SIGTERM' }, (error, stdout, stderr) => {
                            if (error && error.killed) {
                                reject(new Error(`突變測試超時 (超過 ${params.timeoutSeconds} 秒)`));
                            } else {
                                resolve(stdout || stderr || "無輸出內容");
                            }
                        });
                    });

                    log(`[MutPy 執行結果]\n${mutpyResult}`);

                    // 解析分數與存活突變體
                    const scoreMatch = mutpyResult.match(/Mutation score \[([\d.]+) %\]/);
                    if (scoreMatch) {
                        mutationScore = parseFloat(scoreMatch[1]);
                        log(`[分析] 本輪突變分數：${mutationScore}%`);

                        // 主動將突變分數同步回 Webview 的表格顯示
                        sidebarProvider.webview?.postMessage({
                            command: 'updateCoverage',
                            fileName: path.basename(params.filePath),
                            score: `${mutationScore}%`
                        });
                    }

                    // 更新存活變異體資訊供下一輪使用
                    survivedMutants = parseSurvivedMutants(mutpyResult);
                    if (survivedMutants) {
                        log(`[弱點分析] 本輪存活變異體資訊已擷取，將於下一輪優化進行 Assert 強化：\n${survivedMutants}`);
                    } else {
                        log(`[分析] 本輪無存活變異體，或分析結果已達最優。`);
                    }

                    // 自動開啟 HTML 報告
                    if (fs.existsSync(path.join(reportDir, 'index.html'))) {
                        vscode.env.openExternal(vscode.Uri.file(path.join(reportDir, 'index.html')));
                    }

                    if (mutationScore >= 100) {
                        log(`[優化] 突變分數已達到 100%，自我修復成功！`);
                        break;
                    }

                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    log(`[錯誤] 執行中斷: ${message}`);
                    break;
                }
                currentLoop++;
            }
        }
    );

    // 將指令加入 subscriptions 以便擴充停用時正確清除
    context.subscriptions.push(runTestCmd);
}

/**
 * 呼叫 Python AST 模組擷取指定函式的參數、docstring、相依呼叫等特徵
 */
async function extractAstContext(
    filePath: string,
    funcName: string,
    baseDir: string
): Promise<AstContext | null> {
    // 透過 JSON.stringify 跳脫路徑和函式名，防止 code injection
    const safeFilePath = JSON.stringify(filePath);
    const safeFuncName = JSON.stringify(funcName);

    const pythonCode = `
import ast, json, sys
try:
    with open(${safeFilePath}, "r", encoding="utf-8") as f:
        tree = ast.parse(f.read())
    found = False
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == ${safeFuncName}:
            args = [arg.arg for arg in node.args.args]
            calls = []
            for subnode in ast.walk(node):
                if isinstance(subnode, ast.Call):
                    if isinstance(subnode.func, ast.Name):
                        calls.append(subnode.func.id)
                    elif isinstance(subnode.func, ast.Attribute):
                        calls.append(subnode.func.attr)

            with open(${safeFilePath}, "r", encoding="utf-8") as f2:
                lines = f2.readlines()
            func_code = "".join(lines[node.lineno-1:node.end_lineno])

            print(json.dumps({
                "name": node.name,
                "args": args,
                "docstring": ast.get_docstring(node) or "",
                "calls": list(set(calls)),
                "code": func_code
            }))
            found = True
            break
    if not found:
        print(json.dumps({"error": "Function not found in AST"}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

    return new Promise<AstContext | null>((resolve) => {
        const tempScriptPath = path.join(baseDir, `__ast_temp_${Date.now()}.py`);
        fs.writeFileSync(tempScriptPath, pythonCode, 'utf-8');

        exec(`python "${tempScriptPath}"`, (_error, stdout) => {
            try {
                if (fs.existsSync(tempScriptPath)) {
                    fs.unlinkSync(tempScriptPath);
                }
            } catch { /* ignore cleanup errors */ }
            try {
                resolve(JSON.parse(stdout.trim()) as AstContext);
            } catch {
                resolve({ name: '', args: [], docstring: '', calls: [], code: '', error: "Failed to parse AST script output" });
            }
        });
    });
}

/** 將 LLM 回傳的程式碼去除 markdown code fence */
function sanitizeLlmResponse(response: string): string {
    const pyCodeFenceRegex = /```(?:python)?\s*([\s\S]*?)```/i;
    const match = response.match(pyCodeFenceRegex);
    if (match) {
        return match[1].trim();
    }
    return response.trim();
}

/** 從 MutPy 輸出解析存活的突變體資訊 */
function parseSurvivedMutants(mutpyResult: string): string {
    const mutantMap = new Map<string, string>();
    const survivedIds: string[] = [];

    const lines = mutpyResult.split('\n');
    for (const line of lines) {
        const defMatch = line.match(/^\s*-\s*\[#\s*(\d+)\]\s*(.*)$/);
        if (defMatch) {
            mutantMap.set(defMatch[1], defMatch[2].trim());
            continue;
        }

        const outcomeMatch = line.match(/mutant\s*#\s*(\d+).*survived/i);
        if (outcomeMatch) {
            survivedIds.push(outcomeMatch[1]);
        }
    }

    if (survivedIds.length === 0) {
        const backupLines = lines.filter(
            l => l.toLowerCase().includes('survived') &&
                !l.includes('mutation score') &&
                !l.includes('Start testing')
        );
        if (backupLines.length > 0) {
            return backupLines.map(l => l.trim()).join('\n');
        }
        return "";
    }

    return survivedIds.map(id => {
        const desc = mutantMap.get(id) || "未知變異操作";
        return `- 變異體 #${id} 存活: ${desc}`;
    }).join('\n');
}

export function deactivate() {}