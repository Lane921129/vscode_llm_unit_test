# Python 工具

這裡的正式工具由 [TypeScript 工具登錄表](../src/pipeline/pythonTools.ts) 呼叫。要看整體流程，先讀 [專案閱讀入口](../ARCHITECTURE.md)。

| 階段 | 工具 | 工作 |
|---|---|---|
| 來源分析 | `complexity_assessor.py`、`ast_extractor.py` | 函式結構、參數、複雜度 |
| 呼叫與行為觀測 | `ast_caller_finder.py`、`dynamic_tracer.py` | 找來源支持的輸入並受控執行；只回傳有界 I/O 觀測，不回傳逐行除錯軌跡 |
| 生成前環境檢查 | `module_preflight.py` | 在隔離程序中受控匯入正規模組，核對來源路徑與缺少相依；不呼叫目標函式 |
| 測試設定 | `mock_scaffold_generator.py` | 提供可驗證的 Mock 骨架 |
| 候選檢查 | `validate_test_bindings.py`、`validate_target_calls.py` | 匯入、Mock 使用點與呼叫簽名 |
| 正式執行 | `generated_test_runner.py` | unittest／coverage 與突變子程序的外部操作防護；違規不能算通過或 killed |
| 修復範圍 | `validate_repair_scope.py` | 限制 Bug Fixer 只修改失敗測試並保留既有測試 |
| 斷言證據 | `validate_assertion_evidence.py` | 檢查同一呼叫的 literal 斷言是否與已驗證行為觀測矛盾 |
| 情境識別 | `scenario_inventory.py` | 為測試 AST 與設定建立指紋，不執行測試 |
| 格式救援 | `rescue_unittest.py` | 受限制的 unittest 產物整理 |
| 品質測量 | `basic_mutation_runner.py` | 每個變異體使用獨立目錄並停用 bytecode 後執行 |

`test_*.py` 是此專案自己的回歸測試，不是執行中的角色。`fixture_scorecard.py` 用於測試結果評量，`secret_scan.py` 用於開發檢查。

正式工具使用工作區 `.venv` 或明確指定的 Python。分析 JSON 從 stdout 回傳；診斷不要混入 JSON。測試由 `generated_test_runner.py` 呼叫 unittest／coverage，環境由 [pythonTestEnvironment.ts](../src/utils/pythonTestEnvironment.ts) 統一建立。exit code 86 與 `TEST_ISOLATION_BLOCKED` 表示外部操作未隔離；即使測試吞掉例外仍失敗。這是生成碼 AST gate 的執行補強，不是對惡意原生 extension 的 OS sandbox。

`module_preflight.py` 接受 stdin JSON：`file`、`module`、`importPaths`。成功回傳相同匯入環境；失敗回傳 stage、例外型別、missing_module 與診斷堆疊。`dynamic_tracer.py` 的 `load_diagnostic` 保留相同載入證據，不把載入錯誤放進可斷言的 target errors。
