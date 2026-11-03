# 停止政策修正驗收（2026-11-01）

這是本機程式與受控 fixture 驗收，未呼叫真實 LLM，也未執行跨專案泛化實驗。程式變更仍在工作目錄，沒有建立 commit 或覆蓋既有 `test_data/result`。

## 版本識別

- 基準 commit：`8fb075f7dd940938f07a021d40f121cee99529b0`。
- 修改後來源 SHA-256：`fd83dcadd6811726e75c44b23e28be002ef83bf3d997b6e7d6383b22fc839de1`。
- `dist/extension.js` SHA-256：`5352e2a666677831f5ce74cc4cef2647d10ef16124ccee03f11ad96ddc7a739a`。
- Node `24.18.0`、Python `3.13.14`、mutatest `3.1.0`。

來源雜湊涵蓋 `src`、`python_scripts`、`contracts`、package／lockfile、語系設定與建置設定，包含新增來源檔；不包含本文件與本機測試日誌。不能單獨拿基準 commit 當成修改後版本。詳細識別保留於本機 `log/stop-policy-verification-identity.json`。

## 驗收範圍

- `npm run package`：型別、lint 與 production bundle 通過。esbuild 在受限沙箱無法讀取父目錄，已使用核准的相同建置命令完成。
- Webview 抽取腳本語法檢查通過。
- 包含局部修訂完整／僅執行流程的 Node 回歸 169 項通過；最後另跑停止政策、批次、速率、側欄與結果呈現 54 項通過。兩組有重疊，不應相加當作獨立測試數。
- 突變匯入／fixture 38 項通過，包含真實 mutatest、外部相依副本的來源雜湊、初始化 entry point、父套件／混合匯入、原始資料不被複製及 fixture source 變更後拒絕。
- 資源診斷、SQLite schema 與別名相關追加回歸 18 項通過。
- 最後重新合併執行 import fixtures、突變 layout／activation／baseline、runtime policy、資源診斷、別名及 Reviewer AST facts：144 項全部通過，見本機 `log/stop-policy-python-verified.log`。此組涵蓋前述多個子集合，不應重複加總。

本機原始結果保留在 `log/stop-policy-node-results.log`、`log/stop-policy-final-checks.log`、`log/stop-policy-copy-fixture-results.log`、`log/stop-policy-diagnostics-results.log`。`log/` 為忽略的執行產物；中途失敗及修正後重跑採用不同檔名保存。

## 已確認的既有失敗與限制

較廣的 Python 回歸發現下列五個斷言失敗。已在隔離目錄以 HEAD 的原始工具程式重現相同結果，並未以降低測試要求消除：

1. `test_dynamic_tracer_reaches_reverse_and_literal_membership_branches`：既有輸入規劃沒有涵蓋 `fast`。
2. `test_dynamic_tracer_reaches_scalar_branches_from_source_conditions`：既有輸入規劃沒有涵蓋 `second`。
3. `test_dynamic_mount_paths_reject_devices_streams_and_executable_files`：Windows 的 `CON`、`NUL.txt`、`COM1` 三個子案例雖受阻，但停止原因不是測試要求的 `unsupported filename`。

原始比較紀錄為本機 `log/stop-policy-baseline-comparison.log`。這次不能宣稱整個 repository 全套回歸已通過。

倉庫要求的 AOCI MCP 工具在本次工作階段未提供；沒有自行生成或修改正式 AOCI 索引。設定語意與後續實驗要求見 [STOP_POLICY.md](STOP_POLICY.md)。
