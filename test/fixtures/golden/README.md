# Orchestrator golden 安全網

執行 `npm run test:golden` 比對五條正式命令路徑：BMI full（真實 builtin 突變）、execution 成功、Writer 無效回覆與修訂失敗、惰性 stub、三目標批次首敗後續跑。

本次產品基準是 pull 後的 `050f969`。計畫指定的 `8fb075f` 另以隔離的原始碼副本執行同一 harness；兩個版本的快照分開保存，不能把舊版輸出當成新版的結果。

保存 final report、function knowledge、role events、run manifest、batch manifest/events，以及角色順序與正規化提示的 SHA-256。Stub 不產生 final report，保留其真實終態。狀態、原因、分數、方法與請求數保持原值。僅正規化執行時間、剩餘期限分配、路徑、執行 ID 與建置識別；設定的期限與突變門檻保留。清單見測試的 `normalize`。

工具自由文字 `mutants[].output` 保留為 `{hasOutput,lastException}`，其餘突變欄位完整比對。`scopeId` 先驗證原始 root／knownFiles／selectedFiles 的 hash，再只正規化 root 重算；範圍內容或原 hash 損壞仍失敗。Coverage 純文字表格僅正規化由路徑長度決定的欄寬與分隔線，保留所有檔名、數字、百分比、缺漏行號。TEMP、TMP、TMPDIR 固定在測試根的 `tmp/`，結束後還原環境變數。

JSON 物件鍵以字元順序序列化；陣列不排序，事件與角色請求順序維持可觀察。比對以解析後的 canonical JSON 為準，檔案的空白或物件鍵順序不代表產品行為差異。

執行 ID 採一對一固定編號，保留跨產物的同一／不同身分。Trace case ID 的絕對位置摘要不進快照識別；case index、完整型別化輸入、來源與候選 hash 照常比較。Windows 來源身分的大小寫與路徑分隔符也正規化，固定規則卡內的路徑示例仍保留。

`npm run test:golden -- --update` 明確建立／更新快照。初次建立後，只能在刻意改行為的獨立變更中更新，須說明差異；重構期間有差異應調查，不可直接覆蓋。integration 與 full 自動執行比對，不會更新快照。

測試工具正規化修復須先在原始產品 commit 的獨立副本重錄，再設定 `ORCHESTRATOR_GOLDEN_FIXTURES` 讓目前版本讀取該副本快照；完整比對一致後才發布 fixtures。2026-11-05 的 050f969 重錄與目前版本比對皆 11/11，來源與快照 hash 證據及原生隔離副本操作見 `docs/HANDOFF.md`。

固定角色回覆只驗證流程；Python、隔離與突變仍真實執行。這些結果不能當成真實模型或實驗室驗收。

測試在 `log/golden-runtime/` 排他建立工作目錄，避免同時執行的兩個 golden 共用成果；同一 checkout 的 golden 請依序執行。測試以固定 UUID 建立獨立執行身分，結束後還原產生器並清理自己建立的目錄。integration 與 full 使用相同預設比對路徑。

`ORCHESTRATOR_GOLDEN_SCENARIO` 可選單一情境（full、execution、writer-failure、stub、batch），省略仍跑完整順序。失敗先保存 `diagnostic.json` 與結果檔至 `log/golden-failure-<scenario>/run-N/` 再清理；失敗副本不覆蓋，原斷言與錯誤保持不變。此 Windows Node 環境的 `fs.cpSync` 曾使程序終止，因此保存採逐檔排他複製。
