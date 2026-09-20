# 模型角色

本目錄是角色的唯一正式入口。整體流程與 Python 工具請從 [專案閱讀入口](../../ARCHITECTURE.md) 查看。

| 角色 | 時機與職責 | 正式實作 | 輸出 |
|---|---|---|---|
| 語意分析師 | 整合 AST、呼叫點與初始受控行為觀測，提出待測情境；不選規則 | [semanticAnalyzer.ts](semanticAnalyzer.ts) | 情境與證據假設 JSON |
| Writer | 根據合併證據包與程式選出的測試生成規則寫測試，或依 Reviewer 意見修改 | [unittestWriter.ts](unittestWriter.ts) | 完整 Python unittest |
| Reviewer | 隔離執行通過後檢查測試，區分阻擋問題與品質缺口 | [testReviewer.ts](testReviewer.ts) | `review-v7` 單一 findings 陣列，每項含 category、test_line、原因與具體動作；程式還原原文 |
| Bug Fixer | 根據可明確定位的實際測試失敗做單一方法修復 | [bugFixer.ts](bugFixer.ts) | `bug-fix-v4` 的單方法 Python fence，由管線合併回完整 unittest |
| 品質分析師 | 執行通過後，根據覆蓋／突變結果規劃下一輪 | [qualityAnalyst.ts](qualityAnalyst.ts) | 最多一個綁定實測證據 ID 的待驗證任務 |

這是五個任務入口，可以共用同一個模型；語意分析與品質分析分別在生成前後工作。Validation 是工具階段，不是另一個模型角色。

- 改「角色被要求做什麼」：找該檔案的 System Prompt。
- 改「角色看到什麼」：找 User Prompt；Reviewer 與品質分析的輸入組裝在 orchestrator 中。
- 改「回應如何被接受」：找該角色的 parser，以及 [候選流程](../pipeline/testCandidatePipeline.ts)。Writer／Bug Fixer 的 Python 回應由共用結構與執行驗證處理。
- 改「測試生成規則選什麼」：找 [testRuleDispatcher.ts](../pipeline/testRuleDispatcher.ts)，共用規則在 [testRuleLibrary.ts](../prompts/testRuleLibrary.ts)。

角色交接版本集中在 [roleContracts.ts](roleContracts.ts)。Reviewer 的阻擋問題、結構／證據錯誤、測試檔匯入與 fixture 失敗交給 Writer；可唯一定位的實際方法失敗才交給 Bug Fixer。模組載入失敗沒有測試方法時，禁止猜選第一個方法。Bug Fixer 的輸出在執行前會由 `validate_repair_scope.py` 檢查，避免改動通過或無關的測試。

三個角色共用 [targetContract.ts](../pipeline/targetContract.ts)，保留 class／static／property／instance 與 async 綁定。修復與審查包含完整目標來源、建構子、imports、globals、相依與真實觀測；預算不足時明示未完成，不截斷來源。Bug Fixer 另附該測試類別的 setup／teardown，仍只能替換失敗方法。

Reviewer 只有原文引述而缺少具體原因／動作時屬無效回覆；`focused correction` 等空泛指令不能形成 blocking。這個 parser 保證格式與引述來源，不代表模型意見已證明正確；執行、回歸、coverage 與 mutation gate 仍是驗證依據。

`legacy/mutantTriage.ts` 只保留舊格式處理，不在正式流程中啟動，也不是第六個角色。

`review-v7` 的 schema 與 parser 共用最多五項及七個分類；程式推導 blocking／quality，模型不可自行輸出 severity。`test_line` 必須引用本次候選的有效非空、非註解行；程式保存該行原文。舊 JSON 只供歷史讀取，正式請求與 `python-unittest-v5` 資格探針必須使用新契約。明確違反 target binding／目標自我 mock／來源修改規則的審查保持未完成；這些有界檢查仍不能證明任意模型意見正確。

品質分析使用 `quality-task-v3`：只接收一個程式選定的量測證據 ID、完整目標來源與目前測試，最多交付一項待執行情境。格式補正最多一次且共用原 deadline，傳輸錯誤或取消不啟動補正。歷史 `parseQualityTasks` 僅讀舊資料，正式流程使用 `requestFocusedQualityTask` 與 `parseFocusedQualityTask`。

Bug Fixer 只接受 unittest 明確列出的一個失敗方法，不能從 traceback 中的方法名猜測；多方法、fixture、匯入或定位不明交 Writer。修改範圍驗證保留其他方法、class 屬性、signature、decorator 與 fixture，新增 import 不得遮蔽原 binding。

Tier 3 的 scaffold 只是完整 Writer 語境中的 setup 指引；Writer 仍回傳完整測試檔並通過相同驗證。所有可執行候選先執行再審查，避免把 Reviewer 請求花在已知執行失敗的候選上。
