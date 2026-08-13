# 🔍 LLM Unit Test — 開發紀錄與現況總結

> **最後更新**: 2026-07-15

---

## 一、專案現況快照

| 維度 | 狀態 |
|------|------|
| **核心功能** | ✅ 完整可運作 — 四階段自精煉迴圈（AST → LLM → 突變測試 → 迭代）|
| **LLM 支援** | ✅ 三種環境 — Ollama (Local)、Gemini (Cloud)、OpenAI 相容 (Custom) |
| **防錯機制** | ✅ 重試、超時、格式救援、中止、CUDA OOM 偵測 |
| **UI** | ✅ VS Code 側邊欄 — 5 大區塊，覆蓋率表格，即時日誌 |
| **自動化測試** | ✅ 已建立核心單元測試（`core.test.ts`） |
| **文件** | ✅ README 已與實際程式碼同步 |
| **i18n** | ❌ 全繁體中文硬編碼 |
| **Prompt 效率** | ✅ 已加入分層 Few-Shot 範例與算子防護策略 |

---

## 二、已完成的重大修復紀錄

### 修復 1：AST 解析退回全域模式
- **原因**：`python_scripts/ast_extractor.py` 遺失
- **修復**：重新建立 AST 解析器，使用 Python `ast` 模組
- **Commit**：`fix: Implement missing AST extractor and add LLM retry mechanism for empty responses.`

### 修復 2：模型回傳空內容崩潰
- **原因**：LLM 回傳無效內容時直接拋出 Error
- **修復**：加入 2 次重試迴圈，印出原始回傳內容
- **Commit**：同上

### 修復 3：Windows AST 輸出亂碼
- **原因**：Windows 預設用 Big5 接收 Python 的 UTF-8 輸出
- **修復**：強制設定 `PYTHONIOENCODING=utf-8` 環境變數
- **Commit**：`fix: Force UTF-8 encoding for AST extraction and implement strict LLM fetch timeout.`

### 修復 4：API 超時未生效
- **原因**：使用者設定的超時秒數沒有綁到 `fetch` 請求
- **修復**：使用 `AbortController` + `setTimeout` 實作精準超時控制
- **Commit**：同上

### 修復 5：AST 報告重複（每輪都印一次）
- **原因**：AST 解析邏輯放在 while 迴圈內部
- **修復**：移到迴圈外，只執行一次
- **Commit**：`fix: Extract AST context outside of retry loop to prevent duplicate logging.`

### 修復 6：模型鬼打牆 + 無效佔位測試
- **原因**：`rescueToUnittest` 會幫無效輸出生成「一定會過」的假測試（`assertIsNotNone`）
- **修復**：移除佔位測試、將驗證移入重試迴圈
- **Commit**：`fix: Move unittest validation into LLM retry loop and remove weak fallback tests.`

### 修復 7：模型輸出原始碼修改方案而非測試
- **原因**：System Prompt 提及「分析改進空間」，小模型誤解為重寫原始碼
- **修復**：重寫 Prompt，新增第 9 條規則「嚴格禁止重寫目標程式碼」
- **Commit**：`fix: Refine system prompt to stop LLM from hallucinating source code rewrites.`

### 實作 8：多層次 Few-Shot Prompt 系統 (P0)
- **實作內容**：建立 `fewShotExamples.ts`，提供 3 組基礎範例（算術/例外/字串）、動態特徵範例（分支/迴圈/try-except），以及突變算子專屬殺死策略。
- **效果**：大幅降低小模型產生幻覺的機率，引導其撰寫邊界值測試。

### 實作 9：API 連線測試與核心單元測試 (P0)
- **實作內容**：在 UI 新增「測試連線」按鈕，支援 Local/Cloud/Custom 的即時網路診斷；新增 `src/test/core.test.ts` 涵蓋核心解析與轉換邏輯。
- **效果**：開發者修改程式碼後可快速回歸驗證，使用者可提前排除 API 連線問題。

---

## 三、技術架構分析

### 3.1 優勢

| 優勢 | 說明 |
|------|------|
| **零運行時依賴** | 所有 npm 依賴都是 devDependencies，esbuild 打包後為獨立 bundle |
| **多模型彈性** | 支援本機、雲端、自訂三種 LLM 環境 |
| **自精煉迴圈** | 存活變異體回饋機制形成閉環優化 |
| **動態焦點** | 聚焦存活變異體附近程式碼，避免注意力稀釋 |
| **漸進降級** | 無效輸出 → 救援轉換 → 重試 → 報錯，層層防護 |

### 3.2 待改善

| 問題 | 嚴重度 | 說明 |
|------|--------|------|
| 無自動化測試 | 🟢 已解決 | 已新增核心功能測試（`core.test.ts`） |
| Prompt 效率低 | 🟢 已解決 | 已實作 Few-Shot 動態範例系統 |
| README 不一致 | 🟢 已解決 | README 與 CHANGELOG 已更新 |
| 硬編碼中文 | 🟡 中 | 阻礙國際化推廣 |
| Windows 限定 | 🟡 中 | `taskkill`、`chcp 65001` 等 Windows 專用指令 |
| 死碼 | 🟢 已解決 | 已移除未使用的 `srcArgCount` 等變數 |
| AST 方法呼叫 | 🟢 低 | 只偵測直接函式呼叫，忽略 `obj.method()` |

---

## 四、七大需求的現況評估

| # | 需求 | 現況 | 難度 | 建議優先序 |
|---|------|------|------|-----------|
| 1 | 量化弱點分析 / Matrix | ❌ 未開始 — 目前只有單一突變分數 | 🟡 中 | P1 |
| 2 | Prompt 優化完成標準 | ❌ 未開始 — 無基準測試集 | 🟡 中 | P1 |
| 3 | API 測試 | ✅ 已完成 — 包含 UI 按鈕與單元測試套件 | 🟢 低 | ✅ Done |
| 4 | 專案讀取測試 | ⚠️ 基礎完成 — 掃描功能可用，但缺乏進階支援 | 🟡 中 | P2 |
| 5 | 說明文件 | ✅ 已完成 — `target/project_overview.md` | 🟢 低 | ✅ Done |
| 6 | Few-Shot Prompt | ✅ 已完成 — 實作動態多層次範例 | 🟢 低 | ✅ Done |
| 7 | 多國語言 i18n | ❌ 未開始 — 全硬編碼中文 | 🟡 中 | P3 |

### 建議執行順序

```
P0 (最優先)           P1 (中優先)          P2 (次優先)         P3 (長期)
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ 需求 6:       │    │ 需求 1:       │    │ 需求 4:       │    │ 需求 7:       │
│ Few-Shot      │ ─▶ │ 量化分析      │ ─▶ │ 專案讀取      │ ─▶ │ i18n          │
│ Prompt 強化   │    │ Matrix        │    │ 進階支援      │    │ 多國語言      │
├──────────────┤    ├──────────────┤    └──────────────┘    └──────────────┘
│ 需求 3:       │    │ 需求 2:       │
│ API 測試      │    │ Prompt 基準   │
│ 自動化測試    │    │ 測試集        │
└──────────────┘    └──────────────┘
```

**理由**：
- **Few-Shot (P0)**：直接影響使用者體驗，小模型生成效率太差會讓人放棄使用
- **API 測試 (P0)**：沒有自動化測試的專案無法安心迭代，是所有後續開發的基礎
- **量化分析 (P1)**：有了穩定的測試與高效的 Prompt 後，才有意義做深度分析
- **Prompt 基準 (P1)**：需要 Few-Shot 先完成，才能有效比較改進效果
- **專案讀取 (P2)**：功能已可用，只是缺乏邊界情況處理
- **i18n (P3)**：等核心功能穩定後再做，避免翻譯內容反覆修改
