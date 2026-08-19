import * as vscode from 'vscode';
import { MutationViewProvider } from './SidebarProvider';
import { getSystemPrompt, getUserPrompt, getTier1SystemPrompt, getTier1UserPrompt, getTier3SystemPrompt, getTier3UserPrompt, getTier4SystemPrompt, getTier4SelfRepairPrompt } from './promptProvider';
import { getReviewerSystemPrompt, getReviewerUserPrompt } from './reviewerPromptProvider';
import { extractFunctionsWithAst, findPythonFilesInDir, detectMutationEngine } from './utils';
import { mergeTestSnippets } from './testMerger';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

// ── 並行與執行緒安全 Process Pool ──
const activeProcesses = new Set<ChildProcess>();
const activeAbortControllers = new Set<AbortController>();
let isAborted = false;

/** 跨平台安全中斷 Process Tree */
function killProcessTree(proc: ChildProcess) {
    if (!proc.pid) return;
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', proc.pid.toString(), '/T', '/F']);
    } else {
        try {
            process.kill(-proc.pid, 'SIGKILL'); // Kill process group
        } catch {
            proc.kill('SIGKILL');
        }
    }
}

/** 跨平台執行子行程 (Promise 封裝) */
function runCommand(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
        if (isAborted) return reject(new Error('使用者強制中止'));

        const proc = spawn(command, args, {
            cwd: options.cwd,
            env: options.env || process.env,
            detached: process.platform !== 'win32', // Unix 下建立獨立 Process Group 便於清理
            shell: false
        });

        activeProcesses.add(proc);
        let stdout = '';
        let stderr = '';

        let timer: NodeJS.Timeout | null = null;
        if (options.timeout) {
            timer = setTimeout(() => {
                killProcessTree(proc);
                reject(new Error(`執行超時 (超過 ${options.timeout! / 1000} 秒)`));
            }, options.timeout);
        }

        proc.stdout?.on('data', d => stdout += d.toString());
        proc.stderr?.on('data', d => stderr += d.toString());

        proc.on('close', (code) => {
            if (timer) clearTimeout(timer);
            activeProcesses.delete(proc);
            resolve({ stdout, stderr, code });
        });

        proc.on('error', (err) => {
            if (timer) clearTimeout(timer);
            activeProcesses.delete(proc);
            reject(err);
        });
    });
}

/** 動態並行執行器（含降級策略） */
async function runWithAdaptiveConcurrency<T>(
    tasks: (() => Promise<T>)[],
    userConcurrency: string, // 'auto' | '1' | '2' | '3' | ...
    modelParamBillion: number,
    log: (text: string) => void
): Promise<T[]> {
    let limit = 1;
    if (userConcurrency === 'auto') {
        if (isNaN(modelParamBillion) || modelParamBillion > 30) {
            limit = 3; // Cloud 或大模型
        } else if (modelParamBillion <= 8) {
            limit = 1; // 8B 以下小模型嚴格單 thread 避免 VRAM 爆掉
        } else {
            limit = 2;
        }
    } else {
        limit = Math.max(1, parseInt(userConcurrency) || 1);
    }

    log(`[排程] 啟動執行佇列，設定最大並行數：${limit} Worker (模式: ${userConcurrency})`);

    const results: T[] = new Array(tasks.length);
    let idx = 0;
    let fallbackToSingleThread = false;

    async function worker() {
        while (idx < tasks.length) {
            if (isAborted) break;
            const i = idx++;
            try {
                results[i] = await tasks[i]();
            } catch (err: any) {
                // 若為 GPU OOM 或 API Rate Limit，自動動態降為 1 thread
                if (!fallbackToSingleThread && (err.message?.includes('CUDA') || err.message?.includes('429'))) {
                    fallbackToSingleThread = true;
                    log(`[警示] 偵測到模型負載過高或 Rate Limit，動態降級為 1 Worker 串行模式！`);
                }
                throw err;
            }
        }
    }

    const initialWorkers = Math.min(limit, tasks.length);
    await Promise.all(Array.from({ length: initialWorkers }, () => worker()));
    return results;
}

/** 強化版 Python REPL / 裸 assert 救援 */
function rescueToUnittest(rawCode: string, srcFilePath: string, funcName: string): string {
    const moduleName = path.basename(srcFilePath, '.py');
    const lines = rawCode.split('\n').map(l => l.replace(/^>>>\s?/, '').trim()).filter(Boolean);
    const testMethods: string[] = [];
    let idx = 1;

    for (const line of lines) {
        if (line.startsWith('assert ')) {
            const rawAssert = line.substring(7).trim();
            // 尋找最高層級的 == (忽略字串或括號內的 ==)
            const eqIdx = rawAssert.indexOf('==');
            if (eqIdx !== -1) {
                const left = rawAssert.substring(0, eqIdx).trim();
                const right = rawAssert.substring(eqIdx + 2).trim();
                testMethods.push(`    def test_case_${idx++}(self):\n        self.assertEqual(${left}, ${right})`);
            } else {
                testMethods.push(`    def test_case_${idx++}(self):\n        self.assertTrue(${rawAssert})`);
            }
        }
    }

    if (testMethods.length === 0) return '';
    return [
        `import unittest`,
        `from ${moduleName} import *`,
        ``,
        `class TestAutoRescued(unittest.TestCase):`,
        testMethods.join('\n\n'),
        ``,
        `if __name__ == '__main__':`,
        `    unittest.main()`
    ].join('\n');
}

export function activate(context: vscode.ExtensionContext) {
    const sidebarProvider = new MutationViewProvider(context.secrets);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MutationViewProvider.viewType, sidebarProvider)
    );

    const abortTestCmd = vscode.commands.registerCommand('llm-unit-test.abortTest', () => {
        isAborted = true;
        for (const ctrl of activeAbortControllers) ctrl.abort();
        activeAbortControllers.clear();
        for (const proc of activeProcesses) killProcessTree(proc);
        activeProcesses.clear();
    });

    context.subscriptions.push(abortTestCmd);
}