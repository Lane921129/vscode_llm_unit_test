# 共用提示素材

五個模型角色的實作都在 [src/roles](../roles/README.md)。此處只放共用素材：測試生成規則、提示詳略、範例等，不再用轉發檔重複角色入口。

測試生成規則由 [testRuleDispatcher](../pipeline/testRuleDispatcher.ts) 在分析師完成後依來源碼與 AST 確定性選取；分析師不閱讀整份規則目錄，也不選取 ID。完整閱讀路線見 [ARCHITECTURE.md](../../ARCHITECTURE.md)。
