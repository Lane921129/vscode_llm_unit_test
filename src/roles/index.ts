/**
 * roles/index.ts
 * 任務 LLM（工作 AI 角色）核心入口
 *
 * 本專案中的 5 個核心工作 AI 角色：
 * 1. semanticAnalyzer - 語意分析師：分析目標原始碼、依賴、分支路徑與待驗證情境
 * 2. unittestWriter   - 測試撰寫師：依據證據與技能卡，產生單元測試代碼
 * 3. testReviewer      - 測試審查師：獨立審查測試品質與 Mock 正確性（只審查、不寫碼）
 * 4. bugFixer          - 錯誤修復師：測試執行報錯時，根據錯誤堆疊精準修復測試碼
 * 5. qualityAnalyst    - 品質分析師：突變測試後，分析存活變異體並提出下一輪突破任務
 */

export * from './semanticAnalyzer';
export * from './unittestWriter';
export * from './testReviewer';
export * from './roleContracts';
export * from './bugFixer';
export * from './qualityAnalyst';
