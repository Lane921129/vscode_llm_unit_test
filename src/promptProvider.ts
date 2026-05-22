export function getSystemPrompt(loopCount: number, survivedMutants?: string): string {
    let prompt = `你是一個專門產生 Python unittest 測試程式碼的機器人。你只能輸出程式碼，不能輸出任何解釋、說明或對話文字。

【你的輸出規則 - 必須嚴格遵守】
你的回應必須且只能包含一個程式碼區塊，格式如下：
\`\`\`python
（測試程式碼）
\`\`\`

【程式碼內容規則 - 違反任何一條都會造成系統錯誤】
1. 第一行必須是 \`import unittest\`
2. 必須定義繼承 \`unittest.TestCase\` 的測試類別
3. 測試函式必須在類別內，以 \`test_\` 開頭，使用 \`self.assert*()\`
4. 最後一行必須是 \`if __name__ == '__main__': unittest.main()\`
5. 必須使用 \`from <模組名> import <函式名>\` 匯入被測函式
6. 嚴格禁止使用 pytest、nose、或任何第三方測試框架
7. 嚴格禁止輸出 Python REPL 格式（即帶有 >>> 的行）
8. 嚴格禁止輸出頂層 assert 語句（assert 只能在 self.assert*() 內）
9. 嚴格禁止在程式碼前後加任何解釋文字

【正確格式範例】
\`\`\`python
import unittest
from add import add

class TestAdd(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(add(1, 2), 3)

    def test_negative(self):
        self.assertEqual(add(-1, -1), -2)

    def test_zero(self):
        self.assertEqual(add(0, 0), 0)

if __name__ == '__main__':
    unittest.main()
\`\`\`

你必須考慮邊界條件，並確保突變測試 (Mutation Testing) 的分數能達到最高。
`;

    if (loopCount > 1 && survivedMutants) {
        prompt += `\n⚠️ 注意：上一輪測試後，以下突變體依然存活，請加強 Assert 邏輯來殺死它們：\n${survivedMutants}`;
    }
    return prompt;
}

export function getUserPrompt(fileName: string, funcName: string, code: string, astContext?: any): string {
    const target = funcName ? `函式 \`${funcName}\`` : `整份檔案`;
    let prompt = `【目標檔案】: ${fileName}\n【目標範圍】: ${target}\n`;
    
    if (astContext && !astContext.error) {
        prompt += `【AST 解析特徵】:\n`;
        prompt += `- 函數名稱: ${astContext.name}\n`;
        if (astContext.args && astContext.args.length > 0) {
            prompt += `- 參數清單: ${astContext.args.join(', ')}\n`;
        }
        if (astContext.docstring) {
            prompt += `- 說明文件/註解: ${astContext.docstring.trim()}\n`;
        }
        if (astContext.calls && astContext.calls.length > 0) {
            prompt += `- 內部相依呼叫: ${astContext.calls.join(', ')}\n`;
        }
        prompt += `\n【原始程式碼】:\n\`\`\`python\n${astContext.code || code}\n\`\`\``;
    } else {
        prompt += `\n【原始程式碼】:\n\`\`\`python\n${code}\n\`\`\``;
    }
    return prompt;
}