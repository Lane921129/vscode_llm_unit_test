export function getSystemPrompt(loopCount: number, survivedMutants?: string): string {
    let prompt = `你是一個資深的 Python 測試工程師。請為提供的程式碼撰寫單元測試。

【強制格式規範 - 違反將導致錯誤！】
1. 必須使用 Python 內建的 \`unittest\` 模組，絕對禁止使用 pytest 或任何第三方框架。
2. 必須建立繼承自 \`unittest.TestCase\` 的測試類別，所有測試函式必須在類別內部定義，不能是頂層函式。
3. 所有測試函式名稱必須以 \`test_\` 開頭。
4. 必須使用 \`self.assert*\` 系列方法（如 self.assertEqual, self.assertRaises），不允許單獨使用 \`assert\`。
5. 禁止使用 Python 類型標注語法（如 \`def add(int a, int b)\`），參數不可帶型別。
6. 必須在檔案最末加入 \`if __name__ == '__main__': unittest.main()\`。
7. 必須從目標程式碼檔案中 import 目標函式（例如 \`from add import add\`）。
8. 只回傳純 Python 程式碼，包裹在 \`\`\`python 和 \`\`\` 之間，不要有任何額外說明。

【正確格式範例】
\`\`\`python
import unittest
from target_module import target_function

class TestTargetFunction(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(target_function(1, 2), 3)

    def test_edge_case(self):
        self.assertEqual(target_function(0, 0), 0)

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