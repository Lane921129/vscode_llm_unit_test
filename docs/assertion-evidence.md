# 斷言證據防護範圍

正式入口是 [traceAssertionEvidence.ts](../src/validation/traceAssertionEvidence.ts)，實際語法分析由 [validate_assertion_evidence.py](../python_scripts/validate_assertion_evidence.py) 執行。所有模型候選都經過此檢查，之後仍須實際執行 unittest、coverage 與 mutation。

## 這次補上的缺口

| 情況 | 處理 |
|---|---|
| `result = target(...)` 後才斷言 | 在同一測試的直線流程追蹤結果變數 |
| 多行 `assertEqual` | 以 AST 解析，不依賴單行文字 |
| `target()` 無參數 | 空參數也能匹配 Trace |
| `assertIs(result, False)` | 區分 `False`、`None` 與數字 `0` |
| 字串內容有空白 | 保留 literal 內容，不把 `"a b"` 當成 `"ab"` |
| 註解裡有斷言文字 | 不當成可執行斷言 |
| 匯入別名 | 僅對可解析的目標模組／函式 binding 使用證據 |

## 刻意保留為未知的情況

- 使用 Mock、decorator、fixture、未知繼承或模組初始化控制相依時，不套用無 Mock 的 Trace。
- 有流程分支、結果轉換、未知 helper 呼叫、變數重綁定，或輸入沒有 Trace 時，不猜測結果。
- 類別成員需有同一實例設定的證據；本檢查不將頂層函式規則套到未知實例。
- 相同輸入已有互相矛盾的 Trace 時，不選其中一個作為唯一答案。
- 非 literal repr 不會被 eval，也不會被當作精確預期值。

「未知」不是批准：結構、隔離執行、Trace 基線保存、Reviewer 與突變測量仍繼續生效。這不是任意 Python 程式的形式化正確性證明。

Trace 只描述觀察到的行為。要證明程式符合業務需求，還需要外部規格或契約；不能把目前程式輸出一律當成業務正確答案。
