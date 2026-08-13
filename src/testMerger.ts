/**
 * testMerger.ts — 分治合流法 (Divide & Conquer Test Merger)
 * 負責將多個獨立針對不同呼叫站 (Call Site) 生成的 unittest 程式碼片段，
 * 機械式地抽取 imports 與 test_* 方法，並自動重組為單一完整的 TestCase 類別。
 */

export interface MergeResult {
    mergedCode: string;
    totalMethodsCount: number;
}

/**
 * 從單一 unittest 程式碼中提取所有 import 行與 def test_* 方法區塊
 */
function parseSnippet(code: string): { imports: string[]; methods: { name: string; body: string }[] } {
    const lines = code.split('\n');
    const imports: string[] = [];
    const methods: { name: string; body: string }[] = [];

    let currentMethodName = '';
    let currentMethodLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // 收集 import 語句
        if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
            // 跳過 placeholder
            if (!trimmed.includes('module_name') && !trimmed.includes('MODULE_NAME')) {
                imports.push(trimmed);
            }
            continue;
        }

        // 偵測 test 方法開頭: def test_xxx(self...):
        const methodMatch = line.match(/^(\s*)def\s+(test_[a-zA-Z0-9_]*)\s*\(/);
        if (methodMatch) {
            // 如果上一個方法還在收集，先結算
            if (currentMethodName && currentMethodLines.length > 0) {
                methods.push({ name: currentMethodName, body: currentMethodLines.join('\n') });
            }

            currentMethodName = methodMatch[2];
            currentMethodLines = [line];
            continue;
        }

        // 如果在方法區塊內部
        if (currentMethodName) {
            // 如果遇到 class 定義或 if __name__ 開頭，代表方法結束
            if (line.match(/^class\s+/) || line.match(/^if\s+__name__/)) {
                methods.push({ name: currentMethodName, body: currentMethodLines.join('\n') });
                currentMethodName = '';
                currentMethodLines = [];
                continue;
            }

            // 如果縮排退回頂層且不是空行/註解，代表方法結束
            if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('#')) {
                methods.push({ name: currentMethodName, body: currentMethodLines.join('\n') });
                currentMethodName = '';
                currentMethodLines = [];
                continue;
            }

            currentMethodLines.push(line);
        }
    }

    // 處理最後一個方法
    if (currentMethodName && currentMethodLines.length > 0) {
        methods.push({ name: currentMethodName, body: currentMethodLines.join('\n') });
    }

    return { imports, methods };
}

/**
 * 將多個獨立生成片段組裝合併成單一 unittest.TestCase 類別
 * @param snippets 多個 AI 輸出的 sanitized python code
 * @param className 目標測試類別名稱 (預設 TestMergedSuite)
 */
export function mergeTestSnippets(snippets: string[], className: string = 'TestMergedSuite'): MergeResult {
    const allImportsSet = new Set<string>();
    allImportsSet.add('import unittest');

    const methodNamesSeen = new Map<string, number>();
    const finalMethodBodies: string[] = [];

    for (let sIdx = 0; sIdx < snippets.length; sIdx++) {
        const snippet = snippets[sIdx];
        const { imports, methods } = parseSnippet(snippet);

        // 彙整 Imports
        for (const imp of imports) {
            allImportsSet.add(imp);
        }

        // 彙整 Methods 並進行防衝突更名
        for (const m of methods) {
            let finalName = m.name;
            const count = methodNamesSeen.get(m.name) || 0;
            methodNamesSeen.set(m.name, count + 1);

            if (count > 0) {
                // 名稱衝突：加上呼叫站/序號別名 (如 test_valid_token_site2)
                finalName = `${m.name}_site${sIdx + 1}`;
                // 替換方法體的第一行函式名
                m.body = m.body.replace(`def ${m.name}(`, `def ${finalName}(`);
            }

            finalMethodBodies.push(m.body);
        }
    }

    // 組合最終 Python 檔案內容
    const importsStr = Array.from(allImportsSet).join('\n');
    const methodsStr = finalMethodBodies.join('\n\n');

    const mergedCode = [
        importsStr,
        '',
        `class ${className}(unittest.TestCase):`,
        methodsStr ? methodsStr : '    pass',
        '',
        `if __name__ == '__main__':`,
        `    unittest.main()`
    ].join('\n');

    return {
        mergedCode,
        totalMethodsCount: finalMethodBodies.length
    };
}
