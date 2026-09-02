# 專案執行規則

本文件是本專案自動化測試系統的長期約束；程式、提示詞、測試與維護工作都必須遵守。

## 通用性與語境

- `python_scripts/dynamic_tracer.py`、`python_scripts/ast_extractor.py` 與基礎提示詞不得硬編碼任何業務領域關鍵字、固定閾值或特定回傳結構。
- 領域特化必須由 Semantic Analyzer 根據目標原始碼選取 Skill Cards；不得把某個專案的規則帶進其他專案。
- Prompt 詳細程度與 Tier 2 分治策略必須依已探測的參數量、Context 與已解析 Tier 決定；不得以供應商、模型品牌或名稱片段建立白名單／黑名單。
- Writer 的輸出契約必須對所有 provider、模型與 Tier 使用相同的純 Python code fence；包括 Tier 3 Scaffold、Tier 4 與 Self-repair。不得依模型名稱插入或移除 `<thinking>` 等分析標籤，以免分析文字混入可執行測試。
- 產生測試前必須保留必要的語境：目標函式、imports、引用的模組常數、類別與 `__init__`、相依函式、呼叫站與動態追蹤結果。
- `__init__` 語境只可包含建構子本體實際執行路徑中的 `self` 賦值；不得把巢狀 helper、lambda、內部類別的 `self` 賦值誤列為初始化狀態。
- 生成、Mock Scaffold、Reviewer 與救援程式必須使用同一個可匯入的目標模組路徑；不得以檔名匯入而建立與 package 模組不同的第二個模組實例。
- 呼叫站搜尋必須以目標模組／匯入關係確認，不得只依同名函式全域比對。
- 使用者選取 `Class.method` 時，AST、Dynamic Trace、Mock Scaffold、複雜度與突變測試必須全程解析為同一個明確類別成員；不得退回同名頂層函式或其他類別方法。
- `Class.method` 的呼叫站語境必須解析直接匯入、模組別名與明確 `Class(...).method(...)` 結構；建構子字面值與方法字面值必須分開傳遞，且不得把未能靜態驗證的實例呼叫當作目標證據。
- 函式選單、全檔案與批次掃描只能列出可獨立執行的頂層函式與直接 `Class.method`；不得把函式內局部 helper、巢狀類別或巢狀類別方法建立為分析任務。
- Tier 路由的複雜度評估只能根據 Python AST 結構與可解析的匯入／呼叫關係；不得以業務、資料庫、網路或檔案等名稱關鍵字推測風險。
- 動態追蹤執行目標函式時，必須對目標函式的 stdout 與 stderr 進行重定向隔離，確保追蹤輸出永遠為純淨 JSON，不受目標程式碼中的 print 或日誌干擾。
- Dynamic Trace 不得執行被測模組的檔案寫入、刪除、子程序、shell 或網路副作用；被阻擋的操作只能列為診斷，不得轉化為 LLM 的例外 assertion 事實。
- 含記憶體位址、循環結構、非有限數值或遭截斷 repr 的 Trace 結果僅能作為診斷語境，不得轉換為 Tier 1 或 LLM 的精確 assertion oracle。

## 測試生成安全

- LLM 回應必須先通過 unittest 結構檢查與 Python AST 解析，才可寫入 `loop*_test.py`。
- 結構驗證必須接受可追溯的合法匯入別名，但不得允許測試碼重新定義被測函式或其匯入別名。
- 結構驗證必須確認 assertion 直接驗證目標呼叫、目標的回傳值，或 `assertRaises` 區塊中的目標例外；不得將無關 assertion 視為行為測試。
- 行為驗證只能採用可執行的 Python 語句；註解、docstring、字串或 Markdown 中出現的目標函式與 assertion 文字不得視為測試證據。
- 生成測試不得直接啟動 shell／子程序、直接連網、直接檔案 I/O、動態執行程式碼或做破壞性檔案操作；外部行為必須使用 `unittest.mock.patch`／`mock_open` 模擬。
- 生成、Reviewer 與 Self-repair 的目標函式呼叫必須符合 AST 擷取的簽名；未知 keyword 或過多 positional 引數只允許用於明確的 `assertRaises(TypeError)` 行為測試。
- 上述簽名規則同樣適用於被測函式的合法匯入別名，不得因 alias 而略過驗證。
- Markdown、分析文字、空內容、原始碼複製或沒有 `test_` 方法的內容均不可當作測試檔。
- Reviewer 與 Self-repair 必須使用相同驗證規則；失敗回應只能寫入報告，不可覆寫有效測試。
- Reviewer 與 Self-repair 階段必須提供與生成端同等完整度的語境（目標原始碼、引用常數、Class 定義與真實 Trace 數據），禁止在缺乏常數與依賴定義的狀態下進行盲目修復。
- 涉及外部模組副作用或跨模組返回值測試時，必須使用標準的 `unittest.mock.patch`；嚴禁透過竄改本地變數進行無效的偽 Mock。
- 動態追蹤只提供可呼叫性的基礎 I/O 事實；複雜邊界與多分支策略由 Semantic Analyzer 產生。
- 已通過資格的 Tier 2–4 測試，對頂層函式必須保留所有可安全 assertion 的 Dynamic Trace I/O 方法；LLM 可以增加情境、Mock 與突變修補，但不得移除或覆寫已驗證的行為 oracle。
- Dynamic Trace 可使用受限、語法／型別中立的數值尺度組合作為探索輸入，但任何測試 oracle 都必須來自實際執行結果；不得將探索值或結果解讀為特定領域規則。
- 相依函式的具體回傳值與例外類型，只有在 Python Dynamic Trace 驗證後才可作為測試事實；模型的語意推論只能當作策略建議，缺乏事實時應依原始碼或 `mock.patch` 處理。
- 突變分數必須以相同隔離匯入環境下可通過的原始 unittest baseline 為前提；baseline 失敗不得計算 killed mutant 或宣稱高品質分數。

## 憑證與外部服務

- API Key 只能放在 VS Code SecretStorage、CI Secret 或執行環境變數；禁止寫入原始碼、設定檔、報告與 Git。
- Google API Key 必須走 HTTP Header，不可放入 URL。
- Cloud 設定需分開保存「名稱、模型、Key」；名稱不可被當成模型 ID。
- 模型 unittest 生成資格必須以無副作用的最小 fixture 在 isolated Python 中實際執行為準；不可僅根據 HTTP 成功或文字結構標記為可用。
- 尚未完成「測試連線」的 provider／model 視為尚未驗證，必須先使用有真實 Dynamic Trace 的 Tier 1；只有同一 provider／model 通過可執行 unittest 探測後，才可使用 Tier 2–4。測試連線應一併讀取供應商可提供的參數量與 Context，但兩者不可取代可執行性驗證。
- 測試連線的供應商發現與基本探針時限不得低於 30 秒；每一次結構化或純 Python unittest 資格生成必須有獨立、至少 60 秒的時限，禁止共用已消耗的 AbortController 而誤判慢速模型無法生成測試。
- 未驗證模型的 Tier 1 僅可產生完全由 assertable Dynamic Trace 推導的測試；Trace 不足或無法安全建構類別實例時必須停止並說明原因，禁止暗中退回 LLM 生成。
- 未驗證模型不得呼叫 LLM 語意分析師、Reviewer、Tier 4 修補或突變體分流師。若 deterministic Tier 1 仍有存活變異體，必須保留測試與報告後停止，不得以猜測性修補灌水分數。
- Stub/Dummy 快速通道只能依函式本體的結構（`pass` 或單一安全 literal 回傳）或函式名稱中明確的 `dummy` token 判定；不得依短小行數或複雜度分數略過具有可觀察行為的程式碼。`dummy` 是使用者標記的雜訊／佔位約定，不是業務領域關鍵字。
- 名稱含明確 `dummy` token 的使用者標記函式，必須在複雜度、AST、Dynamic Trace、LLM 與突變測試之前直接略過；報告須清楚標示略過原因，且不得生成未驗證的 Smoke Test。
- 覆蓋率儀表板的完成項目必須可直接開啟同一項的 `final_report.md`；開啟前需確認檔案存在且名稱正確，執行中項目不可假裝有可用報告。
- 報告的擴充功能追溯資料必須使用可攜的 extension ID、版本、建置識別與執行模式；不得寫入使用者帳號、絕對檔案路徑或工作目錄。
- 生成測試的預先驗證必須透過引數陣列、明確 `cwd` 與 `PYTHONPATH` 環境變數直接啟動 Python；不得依賴 `chcp`、`set`、`cd /d`、磁碟代號或 shell 字串串接。
- 原生突變引擎（`mutatest`／`mutmut`）同樣必須使用引數陣列、明確 `cwd` 與隔離 Python 環境；路徑不得內插至 shell 命令。突變工具的非零結束碼必須保留 stdout／stderr 供報告與後續修復判讀。
- 偵測到資料庫 driver 的函式必須以資料庫隔離技能卡生成測試：每個測試使用 mock、in-memory 或暫存資料庫；禁止碰觸預設／共享資料庫、猜測驗證例外，或裸用未匯入的私有連線 helper。
- 生成測試結構驗證必須拒絕非隔離的 SQLite 連線與未匯入／直接呼叫被測模組私有 helper；`sqlite3.connect(':memory:')` 與標準 `mock.patch` 得以保留。
- LLM 的 `assertRaises` 必須有目標函式 AST 明確 `raise`、可 assertion 的 Dynamic Trace 例外，或同一測試明確設定的 mock `side_effect` 作為事實依據；不得憑空猜測業務例外。簽名不符的 `TypeError` 測試依既有簽名閘門處理。
- Mock Scaffold 必須追蹤被測函式呼叫的同模組 side-effect helper；helper 若到達 imported I/O boundary，必須 patch helper 的 module use point，避免因只看目標函式本體而遺漏資料庫連線。
- 模型輸出可使用標準 Python／Py／未標記 code fence；系統只能擷取含 unittest 證據的單一程式碼區塊後進行結構與 AST 驗證，不得把 Markdown 說明當作測試程式。

## 品質、Git 與紀錄

- 每個可交付改動都必須通過相應測試、型別檢查、靜態檢查與建置檢查。
- 每次完成並驗證後都必須建立一次本機 Git commit；commit subject 必須同時包含英文與繁體中文。
- 每個 commit 必須同步更新 `CHANGELOG.zh-TW.md`，以中文寫明改動、驗證方式與已知限制。
- 不得推送至 GitHub、變更 Git remote 或使用／揭露使用者提供的密鑰，除非使用者明確授權。
