import * as vscode from 'vscode';
import { MutationViewProvider } from './SidebarProvider';
import { getSystemPrompt, getUserPrompt } from './promptProvider';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

export function activate(context: vscode.ExtensionContext) {
    const sidebarProvider = new MutationViewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MutationViewProvider.viewType, sidebarProvider)
    );

    let runTestCmd = vscode.commands.registerCommand('llm-unit-test.runCaptureAndTest', async (params: any) => {
    const log = (text: string) => sidebarProvider.webview?.postMessage({ command: 'appendLog', text });
    
    // 1. 在最前面宣告並初始化，避免 TS 報錯
    let targetCode = ""; 
    let currentLoop = 1;
    let mutationScore = 0;

    if (!params.filePath || !fs.existsSync(params.filePath)) {
        log('[錯誤] 找不到目標檔案路徑');
        return;
    }

    try {
        targetCode = fs.readFileSync(params.filePath, 'utf-8');
    } catch (err) {
        log('[錯誤] 讀取檔案失敗');
        return;
    }

    // 2. 進入迴圈
    // extension.ts 內的指令實作
while (currentLoop <= params.maxLoops && mutationScore < 100) {
        log(`\n--- 🔄 第 ${currentLoop} 輪開始 ---`);

        // 1. 定義路徑 (解決你的 reportDir 問題)
        // 如果使用者沒選輸出資料夾，就預設放在目標檔案同目錄
        const baseDir = params.outputPath || path.dirname(params.filePath);
        const testPath = path.join(baseDir, `test_loop_${currentLoop}.py`);
        const reportDir = path.join(baseDir, `report_loop_${currentLoop}`);

        // 2. 呼叫 LLM (這部分維持你原本的 fetch 邏輯)
        const targetCode = fs.readFileSync(params.filePath, 'utf-8');
        const systemPrompt = getSystemPrompt(currentLoop, "目前模擬的存活突變體");
        const userPrompt = getUserPrompt(params.filePath, params.funcName, targetCode);

        try {
            // 2. LLM 呼叫分流
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
                // 這裡以 Gemini 為例，解決 404
                apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${actualKey}`;
                bodyData = { contents: [{ parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }] };
            }

            log(`[LLM] 正在呼叫模型: ${params.modelName}`);
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyData)
            });

            const llmResponse = "LLM 生成的測試程式碼..."; 
            fs.writeFileSync(testPath, llmResponse, 'utf8');
            log(`[系統] 測試腳本已存檔: ${path.basename(testPath)}`);

            // 3. 呼叫 MutPy 並產生 HTML 報告 (解決亂碼與呼叫問題)
            log(`[MutPy] 啟動突變分析，報告輸出至: ${reportDir}`);
            
            const mutpyResult = await new Promise<string>((resolve) => {
                // 💡 使用 chcp 65001 強制 UTF-8 解決亂碼
                // 💡 使用 python -m mutpy 解決找不到指令的問題
                const cmd = `chcp 65001 && python -m mutpy --target ${params.filePath} --unit-test ${testPath} --report-html ${reportDir}`;
                
                exec(cmd, (error, stdout, stderr) => {
                    resolve(stdout || stderr || "無輸出內容");
                });
            });

            log(`[MutPy 執行結果]\n${mutpyResult}`);

            // 4. 解析分數 (從文字輸出抓取)
            const scoreMatch = mutpyResult.match(/Mutation score \[([\d.]+) %\]/);
            if (scoreMatch) {
                mutationScore = parseFloat(scoreMatch[1]);
                log(`[分析] 本輪突變分數：${mutationScore}%`);
            }

            // 5. 💡 自動開啟 HTML 報告
            if (fs.existsSync(path.join(reportDir, 'index.html'))) {
                vscode.env.openExternal(vscode.Uri.file(path.join(reportDir, 'index.html')));
            }

            if (mutationScore >= 100) {break;}

        } catch (error: any) {
            log(`[錯誤] 執行中斷: ${error.message}`);
            break;
        }
        currentLoop++;
    }

});}

export function deactivate() {}