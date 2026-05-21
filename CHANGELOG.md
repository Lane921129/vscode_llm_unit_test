# Change Log

This file documents all notable changes to the `llm-unit-test` extension.

## [0.0.1] - 2026-05-21

### Added
- **Core Architecture**: Implemented the 4-stage automated loop (Context Extraction -> LLM Generation -> MutPy Verification -> Prompt Refinement).
- **Python AST Integration**: Support for precisely extracting target function arguments, docstrings, and dependencies, reducing Token consumption and improving generation accuracy.
- **Dynamic Prompt System**: Integrated MutPy's surviving mutants report to dynamically generate optimization suggestions for LLM to strengthen Assertions.
- **Multi-Model Support**:
  - Support for local Ollama inference, ensuring source code privacy.
  - Support for cloud APIs (e.g., Gemini 2.0 Flash) for enhanced reasoning, including an API Key management interface.
- **Frontend Interface (Webview)**:
  - Integrated with VS Code's native dark theme design.
  - Support for automatic workspace file scanning and function selection.
  - Real-time log panel to track the execution status of each test loop.
  - Dynamic coverage and Mutation Score tracking table.

### Fixed
- Fixed memory leak caused by missing command unregistration upon extension deactivation.
- Fixed MutPy command execution failure on Windows when the path contains spaces.
- Fixed hardcoded API model URL issue during model switching, ensuring the user's selection takes effect correctly.
- Strengthened the AST parsing script's Code Injection Prevention mechanism.
- Unified project indentation and enabled strict TypeScript type checking (`interface`).
- Cleaned up redundant intermediate files and placeholder documents before release.

---

# 更新日誌

本文件記錄 `llm-unit-test` 擴充功能的所有重要更新。

## [0.0.1] - 2026-05-21

### 新增
- **核心架構**：完成四階段自動化循環 (上下文擷取 -> LLM 生成 -> MutPy 驗證 -> 提示精煉)。
- **Python AST 整合**：支援精準擷取目標函式的參數、註解及相依呼叫，減少 Token 消耗並提升生成精準度。
- **動態 Prompt 系統**：整合 MutPy 的存活變異體報告，動態生成優化建議給 LLM 進行 Assert 強化。
- **多模型支援**：
  - 支援本地 Ollama 推理，保障原始碼隱私。
  - 支援雲端 API (如 Gemini 2.0 Flash) 以提升推理能力，並實作 API Key 管理介面。
- **前端介面 (Webview)**：
  - 整合 VS Code 原生深色主題設計。
  - 支援工作區檔案自動掃描與函式選擇。
  - 即時日誌面板追蹤每輪測試執行狀態。
  - 覆蓋率與突變分數 (Mutation Score) 動態追蹤表格。

### 修正
- 修正指令註冊遺漏導致的記憶體洩漏問題。
- 修正 MutPy 指令在包含空白的 Windows 路徑下會執行失敗的問題。
- 修正 API 模型切換時 URL 硬編碼問題，確保使用者選擇正確生效。
- 強化 AST 解析腳本的防注入機制 (Code Injection Prevention)。
- 統一專案排版與 `TypeScript` 嚴格型別檢查 (`interface`)。
- 清理上架前多餘的中介檔案與佔位文件。