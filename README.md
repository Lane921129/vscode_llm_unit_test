# 🧬 LLM Unit Test Generation & Mutation Analysis System

> A VS Code extension that combines Large Language Models (LLM) and Mutation Testing to automatically generate high-quality unit tests for Python code, continuously improving test strength through a self-refining feedback loop.

## ✨ Core Features

### 🔄 Four-Stage Automated Pipeline

| Phase | Function | Description |
|------|------|------|
| **Phase 1** | Context Extraction | Uses VS Code API to get the target file, and Python AST to parse function signatures, arguments, and dependencies. |
| **Phase 2** | Smart Generation | Calls LLM (Local Ollama or Cloud Gemini) to automatically generate Pytest test scripts. |
| **Phase 3** | Vulnerability Analysis | Executes mutation testing via MutPy to identify surviving mutants and pinpoint code weaknesses. |
| **Phase 4** | Iterative Optimization | Feeds surviving mutant data back to the LLM to strengthen Assert logic until the mutation score reaches the target. |

### 🖥️ User Interface

- **Sidebar Control Panel**: Toggle model environments, manage API Keys, and select target files/functions.
- **Real-time Logs**: Fully tracks the execution status of every LLM call and MutPy run.
- **Coverage Dashboard**: Dynamically displays the Mutation Score for each file.

## 📦 Tech Stack

| Component | Technology |
|------|------|
| Extension Framework | VS Code Extension API |
| LLM Engine | Ollama (Local) / Google Gemini (Cloud) |
| Test Framework | Pytest |
| Mutation Testing | MutPy |
| Semantic Analysis | Python `ast` Module |
| Build Tools | esbuild + TypeScript |

## 🚀 Installation & Usage

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Python](https://www.python.org/) 3.8+
- `pip install pytest mutpy`
- (Optional) [Ollama](https://ollama.com/) — For local model inference

### Development Setup

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Press F5 in VS Code to launch the Extension Development Host
```

### How to Use

1. Click the 🧪 **Mutation Test Analysis** icon on the Activity Bar.
2. Select the **Model Environment** (Local Ollama or Cloud API).
3. If using Cloud mode, click **➕ Add Key** to set your API Key.
4. Select the target Python file and function.
5. Set the maximum loop count.
6. Click **🚀 Execute Automated Test Loop**.

## 📄 License

MIT License

---

# 🧬 LLM 單元測試生成與突變弱點分析系統

> 一款 VS Code 擴充功能，結合大型語言模型 (LLM) 與突變測試 (Mutation Testing)，自動為 Python 程式碼生成高品質單元測試，並透過自我精煉迴圈持續提升測試強度。

## ✨ 核心功能

### 🔄 四階段自動化流程

| 階段 | 功能 | 說明 |
|------|------|------|
| **Phase 1** | 上下文擷取 | 透過 VS Code API 取得目標檔案，使用 Python AST 解析函式特徵、參數、相依呼叫。 |
| **Phase 2** | 智慧生成 | 呼叫 LLM（本地 Ollama 或雲端 Gemini）自動生成 Pytest 測試腳本。 |
| **Phase 3** | 弱點分析 | 以 MutPy 執行突變測試，辨識存活的突變體並定義程式碼弱點。 |
| **Phase 4** | 迭代優化 | 將存活突變體資訊回饋至 LLM，強化 Assert 邏輯，直到突變分數達標。 |

### 🖥️ 使用者介面

- **Sidebar 控制面板**：模型環境切換、API Key 管理、目標檔案與函式選擇。
- **即時日誌**：完整顯示每輪 LLM 呼叫與 MutPy 執行結果。
- **覆蓋率看板**：動態顯示每個檔案的突變分數 (Mutation Score)。

## 📦 技術架構

| 元件 | 技術 |
|------|------|
| 擴充框架 | VS Code Extension API |
| LLM 引擎 | Ollama (本地) / Google Gemini (雲端) |
| 測試框架 | Pytest |
| 突變測試 | MutPy |
| 語意分析 | Python `ast` 模組 |
| 建置工具 | esbuild + TypeScript |

## 🚀 安裝與使用

### 前置需求

- [Node.js](https://nodejs.org/) v18+
- [Python](https://www.python.org/) 3.8+
- `pip install pytest mutpy`
- （選用）[Ollama](https://ollama.com/) — 本地模型推理

### 開發環境啟動

```bash
# 安裝依賴
npm install

# 編譯
npm run compile

# 在 VS Code 中按 F5 啟動 Extension Development Host
```

### 使用步驟

1. 點擊左側活動欄的 🧪 **突變測試分析** 圖示。
2. 選擇 **模型環境**（本地 Ollama 或雲端 API）。
3. 若使用雲端模式，點擊 **➕ 新增密鑰** 設定 API Key。
4. 選擇目標 Python 檔案與函式。
5. 設定最大循環次數。
6. 點擊 **🚀 執行自動化測試循環**。

## 📄 授權

MIT License
