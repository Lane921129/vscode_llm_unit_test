# LLM Unit Test — 目前進度與後續任務

> 更新：2026-09-07。以目前程式碼與本機驗證為準；不再使用舊版 34% 完成率。
> 詳細修改與驗證見 [中文變更紀錄](../CHANGELOG.zh-TW.md)。歷史設計文件不代表當前功能缺陷清單。

## 目前階段

核心生成／驗證流程已具備，模組分層及已確認的執行缺陷已修復；下一階段是公開品質驗收與發行準備。目前套件版本仍為 0.0.1，不能視為 v1.0 已完成。

## 已具備的能力

| 面向 | 實作狀態 | 驗收界線 |
|---|---|---|
| 模型整合 | Ollama、Google AI Studio、OpenAI 相容 API；資格探測與格式回退 | 尚缺公開多模型實測矩陣 |
| 測試生成 | Tier 1–4、Auto、AST／Trace、技能卡、Mock Scaffold、Reviewer／修補 | 尚缺各 Tier 完整公開端到端驗收集 |
| Python 目標 | 頂層函式、直接 Class.method、必要建構子、property、async、generator | 不代表任意繼承、decorator 或間接 factory 都可解析 |
| 品質閘門 | 結構、目標行為、簽名、隔離執行、coverage、mutation baseline | 模型輸出仍需通過所有閘門 |
| 批次與中止 | 最多 3 個 worker、每次分析獨立取消與模型快照、唯一輸出 session | 真實桌面及跨平台操作尚待實測 |
| UI | 中英文架構、側邊欄設定、結果報告入口、公開中止／批次設定命令 | 尚未宣稱所有日誌均已翻譯 |
| CI | 已建立無雲端密鑰的測試、建置與歷史掃描流程 | 本次未查驗遠端 CI 執行結果 |

## 本次已完成

- [x] 固定 34 個模組搬移與引用修正的完整本機提交。
- [x] 裸 assert 以 Python AST 解析，修復複合布林與連鎖比較轉換；保留跨 assertion 的 setup。
- [x] 單次／批次命令無參數時開啟側邊欄設定，避免 undefined 參數錯誤。
- [x] Google／Custom 純文字探測失敗時回報正確的重試回應。
- [x] 抽出 ExecutionContext／ExecutionManager，阻擋舊任務的訊息、完成通知及取消後寫入。
- [x] 抽出 processRunner，統一 Python 行程的取消、timeout 與執行證據。
- [x] 修復 Webview 擷取腳本的來源、輸出位置與翻譯函式參數，加入正式 JavaScript 語法檢查。
- [x] 移除無效的 modelName／apiKeys 設定宣告與歷史 patch 腳本。
- [x] 將已追蹤的 Python 快取移出 Git，保留本機檔案。

## 本機驗證基準

- 149 個 TypeScript 測試及 60 個 Python 測試通過。
- 型別檢查、lint、extension 建置與 Git 差異格式檢查通過。
- Webview 實際生成的 JavaScript 語法通過；擷取腳本可從不同工作目錄執行。
- tracked files 與可達 Git 歷史的高可信格式密鑰掃描通過。
- 新增真實 Python 正反斷言、雙行程取消隔離，以及命令層中止後立即重跑的回歸測試。

上述自動化基準不等於真實雲端模型、VS Code GUI 或乾淨環境安裝驗收。

## 後續優先順序

### P0：公開品質驗收與發行準備

- [ ] 建立至少 12 個公開 Python fixture，定義各自可用 Tier、coverage、mutation 與不可接受的假測試。
- [ ] Tier 1–4 各建立至少 3 個完整端到端驗收案例及可重現報告。
- [ ] 建立至少 2 個 Ollama、1 個 Google、1 個 Custom 模型的實測矩陣。
- [ ] 在 VS Code 實測開始、中止、立即重跑、缺少憑證及失敗後恢復的 UI 行為。
- [ ] 確認遠端 CI 執行成功，完成 Windows／WSL 原生 mutation 驗收。
- [ ] 補 LICENSE、SECURITY、CONTRIBUTING、CODE_OF_CONDUCT 與 Issue／PR 模板。
- [ ] 建置 VSIX，在乾淨環境驗證 README 安裝流程，補版本與 Release Notes。

### P1：可維護性與品質量化

- [ ] 將單檔流程按語境蒐集、生成、驗證、突變與報告逐步拆分；避免只搬移整個大函式。
- [ ] 抽出 reportGenerator，以固定案例驗證階段失敗與 baseline／survived mutant 報告。
- [ ] 建立 Prompt 基準指標：首輪有效率、重試率、耗時、coverage、mutation 與失敗分類。
- [ ] 依驗收失敗案例補強 AST／Trace，維持可證明的目標綁定與資料流。
- [ ] 完成 i18n 殘留日誌與通知盤點。

### P2：擴充與維護

- [ ] 專案掃描支援 .gitignore、自訂 excludePatterns 與大型專案驗收。
- [ ] 突變算子矩陣、弱點熱力圖與跨次結果比較。
- [ ] pytest 專屬語法、結果持久化與更廣泛 Python 專案相容性。
- [ ] 需要磁碟空間時，關閉測試實例後清理 .vscode-test 下載快取。

## 提交流程

每個獨立改動完成相應驗證、更新中文變更紀錄，再建立中英雙語本機 commit。推送、Release 與 Marketplace 發布需另有明確授權。
