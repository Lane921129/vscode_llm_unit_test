export function getSystemPrompt(loopCount: number, survivedMutants?: string): string {
    let prompt = `你是一個專業的 Python 單元測試工程師與突變測試 (Mutation Testing) 專家。你的「唯一」任務是：為目標程式碼撰寫高覆蓋率的 unittest 測試案例，以殺死所有潛在的變異體。

【你的輸出規則 - 必須嚴格遵守】
你的回應必須包含兩個部分：
1. <thinking> 區塊：在此處用中文分析該如何設計測試案例來涵蓋所有邊界條件。如果是後續輪次，請分析為什麼變異體會存活。嚴格禁止試圖優化、重構或提供目標程式碼的修改建議！
2. 程式碼區塊：在思考完畢後，輸出一個且只能有一個 Python 程式碼區塊，包含完整的 unittest。

格式必須嚴格如下：
<thinking>
（在此撰寫你的程式碼分析、發現的問題、改進建議，以及你將如何設計測試案例）
</thinking>

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
9. 嚴格禁止重寫、修改或提供目標程式碼的各種實作方法！你只能輸出測試程式碼！

【正確格式範例】
<thinking>
這個 add 函式非常簡單，但可能會有型別問題。如果傳入字串，雖然 Python 允許相加，但作為整數加法函式這可能是不預期的。
為了殺死把 + 變成 - 的突變體，我必須提供 1+2=3 的測試，因為 1-2=-1，這樣斷言才會失敗並殺死突變體。如果只給 0+0=0，0-0 也是 0，突變體就會存活。
</thinking>

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
        prompt += `\n⚠️ 注意：上一輪測試後，以下突變體依然存活，請在 <thinking> 中分析它們存活的原因，並加強程式碼的 Assert 邏輯來殺死它們：\n${survivedMutants}`;
    }
    return prompt;
}

export function getUserPrompt(fileName: string, funcName: string, code: string, astContext?: any, focusContexts?: string): string {
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
    }

    if (focusContexts) {
        prompt += `\n【動態焦點分析】\n你的測試目前漏掉了以下變異體的防護，請專注於這些焦點行數：\n\n${focusContexts}\n`;
        prompt += `\n（註：為保持專注，本輪僅提供焦點周遭程式碼。請在 \`<thinking>\` 中分析為何該突變會發生，並撰寫針對性的 Assert 殺死它。新的 Assert 請加到你原本已經寫好的測試類別中。）\n`;
    } else {
        if (astContext && !astContext.error) {
            prompt += `\n【原始程式碼】:\n\`\`\`python\n${astContext.code || code}\n\`\`\``;
        } else {
            prompt += `\n【原始程式碼】:\n\`\`\`python\n${code}\n\`\`\``;
        }
    }

    return prompt;
}