import * as vscode from 'vscode';
import { MutationViewProvider } from './SidebarProvider';
import { getSystemPrompt, getUserPrompt } from './promptProvider';
import { extractFunctionsFromFile, findPythonFilesInDir, detectMutationEngine } from './utils';
import * as path from 'path';
import * as fs from 'fs';
import { exec, execSync, ChildProcess } from 'child_process';

let currentAbortController: AbortController | null = null;
let currentMutpyProcess: ChildProcess | null = null;
let isAborted = false;

interface ModelProfile {
    paramSize: string;      // e.g. "2.0B", "13.0B", "Cloud (Gemini)"
    contextLength: number;  // max context tokens from model
    budgetTokens: number;   // calculated usable budget
}

let currentModelProfile: ModelProfile = {
    paramSize: 'unknown',
    contextLength: 4096,
    budgetTokens: 2000  // safe default
};

function estimateTokens(text: string): number {
    // 快速估算：平均 4 字元 ≈ 1 token（英文）；中文約 1.5 字元 ≈ 1 token
    return Math.ceil(text.length / 3.5);
}

function getContextBudget(profile: ModelProfile): number {
    const ctx = profile.contextLength;
    // 保留 30% 給模型回應輸出，70% 用於 prompt input
    const usable = Math.floor(ctx * 0.7);
    // 根據參數量再限制：小模型即使 ctx 大也不要塞太多
    const paramBillion = parseFloat(profile.paramSize);
    if (!isNaN(paramBillion)) {
        if (paramBillion <= 2)  return Math.min(usable, 1800);
        if (paramBillion <= 7)  return Math.min(usable, 3500);
        if (paramBillion <= 13) return Math.min(usable, 6000);
        return Math.min(usable, 12000);
    }
    // Cloud / unknown -> 充裕 budget
    return Math.min(usable, 20000);
}

interface AnalysisParams {
    envType: 'local' | 'cloud' | 'custom';
    modelName: string;
    filePath: string;
    funcName: string;
    promptStrategy?: string;
    ollamaUrl?: string;
    maxLoops: number;
    mutpyTimeout?: number;
    timeoutSeconds: number;
    outputPath: string;
    customUrl?: string;
    customKey?: string;
    projectName?: string;
    sessionDate?: string;
}

interface CallerContext {
    caller_file: string;
    caller_func: string;
    line: number;
    args: string[];
    kwargs: Record<string, string>;
}

interface AstContext {
    name: string;
    args: string[];
    docstring: string;
    calls: string[];
    dependencies?: { name: string, module: string }[];
    dependencyContexts?: AstContext[];
    callerContexts?: CallerContext[];
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
            
            const now = new Date();
            const dateStr = now.toISOString().split('T')[0].replace(/-/g, '_') + '_' + now.toLocaleTimeString('en-GB', {hour12: false}).substring(0,5).replace(':', '_');
            params.sessionDate = dateStr;

            if (!params.funcName) {
                // 全檔案模式：萃取所有函式並依序測試
                const funcs = extractFunctionsFromFile(params.filePath);
                if (funcs.length === 0) {
                    log(`[系統] 在檔案 ${path.basename(params.filePath)} 中找不到任何函式，無法進行全檔案測試。`);
                } else {
                    log(`[系統] 開啟「全檔案掃描模式」！共找到 ${funcs.length} 個函式，準備依序進行 AST 解析與測試...`);
                    for (let i = 0; i < funcs.length; i++) {
                        if (isAborted) break;
                        const fName = funcs[i];
                        log(`\n======================================================`);
                        log(`[系統] 正在處理函式 (${i+1}/${funcs.length}): ${fName}`);
                        log(`======================================================`);
                        const singleParams: AnalysisParams = { ...params, funcName: fName };
                        await executeSingleFileAnalysis(singleParams, log, sidebarProvider);
                    }
                    log(`\n[系統] 🎉 全檔案掃描與測試執行完畢！`);
                }
            } else {
                await executeSingleFileAnalysis(params, log, sidebarProvider);
            }
            
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
                const now = new Date();
                const dateStr = now.toISOString().split('T')[0].replace(/-/g, '_') + '_' + now.toLocaleTimeString('en-GB', {hour12: false}).substring(0,5).replace(':', '_');
                
                const pyFiles = await findPythonFilesInDir(params.batchPath);
                if (pyFiles.length === 0) {
                    log(`[系統] 在目錄 ${params.batchPath} 中找不到任何 Python 檔案。`);
                    return;
                }

                log(`[系統] 開始批次測試，共找到 ${pyFiles.length} 個 Python 檔案。`);
                const projectName = path.basename(params.batchPath);
                for (let i = 0; i < pyFiles.length; i++) {
                    if (isAborted) {
                        log(`[系統] ⚠️ 批次測試已由使用者強制中止。`);
                        break;
                    }
                    const file = pyFiles[i];
                    log(`\n======================================================`);
                    log(`[系統] 正在處理批次檔案 (${i+1}/${pyFiles.length}): ${file}`);
                    log(`======================================================`);
                    
                    const funcs = extractFunctionsFromFile(file);
                    if (funcs.length === 0) {
                        log(`[系統] 檔案 ${path.basename(file)} 中無可測試的函式，跳過。`);
                        continue;
                    }
                    
                    log(`[系統] 該檔案包含 ${funcs.length} 個函式，準備逐一測試...`);
                    for (let j = 0; j < funcs.length; j++) {
                        if (isAborted) break;
                        const fName = funcs[j];
                        log(`\n--- 批次任務進度: 檔案 ${i+1}/${pyFiles.length}, 函式 ${j+1}/${funcs.length} ---`);
                        log(`[系統] 目標函式: ${fName}`);
                        const singleParams: AnalysisParams = { ...params, filePath: file, funcName: fName, projectName: projectName, sessionDate: dateStr };
                        await executeSingleFileAnalysis(singleParams, log, sidebarProvider);
                    }
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

    const updateModelProfileCmd = vscode.commands.registerCommand('llm-unit-test.updateModelProfile', (profile: { paramSize: string; contextLength: number }) => {
        currentModelProfile = {
            paramSize: profile.paramSize,
            contextLength: profile.contextLength,
            budgetTokens: getContextBudget({ paramSize: profile.paramSize, contextLength: profile.contextLength, budgetTokens: 0 })
        };
    });

    context.subscriptions.push(runTestCmd, runBatchCmd, abortTestCmd, updateModelProfileCmd);
}


async function extractAstContext(
    targetPath: string,
    funcName: string
): Promise<AstContext | null> {
    return new Promise((resolve) => {
        const pythonScript = path.join(__dirname, '..', 'python_scripts', 'ast_extractor.py');

        const cmd = `python "${pythonScript}" "${targetPath}" "${funcName}"`;

        exec(cmd, { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (error, stdout, stderr) => {
            if (error) {
                resolve({ error: stdout || stderr, name: "", args: [], docstring: "", calls: [], code: "" });
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch {
                resolve(null);
            }
        });
    });
}

async function findCallerContexts(
    funcName: string,
    projectRoot: string
): Promise<CallerContext[]> {
    return new Promise((resolve) => {
        const pythonScript = path.join(__dirname, '..', 'python_scripts', 'ast_caller_finder.py');
        const cmd = `python "${pythonScript}" "${funcName}" "${projectRoot}"`;
        exec(cmd, { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (error, stdout) => {
            if (error) { resolve([]); return; }
            try {
                const parsed = JSON.parse(stdout);
                if (Array.isArray(parsed)) {
                    resolve(parsed as CallerContext[]);
                } else {
                    resolve([]);
                }
            } catch {
                resolve([]);
            }
        });
    });
}

interface TraceExample {
    args: string[];
    result?: string;
    result_type?: string;
    exception?: string;
    message?: string;
}

interface DynamicTraceResult {
    func_name: string;
    args: string[];
    examples: TraceExample[];
    errors: TraceExample[];
    load_error: string | null;
}

/**
 * 執行動態追蹤：呼叫 dynamic_tracer.py 取得真實的 input→output 範例
 * callerArgs: 從呼叫站語境中提取的已知真實參數（可選）
 */
async function runDynamicTrace(
    filePath: string,
    funcName: string,
    callerArgs?: CallerContext[]
): Promise<DynamicTraceResult | null> {
    return new Promise((resolve) => {
        const pythonScript = path.join(__dirname, '..', 'python_scripts', 'dynamic_tracer.py');
        
        // 如果有呼叫站語境，把已知的真實參數傳入
        let inputsArg = '';
        if (callerArgs && callerArgs.length > 0) {
            const knownInputs = callerArgs.map(ctx => ctx.args);  // 只取 positional args
            inputsArg = ` "${JSON.stringify(knownInputs).replace(/"/g, '\\"')}"`;
        }

        const cmd = `python "${pythonScript}" "${filePath}" "${funcName}"${inputsArg}`;
        exec(cmd, { encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (error, stdout) => {
            if (error) { resolve(null); return; }
            try {
                const parsed = JSON.parse(stdout.trim());
                resolve(parsed as DynamicTraceResult);
            } catch {
                resolve(null);
            }
        });
    });
}

function sanitizeLlmResponse(rawCode: string): string {
    let cleanCode = rawCode.trim();

    // 偵測無限 thinking 迴圈（小模型常見問題）
    // 如果 <thinking> 出現 3 次以上，或同一 emoji 連續重複 8 次以上 → 視為垃圾輸出
    const thinkingCount = (cleanCode.match(/<thinking>/g) || []).length;
    if (thinkingCount >= 3) { return ''; }
    const emojiLoopMatch = cleanCode.match(/([\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF])\1{7,}/u);
    if (emojiLoopMatch) { return ''; }

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
        for (const block of blocks) {
            if (block.includes('unittest') || block.includes('TestCase')) {
                return block;
            }
        }
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
    let currentContext: string[] = [];

    for (const line of lines) {
        let testBody = '';

        if (line.startsWith('assert ')) {
            const assertBody = line.substring(7).trim();
            // Handle assert with messages: assert x == y, "message"
            const parts = assertBody.split(',');
            const expr = parts[0].trim();
            const msg = parts.length > 1 ? `, ${parts.slice(1).join(',').trim()}` : '';

            const eqMatch = expr.match(/^(.+?)\s*==\s*(.+)$/);
            const neqMatch = expr.match(/^(.+?)\s*!=\s*(.+)$/);
            
            if (eqMatch) {
                testBody = `self.assertEqual(${eqMatch[1].trim()}, ${eqMatch[2].trim()}${msg})`;
            } else if (neqMatch) {
                testBody = `self.assertNotEqual(${neqMatch[1].trim()}, ${neqMatch[2].trim()}${msg})`;
            } else {
                testBody = `self.assertTrue(${expr}${msg})`;
            }
        } else if (line.startsWith('print(') || line.startsWith('import ') || line.startsWith('from ')) {
            continue;
        } else if (line.startsWith('def ') || line.startsWith('class ') || line.startsWith('@')) {
            continue;
        } else if (line.includes('==') && !line.includes('(')) {
            // Ignore bare == without function calls to prevent bad parsing
            const eqMatch = line.match(/^(.+?)\s*==\s*(.+)$/);
            if (eqMatch && eqMatch[1].includes('(')) {
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
            const bodyLines = [...currentContext, testBody].map(l => `        ${l}`).join('\n');
            testMethods.push(`    def test_case_${methodIndex}(self):\n${bodyLines}`);
            methodIndex++;
            currentContext = []; // Reset for next assert
        }
    }



    if (testMethods.length === 0) { return ''; }

    return [
        `import unittest`,
        `from ${moduleName} import *`,
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
        let line = lines[i].trim();
        // 移除 ANSI 色碼（如 [91m, [0m）
        line = line.replace(/\x1B\[\d+m/g, '');
        // 移除有些情況下沒有 \x1B 但只有 [0m 的殘留字元（這是在日誌中常見的亂碼）
        line = line.replace(/\[\d+m/g, '');

        if (line === 'SURVIVED' && lines[i+1]?.replace(/\[\d+m/g, '').trim() === '--------') {
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

    let evalStrategy = params.promptStrategy || 'auto';
    if (evalStrategy === 'auto') {
        const nameLower = params.modelName.toLowerCase();
        if (nameLower.includes('gpt-4') || nameLower.includes('claude-3') || nameLower.includes('gemini-1.5') || nameLower.includes('pro') || nameLower.includes('opus')) {
            evalStrategy = 'large';
        } else {
            evalStrategy = 'small';
        }
    }
    log(`[系統] 模型策略判定為: ${evalStrategy === 'large' ? 'Large Model (Advanced)' : 'Small Model (Strict)'}`);

    if (!params.filePath || !fs.existsSync(params.filePath)) {
        log('[錯誤] 找不到目標檔案路徑');
        return;
    }

    let survivedMutants = "";
    const reportDateStr = new Date().toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let finalReportMarkdown = `# 突變測試與修復分析報告\n\n- **目標檔案**: ${params.filePath}\n- **測試函式**: ${params.funcName || '全檔案'}\n- **日期**: ${reportDateStr}\n\n`;

    const baseDir = params.outputPath || path.dirname(params.filePath);
    
    // 建立本次測試的專屬資料夾
    const now = new Date();
    const dateStr = params.sessionDate || (now.toISOString().split('T')[0].replace(/-/g, '_') + '_' + now.toLocaleTimeString('en-GB', {hour12: false}).substring(0,5).replace(':', '_'));
    const safeFuncName = params.funcName || 'file';
    const baseName = path.basename(params.filePath, '.py');
    
    let sessionDir = "";
    if (params.projectName) {
        // 批次測試： baseDir / ProjectName_Date / FileName / FunctionName
        sessionDir = path.join(baseDir, `${params.projectName}_${dateStr}`, baseName, safeFuncName);
    } else {
        // 單檔測試： baseDir / FileName_Date / FunctionName
        sessionDir = path.join(baseDir, `${baseName}_${dateStr}`, safeFuncName);
    }
    
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    let astContext: AstContext | null = null;
    if (params.funcName) {
        log(`[AST] 正在解析函式 \`${params.funcName}\` 的結構與依賴...`);
        astContext = await extractAstContext(params.filePath, params.funcName);
        if (astContext && !astContext.error) {
            log(`[AST] 解析完成！已擷取函式特徵與依賴。`);
            
            // 深度跨檔案 AST 解析 (Deep Dependency Resolution)
            if (astContext.dependencies && astContext.dependencies.length > 0) {
                log(`[AST] 發現跨檔案依賴！正在深度擷取相依模組原始碼...`);
                astContext.dependencyContexts = [];
                // 取得專案根目錄（batchPath 本身就是資料夾；否則用 workspace 根目錄）
                const projectRoot = (params as any).batchPath
                    ? (params as any).batchPath
                    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(params.filePath);

                for (const dep of astContext.dependencies) {
                    const moduleParts = dep.module.split('.');
                    const depFilePath = path.join(projectRoot, ...moduleParts) + '.py';
                    
                    if (fs.existsSync(depFilePath)) {
                        const depAst = await extractAstContext(depFilePath, dep.name);
                        if (depAst && !depAst.error) {
                            // 🔍 呼叫站掃描：找出這個依賴函式在全專案的所有呼叫點
                            log(`[AST] 掃描 ${dep.name} 的呼叫站語境...`);
                            const callers = await findCallerContexts(dep.name, projectRoot);
                            if (callers.length > 0) {
                                depAst.callerContexts = callers;
                                log(`[AST] 找到 ${callers.length} 個呼叫點：${callers.map(c => `${c.caller_file}:${c.caller_func}`).join(', ')}`);
                            }
                            astContext.dependencyContexts.push(depAst);
                            log(`[AST] 成功擷取外部依賴: ${dep.module}.${dep.name}`);
                        }
                    }
                }
            }

            // 同時也掃描目標函式本身的呼叫站（在大專案中作為被呼叫者時使用）
            {
                const projectRoot = (params as any).batchPath
                    ? (params as any).batchPath
                    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(params.filePath);
                const selfCallers = await findCallerContexts(params.funcName, projectRoot);
                if (selfCallers.length > 0) {
                    astContext.callerContexts = selfCallers;
                    log(`[AST] 目標函式被呼叫 ${selfCallers.length} 次，已收集所有呼叫語境。`);
                }
            }

            // 動態執行追蹤：取得真實的 input→output 範例，讓 LLM 的 assert 值不再是猜的
            log(`[Trace] 正在動態執行函式以取得真實輸入輸出範例...`);
            const traceResult = await runDynamicTrace(params.filePath, params.funcName, astContext.callerContexts);
            if (traceResult && !traceResult.load_error) {
                (astContext as any).traceResult = traceResult;
                const exCount = traceResult.examples.length;
                const errCount = traceResult.errors.length;
                log(`[Trace] 完成！取得 ${exCount} 個成功範例、${errCount} 個預期例外範例。`);
            } else if (traceResult?.load_error) {
                log(`[Trace] 動態追蹤失敗: ${traceResult.load_error}（將繼續使用靜態分析）`);
            }


            // 寫入 AST 分析結果到報告（包含呼叫站語境）
            let astReport = `### AST 靜態解析結果\n`;
            astReport += `- 函式名稱: \`${astContext.name}\`\n`;
            astReport += `- 參數列表: \`${astContext.args.join(', ') || '無'}\`\n`;
            astReport += `- 相依呼叫: \`${astContext.calls.join(', ') || '無'}\`\n`;
            if (astContext.docstring) {
                astReport += `- 文件註解: \`${astContext.docstring.trim().replace(/\n/g, ' ')}\`\n`;
            }
            if (astContext.dependencies && astContext.dependencies.length > 0) {
                astReport += `- 跨檔案依賴: ${astContext.dependencies.map((d: any) => `\`${d.module}.${d.name}\``).join(', ')}\n`;
            }
            if (astContext.callerContexts && astContext.callerContexts.length > 0) {
                astReport += `- 呼叫站語境 (${astContext.callerContexts.length} 個):\n`;
                for (const ctx of astContext.callerContexts) {
                    const argsStr = ctx.args.join(', ');
                    const kwargsStr = Object.entries(ctx.kwargs as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(', ');
                    const callSig = [argsStr, kwargsStr].filter(Boolean).join(', ');
                    astReport += `  - \`${ctx.caller_file}\` / \`${ctx.caller_func}()\`: \`${astContext.name}(${callSig})\`\n`;
                }
            }
            if (astContext.dependencyContexts && astContext.dependencyContexts.length > 0) {
                for (const dep of astContext.dependencyContexts) {
                    if (dep.callerContexts && dep.callerContexts.length > 0) {
                        astReport += `- \`${dep.name}\` 的呼叫站語境 (${dep.callerContexts.length} 個):\n`;
                        for (const ctx of dep.callerContexts) {
                            const argsStr = ctx.args.join(', ');
                            const kwargsStr = Object.entries(ctx.kwargs as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(', ');
                            const callSig = [argsStr, kwargsStr].filter(Boolean).join(', ');
                            astReport += `  - \`${ctx.caller_file}\` / \`${ctx.caller_func}()\`: \`${dep.name}(${callSig})\`\n`;
                        }
                    }
                }
            }
            astReport += `\n`;
            finalReportMarkdown += astReport;
        }
        else { log(`[AST] 解析遇到問題或找不到指定函式，將退回全域分析模式。`); }
    }


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

        // 測試結果全部放入 sessionDir
        const testPath = path.join(sessionDir, `loop${currentLoop}_test.py`);
        const reportDir = path.join(sessionDir, `loop${currentLoop}_report`);

        const systemPrompt = getSystemPrompt(currentLoop, evalStrategy as 'small' | 'large', survivedMutants, params.modelName);
        let focusContext = "";
        if (currentLoop > 1 && survivedMutants) {
            focusContext = extractFocusContext(survivedMutants, targetCode);
            if (focusContext) {
                log(`[動態焦點] 已擷取 ${focusContext.split('【目標變異體】').length - 1} 個突變體焦點區塊，準備進行精準修復。`);
            }
        }
        const userPrompt = getUserPrompt(
            params.filePath,
            params.funcName,
            targetCode,
            evalStrategy as 'small' | 'large',
            astContext,
            focusContext,
            currentModelProfile.budgetTokens,
            params.modelName
        );
        const estimatedTokens = estimateTokens(systemPrompt + userPrompt);
        log(`[Budget] Prompt 估算：${estimatedTokens.toLocaleString()} / ${currentModelProfile.budgetTokens.toLocaleString()} tokens (模型: ${currentModelProfile.paramSize}, Context: ${currentModelProfile.contextLength.toLocaleString()})`);


        let rawCode = ""; // 宣告在外層 try 前面，讓 catch 也能存取
        let sanitizedCode = "";
        try {
            for (let llmRetry = 0; llmRetry < 2; llmRetry++) {
                let apiUrl = "";
                let bodyData = {};
                let headers: Record<string, string> = { 'Content-Type': 'application/json' };

                if (params.envType === 'local') {
                    const baseUrl = params.ollamaUrl || 'http://127.0.0.1:11434';
                    apiUrl = `${baseUrl.replace(/\/$/, '')}/api/generate`;
                    bodyData = { model: params.modelName, system: systemPrompt, prompt: userPrompt, stream: false };
                    if (llmRetry === 0) log(`[LLM] 正在呼叫 Ollama 模型推論中... (模型: ${params.modelName}, URL: ${apiUrl})`);
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
                    if (llmRetry === 0) log(`[LLM] 正在透過自訂 API 請求雲端模型... (模型: ${params.modelName})`);
                } else {
                    const config = vscode.workspace.getConfiguration('llmUnitTest');
                    const keys = config.get<Record<string, string>>('apiKeys', {});
                    const actualKey = keys[params.modelName];
                    apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.modelName)}:generateContent?key=${actualKey}`;
                    bodyData = { contents: [{ parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }] };
                    if (llmRetry === 0) log(`[LLM] 正在透過 API 請求雲端模型... (模型: ${params.modelName})`);
                }
                
                currentAbortController = new AbortController();
                const timeoutId = setTimeout(() => {
                    if (currentAbortController) {
                        currentAbortController.abort();
                        log(`[警告] API 請求超時 (超過 ${params.timeoutSeconds} 秒)`);
                    }
                }, params.timeoutSeconds * 1000);

                let response;
                try {
                    response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify(bodyData),
                        signal: currentAbortController.signal
                    });
                } catch (err: any) {
                    clearTimeout(timeoutId);
                    currentAbortController = null;
                    if (err.name === 'AbortError') {
                        if (isAborted) throw new Error("使用者強制中止");
                        if (llmRetry === 0) {
                            log(`[系統] 請求超時，嘗試自動重試 (1/1)...`);
                            continue;
                        } else {
                            throw new Error(`API 請求超時 (${params.timeoutSeconds} 秒)，請檢查網路或調高超時限制`);
                        }
                    } else {
                        if (llmRetry === 0) {
                            log(`[警告] 網路請求失敗: ${err.message}`);
                            log(`[系統] 嘗試自動重試 (1/1)...`);
                            continue;
                        } else {
                            throw new Error(`網路請求連續失敗: ${err.message}`);
                        }
                    }
                }
                
                clearTimeout(timeoutId);
                currentAbortController = null;

                if (isAborted) {throw new Error("使用者強制中止");}

                if (llmRetry === 0) log(`[LLM] 模型推論已完成，正在檢查回應狀態...`);
                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`API 伺服器錯誤 (HTTP ${response.status}): ${errText}`);
                }

                const resJson = await response.json() as Record<string, unknown>;
                if (llmRetry === 0) log(`[LLM] 呼叫成功！正在萃取回傳的程式碼片段...`);

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

                sanitizedCode = sanitizeLlmResponse(rawCode);
                
                if (!sanitizedCode) {
                    if (llmRetry === 0) {
                        log(`[警告] 模型回傳的程式碼為空或無法解析。擷取原始回傳前 300 字元:\n${rawCode.substring(0, 300)}`);
                        log(`[系統] 嘗試自動重試 (1/1)...`);
                        continue;
                    } else {
                        throw new Error("模型產生的程式碼內容為空 (已重試失敗)");
                    }
                }

                // 🚨 偵測 AI 是否在複製原始碼（小模型常見的注意力崩潰）
                const hasTestMethods = sanitizedCode.includes('def test_') || sanitizedCode.includes('self.assert');
                const looksLikeSourceCopy = !hasTestMethods && params.funcName && sanitizedCode.includes(`def ${params.funcName}`);
                if (looksLikeSourceCopy) {
                    if (llmRetry === 0) {
                        log(`[警告] ⚠️ AI 輸出的是原始碼而不是測試碼（偵測到複製行為），嘗試重試...`);
                        continue;
                    } else {
                        throw new Error("AI 連續兩次輸出了原始碼而非測試碼，無法產生有效測試");
                    }
                }

                // 驗證 AI 產出的程式碼格式是否符合要求，若不合規則嘗試自動救援
                if (!sanitizedCode.includes('unittest.TestCase') && !sanitizedCode.includes('import unittest')) {
                    log(`[警告] AI 未按格式輸出 unittest.TestCase，嘗試自動救援轉換...`);
                    const rescued = rescueToUnittest(sanitizedCode, params.filePath, params.funcName);
                    if (!rescued) {
                        if (llmRetry === 0) {
                            log(`[警告] AI 回傳格式無法解析出有效的測試案例，嘗試重新請求...`);
                            log(`[警告] AI 原始輸出前 600 字元: ${sanitizedCode.substring(0, 600)}`);
                            continue;
                        } else {
                            throw new Error("AI 輸出格式連續兩次無法解析為有效測試（無任何 assert 或可用語句）");
                        }
                    }
                    log(`[救援] 自動轉換成功！已將 AI 輸出包裝為 unittest.TestCase 格式。`);
                    sanitizedCode = rescued;
                }
                
                break; // 成功取得 sanitizedCode，跳出 retry 迴圈
            }

            // 【新增】將 AI 完整思考與輸出記錄到報告中（使用摺疊標籤避免太長）
            finalReportMarkdown += `### 🤖 AI 原始輸出與思考過程\n\n`;
            finalReportMarkdown += `<details>\n<summary>點擊展開 AI 完整回應</summary>\n\n\`\`\`text\n${rawCode}\n\`\`\`\n\n</details>\n\n`;

            let finalCode = sanitizedCode;
            
            // 強制檢查並補齊 import，同時移除 LLM 可能寫的假 placeholder
            const baseName = path.basename(params.filePath, '.py');
            finalCode = finalCode
                .split('\n')
                .filter(line => {
                    const t = line.trim();
                    if (!t.startsWith('from ') && !t.startsWith('import ')) return true;
                    // 移除 placeholder imports
                    if (t.includes('module_name') || t.includes('MODULE_NAME') ||
                        t.includes('<module>') || t.includes('your_module') ||
                        t.includes('FUNCTION_NAME')) return false;
                    // 移除相對 import（from .. import, from .x import）
                    if (/^from\s+\./.test(t)) return false;
                    return true;
                })
                .join('\n');

            if (!finalCode.includes(`from ${baseName} import`)) {
                log(`[警告] AI 遺漏了 import 目標模組的語句，系統自動補齊...`);
                if (finalCode.includes('import unittest')) {
                    finalCode = finalCode.replace('import unittest', `import unittest\nfrom ${baseName} import *`);
                } else {
                    finalCode = `import unittest\nfrom ${baseName} import *\n\n` + finalCode;
                }
            }

            log(`[系統] 準備將生成的測試程式碼存檔...`);
            fs.writeFileSync(testPath, finalCode, 'utf8');
            log(`[系統] 測試腳本已存檔至: ${testPath}`);

            // 【預先驗證】先距行一次 unittest 確認測試檔能跟上
            await new Promise<void>((resolve, reject) => {
                const testDir = path.dirname(testPath);
                const testModule = path.basename(testPath, '.py');
                const targetDir = path.dirname(params.filePath);
                const parentDir = path.dirname(targetDir);
                const grandParentDir = path.dirname(parentDir);
                const pythonPath = `${targetDir};${parentDir};${grandParentDir};${testDir};%PYTHONPATH%`;
                const preCheckCmd = `chcp 65001 && set PYTHONPATH=${pythonPath} && cd /d "${testDir}" && python -m unittest ${testModule}`;
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

            // 動態偵測 mutation engine（不再依賴 isWin，改用 Python 版本 + 工具可用性）
            let engine = 'mutatest';
            const isWin = process.platform === 'win32';
            try {
                // 取得 Python 版本
                const pyVerRaw = execSync('python --version 2>&1', { encoding: 'utf8' }).trim();
                const pyVer = pyVerRaw.replace('Python ', '');
                const preferredEngine = detectMutationEngine(pyVer);
                log(`[系統] 偵測到 Python ${pyVer}，建議引擎：${preferredEngine}`);

                if (preferredEngine === 'mutmut') {
                    // 先嘗試 mutmut（Python 3.12+ 首選）
                    try {
                        execSync('mutmut --version', { stdio: 'ignore' });
                        engine = 'mutmut';
                        log(`[系統] mutmut 可用，使用 mutmut 進行突變測試。`);
                    } catch {
                        // mutmut 不可用，退回 mutatest
                        log(`[系統] mutmut 不可用，退回使用 mutatest（注意：mutatest 在 Python 3.12+ 可能不穩定）。`);
                        engine = 'mutatest';
                    }
                } else {
                    // Python < 3.12，優先 mutatest；若不可用則用 mutmut
                    try {
                        execSync('python -c "import mutatest"', { stdio: 'ignore' });
                        engine = 'mutatest';
                        log(`[系統] mutatest 可用，使用 mutatest 進行突變測試。`);
                    } catch {
                        try {
                            execSync('mutmut --version', { stdio: 'ignore' });
                            engine = 'mutmut';
                            log(`[系統] mutatest 不可用，改用 mutmut。`);
                        } catch {
                            log(`[系統] 警告：mutatest 與 mutmut 均不可用，請執行 pip install -r requirements.txt`);
                        }
                    }
                }
            } catch (e) {
                log(`[系統] 無法取得 Python 版本，使用預設引擎 mutatest。`);
            }

            log(`[${engine}] 正在建構突變測試指令...`);
            log(`[${engine}] 正式啟動分析 (系統超時限制: ${params.timeoutSeconds}秒) ... 這可能會花費數十秒，請稍候！`);

            if (isAborted) {throw new Error("使用者強制中止");}

            const mutpyResult = await new Promise<string>((resolve, reject) => {
                const targetDir = path.dirname(params.filePath);
                const parentDir = path.dirname(targetDir);
                const grandParentDir = path.dirname(parentDir);
                const testDir = path.dirname(testPath);
                const testModule = path.basename(testPath, '.py');
                
                const pythonPath = isWin
                    ? `${targetDir};${parentDir};${grandParentDir};${testDir};%PYTHONPATH%`
                    : `${targetDir}:${parentDir}:${grandParentDir}:${testDir}:$PYTHONPATH`;

                const setPythonPath = isWin 
                    ? `set PYTHONIOENCODING=utf8 && set PYTHONPATH=${pythonPath}` 
                    : `export PYTHONIOENCODING=utf8 && export PYTHONPATH="${pythonPath}"`;
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

    const finalReportPath = path.join(sessionDir, `final_report.md`);
    fs.writeFileSync(finalReportPath, finalReportMarkdown, 'utf8');
    log(`[系統] 分析結束！測試檔與最終報告已儲存至:\n${sessionDir}`);
    
    const doc = await vscode.workspace.openTextDocument(finalReportPath);
    await vscode.window.showTextDocument(doc, { preview: false });
}


/**
 * 動態焦點上下文 (Dynamic Focus Context): 
 * 從存活突變體日誌中解析出行號，並提取該行前後的程式碼作為焦點切片。
 */
function extractFocusContext(survivedMutants: string, targetCode: string): string {
    if (!survivedMutants) return "";
    const lines = targetCode.split('\n');
    const focusSnippets: string[] = [];
    const mutantLines = survivedMutants.split('\n');
    
    let processedCount = 0;
    for (const mLine of mutantLines) {
        if (processedCount >= 3) break; // 最多只取前 3 個焦點，避免 Prompt 過載
        if (!mLine.trim() || !mLine.includes('mutation')) continue;
        
        let lineNum = -1;
        // 優先匹配 mutatest 格式: (l: 5, c: 11)
        const mutatestMatch = mLine.match(/\(l:\s*(\d+)/);
        if (mutatestMatch) {
            lineNum = parseInt(mutatestMatch[1], 10);
        } else {
            // fallback
            const otherMatch = mLine.match(/line\s+(\d+)/i) || mLine.match(/:(\d+)/);
            if (otherMatch) {
                lineNum = parseInt(otherMatch[1], 10);
            }
        }
        
        if (lineNum > 0 && lineNum <= lines.length) {
            const idx = lineNum - 1;
            const start = Math.max(0, idx - 2);
            const end = Math.min(lines.length - 1, idx + 2);
            
            let snippet = `【目標變異體】\n${mLine.trim()}\n【發生位置周遭程式碼 (第 ${start+1}~${end+1} 行)】\n\`\`\`python\n`;
            for (let i = start; i <= end; i++) {
                const prefix = (i === idx) ? '>> ' : '   ';
                snippet += `${prefix}${i+1}: ${lines[i]}\n`;
            }
            snippet += `\`\`\``;
            focusSnippets.push(snippet);
            processedCount++;
        }
    }
    return focusSnippets.join('\n\n');
}

export function deactivate() {}