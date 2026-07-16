# 📖 LLM Unit Test — 專案說明文件

> **版本**: 0.0.1 (lane_edition)
> **最後更新**: 2026-07-15
> **技術棧**: TypeScript + Python + VS Code Extension API + esbuild

---

## 一、專案概述

本專案是一個 **VS Code 擴充套件**，結合 LLM（大型語言模型）與突變測試 (Mutation Testing) 技術，自動為 Python 原始碼生成高品質的單元測試。

### 核心工作流程（四階段自精煉迴圈）

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  1. 上下文擷取   │ ──▶ │  2. 智慧生成     │ ──▶ │  3. 弱點分析     │ ──▶ │  4. 迭代優化     │
│  AST 解析函式    │     │  LLM 生成測試    │     │  突變測試驗證    │     │  回饋存活變異體  │
│  特徵與依賴      │     │  unittest 程式碼  │     │  計算突變分數    │     │  加強 Assert     │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                                                 │
                                                                      ┌──────────▼──────────┐
                                                                      │  迴圈直到分數 100%   │
                                                                      │  或達到最大輪數上限   │
                                                                      └─────────────────────┘
```

---

## 二、目錄結構與檔案職責

```
vscode_llm_unit_test/
├── 📁 src/                          # TypeScript 原始碼（擴充套件核心）
│   ├── extension.ts                 # 擴充套件主入口 & 測試執行引擎
│   ├── SidebarProvider.ts           # VS Code 側邊欄 Webview 後端
│   ├── webviewContent.ts            # 側邊欄 UI（HTML/CSS/JS）
│   ├── promptProvider.ts            # LLM 提示詞模板管理
│   └── 📁 test/                     # VS Code 擴充套件測試（尚未建置）
│
├── 📁 python_scripts/               # Python 輔助腳本
│   └── ast_extractor.py             # AST 靜態解析器
│
├── 📁 dist/                         # esbuild 編譯輸出（不入版控）
│   └── extension.js                 # 編譯後的擴充套件
│
├── 📁 test/                         # 手動測試用的範例與工具腳本
│   ├── extract_script.js            # 從 webviewContent.ts 抽取前端 JS
│   ├── test_script.js               # 抽取後的 Webview 前端 JS
│   ├── test_webview.js              # Unicode 轉義版本
│   ├── patch.js                     # 功能遷移腳本（批次測試/中止功能）
│   ├── temp.js                      # webviewContent.ts 編譯中間產物
│   ├── 📁 test_mut/                 # mutatest 測試範例
│   │   ├── gcd.py                   # 範例函式（故意寫錯的 GCD）
│   │   ├── test_gcd.py              # 範例單元測試
│   │   └── report.rst               # 突變測試報告範例
│   └── 📁 test_mutmut/              # mutmut 測試範例
│       ├── gcd.py                   # 同上
│       └── test_gcd.py              # 同上
│
├── 📁 target/                       # 專案規劃與說明文件
│
├── package.json                     # VS Code 擴充套件設定與依賴
├── tsconfig.json                    # TypeScript 編譯設定
├── esbuild.js                       # 打包工具設定
├── eslint.config.mjs                # ESLint 程式碼風格設定
├── requirements.txt                 # Python 依賴清單
├── README.md                        # 專案說明（中英雙語）
├── CHANGELOG.md                     # 版本更新紀錄
├── .vscodeignore                    # VSIX 打包排除清單
└── .gitignore                       # Git 版控排除清單
```

---

## 三、核心檔案詳細說明

### 3.1 `src/extension.ts` — 擴充套件主入口 & 測試執行引擎

> **角色**：整個擴充套件的大腦，負責指揮所有測試流程。

| 函式 | 說明 |
|------|------|
| `activate()` | 擴充套件啟動點。註冊側邊欄、註冊三個指令（單一測試、批次測試、中止測試）|
| `deactivate()` | 擴充套件停用（目前為空） |
| `extractAstContext()` | 呼叫 Python AST 解析器，取得函式的參數、Docstring、依賴呼叫 |
| `sanitizeLlmResponse()` | 清洗 LLM 回傳內容，剝離 Markdown 程式碼區塊包裝 |
| `rescueToUnittest()` | **救援機制**：將 AI 輸出的非標準格式（REPL、裸 assert）自動轉換為 unittest |
| `parseMutatestSurvived()` | 解析 mutatest 輸出，提取存活變異體清單 |
| `parseMutmutSurvived()` | 解析 mutmut 輸出，提取存活變異體清單 |
| `executeSingleFileAnalysis()` | **核心迴圈**：LLM 呼叫 → 生成測試 → 預驗證 → 突變測試 → 解析結果 → 迭代 |
| `findPythonFilesInDir()` | 遞迴掃描目錄下所有 `.py` 檔案 |
| `extractFocusContext()` | **動態焦點上下文**：從存活的變異體中提取對應程式碼片段，供下一輪 LLM 聚焦 |

**支援的 LLM 環境**：
- **Local（Ollama）**：`http://127.0.0.1:11434/api/generate`
- **Cloud（Gemini）**：Google Generative AI API
- **Custom（OpenAI 相容）**：任意 OpenAI 格式端點

**防錯機制**：
- LLM 呼叫失敗自動重試（最多 2 次）
- API 超時控制（`AbortController`）
- 無效輸出格式救援轉換
- 使用者手動中止（`taskkill` 終止子程序）
- CUDA VRAM 不足偵測

---

### 3.2 `src/SidebarProvider.ts` — 側邊欄 Webview 後端

> **角色**：VS Code 與 Webview UI 之間的橋樑，處理所有訊息傳遞。

| 功能 | 說明 |
|------|------|
| 載入初始資料 | 從 VS Code 設定讀取 API Key、專案路徑、輸出路徑，掃描 Python 檔案 |
| 瀏覽資料夾 | 開啟原生資料夾選擇器（專案、輸出、批次目錄） |
| 函式解析 | 用正則表達式從 Python 檔案中提取函式名稱 |
| API Key 管理 | CRUD 操作：新增/編輯/刪除雲端與自訂 API 設定 |
| 啟動測試 | 轉發 UI 指令到 VS Code 指令系統 |
| Ollama 模型列表 | 從本機 Ollama 伺服器取得可用模型 |

**永久化狀態**（存在 VS Code 設定中）：
- `llmUnitTest.apiKeys` — 雲端 API 金鑰
- `llmUnitTest.customApiKeys` — 自訂 API 設定
- `llmUnitTest.projectPath` — 專案路徑
- `llmUnitTest.outputPath` — 輸出路徑

---

### 3.3 `src/webviewContent.ts` — 側邊欄 UI

> **角色**：生成完整的 HTML/CSS/JS 字串，渲染在 VS Code 側邊欄中。

**五大區塊**：

| # | 區塊 | 說明 |
|---|------|------|
| 1 | 🤖 模型與環境設定 | 切換 Cloud/Local/Custom 模式，管理 API Key |
| 2 | ⚙️ 基礎設定 | 專案路徑、輸出路徑、迴圈次數、超時秒數 |
| 3 | 🎯 單一測試目標 | 選擇檔案與函式，啟動/中止測試 |
| 4 | 📊 檔案覆蓋率與結果 | 批次測試路徑、覆蓋率表格（含勾選/批次刪除） |
| 5 | 📝 系統日誌 | 即時日誌輸出，支援清除 |

**特殊功能**：
- 跨專案自動清除：切換不同專案時自動清空覆蓋率表格
- 全選/批次刪除測試結果
- 測試中鎖定 UI（停用按鈕 + 顯示中止按鈕）

---

### 3.4 `src/promptProvider.ts` — LLM 提示詞模板

> **角色**：管理送給 LLM 的系統提示詞和使用者提示詞。

| 函式 | 說明 |
|------|------|
| `getSystemPrompt()` | 系統提示詞：定義 AI 角色、輸出格式規則（9 條嚴格限制）、正確範例 |
| `getUserPrompt()` | 使用者提示詞：包含目標檔名、AST 特徵、原始碼或焦點上下文 |

**兩種模式**：
- **一般模式**（第 1 輪）：附上完整原始碼
- **焦點模式**（第 2+ 輪）：只附上存活變異體附近的程式碼片段

---

### 3.5 `python_scripts/ast_extractor.py` — AST 靜態解析器

> **角色**：使用 Python `ast` 模組解析目標 Python 檔案，提取函式特徵。

**輸入**：`python ast_extractor.py <檔案路徑> <函式名稱>`

**輸出**（JSON）：
```json
{
  "name": "add",
  "args": ["a", "b"],
  "docstring": "簡單的加法函數",
  "calls": ["print"],
  "code": "def add(a, b):\n    return a + b"
}
```

**限制**：只能偵測直接函式呼叫（如 `foo()`），無法偵測方法呼叫（如 `obj.method()`）。

---

## 四、外部工具依賴

| 工具 | 用途 | 安裝方式 |
|------|------|----------|
| **Ollama** | 本機 LLM 推理引擎 | [ollama.com](https://ollama.com) |
| **mutatest** | 突變測試引擎（Windows 主要使用） | `pip install mutatest` |
| **mutmut** | 突變測試引擎（備用） | `pip install mutmut` |
| **Python 3.8+** | 執行 AST 解析與測試 | 系統安裝 |
| **Node.js 18+** | 擴充套件運行環境 | 系統安裝 |

---

## 五、快速初始化

```bash
# 1. 安裝 Node.js 依賴（擴充套件核心）
npm install

# 2. 安裝 Python 依賴（突變測試引擎）
pip install -r requirements.txt

# 3. 編譯擴充套件
node esbuild.js

# 4. 在 VS Code 中按 F5 啟動偵錯模式
```

---

## 六、設定項目

| 設定鍵 | 類型 | 預設值 | 說明 |
|--------|------|--------|------|
| `llmUnitTest.modelName` | string | `phi4-mini-reasoning` | 本機 Ollama 模型名稱 |
| `llmUnitTest.apiKeys` | object | `{}` | 雲端 LLM API 金鑰 |
| `llmUnitTest.customApiKeys` | object | `{}` | 自訂 OpenAI 相容 API 設定 |
| `llmUnitTest.projectPath` | string | `""` | 測試目標專案資料夾 |
| `llmUnitTest.outputPath` | string | `""` | 測試結果輸出資料夾 |

---

## 七、資料流架構圖

```
使用者操作 (UI)
     │
     ▼
┌──────────────────┐    postMessage     ┌──────────────────┐
│  webviewContent   │ ◄──────────────▶  │ SidebarProvider   │
│  (前端 HTML/JS)   │                   │ (後端 TS)         │
└──────────────────┘                   └────────┬─────────┘
                                                │ executeCommand
                                                ▼
                                       ┌──────────────────┐
                                       │   extension.ts    │
                                       │   (測試引擎)       │
                                       └──┬──────┬──────┬─┘
                                          │      │      │
                              ┌───────────┘      │      └───────────┐
                              ▼                  ▼                  ▼
                    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
                    │ AST 解析器   │    │  LLM API    │    │ 突變測試引擎 │
                    │ (Python)     │    │ (Ollama/    │    │ (mutatest/  │
                    │              │    │  Gemini/    │    │  mutmut)    │
                    │              │    │  Custom)    │    │             │
                    └─────────────┘    └─────────────┘    └─────────────┘
```
