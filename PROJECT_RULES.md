# 專案執行規則

本文件是本專案自動化測試系統的長期約束；程式、提示詞、測試與維護工作都必須遵守。

## 通用性與語境

- `python_scripts/dynamic_tracer.py`、`python_scripts/ast_extractor.py` 與基礎提示詞不得硬編碼任何業務領域關鍵字、固定閾值或特定回傳結構。
- 領域特化必須由 Semantic Analyzer 根據目標原始碼選取 Skill Cards；不得把某個專案的規則帶進其他專案。
- 產生測試前必須保留必要的語境：目標函式、imports、引用的模組常數、類別與 `__init__`、相依函式、呼叫站與動態追蹤結果。
- 生成、Mock Scaffold、Reviewer 與救援程式必須使用同一個可匯入的目標模組路徑；不得以檔名匯入而建立與 package 模組不同的第二個模組實例。
- 呼叫站搜尋必須以目標模組／匯入關係確認，不得只依同名函式全域比對。
- 動態追蹤執行目標函式時，必須對目標函式的 stdout 與 stderr 進行重定向隔離，確保追蹤輸出永遠為純淨 JSON，不受目標程式碼中的 print 或日誌干擾。
- Dynamic Trace 不得執行被測模組的檔案寫入、刪除、子程序、shell 或網路副作用；被阻擋的操作只能列為診斷，不得轉化為 LLM 的例外 assertion 事實。
- 含記憶體位址、循環結構、非有限數值或遭截斷 repr 的 Trace 結果僅能作為診斷語境，不得轉換為 Tier 1 或 LLM 的精確 assertion oracle。

## 測試生成安全

- LLM 回應必須先通過 unittest 結構檢查與 Python AST 解析，才可寫入 `loop*_test.py`。
- 結構驗證必須接受可追溯的合法匯入別名，但不得允許測試碼重新定義被測函式或其匯入別名。
- 結構驗證必須確認 assertion 直接驗證目標呼叫、目標的回傳值，或 `assertRaises` 區塊中的目標例外；不得將無關 assertion 視為行為測試。
- 生成測試不得直接啟動 shell／子程序、直接連網、直接檔案 I/O、動態執行程式碼或做破壞性檔案操作；外部行為必須使用 `unittest.mock.patch`／`mock_open` 模擬。
- 生成、Reviewer 與 Self-repair 的目標函式呼叫必須符合 AST 擷取的簽名；未知 keyword 或過多 positional 引數只允許用於明確的 `assertRaises(TypeError)` 行為測試。
- 上述簽名規則同樣適用於被測函式的合法匯入別名，不得因 alias 而略過驗證。
- Markdown、分析文字、空內容、原始碼複製或沒有 `test_` 方法的內容均不可當作測試檔。
- Reviewer 與 Self-repair 必須使用相同驗證規則；失敗回應只能寫入報告，不可覆寫有效測試。
- Reviewer 與 Self-repair 階段必須提供與生成端同等完整度的語境（目標原始碼、引用常數、Class 定義與真實 Trace 數據），禁止在缺乏常數與依賴定義的狀態下進行盲目修復。
- 涉及外部模組副作用或跨模組返回值測試時，必須使用標準的 `unittest.mock.patch`；嚴禁透過竄改本地變數進行無效的偽 Mock。
- 動態追蹤只提供可呼叫性的基礎 I/O 事實；複雜邊界與多分支策略由 Semantic Analyzer 產生。
- Dynamic Trace 可使用受限、語法／型別中立的數值尺度組合作為探索輸入，但任何測試 oracle 都必須來自實際執行結果；不得將探索值或結果解讀為特定領域規則。
- 相依函式的具體回傳值與例外類型，只有在 Python Dynamic Trace 驗證後才可作為測試事實；模型的語意推論只能當作策略建議，缺乏事實時應依原始碼或 `mock.patch` 處理。
- 突變分數必須以相同隔離匯入環境下可通過的原始 unittest baseline 為前提；baseline 失敗不得計算 killed mutant 或宣稱高品質分數。

## 憑證與外部服務

- API Key 只能放在 VS Code SecretStorage、CI Secret 或執行環境變數；禁止寫入原始碼、設定檔、報告與 Git。
- Google API Key 必須走 HTTP Header，不可放入 URL。
- Cloud 設定需分開保存「名稱、模型、Key」；名稱不可被當成模型 ID。
- 模型 unittest 生成資格必須以無副作用的最小 fixture 在 isolated Python 中實際執行為準；不可僅根據 HTTP 成功或文字結構標記為可用。
- 尚未完成「測試連線」的 provider／model 視為尚未驗證，必須先使用有真實 Dynamic Trace 的 Tier 1；只有同一 provider／model 通過可執行 unittest 探測後，才可使用 Tier 2–4。測試連線應一併讀取供應商可提供的參數量與 Context，但兩者不可取代可執行性驗證。
- 未驗證模型的 Tier 1 僅可產生完全由 assertable Dynamic Trace 推導的測試；Trace 不足或無法安全建構類別實例時必須停止並說明原因，禁止暗中退回 LLM 生成。

## 品質、Git 與紀錄

- 每個可交付改動都必須通過相應測試、型別檢查、靜態檢查與建置檢查。
- 每次完成並驗證後都必須建立一次本機 Git commit；commit subject 必須同時包含英文與繁體中文。
- 每個 commit 必須同步更新 `CHANGELOG.zh-TW.md`，以中文寫明改動、驗證方式與已知限制。
- 不得推送至 GitHub、變更 Git remote 或使用／揭露使用者提供的密鑰，除非使用者明確授權。
