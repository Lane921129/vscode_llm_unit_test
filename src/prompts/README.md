# 共用提示素材

五個模型角色的實作都在 [src/roles](../roles/README.md)。此處只放共用素材：測試生成規則、提示詳略、範例等，不再用轉發檔重複角色入口。

測試生成規則由 [testRuleDispatcher](../pipeline/testRuleDispatcher.ts) 在分析師完成後依來源碼與 AST 確定性選取；分析師不閱讀整份規則目錄，也不選取 ID。完整閱讀路線見 [ARCHITECTURE.md](../../ARCHITECTURE.md)。

26 項規則文字、用途及版本集中在 [skills](../../skills/README.md)，每項一個 `.txt`；此處的 `testRuleLibrary.ts` 僅保留來源選取及格式化。資料庫／HTTP 可使用同源 AST 模組 factory／alias 事實選卡；固定的 fixture 安排導航先於完整來源契約交付，不額外呼叫模型，也不產生測值或批准。
