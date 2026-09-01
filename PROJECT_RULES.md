# 專案執行規則

本文件是本專案自動化測試系統的長期約束；程式、提示詞、測試與維護工作都必須遵守。

## 通用性與語境

- `python_scripts/dynamic_tracer.py`、`python_scripts/ast_extractor.py` 與基礎提示詞不得硬編碼任何業務領域關鍵字、固定閾值或特定回傳結構。
- 領域特化必須由 Semantic Analyzer 根據目標原始碼選取 Skill Cards；不得把某個專案的規則帶進其他專案。
- 產生測試前必須保留必要的語境：目標函式、imports、引用的模組常數、類別與 `__init__`、相依函式、呼叫站與動態追蹤結果。
- 呼叫站搜尋必須以目標模組／匯入關係確認，不得只依同名函式全域比對。
- 動態追蹤執行目標函式時，必須對目標函式的 stdout 與 stderr 進行重定向隔離，確保追蹤輸出永遠為純淨 JSON，不受目標程式碼中的 print 或日誌干擾。
- 含記憶體位址、循環結構、非有限數值或遭截斷 repr 的 Trace 結果僅能作為診斷語境，不得轉換為 Tier 1 或 LLM 的精確 assertion oracle。

## 測試生成安全

- LLM 回應必須先通過 unittest 結構檢查與 Python AST 解析，才可寫入 `loop*_test.py`。
- 生成、Reviewer 與 Self-repair 的目標函式呼叫必須符合 AST 擷取的簽名；未知 keyword 或過多 positional 引數只允許用於明確的 `assertRaises(TypeError)` 行為測試。
- Markdown、分析文字、空內容、原始碼複製或沒有 `test_` 方法的內容均不可當作測試檔。
- Reviewer 與 Self-repair 必須使用相同驗證規則；失敗回應只能寫入報告，不可覆寫有效測試。
- Reviewer 與 Self-repair 階段必須提供與生成端同等完整度的語境（目標原始碼、引用常數、Class 定義與真實 Trace 數據），禁止在缺乏常數與依賴定義的狀態下進行盲目修復。
- 涉及外部模組副作用或跨模組返回值測試時，必須使用標準的 `unittest.mock.patch`；嚴禁透過竄改本地變數進行無效的偽 Mock。
- 動態追蹤只提供可呼叫性的基礎 I/O 事實；複雜邊界與多分支策略由 Semantic Analyzer 產生。
- 相依函式的具體回傳值與例外類型，只有在 Python Dynamic Trace 驗證後才可作為測試事實；模型的語意推論只能當作策略建議，缺乏事實時應依原始碼或 `mock.patch` 處理。

## 憑證與外部服務

- API Key 只能放在 VS Code SecretStorage、CI Secret 或執行環境變數；禁止寫入原始碼、設定檔、報告與 Git。
- Google API Key 必須走 HTTP Header，不可放入 URL。
- Cloud 設定需分開保存「名稱、模型、Key」；名稱不可被當成模型 ID。

## 品質、Git 與紀錄

- 每個可交付改動都必須通過相應測試、型別檢查、靜態檢查與建置檢查。
- 每次完成並驗證後都必須建立一次本機 Git commit；commit subject 必須同時包含英文與繁體中文。
- 每個 commit 必須同步更新 `CHANGELOG.zh-TW.md`，以中文寫明改動、驗證方式與已知限制。
- 不得推送至 GitHub、變更 Git remote 或使用／揭露使用者提供的密鑰，除非使用者明確授權。
