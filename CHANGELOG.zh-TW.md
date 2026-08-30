# 中文變更紀錄

本檔記錄每個已完成、已驗證並提交的專案改動；不記錄 API Key、Token 或其他密鑰。

## 2026-08-30

### 動態追蹤資料可信度

- 呼叫站中的變數、運算式與不可安全還原的資料不再被當成真實輸入執行；它們只保留在語意提示中。
- 可由 Python `ast.literal_eval` 安全還原的字面值位置／關鍵字參數，才會傳入 dynamic tracer；追蹤器同時支援這種 args／kwargs 格式。
- Tier 4 Self-repair 補上與生成器、Reviewer 相同的 Python／unittest 格式閘門。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、13 個 TypeScript 單元測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### 生成驗證、AST 語境與專案維護規範

- 新增 `PROJECT_RULES.md`、`AUTO_MAINTENANCE.md` 與本中文變更紀錄；規定每個已驗證改動必須更新 Log 並建立中英文 commit。
- 測試生成結果現在必須通過 unittest 結構檢查與 Python AST 解析，Markdown／說明文字不可再寫入測試檔；格式錯誤會以嚴格輸出要求重試。
- Reviewer 使用相同驗證規則，避免說明文字覆寫有效測試；Tier 1 會保留動態追蹤的 Python 字串 repr，修正額外引號造成的錯誤斷言。
- AST 提取新增完整 imports、被引用模組常數、類別基底、類別屬性及 `__init__` 初始化資料；屬性呼叫也會被識別。
- 呼叫站搜尋以目標模組與匯入別名確認，避免不同模組同名函式污染語境；動態追蹤移除業務領域關鍵字，改採型別註解與通用候選值。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、13 個 TypeScript 單元測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### Cloud Gemini 憑證欄位分離

- 改為儲存 API Key 名稱、API Model、API Key 三個欄位，名稱不再被用作模型 ID。
- 儲存完成後清空三個輸入欄位，且不將 API Key 回傳至 Webview。
- 舊版 `{ 名稱: Key }` 資料可讀取；建議重新儲存以補上明確模型名稱。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、9 個單元測試、完整建置、Git diff 檢查。
- Commit：`a5af175`。

### Google API 與突變工具相容性

- Google API Key 改走 HTTP Header，並可由 SecretStorage 或 CI 環境變數取得。
- 依 Python／平台選擇可用突變引擎，避免 Windows + Python 3.12 以上錯誤執行不相容工具。
- 驗證：型別、Lint、單元測試、建置及 Python 相依性檢查。
- Commit：`7961b8c`。

### 語意策略與技能卡基礎

- 加入語意分析策略、技能卡庫與相關提示詞調整。
- 驗證：型別、Lint、Git diff 檢查。
- Commit：`9a6af74`。
