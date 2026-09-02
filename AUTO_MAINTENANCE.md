# 自動更新與維護規範

此文件定義專案在本機與 GitHub 持續維護時的固定流程。它是維護作業的依據，不保存任何憑證。

## 每次改動的自動流程

1. 讀取 `PROJECT_RULES.md` 與目前的 `CHANGELOG.zh-TW.md`。
2. 實作可獨立驗證的一個變更單位。
3. 執行 `npm run check-types`、`npm run lint`、`npm run test:unit`、`npm run compile` 與 `git diff --check`；其中 `test:unit` 已包含 Python AST pipeline。
4. 將改動、測試結果與限制寫入中文 Log。
5. 建立一則含英文與繁體中文的 Git commit。

## GitHub 持續整合建議

將來啟用 GitHub Actions 時，Pull Request 與主分支至少應執行下列工作：

- Node.js 依賴安裝與 `npm run compile`。
- `npm run test:unit`。
- Python AST／追蹤腳本的測試（`python python_scripts/test_ast_pipeline.py`）。
- 密鑰掃描，拒絕疑似 API Key、Token、私鑰或 `.env` 進入版本庫。

CI 只可使用 GitHub Secrets 注入的環境變數，例如 `LLM_UNIT_TEST_GOOGLE_API_KEY`；不得列印、序列化或寫入測試報告。雲端模型的實際連線測試應是手動核准的工作流程，以避免產生非預期費用。

## 依賴與結果維護

- 每月檢查 Node.js、Python 與測試工具相容性，先在分支上驗證再更新。
- Windows + Python 3.12 以上原生環境不支援目前的突變工具組合；應使用 WSL + mutmut，或 Python 3.11 + mutatest。
- `test/result` 是執行產物，分析時須把 Stub／Noise 函式與可評估函式分開統計。
- `test/result` 中的歷史批次產物應定期歸檔與清理，已確認驗證完畢之測試快取（如 `.pyc`）與無效中斷日誌可安全移除，僅保留具代表性之基準對比紀錄。
- 發現 LLM 輸出格式失敗時，優先補充回歸測試與結構驗證，不以放寬輸出條件掩蓋問題。
- 變更生成測試或突變引擎的執行流程時，維持 `spawn` 引數、明確 `cwd` 與環境變數的可攜式做法；不得新增 Windows shell、硬碟代號或未跳脫的路徑字串相依。
- 調整模型連線與資格探針時，保留每個網路階段的獨立 Timeout；基本連線不得少於 30 秒，資格生成不得少於 60 秒，避免因共享取消控制器誤判模型能力。
- 發現模型猜測例外類型時，優先把 AST／Dynamic Trace 例外事實接入結構驗證並加入回歸測試；不得只用更強硬的 Prompt 要求掩蓋錯誤。
- 新增模型或調整 Prompt 路由時，只能使用探測能力資料與程式碼特徵；不得新增模型名稱白名單、黑名單或品牌特化分支。
- 維護 Python 分析腳本時，合格的 `Class.method` 必須在 AST、Trace、Scaffold、複雜度與突變流程維持一致；遇到同名方法要新增整合測試，確認不會誤選其他類別或頂層函式。
- 維護 `Class.method` 的呼叫端掃描時，必須以目標模組的 import／alias 關係與可驗證的接收者結構確認目標；若呼叫為 `Class(...).method(...)`，建構子與方法的字面值要分開傳給 Trace，並測試同名本地類別不會污染結果。
- 若擴充類別方法 caller 的局部變數資料流，只能接受同一 lexical scope、呼叫前的直接類別建構賦值；重新賦值或跨條件／scope／factory 的不確定型別必須保守排除，並加入誤認防護測試。
- 修改 Tier 1 類別方法流程時，已驗證 Trace 若依賴 caller 的 literal 建構子設定，必須用相同設定產生可執行的 `setUp`；缺少雙重（literal 值與原始碼表示）證據時不可猜測建構子或假裝 Trace 可重現。
- 維護生成測試驗證器時，若帶有選取類別名稱，必須驗證方法呼叫的類別／實例來源，而非僅比對方法字串；需要涵蓋直接 import、模組 alias、正確實例與錯誤同名實例。
- 調整函式選單或批次列舉時，只能輸出下游流程可獨立執行的頂層函式與直接 `Class.method`；局部 helper 與巢狀類別成員必須排除，並以回歸測試保護。
- 維護 Class Context 擷取時，`__init__` 的屬性清單只能來自建構子本體，不可遞迴採集巢狀 helper、lambda 或內部類別的狀態；每次調整都要測試這些 scope 邊界。
- 調整 Tier 複雜度評估時，只採可驗證 AST 結構、Imports 與呼叫關係；不得加入業務領域或資源名稱關鍵字作為捷徑。
- 維護 Writer Prompt 時，所有模型與 Tier（含 Tier 3、Tier 4、Self-repair）一律使用同一個純 Python code fence 輸出契約；不要因模型名稱要求或解析 `<thinking>` 等額外標籤，並須以擷取／驗證回歸測試保護此規則。
