import * as vscode from 'vscode';
import { MutationViewProvider } from './SidebarProvider';
import { getSystemPrompt, getUserPrompt } from './promptProvider';
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
    while (currentLoop <= params.maxLoops && mutationScore < 100) {
        log(`\n--- 🔄 第 ${currentLoop} 輪開始 ---`);

        // 使用外包的 Prompt 處理器
        const systemPrompt = getSystemPrompt(currentLoop, "目前模擬的突變體資料");
        const userPrompt = getUserPrompt(params.filePath, params.funcName, targetCode);

        try {
            // 💡 判斷 URL 與 Model 名稱 (防止 404)
            const apiUrl = params.envType === 'local' ? 'http://127.0.0.1:11434/api/generate' : '雲端URL';
            
            log(`[LLM] 正在呼叫模型: ${params.modelName}`);

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: params.modelName, 
                    system: systemPrompt,
                    prompt: userPrompt,
                    stream: false 
                })
            });

            if (!response.ok) {
                const errorDetail = await response.text();
                throw new Error(`HTTP ${response.status} - ${errorDetail}`);
            }

            const data = await response.json() as any;
            log(`[LLM] 成功獲得第 ${currentLoop} 版測試代碼`);
            
            // TODO: 真實 MutPy 邏輯...
            mutationScore = 100; // 暫時跳出
        } catch (error: any) {
            log(`[錯誤] 執行中斷: ${error.message}`);
            break;
        }
        currentLoop++;
    }
});}

export function deactivate() {}