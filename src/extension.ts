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
    // extension.ts 內的指令實作
while (currentLoop <= params.maxLoops && mutationScore < 100) {
    log(`\n--- 🔄 第 ${currentLoop} 輪循環開始 ---`);

    // A. 準備 Prompt
    const systemPrompt = getSystemPrompt(currentLoop, "目前模擬的突變體資料");
    const userPrompt = getUserPrompt(params.filePath, params.funcName, targetCode);

    try {
        // B. LLM 呼叫分流 (解決 404 與格式問題)
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
            // 雲端模式 (假設使用 Gemini)
            const config = vscode.workspace.getConfiguration('llmUnitTest');
            const keys = config.get<Record<string, string>>('apiKeys', {});
            const actualKey = keys[params.modelName];

            apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${actualKey}`;
            bodyData = {
                contents: [{ parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }]
            };
        }

        log(`[LLM] 正在透過 ${params.envType} 呼叫模型: ${params.modelName}`);

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} - ${await response.text()}`);
        }

        const data = await response.json() as any;
        // 根據來源取得回應文字
        const llmResponse = params.envType === 'local' ? data.response : data.candidates[0].content.parts[0].text;
        
        log(`[LLM] 成功獲得第 ${currentLoop} 版測試代碼`);

        // C. 真實存檔 (將 LLM 生成的代碼寫入檔案)
        // 建議存在使用者設定的 outputPath，若無則存原檔案目錄
        const outputDir = params.outputPath || params.filePath.substring(0, params.filePath.lastIndexOf(/[/\\]/));
        const testFileName = `test_loop_${currentLoop}.py`;
        const testPath = `${outputDir}/${testFileName}`;

        fs.writeFileSync(testPath, llmResponse, 'utf8');
        log(`[系統] 測試腳本已存檔: ${testFileName}`);

        // D. 呼叫真實 MutPy (關鍵步驟！)
        log('[MutPy] 啟動突變測試分析...');
        
        // 這裡使用 Promise 包裝 exec，確保迴圈會等待執行結果
        const mutpyOutput = await new Promise<string>((resolve) => {
            const cmd = `mutpy --target ${params.filePath} --unit-test ${testPath}`;
            exec(cmd, (error, stdout, stderr) => {
                resolve(stdout || stderr || "無輸出結果");
            });
        });

        log(`[MutPy 結果]\n${mutpyOutput}`);

        // E. 解析分數 (簡單 Regex 範例)
        const scoreMatch = mutpyOutput.match(/Mutation score \[([\d.]+) %\]/);
        if (scoreMatch) {
            mutationScore = parseFloat(scoreMatch[1]);
            log(`[分析] 本輪突變分數: ${mutationScore}%`);
            
            // 將結果傳回側邊欄表格
            sidebarProvider.webview?.postMessage({ 
                command: 'updateCoverage', 
                fileName: params.filePath.split(/[/\\]/).pop(),
                score: mutationScore 
            });
        }

        if (mutationScore >= 100) {
            log('[完成] 突變覆蓋率已達 100%！');
            break;
        }

    } catch (error: any) {
        log(`[錯誤] 執行中斷: ${error.message}`);
        break;
    }
    currentLoop++;
}
});}

export function deactivate() {}