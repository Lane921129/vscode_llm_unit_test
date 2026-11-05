# 重構安全網：驗證紀錄（2026-11-04）

## 2026-11-05 更新：獨立基準驗證完成

最新進度以 `docs/HANDOFF.md` 為準。新版 harness 在原始 `050f969` 副本錄製 11/11，來源逐檔相同的目前版本副本完整比對 11/11，成功後才更新主倉庫五份 fixtures。PR #1 的完整 Python／integration 與新版決策文件仍待後續步驟，未宣稱整個 PR 已驗收。

正規化新增範圍：固定測試 TEMP／TMP／TMPDIR；只把 mutants[].output 轉為輸出存在與最後例外摘要；scopeId 先驗證原 body 的 hash，再以正規化 root 與完整檔案清單重算；coverage 文字表格只移除路徑長度衍生的欄寬與分隔線長度，保留全部量測值。其他狀態、原因、角色順序、提示 hash、品質、計數、門檻與內容 hash 完整比對。

目前版本三輪完整順序的 writer-failure 皆 writers=5，2306.234／2322.334／2261.750ms；基準兩輪為 2235.731／2616.637ms。工作區另已捕捉 writers=0 的原生 rename EPERM，發生在模型請求前；改用來源相同的倉庫外驗證副本保留真實執行，沒有加入產品重試或放寬斷言。外部鎖定來源尚未識別。失敗保存避開已重現會終止程序的 fs.cpSync，改為診斷先落盤與逐檔排他複製。

來源、harness 與新舊 fixtures hash 證據在 `log/pr1-writer-final-source-proof.json`；逐輪摘要在 `log/pr1-writer-stability-results.json`。下文為較早的歷史狀態。

本次先依指示 pull，`lane_edition` 從 `8fb075f` 快轉到 `050f969`。保留使用者原有未追蹤的重構計畫文件。實作範圍是計畫 PR #1（A1+A2），產品程式未搬移或修改；B～E 與功能改善尚未開始。

## 已加入的安全網

- `src/test/orchestratorGolden.test.ts`：透過正式命令驅動五條路徑，包含真實隔離 Python、BMI full 的 builtin 突變，以及首目標失敗後仍執行其餘兩個目標的批次。
- `test/fixtures/golden/`：保存 final report、analysis journal、run manifest、BatchJournal 的 batch manifest，以及每次 wire 請求的精確 journal 角色、順序與正規化提示 SHA-256。
- `npm run test:golden` 預設只比對；`-- --update` 明確建立／更新。新測試依既有盤點規則納入 integration 與 full，保留 fast/integration 互斥。
- 正規化只處理執行時間／剩餘期限分配、路徑、執行識別與建置識別；狀態、原因、方法數、請求次數、品質分數及設定門檻保留。不同執行 ID 映射到不同的固定識別；Trace case ID 保留執行及 case index，移除由絕對位置衍生的識別摘要，完整型別化輸入與來源／候選 hash 仍保留。

初始 harness 的五條路徑已在目前版本與 `8fb075f` 副本跑通。Windows 沙箱的突變暫存目錄出現 WinError 5，改以相同測試原生重跑後可實際完成突變；未因此變更產品隔離或品質 gate。首次穩定性比對用來發現並補齊時間、Python Trace 執行 ID 與暫存路徑的正規化，不能當成三次穩定通過。

## 既有回歸失敗

`npm run test:fast`：Node 770/772，兩項失敗；runner 因 Node 失敗未繼續後面的 Python 步驟。單獨重跑下列兩個檔案為 12/14，重現同兩項失敗。這兩項測試與對應產品來源均無本次差異。

1. `src/test/modelQualification.test.ts` 的 `role qualification runs Reviewer and Bug Fixer probes independently`：fixture 以舊提示片語 `ONE findings array` 辨識 Reviewer；目前提示已改寫，實際辨識結果為 `[false, false]`，原預期為 `[true, false]`。
2. `src/test/supplementalProbeInputs.test.ts` 的 `builds complete, bounded calls from semantic candidates and AST defaults`：原預期把 `value` 放進 kwargs；目前實作將 positional-or-keyword 參數放進 args，`mode` 仍放在 kwargs。

`npm run test:integration`：Node 892/1019，127 項失敗，約 37 分鐘；紀錄在 `log/refactor-integration.log`。其中兩項是當時 golden 的 JSON key 順序比對問題（full 子測試與父測試），後續已以 canonical object keys 修正，最終相關回歸 23/23 通過；沒有重跑整套 integration，因此不能扣除後宣稱整合已通過。其餘失敗尚未逐項以獨立乾淨副本重現，不能一概視為已證明的上游缺陷。Node 失敗後未執行後續 Python 步驟。

上述問題保留為獨立修復證據，不在安全網變更中改動產品、提示、門檻或舊測試預期以消除失敗。

## 驗收狀態

最終 harness 在隔離的 `8fb075f` 原始碼副本建立獨立基準後，連續三次比對皆為 7/7（包含正規化測試、父測試與五個情境；不是七條獨立情境）。目前 `050f969` 版本獨立建立 golden 後，最終 `npm run test:related -- --node orchestratorGolden --node verificationRunner` 為 23/23；`npm run compile` 包含的 check-types、lint 與 esbuild 皆成功；`git diff --check` 通過。

基準副本原在 `D:/read/專題/test/golden-baseline-8fb075f` 執行，完成後移至本倉庫忽略目錄 `log/golden-baseline-8fb075f-verified/` 保留證據，避免污染另一工作區的 Python 掃描。其 `log/golden-portable-repeat-1.log` 至 `-3.log` 保存三次結果；目前版本紀錄為 `log/refactor-related-final.log`、`log/refactor-compile-final.log`。兩邊最終 harness 的 SHA-256 相同。

A1+A2 已有可檢視實作，但全綠門檻尚未滿足；A 階段尚未驗收，不以此紀錄宣稱整份重構計畫完成，不開始階段 B，亦未建立 commit 或 push。中文 CHANGELOG 的完成紀錄及雙語提交留待本單元驗收後，這份文件記錄未驗收草稿的進度與失敗證據。

沒有執行新真實模型、實驗室車輛整批或跨平台驗收。`test:full` 是 A 階段完成時的必要檢查，不能以局部或固定回覆測試代替。

## AOCI 收尾限制

最終業務檔穩定後已呼叫一次 `aoci_maintain`，結果為 `stopped/blocked`，未簽發任何可提交候選，正式索引沒有更新。`scope status` 指向 `observed_evidence_review_required`：1,210 筆 observe 變化待復核，另回報 8 項人工審查項目；其中包含執行產物與保留的基準副本。工具要求先完成範圍證據審查才可 acknowledge，不能僅為解鎖而冒稱全部已審查。原有上游及本次變更合計 73 個認知目標仍待維護；索引狀態維持 dirty/stale，未宣稱認知已對齊。機讀證據留在忽略的 `log/aoci-scope-status-final.json`。
