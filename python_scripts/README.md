# Python 工具

這裡的正式工具由 [TypeScript 工具登錄表](../src/pipeline/pythonTools.ts) 呼叫。要看整體流程，先讀 [專案閱讀入口](../ARCHITECTURE.md)。

| 階段 | 工具 | 工作 |
|---|---|---|
| 來源分析 | `complexity_assessor.py`、`ast_extractor.py` | 函式結構、參數、複雜度 |
| 呼叫與行為觀測 | `ast_caller_finder.py`、`dynamic_tracer.py` | 找來源支持的輸入並受控執行；只回傳有界 I/O 觀測，不回傳逐行除錯軌跡 |
| 生成前環境檢查 | `module_preflight.py` | 在隔離程序中受控匯入正規模組，核對來源路徑與缺少相依；不呼叫目標函式 |
| 測試設定 | `mock_scaffold_generator.py` | 提供可驗證的 Mock 骨架 |
| 候選檢查 | `validate_test_bindings.py`、`validate_target_calls.py` | 匯入、Mock 使用點與呼叫簽名 |
| Checker（執行校驗） | `generated_test_runner.py` | 執行 unittest，以斷言比對實際結果與測試內預期答案；提供 coverage 與突變子程序的外部操作防護，違規不能算通過或 killed |
| 修復範圍 | `validate_repair_scope.py` | 限制 Bug Fixer 只修改失敗測試並保留既有測試 |
| 斷言證據 | `validate_assertion_evidence.py` | 檢查同一呼叫的 literal 斷言是否與已驗證行為觀測矛盾 |
| 情境識別 | `scenario_inventory.py` | 為測試 AST 與設定建立指紋，不執行測試 |
| 品質補測觀測 | `quality_experiment_runner.py`、`parameter_fixture_experiments.py` | 分別觀察實例有序狀態及頂層函式的受控物件參數；只回傳觀測，由 AI 新增測試，再重跑、審查與量測。參見[參數物件受控補測](../docs/參數物件受控補測.md) |
| 物件重放核對 | `parameter_fixture_experiments.py --check-replay` | 僅AST核對新增方法；簡單封閉getter類別按真正receiver比對，巢狀property物件不能冒充外層讀取。其他未知fixture保持unknown；不執行類別或代替實跑審查，規劃／worker能力不因此擴張 |
| 格式救援 | `rescue_unittest.py` | 受限制的 unittest 產物整理 |
| 品質測量 | `basic_mutation_runner.py` | 每個變異體使用獨立目錄並停用bytecode；原測試與基線保留原位元組，避免Windows換行重複轉換。選定突變來源的自相依可在可信trial映射重綁，其他相依漂移仍拒絕 |

Checker 是不呼叫 LLM 的工具階段；Writer 撰寫測試與預期答案，Reviewer 以 LLM 審查輸入、預期值及其依據。Checker 通過表示實際案例符合測試內斷言，不證明預期答案符合獨立業務需求。

`test_*.py` 是此專案自己的回歸測試，不是執行中的角色。`fixture_scorecard.py` 用於測試結果評量，`secret_scan.py` 用於開發檢查。

正式工具使用工作區 `.venv` 或明確指定的 Python。分析 JSON 從 stdout 回傳；診斷不要混入 JSON。測試由 `generated_test_runner.py` 呼叫 unittest／coverage，環境由 [pythonTestEnvironment.ts](../src/utils/pythonTestEnvironment.ts) 統一建立。exit code 86 與 `TEST_ISOLATION_BLOCKED` 表示外部操作未隔離；即使測試吞掉例外仍失敗。這是生成碼 AST gate 的執行補強，不是對惡意原生 extension 的 OS sandbox。

`module_preflight.py` 接受 stdin JSON：`file`、`module`、`importPaths`。成功回傳相同匯入環境；失敗回傳 stage、例外型別、missing_module 與診斷堆疊。`dynamic_tracer.py` 的 `load_diagnostic` 保留相同載入證據，不把載入錯誤放進可斷言的 target errors。
