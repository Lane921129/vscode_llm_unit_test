/**
 * utils.ts — 共用工具函式
 * 供 extension.ts 與 SidebarProvider.ts 共享使用，避免重複實作
 */
import * as fs from 'fs';
import * as path from 'path';

/** 從 .py 檔案中以 regex 萃取所有 top-level def 函式名稱 */
export function extractFunctionsFromFile(filePath: string): string[] {
    if (!fs.existsSync(filePath)) { return []; }
    const content = fs.readFileSync(filePath, 'utf-8');
    const regex = /^def\s+([a-zA-Z0-9_]+)\s*\(/gm;
    const funcs: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
        funcs.push(match[1]);
    }
    return funcs;
}

/** 遞迴掃描資料夾，回傳所有 .py 檔案的絕對路徑 */
export async function findPythonFilesInDir(dir: string): Promise<string[]> {
    const ignored = new Set(['.git', 'node_modules', 'env', '.env', 'venv', '.venv', '.pytest_cache', '__pycache__']);
    const results: string[] = [];
    try {
        const list = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const item of list) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
                if (ignored.has(item.name)) { continue; }
                results.push(...await findPythonFilesInDir(fullPath));
            } else if (item.name.endsWith('.py')) {
                results.push(fullPath);
            }
        }
    } catch { }
    return results;
}

/**
 * 動態偵測可用的 mutation testing 引擎
 * 優先考慮 Python 版本：>= 3.12 的環境 mutatest 不可靠，優先使用 mutmut
 * @returns 'mutatest' | 'mutmut' | null
 */
export function detectMutationEngine(pythonVersion: string): 'mutatest' | 'mutmut' {
    // 解析主版本號
    const versionMatch = pythonVersion.match(/(\d+)\.(\d+)/);
    const major = versionMatch ? parseInt(versionMatch[1]) : 3;
    const minor = versionMatch ? parseInt(versionMatch[2]) : 0;

    // Python >= 3.12：mutatest 無官方支援，優先 mutmut
    if (major > 3 || (major === 3 && minor >= 12)) {
        return 'mutmut';
    }
    // Python < 3.12：mutatest 較輕量，優先使用
    return 'mutatest';
}
