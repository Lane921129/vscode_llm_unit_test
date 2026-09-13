# 模型角色

本目錄是角色的唯一正式入口。整體流程與 Python 工具請從 [專案閱讀入口](../../ARCHITECTURE.md) 查看。

| 角色 | 時機與職責 | 正式實作 | 輸出 |
|---|---|---|---|
| 語意分析師 | 生成前理解目標、相依與待測情境；不選技能 | [semanticAnalyzer.ts](semanticAnalyzer.ts) | 情境與證據假設 JSON |
| Writer | 根據證據寫測試，或根據審查意見修改 | [unittestWriter.ts](unittestWriter.ts) | 完整 Python unittest |
| Reviewer | 只檢查測試，區分阻擋問題與品質缺口 | [testReviewer.ts](testReviewer.ts) | 附原文證據的問題清單 |
| Bug Fixer | 根據實際執行失敗修復測試 | [bugFixer.ts](bugFixer.ts) | 必要修正後的完整 unittest |
| 品質分析師 | 執行通過後，根據覆蓋／突變結果規劃下一輪 | [qualityAnalyst.ts](qualityAnalyst.ts) | 最多三個待驗證任務 |

這是五個任務入口，可以共用同一個模型；語意分析與品質分析分別在生成前後工作。Validation 是工具階段，不是另一個模型角色。

- 改「角色被要求做什麼」：找該檔案的 System Prompt。
- 改「角色看到什麼」：找 User Prompt；Reviewer 與品質分析的輸入組裝在 orchestrator 中。
- 改「回應如何被接受」：找該角色的 parser，以及 [候選流程](../pipeline/testCandidatePipeline.ts)。Writer／Bug Fixer 的 Python 回應由共用結構與執行驗證處理。
- 改「技能選什麼」：找 [skillDispatcher.ts](../pipeline/skillDispatcher.ts)，共用規則在 [promptSkillLibrary.ts](../prompts/promptSkillLibrary.ts)。

`legacy/mutantTriage.ts` 只保留舊格式處理，不在正式流程中啟動，也不是第六個角色。
