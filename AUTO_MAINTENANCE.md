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
