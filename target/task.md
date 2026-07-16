# 📋 LLM Unit Test — 任務進度追蹤表

> **最後更新**: 2026-07-15

---

## 🏗️ Phase 0：已完成項目

- [x] VS Code 擴充套件框架建置（側邊欄、指令、設定）
- [x] LLM 整合（Ollama / Gemini / Custom OpenAI 相容）
- [x] AST 靜態解析器（`python_scripts/ast_extractor.py`）
- [x] 突變測試引擎整合（mutatest / mutmut）
- [x] 多輪迭代迴圈（最多 N 輪，直到 100%）
- [x] 動態焦點上下文（存活變異體附近程式碼聚焦）
- [x] LLM 回覆重試機制（最多 2 次）
- [x] API 超時控制（`AbortController`）
- [x] 無效格式救援轉換（`rescueToUnittest`）
- [x] 使用者中止測試（`taskkill`）
- [x] 批次測試（掃描目錄內所有 .py）
- [x] 覆蓋率表格（勾選、批次刪除）
- [x] 跨專案自動清除覆蓋率
- [x] 系統日誌面板
- [x] API Key CRUD 管理
- [x] 提示詞禁止模型重寫原始碼
- [x] AST 解析結果直接寫入 Summary 報告（不再生成 JSON）
- [x] UTF-8 編碼強制處理（Windows）
- [x] AST 解析移出迴圈（避免重複日誌）
- [x] `requirements.txt` 建立

---

## 🔧 Phase 1：穩固基礎（短期）

### 已知問題修復
- [x] 清理死碼：`srcArgCount`、`resolvedFunc`（已計算但未使用）
- [ ] 修復原始碼中亂碼的中文註解
- [x] 同步 README 與 requirements.txt（README 提及 MutPy/pytest，程式碼用 mutatest/unittest）
- [ ] 修正 `.vscodeignore` 確保 `python_scripts/` 包含在 VSIX 中

### 需求 3：API 測試
- [x] 建立 `src/test/` 正式測試目錄
- [x] 撰寫 `sanitizeLlmResponse()` 單元測試
- [x] 撰寫 `rescueToUnittest()` 單元測試
- [x] 撰寫 `parseMutatestSurvived()` 單元測試
- [x] 撰寫 `parseMutmutSurvived()` 單元測試
- [ ] 撰寫 `extractFocusContext()` 單元測試
- [ ] 撰寫 `getSystemPrompt()` / `getUserPrompt()` 單元測試
- [x] 在 UI 新增「🔗 測試連線」按鈕（Local/Cloud/Custom）
- [x] 實作連線測試邏輯（SidebarProvider + extension）

### 需求 5：說明文件
- [x] 生成 `target/project_overview.md`（完整專案說明）
- [x] 生成 `target/implementation_plan.md`（實作計畫）
- [x] 生成 `target/task.md`（任務追蹤）
- [x] 更新 README.md 使之與實際程式碼一致
- [x] 更新 CHANGELOG.md 加入所有後續修改紀錄

---

## ⚡ Phase 2：效能提升（中期）

### 需求 6：Few-Shot Prompt 強化
- [x] 設計 3 組基礎 Few-Shot 範例（算術/例外/字串）
- [x] 新增 `src/fewShotExamples.ts` 範例模板檔
- [x] 重構 `getSystemPrompt()` 整合 Few-Shot
- [x] 設計動態 Few-Shot 選擇邏輯（根據 AST 特徵）
- [x] 設計存活變異體專屬 Few-Shot（第 2+ 輪）
- [ ] 擴充 `ast_extractor.py` 提取控制流特徵（if/for/while/try）

### 需求 2：Prompt 品質基準
- [ ] 建立 `test/benchmark/` 基準測試目錄
- [ ] 準備 4+ 個難度分級的基準 Python 函式
- [ ] 撰寫自動化基準測試腳本
- [ ] 定義 6 個量化指標（首輪有效率、救援率、重試率等）
- [ ] 執行第一次基準測試，建立 baseline

### 需求 1：量化弱點分析
- [ ] 擴充突變結果解析：提取算子類型（`ast.Add → ast.Sub` 等）
- [ ] 建立突變算子矩陣資料結構
- [ ] 在 Summary 報告中新增 Metrics 區段
- [ ] 在 Webview 覆蓋率表格中新增算子分佈欄位
- [ ] （進階）弱點熱力圖視覺化

### 需求 4：專案讀取測試
- [ ] 改善 `findPythonFilesInDir()` 支援 `.gitignore` 規則
- [ ] 新增 `llmUnitTest.excludePatterns` 設定項
- [ ] 自動偵測專案根目錄（`setup.py` / `pyproject.toml`）
- [ ] 自動設定 `PYTHONPATH` 以支援相對 import
- [ ] 處理 `__init__.py` 模組路徑解析
- [ ] 準備不同規模的測試專案驗證掃描功能

---

## 🌍 Phase 3：擴展功能（長期）

### 需求 7：多國語言 (i18n)
- [ ] 建立 `src/i18n/` 目錄與架構
- [ ] 實作翻譯函式 `t(key, ...args)`
- [ ] 建立語言偵測邏輯（設定 > VS Code 語言 > 預設）
- [ ] 建立 `zh-TW.json` 繁體中文語言包
- [ ] 建立 `en.json` 英文語言包
- [ ] 替換 `webviewContent.ts` 所有硬編碼字串
- [ ] 替換 `extension.ts` 所有 log/error 訊息
- [ ] 替換 `SidebarProvider.ts` 所有通知訊息
- [ ] 處理 `promptProvider.ts` 的 i18n（需考慮模型語言偏好）
- [ ] 新增 `llmUnitTest.language` 設定項

### 跨平台改善
- [ ] 實作 Linux/macOS 的中止測試支援（`kill` 指令）
- [ ] 移除 Windows 限定的 `chcp 65001`，改用跨平台編碼處理

### 進階功能
- [ ] 測試結果持久化（session 間保留進度）
- [ ] 支援 pytest 測試框架（除 unittest 外）
- [ ] 支援 Class 內方法測試（AST 擴充偵測 `self.method()`）
- [ ] 並行測試執行（解除全域可變狀態限制）

---

## 📊 進度統計

| 階段 | 已完成 | 待完成 | 完成率 |
|------|--------|--------|--------|
| Phase 0（核心功能） | 20 | 0 | 100% |
| Phase 1（穩固基礎） | 3 | 14 | 18% |
| Phase 2（效能提升） | 0 | 17 | 0% |
| Phase 3（擴展功能） | 0 | 14 | 0% |
| **總計** | **23** | **45** | **34%** |
