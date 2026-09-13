# Python 工具

這裡的正式工具由 [TypeScript 工具登錄表](../src/pipeline/pythonTools.ts) 呼叫。要看整體流程，先讀 [專案閱讀入口](../ARCHITECTURE.md)。

| 階段 | 工具 | 工作 |
|---|---|---|
| 來源分析 | `complexity_assessor.py`、`ast_extractor.py` | 函式結構、參數、複雜度 |
| 呼叫與真實觀察 | `ast_caller_finder.py`、`dynamic_tracer.py` | 找輸入候選並執行 Trace |
| 測試設定 | `mock_scaffold_generator.py` | 提供可驗證的 Mock 骨架 |
| 候選檢查 | `validate_test_bindings.py`、`validate_target_calls.py` | 匯入、Mock 使用點與呼叫簽名 |
| 斷言證據 | `validate_assertion_evidence.py` | 檢查同一呼叫的 literal 斷言是否與真實 Trace 矛盾 |
| 情境識別 | `scenario_inventory.py` | 為測試 AST 與設定建立指紋，不執行測試 |
| 格式救援 | `rescue_unittest.py` | 受限制的 unittest 產物整理 |
| 品質測量 | `basic_mutation_runner.py` | 隔離執行原程式與變異體 |

`test_*.py` 是此專案自己的回歸測試，不是執行中的角色。`fixture_scorecard.py` 用於測試結果評量，`secret_scan.py` 用於開發檢查。

正式工具使用工作區 `.venv` 或明確指定的 Python。分析 JSON 從 stdout 回傳；診斷不要混入 JSON。測試與 coverage 則由標準 Python 模組執行，環境由 [pythonTestEnvironment.ts](../src/utils/pythonTestEnvironment.ts) 統一建立。
