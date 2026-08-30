# 中文變更紀錄

本檔記錄每個已完成、已驗證並提交的專案改動；不記錄 API Key、Token 或其他密鑰。

## 2026-08-30

### 通用技能卡保底與進階測試能力

- 完整移除歷史遺留的業務領域 Few-shot，基礎範例只保留算術、例外與布林分支等通用 Python 行為。
- 擴充三張按需技能卡：非同步協程、檔案 I/O mock、固定時間；只依目標程式碼的語法／標準函式庫使用情況選取。
- Semantic Analyzer 正常運作時會與保守的語法級選卡合併；模型無法回傳語意 JSON 時仍注入保底技能卡，不會替任何特定專案或函式寫規則。
- 移除會把函式引數誤判為 tuple 回傳的保底推論，tuple 判斷繼續交由 AST／語意分析處理。
- 新增技能卡選擇回歸測試，確認 async、檔案與時間能力可被選取，且沒有除法時不會誤加除零規則。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、20 個 TypeScript 單元／端到端測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### Tier 1 端到端回歸測試

- 新增 Python `unittest` 端到端回歸：由 Tier 1 產生測試程式碼、載入相依函式並實際執行。
- 驗證精確字串回傳可正確斷言，避免再出現預期值被額外加引號而全部失敗的結果。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、18 個 TypeScript 單元／端到端測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### 基礎 Prompt 去領域污染

- 共用 Few-shot 僅保留通用的算術、例外與字串處理案例；舊專案領域案例不再注入任何模型 Prompt。
- Reviewer、Semantic Analyzer、技能卡與 Writer 的範例改為從實際函式簽章、原始碼與 AST 資料推導，不再預設特定欄位、模組或閾值。
- 新增回歸測試，禁止實際共用 Prompt 與啟用的基礎案例出現既有專案領域詞。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、17 個 TypeScript 單元測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### Tier 1 確定性測試生成

- Tier 1 不再請小模型補全 assertion；它直接根據已驗證的 dynamic trace 產生 `assertEqual`、`assertIsNone` 與 `assertRaises`。
- 修正模型即使回覆語法正確、但把字串多包一層引號時仍被接受的問題。
- 例外測試不再因 LLM 請求失敗而遺失，讓小模型、離線或不穩定連線仍能產出基本可執行測試。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、16 個 TypeScript 單元測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### Cloud／Local 結構化輸出與相容回退

- Google Cloud 生成測試時可要求受 JSON Schema 限制的 `{ "code": "..." }` 回應；回覆會在寫入前還原成 Python 程式碼並接受既有驗證。
- Semantic Analyzer 與突變分流師使用 JSON 輸出；本地 Ollama 對這類工作啟用 JSON mode。
- Cloud 或 Local 模型若以 HTTP 400 回報不支援結構化輸出，系統會自動回退至一般文字輸出，不會犧牲模型可用性。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、15 個 TypeScript 單元測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

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
