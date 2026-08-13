# 🗺️ LLM Unit Test — 全面實作計畫

> **基於完整專案分析，涵蓋 7 大需求方向**
> **最後更新**: 2026-07-15

---

## 專案現況總覽

### ✅ 已完成的核心功能

| 模組 | 狀態 | 說明 |
|------|------|------|
| VS Code 擴充套件框架 | ✅ 完成 | 側邊欄 Webview、指令註冊、設定管理 |
| LLM 整合 | ✅ 完成 | Ollama (Local)、Gemini (Cloud)、Custom (OpenAI 相容) |
| AST 靜態解析 | ✅ 完成 | Python `ast` 模組提取函式特徵 |
| 突變測試引擎 | ✅ 完成 | mutatest (Windows) / mutmut (備用) |
| 多輪迭代迴圈 | ✅ 完成 | 最多 N 輪，直到突變分數 100% |
| 動態焦點上下文 | ✅ 完成 | 存活變異體附近程式碼片段聚焦 |
| 防錯與重試機制 | ✅ 完成 | LLM 重試、超時控制、格式救援、中止測試 |
| 批次測試 | ✅ 完成 | 掃描目錄內所有 .py 檔案自動測試 |
| 覆蓋率表格 | ✅ 完成 | 即時顯示突變分數、狀態、批次刪除 |

### ⚠️ 已知問題

| # | 問題 | 影響 |
|---|------|------|
| 1 | `srcArgCount` 和 `resolvedFunc` 已計算但未使用（死碼） | 程式碼品質 |
| 2 | 部分中文註解出現亂碼 | 可讀性 |
| 3 | 中止功能僅支援 Windows（`taskkill`） | 跨平台相容 |
| 4 | 無正式自動化測試套件（有 devDep 但無 .test.ts） | 品質保證 |
| 5 | README 提及 MutPy/pytest，但程式碼使用 mutatest/unittest | 文件不一致 |
| 6 | requirements.txt 與 README 安裝指引不一致 | 使用者困惑 |
| 7 | 全域可變狀態阻止並行執行 | 穩定性 |
| 8 | AST 只能偵測直接函式呼叫，無法偵測方法呼叫 | 分析精度 |

---

## 需求 1：量化弱點生成 — 分析方式與 Matrix

### 問題描述
目前系統只產出一個「突變分數 (Mutation Score)」百分比，缺乏對「弱點分佈」的量化視覺化與深度分析。使用者無法快速理解：哪些程式碼區域最脆弱？哪些突變算子最難殺死？

### 提案

#### 1.1 突變算子矩陣 (Mutation Operator Matrix)
建立一個 **算子 × 檔案/函式** 的矩陣表格：

| 算子 | add.py | gcd.py | utils.py |
|------|--------|--------|----------|
| `+ → -` | ✅ 已殺 | ❌ 存活 | ✅ 已殺 |
| `+ → *` | ✅ 已殺 | ✅ 已殺 | ❌ 存活 |
| `> → >=` | ❌ 存活 | ✅ 已殺 | — |
| `return x → return None` | ✅ 已殺 | ❌ 存活 | ✅ 已殺 |

#### 1.2 弱點熱力圖 (Weakness Heatmap)
- 解析每個存活變異體的**行號與列號**
- 在 Summary 報告中生成一個「熱力分佈」，標示程式碼中哪些行/區段的變異體最難殺死

#### 1.3 對比指標 (Comparison Metrics)
在每輪迭代後追蹤以下指標的變化趨勢：

| 指標 | 說明 |
|------|------|
| Mutation Score (%) | 突變分數 |
| Killed / Total | 殺死數 / 總變異體數 |
| Survived by Operator | 各算子存活分佈 |
| Test Case Count | 生成的測試案例數量 |
| Avg Kill Rate per Round | 每輪平均殺死率 |

#### 1.4 實作位置
- **`extension.ts`**：在解析突變結果時，額外提取算子類型與行號
- **`webviewContent.ts`**：新增「分析儀表板」區塊，渲染矩陣表格
- **`Summary.md`**：在報告中新增 Metrics 區段

---

## 需求 2：Prompt 優化完成標準

### 問題描述
目前提示詞 (Prompt) 的優化缺乏明確的「完成定義」。需要建立一套可量化的評估標準。

### 提案：Prompt 品質基準線

#### 2.1 量化指標

| 指標 | 目標值 | 測量方式 |
|------|--------|----------|
| **首輪有效率** | ≥ 80% | LLM 第一次呼叫就產出有效 unittest 的比例 |
| **救援觸發率** | ≤ 10% | 需要 `rescueToUnittest()` 介入的比例 |
| **重試觸發率** | ≤ 15% | 需要重新呼叫 API 的比例 |
| **首輪突變分數** | ≥ 40% | 第一輪測試的平均突變分數 |
| **三輪收斂率** | ≥ 70% | 三輪內突變分數達 80%+ 的比例 |
| **格式錯誤率** | ≤ 5% | AI 輸出無法解析為任何測試的比例 |

#### 2.2 驗證基準測試集 (Benchmark Suite)
建立一組標準化的 Python 函式作為「基準測試」：

| 難度 | 範例函式 | 預期行為 |
|------|----------|----------|
| 簡單 | `add(a, b)` | 3 輪內 100% |
| 中等 | `gcd(a, b)` | 3 輪內 ≥ 80% |
| 複雜 | `sort_linked_list(head)` | 5 輪內 ≥ 60% |
| 邊界 | `divide(a, b)` (含除零) | 3 輪內 ≥ 70% |

#### 2.3 實作方式
- 新增 `test/benchmark/` 目錄存放基準函式
- 新增自動化腳本執行全部基準測試並統計指標
- 每次修改 Prompt 後重跑基準測試，對比前後差異

---

## 需求 3：API 測試

### 問題描述
目前三種 API 環境（Local/Cloud/Custom）沒有任何自動化測試。連線失敗、格式不對、金鑰過期等問題只能在實際測試時才發現。

### 提案

#### 3.1 API 連線測試 (Connection Test)
在 UI 中新增「🔗 測試連線」按鈕：
- **Local**：`GET http://127.0.0.1:11434/api/tags` → 確認 Ollama 運作中
- **Cloud**：發送一個最小化的 Gemini 請求 → 確認 API Key 有效
- **Custom**：發送一個最小化的 Chat Completion 請求 → 確認端點可達

#### 3.2 自動化單元測試
使用 Mocha + VS Code Test 框架建立正式的測試套件：

| 測試範圍 | 測試內容 |
|----------|----------|
| `sanitizeLlmResponse()` | 各種 Markdown 格式的程式碼區塊解析 |
| `rescueToUnittest()` | REPL 格式、裸 assert、混合格式的轉換 |
| `parseMutatestSurvived()` | ANSI 色碼清除、存活變異體提取 |
| `parseMutmutSurvived()` | mutmut 格式解析 |
| `extractFocusContext()` | 焦點上下文的行號提取與程式碼片段擷取 |
| `getSystemPrompt()` | 不同輪次的提示詞生成 |
| `getUserPrompt()` | AST 上下文 / 焦點模式的切換 |

#### 3.3 實作位置
- **`src/test/`**：建立 `extension.test.ts`、`promptProvider.test.ts` 等測試檔
- **`webviewContent.ts`**：新增連線測試按鈕
- **`SidebarProvider.ts`**：處理 `testConnection` 訊息

---

## 需求 4：專案讀取測試

### 問題描述
目前擴充套件在「批次測試」模式下會遞迴掃描整個目錄，但缺乏對更複雜的專案結構的支援，例如：多層目錄、虛擬環境排除、`__init__.py` 模組結構、大型專案效能等。

### 提案

#### 4.1 改善專案掃描
- 支援 `.gitignore` 規則的排除邏輯
- 新增 `llmUnitTest.excludePatterns` 設定項，讓使用者自訂排除路徑
- 顯示掃描進度（檔案數量、預估時間）

#### 4.2 專案結構感知
- 偵測 `setup.py` / `pyproject.toml` 來判斷專案根目錄
- 自動設定 `PYTHONPATH` 以支援相對 import
- 處理 `__init__.py` 的模組路徑解析

#### 4.3 整合測試
- 準備不同規模的測試專案：單檔 → 小型套件 → 中型專案
- 驗證掃描結果的完整性與正確性

---

## 需求 5：說明文件

### 狀態：✅ 已完成

已生成 `target/project_overview.md`，包含：
- 專案概述與工作流程圖
- 完整目錄結構與每個檔案的職責
- 四個核心 TypeScript 模組的詳細說明
- Python AST 解析器的輸入/輸出格式
- 外部工具依賴清單
- 快速初始化指南
- 設定項目一覽表
- 資料流架構圖

---

## 需求 6：Few-Shot Prompt 強化生成效率

### 問題描述
目前的 System Prompt 只包含一個簡單的 `add()` 範例。小模型（2B）經常：
1. 輸出原始碼修改方案而非測試（鬼打牆）
2. 使用錯誤的測試框架（pytest）
3. 產生 REPL 格式或裸 assert
4. 重複輸出相同內容

### 提案：分層 Few-Shot 範例策略

#### 6.1 基礎 Few-Shot（3 組固定範例）

| 範例 | 涵蓋場景 | 教學重點 |
|------|----------|----------|
| `add(a, b)` | 簡單算術 | assertEqual、邊界值（0, 負數） |
| `divide(a, b)` | 例外處理 | assertRaises、ZeroDivisionError |
| `is_palindrome(s)` | 字串處理 | assertTrue/assertFalse、空字串、特殊字元 |

#### 6.2 動態 Few-Shot（根據 AST 特徵選擇）

根據目標函式的 AST 特徵，動態選擇最相關的範例：

| AST 特徵 | 匹配範例 |
|----------|----------|
| 含有 `if/else` 分支 | 分支覆蓋範例 |
| 含有迴圈 (`for`/`while`) | 迴圈邊界範例 |
| 含有 `try/except` | 例外處理範例 |
| 參數含有 `List`/`Dict` | 集合操作範例 |
| 含有遞迴呼叫 | 遞迴終止條件範例 |

#### 6.3 存活變異體專屬 Few-Shot（第 2+ 輪）

當有存活變異體時，動態注入「如何殺死特定突變算子」的範例：

```
突變算子 `+ → -`（算術替換）：
原始: return a + b
突變: return a - b
殺死方式: self.assertEqual(add(3, 5), 8)  # 3-5=-2 ≠ 8，突變被殺
錯誤方式: self.assertEqual(add(0, 0), 0)  # 0-0=0 = 0，突變存活！
```

#### 6.4 實作位置
- **`src/promptProvider.ts`**：重構 `getSystemPrompt()` 和 `getUserPrompt()`
- **新增 `src/fewShotExamples.ts`**：存放所有 Few-Shot 範例模板
- **`python_scripts/ast_extractor.py`**：擴充提取 `if/for/while/try` 結構特徵

---

## 需求 7：多國語言 (i18n) 支援

### 問題描述
目前所有 UI 文字、提示詞、錯誤訊息都是硬編碼的繁體中文。要支援不同國家語言的使用者，需要建立國際化架構。

### 提案

#### 7.1 i18n 架構

```
src/
├── i18n/
│   ├── index.ts          # i18n 管理器（語言偵測、翻譯函式）
│   ├── zh-TW.json        # 繁體中文（預設）
│   ├── en.json            # 英文
│   ├── ja.json            # 日文
│   └── zh-CN.json         # 簡體中文
```

#### 7.2 實作方式

1. **建立翻譯函式** `t(key: string, ...args: any[]): string`
2. **語言偵測**：
   - 優先讀取 `llmUnitTest.language` 設定
   - 其次讀取 VS Code 的 `vscode.env.language`
   - 預設 `zh-TW`
3. **替換所有硬編碼字串**：
   - UI 文字 → `t('ui.runButton')`
   - 日誌訊息 → `t('log.astParsing', funcName)`
   - 錯誤訊息 → `t('error.emptyResponse')`
4. **提示詞 i18n**（需要注意！）：
   - System Prompt 可能需要保持「英文」才能獲得最佳效果
   - 或根據模型類型選擇語言：英文模型用英文 Prompt、中文模型用中文 Prompt

#### 7.3 影響範圍

| 檔案 | 需修改內容 |
|------|-----------|
| `webviewContent.ts` | 所有 UI 標籤、按鈕文字、placeholder |
| `extension.ts` | 所有 `log()` 訊息、錯誤訊息 |
| `promptProvider.ts` | System/User Prompt 模板 |
| `SidebarProvider.ts` | 資料夾選擇器標籤、通知訊息 |
| `package.json` | 新增 `llmUnitTest.language` 設定項 |

---

## 開發里程碑

### Phase 1：穩固基礎（短期，1-2 週）

| 優先序 | 項目 | 對應需求 |
|--------|------|----------|
| P0 | 建立自動化測試套件 | 需求 3 |
| P0 | 修復 README 與 requirements.txt 不一致 | 已知問題 |
| P0 | 清理死碼與亂碼註解 | 已知問題 |
| P1 | 新增 API 連線測試按鈕 | 需求 3 |
| P1 | 說明文件完成 | 需求 5 ✅ |

### Phase 2：效能提升（中期，2-4 週）

| 優先序 | 項目 | 對應需求 |
|--------|------|----------|
| P0 | 實作 Few-Shot Prompt 策略 | 需求 6 |
| P1 | 建立 Prompt 品質基準測試集 | 需求 2 |
| P1 | 突變算子矩陣與弱點分析 | 需求 1 |
| P2 | 改善專案掃描與 PYTHONPATH | 需求 4 |

### Phase 3：擴展功能（長期，4-8 週）

| 優先序 | 項目 | 對應需求 |
|--------|------|----------|
| P1 | 多國語言 i18n 架構 | 需求 7 |
| P2 | 弱點熱力圖視覺化 | 需求 1 |
| P2 | 大型專案效能優化 | 需求 4 |
| P3 | 跨平台中止支援 (Linux/macOS) | 已知問題 |

---

## 驗證計畫

### 自動化測試
```bash
# 執行擴充套件單元測試
npm test

# 執行 Prompt 基準測試
node test/benchmark/run_benchmark.js
```

### 手動驗證
1. **API 連線**：分別測試 Local/Cloud/Custom 三種環境的連線按鈕
2. **Few-Shot 效果**：對比啟用前後的首輪有效率與突變分數
3. **i18n**：切換語言後確認所有 UI 文字正確切換
4. **批次測試**：使用包含子目錄的專案測試掃描功能
