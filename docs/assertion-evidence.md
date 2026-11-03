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

## 輸入物件狀態的斷言關聯

`target_result_evidence.py` 另行核對斷言是否觀察到真目標結果；這不等於上述 Trace 的預期值核實。測試自行建立且未共享的 `SimpleNamespace`，在真目標呼叫後可觀察來源明確寫入的直接屬性。來源含 `if` 時只保留所有正常完成路徑共同寫入的屬性；測試明確建立標準 `set`／`list`／`dict`，且來源呼叫對應 `add`／`remove` 等 mutator 時也算寫入，不因方法同名就推測任意物件型別。單邊分支、未寫入就返回、迴圈、反射或參數重綁不藉此取得證據。

測試可使用標準 `unittest.mock.patch` context manager 控制來源直接呼叫的 helper。只接受一個明確字串使用點，不能替換受測目標或 `types.SimpleNamespace`，也不能以 `as` 重綁後沿用原物件身分；未知 helper 或測試自行改寫仍撤銷狀態證據。這只讓有相關性的測試進入執行，不提供預期答案、不證明分支已執行。完整品質模式仍須 Reviewer 及品質量測；`execution` 模式只回報已完成的隔離單元測試執行。

真實回傳物件的方法結果也可延續關聯，例如 `connection = target()`、`cursor = connection.cursor()`、`row = cursor.fetchone()` 後斷言 `row`。此規則不決定 row 的正確值；任意 helper 回傳、反射、receiver 重綁或測試覆寫方法都不能藉此取得關聯。
