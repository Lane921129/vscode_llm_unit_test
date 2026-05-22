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
    const blocks: string[] = [];
    
    const pyRegex = /```python([\s\S]*?)```/g;
    let match;
    while ((match = pyRegex.exec(cleanCode)) !== null) {
        blocks.push(match[1].trim());
    }
    
    if (blocks.length === 0) {
        const genericRegex = /```([\s\S]*?)```/g;
        while ((match = genericRegex.exec(cleanCode)) !== null) {
            blocks.push(match[1].trim());
        }
    }
    
    if (blocks.length > 0) {
        // Find the block that contains unittest
        for (const block of blocks) {
            if (block.includes('unittest') || block.includes('TestCase')) {
                return block;
            }
        }
        // Fallback to the last block
        return blocks[blocks.length - 1];
    }
    
    return cleanCode;
}

/**
 * 將 AI 亂輸出的程式碼（REPL格式、裸assert、甚至原始碼）自動包裝成合法的 unittest.TestCase 結構
 */
function rescueToUnittest(rawCode: string, srcFilePath: string, funcName: string): string {
    const moduleName = path.basename(srcFilePath, '.py');
    const targetFunc = funcName || moduleName;

    // 去除 >>> 前綴，逐行整理
    const lines = rawCode
        .split('\n')
        .map(l => l.replace(/^>>>\s?/, '').trim())
        .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('...'));

    const testMethods: string[] = [];
    let methodIndex = 1;

    for (const line of lines) {
        let testBody = '';

        if (line.startsWith('assert ')) {
            const assertBody = line.substring(7).trim();
            const eqMatch = assertBody.match(/^(.+?)\s*==\s*(.+)$/);
            const neqMatch = assertBody.match(/^(.+?)\s*!=\s*(.+)$/);
            if (eqMatch) {
                testBody = `self.assertEqual(${eqMatch[1].trim()}, ${eqMatch[2].trim()})`;
            } else if (neqMatch) {
                testBody = `self.assertNotEqual(${neqMatch[1].trim()}, ${neqMatch[2].trim()})`;
            } else {
                testBody = `self.assertTrue(${assertBody})`;
            }
        } else if (line.startsWith('print(') || line.startsWith('import ') || line.startsWith('from ')) {
            continue;
        } else if (line.includes('==') && !line.startsWith('def ') && !line.startsWith('class ')) {
            const eqMatch = line.match(/^(.+?)\s*==\s*(.+)$/);
            if (eqMatch && eqMatch[1].includes('(')) {
                testBody = `self.assertEqual(${eqMatch[1].trim()}, ${eqMatch[2].trim()})`;
            }
        }

        if (testBody) {
            testMethods.push(`    def test_case_${methodIndex}(self):\n        ${testBody}`);
            methodIndex++;
        }
    }

    // 先對受測原始檔案讀取函式簽名，供決滢乍置用
    let srcArgCount = 0;
    try {
        const srcContent = fs.readFileSync(srcFilePath, 'utf8');
        const srcDefMatch = srcContent.match(/def\s+(?:${targetFunc}|\w+)\s*\(([^)]*)\)/);
        if (srcDefMatch) {
            srcArgCount = srcDefMatch[1].split(',').filter((a: string) => a.trim() && !a.includes('self')).length;
        }
    } catch { /* 讀取失敗就用預設字元 */ }

    // 嘗試從 AI 輸出中解析函式名稱（供 return 語句使用）
    const defMatchGlobal = rawCode.match(/def\s+(\w+)\s*\(/);
    const resolvedFunc = defMatchGlobal ? defMatchGlobal[1] : targetFunc;

    // 【新增】若沒解析出任何測試（例如 AI 只輸出了原始碼），
    // 偵測是否為函式定義，若是則生成基本佔位測試模板
    if (testMethods.length === 0) {
        const defMatch = rawCode.match(/def\s+(\w+)\s*\(([^)]*)\)/);
        const detectedArgs = defMatch ? defMatch[2] : '';
        // 得到 argCount：先嘗試從 AI 輸出解析，如果提取不到就用受測原始檔的簽名
        const argCount = detectedArgs.split(',').filter(a => a.trim() && !a.includes('self')).length || srcArgCount;
        const sampleArgs = argCount > 0
            ? Array.from({length: argCount}, (_, i) => ['1', '2', '3'][i] ?? '0').join(', ')
            : '';
        const zeroArgs = argCount > 0
            ? Array.from({length: argCount}, () => '0').join(', ')
            : '';

        testMethods.push(
            `    def test_basic(self):\n        # 自動生成的基本測試（AI 未提供具體測試案例）\n        result = ${resolvedFunc}(${sampleArgs})\n        self.assertIsNotNone(result)`,
            `    def test_zero(self):\n        result = ${resolvedFunc}(${zeroArgs})\n        self.assertIsNotNone(result)`
        );
    }

    if (testMethods.length === 0) { return ''; }

    return [
        `import unittest`,
        `from ${moduleName} import ${resolvedFunc}`,
        ``,
        `class TestAuto(unittest.TestCase):`,
        testMethods.join('\n\n'),
        ``,
        `if __name__ == '__main__':`,
        `    unittest.main()`,
    ].join('\n');
}


function parseMutatestSurvived(mutatestResult: string): string {
    const lines = mutatestResult.split('\n');
    let isSurvivedSection = false;
    const survivedList: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === 'SURVIVED' && lines[i+1]?.trim() === '--------') {
            isSurvivedSection = true;
            i++; continue;
        }
        if (isSurvivedSection) {
            if (line === '' || line.startsWith('2026-') || line.match(/^\d{4}-\d{2}-\d{2}/)) {break;}
            if (line.startsWith('- ')) {survivedList.push(line);}
        }
    }
    return survivedList.join('\n');
}

function parseMutmutSurvived(mutatestResult: string): string {
    const lines = mutatestResult.split('\n');
    const survivedList: string[] = [];
    let capture = false;
    for (const line of lines) {
        if (line.includes('FAILED:') || line.includes('Survived:') || line.includes('survived')) {capture = true;}
        if (capture && line.trim() !== '') {survivedList.push(line.trim());}
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
    const reportDateStr = new Date().toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let finalReportMarkdown = `# 突變測試與修復分析報告\n\n- **目標檔案**: ${params.filePath}\n- **測試函式**: ${params.funcName || '全檔案'}\n- **日期**: ${reportDateStr}\n\n`;

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
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0].replace(/-/g, '_') + '_' +
            now.toLocaleTimeString('en-GB', {hour12: false}).substring(0,5).replace(':', '_');
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

        let rawCode = ""; // 宣告在外層 try 前面，讓 catch 也能存取
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

            // 【新增】將 AI 完整思考與輸出記錄到報告中（使用摺疊標籤避免太長）
            finalReportMarkdown += `### 🤖 AI 原始輸出與思考過程\n\n`;
            finalReportMarkdown += `<details>\n<summary>點擊展開 AI 完整回應</summary>\n\n\`\`\`text\n${rawCode}\n\`\`\`\n\n</details>\n\n`;

            // 驗證 AI 產出的程式碼格式是否符合要求，若不合規則嘗試自動救援
            let finalCode = sanitizedCode;
            if (!sanitizedCode.includes('unittest.TestCase') || !sanitizedCode.includes('import unittest')) {
                log(`[警告] AI 未按格式輸出 unittest.TestCase，嘗試自動救援轉換...`);
                log(`[警告] AI 原始輸出前 300 字元: ${sanitizedCode.substring(0, 300)}`);
                const rescued = rescueToUnittest(sanitizedCode, params.filePath, params.funcName);
                if (!rescued) {
                    throw new Error("AI 輸出格式無法解析（無任何 assert 或可用語句），請重試。");
                }
                log(`[救援] 自動轉換成功！已將 AI 輸出包裝為 unittest.TestCase 格式。`);
                finalCode = rescued;
            }

            log(`[系統] 準備將生成的測試程式碼存檔...`);
            fs.writeFileSync(testPath, finalCode, 'utf8');
            log(`[系統] 測試腳本已存檔至: ${testPath}`);

            // 【預先驗證】先距行一次 unittest 確認測試檔能跟上
            await new Promise<void>((resolve, reject) => {
                const testDir = path.dirname(testPath);
                const testModule = path.basename(testPath, '.py');
                const targetDir = path.dirname(params.filePath);
                const preCheckCmd = `chcp 65001 && set PYTHONPATH=${targetDir};${testDir};%PYTHONPATH% && cd /d "${testDir}" && python -m unittest ${testModule}`;
                exec(preCheckCmd, { timeout: 30000 }, (err, stdout, stderr) => {
                    const out = (stdout + stderr).trim();
                    if (err) {
                        log(`[預先驗證失敗] 測試檔無法順利執行，詳細資訊: ${out}`);
                        // 將失敗的測試內容記錄到 summary
                        finalReportMarkdown += `### ⚠️ 預先驗證失敗\n\n\`\`\`text\n${out}\n\`\`\`\n\n`;
                        reject(new Error(`測試檔預先驗證失敗（unittest 無法執行），誽誷檔已無法通過: ${out.substring(0, 200)}`));
                    } else {
                        const ran = out.match(/Ran (\d+) test/);
                        if (ran && parseInt(ran[1]) > 0) {
                            log(`[預先驗證通過] 執行了 ${ran[1]} 個測試，即將進行突變測試...`);
                            resolve();
                        } else {
                            const msg = `測試檔都沒有跟 0 個測試（\`Ran 0 tests\`），測試名稱必須以 test_ 開頭`;
                            finalReportMarkdown += `### ⚠️ 預先驗證失敗\n\n${msg}\n\n`;
                            reject(new Error(msg));
                        }
                    }
                });
            });

            let engine = 'mutatest';
            const isWin = process.platform === 'win32';
            
            if (!isWin) {
                try {
                    require('child_process').execSync('mutmut --version', { stdio: 'ignore' });
                    engine = 'mutmut';
                } catch {
                    log(`[系統] 偵測不到 mutmut，降級使用 mutatest。`);
                }
            } else {
                log(`[系統] 偵測到 Windows 環境，自動降級使用 mutatest 以確保相容性。`);
            }

            log(`[${engine}] 正在建構突變測試指令...`);
            log(`[${engine}] 正式啟動分析 (系統超時限制: ${params.timeoutSeconds}秒) ... 這可能會花費數十秒，請稍候！`);

            if (isAborted) {throw new Error("使用者強制中止");}

            const mutpyResult = await new Promise<string>((resolve, reject) => {
                const targetDir = path.dirname(params.filePath);
                const testDir = path.dirname(testPath);
                const testModule = path.basename(testPath, '.py');

                const setPythonPath = isWin 
                    ? `set PYTHONPATH=${targetDir};${testDir};%PYTHONPATH%` 
                    : `export PYTHONPATH="${targetDir}:${testDir}:$PYTHONPATH"`;
                const chcp = isWin ? `chcp 65001 && ` : ``;
                const cdCmd = isWin ? `cd /d "${testDir}"` : `cd "${testDir}"`;

                let cmd = "";
                if (engine === 'mutmut') {
                    const timeoutArg = params.mutpyTimeout ? `--test-time-multiplier ${params.mutpyTimeout}` : '';
                    cmd = `${chcp}${setPythonPath} && ${cdCmd} && mutmut run --paths-to-mutate "${params.filePath}" --runner "python -m unittest ${testModule}" ${timeoutArg}`;
                } else {
                    const timeoutArg = params.mutpyTimeout ? `--timeout_factor ${params.mutpyTimeout}` : '';
                    const mutatestPatch = `import random; orig_sample=random.sample; random.sample=lambda p,k: orig_sample(list(p) if isinstance(p,set) else p,k); import sys; from mutatest.cli import cli_main; sys.argv[0]=__name__; sys.exit(cli_main())`;
                    const mutatestRunCmd = `python -c "${mutatestPatch}"`;
                    cmd = `${chcp}${setPythonPath} && ${cdCmd} && ${mutatestRunCmd} -s "${params.filePath}" -t "python -m unittest ${testModule}" -o "${reportDir}.rst" ${timeoutArg}`;
                }
                
                currentMutpyProcess = exec(cmd, { timeout: params.timeoutSeconds * 1000, killSignal: 'SIGTERM' }, (error, stdout, stderr) => {
                    currentMutpyProcess = null;
                    if (isAborted) {return reject(new Error("使用者強制中止"));}
                    if (error && error.killed) {return reject(new Error(`系統執行超時 (超過 ${params.timeoutSeconds} 秒)`));}
                    
                    if (error) {
                        const cleanMsg = error.message.replace(/^Command failed: .*?\n/s, '');
                        resolve(`[${engine} 系統錯誤訊息]\n${cleanMsg}\n[Stderr]\n${stderr}\n[Stdout]\n${stdout}`);
                    } else {
                        resolve(stdout || stderr || "無輸出內容");
                    }
                });
            });

            log(`[${engine}] 突變分析執行完畢！正在解析報告與分數...`);
            log(`--- 突變測試原生輸出 ---\n${mutpyResult}\n------------------------`);
            
            // 擷取最後 1000 字元，避免錯誤訊息被截斷
            const displayLog = mutpyResult.length > 1000 ? '...' + mutpyResult.substring(mutpyResult.length - 1000) : mutpyResult;
            finalReportMarkdown += `### 執行日誌摘要\n\n\`\`\`text\n${displayLog}\n\`\`\`\n\n`;
            
            let reasonStr = "";
            if (engine === 'mutmut') {
                const totalMatch = mutpyResult.match(/(\d+)\s+mutants/i);
                const survivedMatch = mutpyResult.match(/(\d+)\s+survived/i);
                if (totalMatch || mutpyResult.includes('mutmut')) {
                    const total = totalMatch ? parseInt(totalMatch[1]) : 0;
                    const survived = survivedMatch ? parseInt(survivedMatch[1]) : 0;
                    mutationScore = total === 0 ? 0 : Math.round(((total - survived) / total) * 100);
                    log(`[分析] 本輪突變分數：${mutationScore}% (Total: ${total}, Survived: ${survived})`);
                    finalReportMarkdown += `- **突變分數**: ${mutationScore}%\n`;
                } else {
                    log(`[錯誤] 無法解析突變分數！可能 mutmut 執行失敗。`);
                    reasonStr = "解析失敗";
                    finalReportMarkdown += `- **突變分數**: 解析失敗\n`;
                }
            } else {
                const totalMatch = mutpyResult.match(/TOTAL RUNS: (\d+)/);
                const survivedMatch = mutpyResult.match(/SURVIVED: (\d+)/);
                if (totalMatch) {
                    const total = parseInt(totalMatch[1]);
                    const survived = survivedMatch ? parseInt(survivedMatch[1]) : 0;
                    mutationScore = total === 0 ? 0 : Math.round(((total - survived) / total) * 100);
                    log(`[分析] 本輪突變分數：${mutationScore}% (Total: ${total}, Survived: ${survived})`);
                    finalReportMarkdown += `- **突變分數**: ${mutationScore}%\n`;
                } else {
                    log(`[錯誤] 無法解析突變分數！可能 mutatest 執行失敗。`);
                    reasonStr = "解析失敗";
                    finalReportMarkdown += `- **突變分數**: 解析失敗\n`;
                }
            }

            survivedMutants = engine === 'mutmut' ? parseMutmutSurvived(mutpyResult) : parseMutatestSurvived(mutpyResult);
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
            const stack = error instanceof Error && error.stack ? error.stack : '';
            if (message !== "使用者強制中止") {log(`[錯誤] 執行中斷: ${message}`);}
            finalReportMarkdown += `\n### ❌ 執行中斷（第 ${currentLoop} 輪）\n\n`;
            finalReportMarkdown += `**錯誤訊息**: ${message}\n\n`;
            if (stack && stack !== message) {
                finalReportMarkdown += `**錯誤堆疊**:\n\`\`\`\n${stack}\n\`\`\`\n\n`;
            }
            // 記錄 AI 原始輸出（如果有的話）
            if (rawCode) {
                finalReportMarkdown += `**AI 實際輸出內容（前 500 字元）**:\n\`\`\`\n${rawCode.substring(0, 500)}\n\`\`\`\n\n`;
            }
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
    const now2 = new Date();
    const dateStr = now2.toISOString().split('T')[0].replace(/-/g, '_') + '_' +
        now2.toLocaleTimeString('en-GB', {hour12: false}).substring(0,5).replace(':', '_');
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