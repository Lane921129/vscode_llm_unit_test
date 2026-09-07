# LLM Unit Test & Mutation Analyzer

> A VS Code extension that turns Python source into **evidence-checked** unit tests. It combines AST context extraction, real execution traces, LLM-assisted strategies, coverage, and mutation testing instead of trusting generated code at face value.

> [!WARNING]
> This project is under active development. Run generated tests in an isolated project or environment first, review the produced test code, and never give the extension credentials you would not allow a local development tool to use.

## What it does

- Supports local Ollama, Google AI Studio, and OpenAI-compatible Chat Completions APIs.
- Extracts module imports, referenced constants, class setup, constructor facts, dependency calls, and safe call-site literals using Python AST.
- Uses Dynamic Trace to turn verified inputs, outputs, and exceptions into deterministic Tier 1 assertions.
- Uses AST/Trace evidence-bound Skill Cards for async code, generators, mappings, floating-point values, database isolation, and mocking. No domain-specific vocabulary is hard-coded.
- Validates generated tests before scoring: target invocation, assertions, Python structure, safe mocking, isolated I/O, runtime execution, coverage, and mutation baseline.
- Writes `final_report.md` so failures identify the responsible stage: model, AST, trace, validation, coverage, or mutation tool.

## How the four Tiers work

| Tier | Best for | Core approach |
|---|---|---|
| 1 | Small or unverified models; traceable code | Builds tests mechanically from verified Dynamic Trace facts. |
| 2 | Several clear call sites | Uses constrained, divide-and-conquer LLM generation when helpful. |
| 3 | External dependencies | Supplies a Mock Scaffold and verified constructor setup. |
| 4 | Complex code and survived mutants | Uses full context, reviewer validation, and bounded self-repair. |

`Auto` is conservative: an unprobed provider/model uses deterministic Tier 1 first. If you explicitly select Tier 1–4, your choice is retained, but every generated file must still pass the same structure, execution, coverage, and mutation gates.

## Quick start

### Requirements

- VS Code `1.116` or newer.
- Node.js `20+` for extension development.
- Python `3.9+` for the analysis scripts. Python `3.12` is used in CI.
- Optional: Ollama for local models.
- Recommended for native mutation tools on Windows + Python 3.12+: WSL. The extension falls back to its built-in AST mutation runner when no compatible native tool is available.

### Develop locally

```bash
npm ci
python -m pip install -r requirements.txt
npm run test:unit
npm run compile
```

Then open this folder in VS Code and press `F5` to launch an Extension Development Host.

### Use the extension

1. Open **Mutation Test Analysis** from the VS Code Activity Bar.
2. Choose a project directory and a separate output directory.
3. Choose Local, Cloud, or Custom API.
4. Configure a model and press **Test Connection**.
5. Select a Python file and a top-level function or direct `Class.method`.
6. Select Auto or a Tier, then run the analysis.
7. Open the completed function card in the coverage dashboard to view its `final_report.md`.

For a traceable function such as `increment(value)`, Tier 1 executes safe inputs and produces assertions from the observed behavior. For an instance method, it only reuses constructor arguments that were verified from a safe call site; it never invents a required constructor dependency.

## Provider setup

### Local Ollama

- Start the Ollama server and use its base URL, normally `http://127.0.0.1:11434`.
- Select an installed model and run **Test Connection**.
- If the model cannot enforce JSON output but can write Python, the extension retries with a plain-Python contract.

### Google AI Studio

- Save three separate fields in the sidebar: **API key name**, **API model**, and **API key**.
- Select a model advertised by the API as supporting `generateContent`; do not guess a model ID.
- The key is stored in VS Code SecretStorage and is sent in an HTTP header, never in a URL or report.

### OpenAI-compatible Custom API

- Provide the Chat Completions URL, model name, and optional API key in the Custom API section.
- The extension first requests structured output when needed, then safely retries plain Python only for explicit format-rejection responses. Authentication, model-not-found, quota, and service failures remain visible errors.

## Safety and privacy

- Never commit `.env`, API keys, tokens, certificates, result caches, or local logs. See `.gitignore` and [PROJECT_RULES.md](PROJECT_RULES.md).
- The public CI receives no cloud-model key. It runs TypeScript checks, Python checks, extension build, and a tracked-files plus Git-history secret scan.
- Generated tests may use `mock.patch`, `mock_open`, or SQLite `:memory:`. They are rejected if they directly execute commands, access real files, use shared SQLite databases, or manipulate private target helpers unsafely.
- A passing HTTP request does not mean a model is qualified. The connection probe asks for a harmless unittest fixture and executes it in isolated Python.

## Quality checks and results

Run the same core checks locally as CI:

```bash
npm run test:unit
npm run compile
```

`npm run test:unit` includes TypeScript regression tests, Python AST/trace tests, and high-confidence secret scanning of tracked files and reachable Git history.

Each analysis run creates an output session. The main `final_report.md` records the selected model, Tier, trace facts, validation failures, coverage, mutation baseline, survived mutants, and bounded repair attempts. A mutation score is only reported after the original baseline passes in the same isolated import environment.

## Current limitations

- LLM quality varies. Tier 2–4 output is validated but cannot make an incapable model reason correctly.
- Dynamic Trace deliberately ignores ambiguous call-site data flow rather than guessing values.
- Native `mutatest` / `mutmut` support depends on Python version and OS; Windows with Python 3.12+ uses the built-in AST fallback unless WSL or another compatible environment is used.
- The extension currently targets Python `unittest`, not pytest-specific test syntax.
- Use test connection and cloud models with awareness of provider cost, network access, and your organisation's privacy policy.

## Project status and contribution

The public-release work is tracked in [CHANGELOG.zh-TW.md](CHANGELOG.zh-TW.md). Before contributing, read [PROJECT_RULES.md](PROJECT_RULES.md) and run the local quality checks above. Contribution, security-reporting, and community documents are being added as part of the v1.0 release work.

## License

[MIT](LICENSE)

---

# LLM 單元測試與突變分析器

> 這是一個 VS Code 擴充功能，將 Python 原始碼轉為**有證據驗證**的單元測試。它結合 AST 語境、實際執行 Trace、LLM 測試策略、coverage 與 mutation testing，而不是直接相信模型產出的程式碼。

> [!WARNING]
> 專案仍持續開發中。請先在隔離的測試專案或環境執行生成測試、人工檢查結果，且不要提供你不願交給本機開發工具的憑證。

## 功能

- 支援 Local Ollama、Google AI Studio、OpenAI 相容 Chat Completions API。
- 以 Python AST 擷取 imports、引用常數、class 初始化、建構子事實、依賴呼叫與安全的呼叫端 literal。
- Dynamic Trace 會執行安全探針，將已驗證輸入、輸出與例外轉為 Tier 1 的確定性 assertion。
- 以 AST／Trace 證據挑選技能卡，涵蓋 async、generator、mapping、浮點、資料庫隔離與 mock；不硬編碼業務領域詞彙。
- 生成碼必須通過目標呼叫、assertion、Python 結構、安全 mock、隔離 I/O、實際執行、coverage 與 mutation baseline 驗證。
- 每次執行會產生 `final_report.md`，清楚區分模型、AST、Trace、驗證、coverage 或 mutation 工具造成的問題。

## 四個 Tier

| Tier | 適用情境 | 核心做法 |
|---|---|---|
| 1 | 小型／未探測模型、可追蹤程式 | 從已驗證 Dynamic Trace 機械式建立測試。 |
| 2 | 多個清楚呼叫端 | 必要時以受限的分治 LLM 生成。 |
| 3 | 外部相依 | 提供 Mock Scaffold 與已驗證建構子設定。 |
| 4 | 高複雜度或存活 mutant | 使用完整語境、Reviewer 與有上限的自我修復。 |

Auto 模式會保守處理未探測模型，優先走可重現的 Tier 1。若你明確選擇 Tier 1–4，系統會保留選擇；但所有生成檔仍必須通過相同的結構、執行、coverage 與 mutation Gate。

## 15 分鐘快速開始

### 需求

- VS Code `1.116` 以上。
- 開發 extension 需要 Node.js `20+`。
- 分析腳本需要 Python `3.9+`；CI 使用 Python `3.12`。
- 本機模型可選擇安裝 Ollama。
- Windows + Python 3.12+ 若要使用原生 mutation tool，建議使用 WSL；沒有相容工具時會退回內建 AST mutation runner。

### 本機開發

```bash
npm ci
python -m pip install -r requirements.txt
npm run test:unit
npm run compile
```

接著以 VS Code 開啟此資料夾，按 `F5` 啟動 Extension Development Host。

### 使用步驟

1. 在 VS Code 活動列開啟 **Mutation Test Analysis**。
2. 選擇專案資料夾與獨立的輸出資料夾。
3. 選擇 Local、Cloud 或 Custom API。
4. 設定模型，先按 **Test Connection**。
5. 選擇 Python 檔案與頂層函式或直接 `Class.method`。
6. 選擇 Auto 或 Tier，開始分析。
7. 從 coverage 看板開啟完成函式卡片，閱讀對應的 `final_report.md`。

例如 `increment(value)` 這類可追蹤函式，Tier 1 會實際執行安全輸入，再以觀察到的行為建立 assertion。若是 instance method，系統只會使用安全呼叫端已驗證的建構子參數，不會猜測必要相依。

## 模型設定

### Local Ollama

- 啟動 Ollama server，通常使用 `http://127.0.0.1:11434`。
- 選取已安裝模型後按 **Test Connection**。
- 若模型無法強制 JSON、但可生成 Python，系統會改用純 Python 輸出契約重試。

### Google AI Studio

- 側邊欄分別儲存 **API key 名稱**、**API model**、**API key**。
- 請使用 API 清單中宣告支援 `generateContent` 的模型，不要猜模型 ID。
- Key 儲存在 VS Code SecretStorage，透過 HTTP header 傳送，不會寫入 URL 或報告。

### OpenAI 相容 Custom API

- 在 Custom API 區塊填寫 Chat Completions URL、模型名稱及選填的 API key。
- 需要結構化輸出時會先要求 JSON；只有明確格式拒絕才會安全回退純 Python。認證、模型不存在、配額與服務錯誤會保留為可見錯誤。

## 安全、驗證與結果

- 不要提交 `.env`、API Key、Token、憑證、結果快取或本機 log；詳見 `.gitignore` 與 [PROJECT_RULES.md](PROJECT_RULES.md)。
- 公開 CI 不取得雲端模型 Key，會執行 TypeScript／Python 檢查、extension build，以及 tracked files + Git 歷史密鑰掃描。
- 生成測試可使用 `mock.patch`、`mock_open` 或 SQLite `:memory:`；若直接執行命令、碰觸真實檔案、使用共享 SQLite 或不安全操弄私有 helper，驗證器會拒絕。
- 連線成功不代表模型合格；測試連線會要求模型生成無副作用 unittest fixture，並在隔離 Python 實際執行。

本機可執行與 CI 相同的核心檢查：

```bash
npm run test:unit
npm run compile
```

每次分析的 `final_report.md` 會記錄模型、Tier、Trace、驗證失敗、coverage、mutation baseline、survived mutant 與修補嘗試。只有原始 baseline 在相同隔離匯入環境通過後，才會報告 mutation score。

## 已知限制

- Tier 2–4 的輸出會被驗證，但無法讓能力不足的模型具備正確推理。
- Dynamic Trace 遇到不明確呼叫端資料流會保守略過，不會猜值。
- 原生 `mutatest`／`mutmut` 取決於 Python 版本與 OS；Windows + Python 3.12+ 在未使用 WSL 或相容環境時會使用內建 AST fallback。
- 目前支援 Python `unittest`，尚未支援 pytest 專屬語法。
- 使用雲端模型前請評估費用、網路與組織隱私政策。

## 專案狀態與貢獻

公開發行進度見 [CHANGELOG.zh-TW.md](CHANGELOG.zh-TW.md)。貢獻前請閱讀 [PROJECT_RULES.md](PROJECT_RULES.md)，並執行上述本機品質檢查。v1.0 發行工作正逐步補齊貢獻、安全回報與社群文件。

## 授權

[MIT](LICENSE)
