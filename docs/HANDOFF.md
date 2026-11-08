# 交接紀錄（HANDOFF）

> 這個專案會輪流交給 Claude Code、Codex、Antigravity 執行。**本檔是各 agent 之間唯一的交接來源。**
> 每個 agent 開始時先完整讀本檔，結束時更新本檔。各節的最新內容放最上面。

---

## 0. 固定資訊

- **執行計畫**：`docs/三週改版架構_2026_11_04.md`（第 0 節：規則；第 9 節：PR 清單）
- **已被取代**：`docs/重構與改善計畫_2026_11_04.md`，只保留其中的 golden 安全網
- **分支**：主線是 `lane_edition`。每個 PR 開一個分支 `pr/NN-簡短名稱`；PR #1 沿用 `codex/pr1-regression-baseline`
- **Push**：PR 經使用者驗收後才合併到 `lane_edition` 並 push。WIP commit 只能留在 PR 分支
- **AOCI**：只有 Codex 有 AOCI MCP（設定在 `.codex/config.toml`）。其他 agent 不要呼叫或假裝呼叫 AOCI，改在第 4 節記一筆待辦。`AGENTS.md` 的 AOCI 流程只適用於有 AOCI 工具的 agent
- **CodeGraph**：如果可用，找符號、呼叫者、被呼叫者時優先使用

### 指令與大約耗時（Windows 原生執行）

| 指令 | 耗時 | 備註 |
| --- | --- | --- |
| `npm run check-types` | 約 25 秒 | |
| `npm run lint` | 約 1 分鐘 | |
| `npm run test:fast` | 數分鐘 | 包含 check-types、lint、Webview |
| `npm run test:related -- --node <名稱> --python <名稱>` | 依範圍 | 只跑相關測試 |
| `npm run test:golden` | 數分鐘 | 會實際跑突變測試 |
| `npm run test:python` | 較久 | |
| `npm run test:integration` | **約 37 分鐘** | 在背景執行，輸出導到 `log/`，只讀摘要 |

### 使用者已確認的決策（不需再問）

**2026-11-08 模型篩選結果（詳見 `docs/模型篩選結果_2026_11_08.md`）**：主力模型 **gpt-oss:20b**（26 個目標中完整通過 6、可執行 25、平均覆蓋率 90%），備援 **ministral-3:14b**。之後的開發驗證與評估都以 gpt-oss:20b 為準。
- PR #3 追加需求：保留下來的可執行基線也要跑突變測試，不論 Reviewer 是否核准；否則「可用」層幾乎無法達成。
- PR #3 追加 C 類修正：工具受阻 `Review revision requires the current method inventory.`（篩選中出現 4 次）。
- PR #3 追加 Reviewer 修改（使用者 11/08 核准）：Reviewer 回覆若只是 `basis` 引用格式不合，改把 findings 當建議傳給 Writer，不反覆退回，也不扣目標失敗額度；與實際執行結果或來源事實矛盾的主張照舊擋下。依據：篩選中 31 個審查阻擋目標有 24 個是回覆被格式驗證退回，例如 gpt-oss 的 `html_escape` 正確指出缺少特殊字元情境卻被退回 4 次。詳見架構文件第 9 節 PR #3。
- 待實驗：gpt-oss:20b 的 `localThinkingMode` A/B（provider-default vs disabled）。這批有 64 次輸出截斷，輸出 tokens 是其他模型的 6～12 倍。


0. **2026-11-04 15:30 方向調整（與指導教授討論後，優先於下列舊項目）**：不做錯誤定位。原本的兩種模式合併成單一流程，「預期值以規格為準」：有規格來源時，由模型依規格預測預期值，預測提示中不含函式本體與任何執行結果；與實際結果不一致時，不寫進正式測試，改列入 `test_spec_mismatch.py` 和規格不符報告。設定改為 `llmUnitTest.specOracle: auto | off`，不再有 `generationGoal`。詳見架構文件 0.1、1.3 節。
1. 分層成功（`usable` / `quality-passed`）、允許模型依規格預測預期值、只使用非中國大陸的模型。詳見架構文件 0.1 節。
2. `050f969` 的停止政策保留：`failureLimit=5`、`qualityNoImprovementLimit=3`、`batchFailureLimit=0`。環境受阻、工具受阻和 HTTP 重試不扣額度。
3. supplemental probe：連續的 positional-or-keyword 參數放進 args；中間有參數被省略時，之後改用 kwargs；keyword-only 參數用 kwargs，positional-only 參數用 args。
4. 新版 Reviewer 提示只用於 Reviewer；Analyst-規格的提示不得出現「已驗證」說法、函式本體或任何執行觀察值。
5. runner 診斷證據損壞時歸類為 `tool`；若是候選測試本身造成的損壞，則維持 `validation`。
6. 處理規則分三類：
   - **A 類，直接做**：只讓分類更準確，或只新增診斷資訊。
   - **B 類，先問使用者**：改變重試次數、預算、停止條件、通過或失敗的標準、預設行為或提示詞內容。
   - **C 類，確定是 bug**：直接修產品。
7. 評估以「本系統 vs 同一模型直接寫 unittest」為主軸：只給函式原始碼、單次請求、不修訂，使用同一套隔離執行與量測。
8. **2026-11-05 測試上限調整規則**：先檢查 token 估算是否受路徑長度影響；有關時先固定短路徑，不以提高上限掩蓋。無關時，測試上限增加不超過現值約 5%、產品設定不變且寫明原因，視為 A 類，不逐項詢問。dependencyMockRepair 的 2000→2300 超過 5%，是使用者另行附條件批准的這一項例外，不擴張為其他測試的通用批准。

9. **2026-11-06 評估容量 fixture 規則**：測試容量僅調整為架構文件 6.2 的 num_ctx=8192，且產品預設不變時，視為 A 類，可直接處理。BMI full-file 的 8192 已附條件批准：保留完整函式／caller 證據，核對實際輸入預算與容量事件；若證據截斷即停下回報。6982 是最低總 context，最大完整輸入估算為 5446，兩者不可混稱。

10. **2026-11-07 Windows 原子改名 B 類已批准**：只在 Windows 的 EPERM／EACCES／EBUSY 重試；依四段 20／40／80／160ms 退避採最多五次總嘗試，合計等待 300ms，重試窗口小於 0.5 秒且不重設原期限。每次重試記錄 journal，最後失敗仍拋原錯誤。此決策已實作並驗證，不再列第 3 節。
11. **2026-11-07 PR #1 第 4 步的新完成標準（優先於本檔歷史與原全綠要求）**：目前版不得比乾淨 050f969 副本多出任何新的 integration 失敗，須完整執行並逐一比對 Node／Python 失敗清單。050f969 原本就失敗的測試盡量在 11/7 結束前修好；未修完者列第 5 節「既有失敗清單」與基準實際狀態，不阻擋 PR #1。達成後執行第 4.5、5 步並 commit；第 6 步 AOCI 可延後，不阻擋 PR #2。其他驗證／隔離／golden 標準不變。

---

## 1. PR 進度總表

| PR | 內容 | 狀態 | 分支 | 最後更新 |
| --- | --- | --- | --- | --- |
| 1 | 修復 050f969 回歸、golden 安全網、決策寫入 PROJECT_RULES | **完成：使用者驗收通過，已合併主線；第6步AOCI保留待辦** | `lane_edition`（來源 `codex/pr1-regression-baseline`） | 2026-11-07 Codex |
| 2a | **側欄目標選擇改善**（字母排序、多選累加、批次範圍連動、目標清單匯出入）。規格：`docs/側欄目標選擇改善規格_2026_11_07.md` | **完成：使用者驗收通過，已合併主線並 push** | `lane_edition`（來源 `pr/02a-target-selection`） | 2026-11-08 Antigravity |
| 2 | 模型篩選工具與評估集 | **完成：使用者驗收通過，已合併主線並 push** | `lane_edition`（來源 `pr/02-model-screening`） | 2026-11-08 Antigravity |
| 3 | 成功分層與批次失敗彙總 | **續接驗證中：舊完成聲明不代表本輪五項已完成** | `pr/03-tiered-success-failure-summary` | 2026-11-08 Codex（GPT-6） |
| 4 | 測試範圍預設排除備份與副本 | 未開始（選配；建議延後，待使用者確認） | | |
| 5 | case-table-v1 結構與驗證 | 未開始 | | |
| 6 | 設定分流、Analyst-情境提示、UI 設定 | 未開始 | | |
| 7 | Capture run、列轉測試、逐方法執行、Bug Fixer 單列修正 | 未開始 | | |
| 8 | **規格預測**（規格來源、Analyst-規格、比對分級、規格不符報告） | 未開始 | | |
| 9 | Reviewer 改審案例表 | 未開始 | | |
| 10 | Quality Analyst 存活突變轉案例列 | 未開始 | | |
| 11 | 需求涵蓋表與設計疑點 | 未開始 | | |
| 12 | 對照組執行器與埋 bug 評估 | 未開始 | | |

評估集以架構文件 6.1 節為準：BMI、add、markupsafe、validators、learn-python、bottle、車輛管理主程式（排除副本與 `old backup/`）。

---

## 2. PR #3 完成紀錄與下一步

詳細說明：`eval/README.md`、`docs/模型篩選結果_2026_11_08.md`。本節為最新續接狀態；第 6 節保留歷史。

### 2026-11-08 Codex（GPT-6）續接 PR #3（最新狀態）

- 開始狀態：分支 `pr/03-tiered-success-failure-summary`，HEAD `8a57e31`；保留 Antigravity 的七個已修改檔與新檔 `src/test/tieredSuccessIntegration.test.ts`。原本未追蹤的 `Claude outputs/` 與舊重構計畫不納入提交。
- 本次有 CodeGraph MCP，已先查詢候選流程；沒有 AOCI MCP，未呼叫任何 AOCI 工具，收尾待辦見第 4 節。`.codex/`、`.aoci/` 不修改，不 push。
- 已核對 diff：量測失敗事件、恢復原迴圈停止條件及整合測試已存在；補齊「Writer 一次修訂後，第二次審查仍有正常品質意見也立即保留為未核准」分支，不增加預算或修訂次數。
- 下方 Antigravity 完成紀錄為 `8a57e31` 歷史；不作為未提交修改的驗證證據。

- 本輪確認並修復產品漏扣／誤扣邊界：格式建議原本仍呼叫 `rejectedCandidate`，其 orchestrator hook 會扣失敗額度；改記錄 `reviewer/suggestion-handed-off`，正式整合測得 `failureCount=0`。普通品質意見仍走既有扣額規則。
- 新 fixture 的錯誤已修正：`seedTestCode` 改用既有 `seedCode`、修訂後審查綁定新候選雜湊、保留理由碼用 `removed-passing-method`、故障注入使用 `pythonToolPath('mutation')`。量測錯誤核對既有安全診斷碼 `adapter-execution-failed`，不要求洩漏 stderr。
- 初輪 related 132 tests：127 pass／5 fail（4 leaf＋1 parent）；v2、v3 保留診斷。最終重驗 5 檔 45/45 全過（`log/pr3-codex-fixtures-v4.log`），含三項真整合與拒絕 tracing。其他原已通過且未受本輪格式 hook 修正影響的測試不重跑。

#### 下一步（本輪依序）

- [x] 1. 驗證保留基線量測失敗會寫入 `mutation/retained-measurement-failed`，沒有空 catch。
- [x] 2. 驗證原迴圈上限與一次格式建議修訂；未核准只可為 `usable`，不得升為 `quality-passed`。
- [x] 3. 驗證真實保留基線突變分數與 `html_escape` 建議進 Writer 提示兩項整合測試（另含量測失敗測試）。
- [ ] 4. lint、test:related、test:fast、test:golden 已通過；背景完整 test:integration 執行中，**下一步等完整 Node／Python 結束，逐案比對第 5 節既有 14 個失敗**。目前不得宣稱無新增失敗。
- [ ] 5. golden 有差異立即停止並列差異，絕不更新快照；否則完成交接供驗收。

| 本輪驗證 | 結果 | 證據 |
| --- | --- | --- |
| check-types / lint | 最終 fast 再驗通過 | `log/pr3-codex-fast.log` |
| related | 最終 45/45 全過；初輪其他相關案例通過紀錄保留 | `log/pr3-codex-fixtures-v4.log`、`log/pr3-codex-related.log` |
| fast | Node 776/776、Python 48/48，含型別、lint、Webview；退出碼 0 | `log/pr3-codex-fast.log`、`log/pr3-codex-fast.status.json` |
| golden | 11/11 通過；五組快照零差異，來源雜湊無變更 | `log/pr3-codex-golden.log`、`log/pr3-codex-golden.status.json` |
| 完整 integration | 背景執行中（PID 14768）；187 個 Node 檔、52 個 Python 檔。Node 若失敗仍補跑完整 Python tier，逐案比對第 5 節既有 14 個失敗 | `log/pr3-codex-integration.log`、`log/pr3-codex-integration.status.json`；來源版本證據 `log/pr3-codex-integration.source-before.json` |

### 2026-11-08 PR #3 歷史完成紀錄（後續五項續接以上節為準）

- **已實作**：
  1. **終態分層（Tiered Terminal Status）**：於 `src/pipeline/resultPresentation.ts` 新增 `OutcomeTier`、`isUsableOutcomeEvidence` 與 `classifyOutcomeTier`，將目標結果明確分為 `quality-passed`、`usable`（隔離環境通過、確實呼叫真實目標 `targetExecuted === true`、且完成突變量測取得數值突變分數）、`failed`、`environment-blocked`、`tool-blocked`，並擴充 `presentOutcome` 呈現文字。
  2. **保留的可執行基線一律跑突變測試**：於 `src/orchestrator.ts` 記錄已量測突變的候選雜湊（`mutationAttemptedHashes`）；當目標因審查阻擋、失敗上限等原因進入收尾 `catch` 分支時，若 `checkpoints.executable` 存在且尚未完成突變量測，立即對該保留基線執行隔離突變測試、寫入 `quality_baseline.json`（`checkpoints.saveQuality`）並更新 `function_knowledge.json` 與 `final_report.md` 的突變分數與保留基線欄位；Reviewer 僅決定能否升為 `quality-passed`。
  3. **Reviewer `basis` 引用格式不合轉為建議且不扣失敗額度**：於 `src/roles/reviewEvidenceBasis.ts`、`src/roles/testReviewer.ts`、`src/roles/reviewContractRepair.ts`、`src/pipeline/testCandidatePipeline.ts` 實作：當 Reviewer 回覆僅有 `basis` 引用格式問題（`missing-evidence-basis`、`invalid-evidence-basis`、`evidence-reference-missing`、`evidence-reference-unrelated`）且無任何事實／執行結果矛盾時，不再於 `reviewWithContractRepair` 反覆退回重試，亦不呼叫 `policy.reject(...)` 扣除目標失敗額度，改轉為 `quality` 建議傳遞給 Writer 修訂；與實際執行結果或來源事實矛盾的主張（`evidence-fact-contradiction`、`observed-outcome-contradiction`、`target-self-mock` 等）照舊攔截。
  4. **修正工具受阻（`Review revision requires the current method inventory.`）**：於 `src/orchestrator.ts` 的 `review(code)` 建立審查修訂範圍前，若 `methodInventories` 尚未記錄目前候選的 AST 方法清冊（例如由 Bug Fixer 或算術修復產生的候選），自動呼叫 `await inventoryExecutedBaseline?.(code)` 補齊方法清冊。
  5. **批次輸出 `batch_failure_summary.json`／`batch_failure_summary.md`**：於 `src/pipeline/batchJournal.ts` 新增 `BatchFailureSummary`，統計五類終態分層（`quality-passed`、`usable`、`failed`、`environment-blocked`、`tool-blocked`，合計必等於 `expectedTargets`）、`byStageAndReason`（依 `stage × reasonCode` 計數並附目標清單）、`roleUsability`（各角色回覆可用率）與 `specMismatchCount`（預設 `0`，供後續 PR #8 接續）。
- **回歸與驗收測試**：
  - 由 `gpt_oss20b/bottle_utils_9e53c6fc/html_escape_6d4c4a8f/` 的真實 Reviewer 回覆建立去本機路徑的倉庫內 fixture `test/fixtures/eval_screening/gpt_oss20b/bottle_utils_9e53c6fc/html_escape_6d4c4a8f/reviewer_response_fixture.json`，於 `src/test/reviewContractRepair.test.ts` 驗證「補上特殊字元情境」（`Test only covers empty string; missing scenario for non-empty string with special characters.`）的建議直接傳給 Writer 且 `policy.failureCount === 0`。
  - `npm run check-types` 與 `npm run lint`：0 錯誤。
  - `npm run test:fast`：退出碼 0，Node 776/776、Webview 語法、Python 48/48 全數通過。
  - `npm run test:golden`：退出碼 0，11/11 全數通過（五組 golden 快照零差異，無須重錄）。
  - `python python_scripts/secret_scan.py`：通過。

**歷史接續入口已由上方 Codex 五項清單取代；PR #3 本輪驗證完成後才供使用者驗收，目前禁止 push。PR #4 選配延後建議見第 3 節。**

### 2026-11-08 PR #2 完成（模型篩選工具與評估集）

- **已實作**：
  - `eval/eval-set-v1.json`：由倉庫內 `eval/eval_screening/`（7 個檔案、26 個函式）建立固定版本與固定內容雜湊（`contentHash: 0afe8e4d1147920571949cca7faf67d241e4778faa9ef62b1efb7874c6feec14`）的評估集清單，包含各檔案 SHA-256、26 個目標的 `hasSpec`／`specSources` 分類（有規格來源 18 個、無規格來源 8 個），並將架構文件 6.1 節其餘專案（`markupsafe`、`learn-python`、`bottle` 其餘函式等）列於 `plannedExtensions` 供後續擴充；同時維持 `version: "eval-screening-v1"` 與 `targets` 結構，可直接匯入側欄目標清單。
  - `eval/eval_screening/LICENSES.md`、`eval/README.md`、`eval/eval_screening/README.md`：補齊複製自 Bottle（Marcel Hellkamp）與 validators（Konsta Vesterinen）的 MIT 授權全文與原作者版權聲明，並撰寫評估集與 `eval_aggregate.py` 的操作說明。
  - `python_scripts/eval_aggregate.py`：讀取包含多個模型結果子資料夾的根目錄或多個 `batch_manifest.json`，結合各目標 `function_knowledge.json`（與備援 `quality_baseline.json`／`executable_baseline.json`）及 `role_events.jsonl`，輸出每個模型的完整通過、保留可用、審查阻擋、失敗、其他終態、產生可執行測試數、平均覆蓋率、量到突變分數的數量、平均突變分數、耗時、請求數、輸出 tokens 與輸出截斷次數（`role_events.jsonl` 中 `completionReason == "length"` 的次數），並提供有／無規格來源分開統計；被取消或未完成的批次（如 `mistralnemo12b_2`）自動標示於「被取消或未完成的批次（不列入比較）」，不混入模型比較總表。
  - `test/fixtures/eval_screening/`、`python_scripts/test_eval_aggregate.py`、`test/verificationConfig.js`、`src/test/verificationRunner.test.ts`、`src/test/targetList.test.ts`：新增去本機路徑的精簡批次 fixture（`gpt_oss20b`、`ministral3_14b` 與已取消的 `mistralnemo12b_2`）及單元測試，完全使用倉庫內 fixture 而不依賴 `D:/read` 等本機路徑。
- **回歸通過**（日誌保存於 `log/pr2-*.log`）：
  - 實際實驗室資料驗證：`python python_scripts/eval_aggregate.py D:/read/專題/test/result/model_test --output log/pr2-eval-aggregate-model-test.md`，5 個完成模型（`gpt-oss:20b`、`ministral-3:14b`、`phi4:14b`、`mistral-nemo:12b`、`codellama:13b`）的所有指標與 `docs/模型篩選結果_2026_11_08.md` 完全一致，`mistralnemo12b_2` 正確標示為 `cancelled`（`3／26`、`pending=23`）並排除於比較表外。
  - `npm run test:related -- --node verificationRunner --node targetList --python test_eval_aggregate --python test_skill_ab_summary --python test_fixture_scorecard --python test_lab_batch_plan --python test_secret_scan`：Node 25/25、Python 29/29 通過（`log/pr2-related-full.log`）。
  - `npm run test:fast`：退出碼 0，含 `check-types`、`lint`、Node 774/774、Webview 語法、Python 48/48（`log/pr2-fast.log`）。
  - `python python_scripts/secret_scan.py`：通過。
- **尚需實驗室實測**：`gpt-oss:20b` 的 `localThinkingMode`（`provider-default` vs `disabled`）A/B 實驗室批次實測。

**接續入口：PR #2 已獲使用者驗收通過，並已合併至 `lane_edition` 及 push 至 `origin/lane_edition`；下一個 PR 為 PR #3「成功分層與批次失敗彙總」（見架構文件第 4 節第 15 列與第 9 節 PR #3，包含 2026-11-08 追加的三項需求：①保留的可執行基線一律跑突變測試、②Reviewer `basis` 引用格式不合改當建議傳給 Writer 且不扣失敗額度、③修復 `Review revision requires the current method inventory.` 工具受阻）。**

### 2026-11-08 PR #2a 完成（側欄目標選擇改善）

- **已實作**：
  - `src/pipeline/targetList.ts`：實作 R1 不分大小寫字母排序（`Class.method` 以完整名稱排序，同名函式以檔案相對路徑決勝）、R2 目標清單累加／去重／單項移除／清空、R4 `eval-screening-v1` JSON 匯出入與檔案／函式存在性檢查（明確列出並略過缺漏項目，不靜默忽略）、R5 依正規化專案根保存與還原目標清單狀態（`targetListStateKey`），以及 `createExplicitTargetBatchScope` 與 `resolveExplicitBatchTargets`（逐檔案與逐目標皆執行 `throwIfExecutionCancelled()`）。
  - `src/pipeline/batchScope.ts`：新增 `buildBatchScopeTargetCandidates` 與 `resolveBatchScopeTargets`，支援 R3 批次範圍預覽已選檔案的函式彙整與排序。
  - `src/pipeline/batchJournal.ts`、`src/orchestrator.ts`：`runBatchAnalysis` 支援明確 `targets` 清單並依目標清單順序逐一探索與執行，沿用既有 `BatchJournal`、`batch_manifest.json`、報告、隔離與停止政策；若明確目標清單含有不存在的檔案或函式，不靜默跳過，改以 `batch.discoveryFailed(file, 'target-missing', target)` 記錄，並於 `batch_manifest.json`、`batch_summary.md`、`batch_workflow.md` 與 `failure_report.md` 顯示缺少的目標。
  - `src/ui/SidebarProvider.ts`、`src/ui/webviewContent.ts`、`src/i18n/en.ts`、`src/i18n/zh-tw.ts`：實作側欄檔案／函式排序（R1）、函式勾選清單與全選／全不選／加入目標清單、目標清單區塊（總數、單項移除、清空、匯出／匯入 JSON）（R2／R4）、批次範圍預覽連動測試目標區並隱藏單檔選擇控制項（R3），以及專案根目標清單狀態保存（R5）。
  - `eval/eval_screening/`、`src/test/targetList.test.ts`：將篩選評估集（7 個 `.py`、`targets.json`、`README.md`，不含 `__pycache__`）納入倉庫 `eval/eval_screening/`，移除本機絕對路徑依賴；測試涵蓋 R1～R5、Webview 互動、2 檔 3 函式明確目標清單順序批次整合測試、含 1 個不存在函式的批次整合測試（驗證其餘目標照常執行且 `batch_manifest.json` 與 `batch_summary.md` 列出 `target-missing`），以及匯入 `eval/eval_screening/targets.json`（驗證得到 26 個目標、0 個不存在項目）。
- **回歸通過**（日誌保存於 `log/pr2a-*.log`）：
  - `npm run test:webview`：通過（Webview script 語法與結構驗證）。
  - `npm run test:related -- --node targetList --node batchScope --node batchJournal --node webviewContent --node sidebarPreferences --node sidebarDashboardReplay`：38/38 通過（`log/pr2a-related.log`）。
  - `npm run test:fast`：退出碼 0，含 `check-types`、`lint`、Node 774/774、Webview 語法、Python 44/44（`log/pr2a-fast.log`）。
  - `npm run test:golden`：退出碼 0，11/11 通過，5 個 golden 快照零修改（`log/pr2a-golden.log`）。
- **尚需實驗室實測**：VS Code 實機擴充套件視窗操作與實驗室模型批次驗收。

**接續入口（2026-11-08 更新）：PR #2a 已獲使用者驗收通過，並已合併至 `lane_edition` 及 push 至 `origin/lane_edition`；下一個步驟為 PR #2「模型篩選工具與評估集」（見架構文件第 6 節與第 9 節 PR #2）。** 篩選用評估資料夾已納入倉庫 `eval/eval_screening/`（26 個函式，清單在 `eval/eval_screening/targets.json`），PR #2 建立 `eval/eval-set-v1.json` 時以它為準。

### 2026-11-07 PR #1 使用者驗收通過與主線合併

- 使用者已明確驗收PR #1，並授權將 `codex/pr1-regression-baseline` 合併至 `lane_edition` 與正常push。合併前本機與origin/lane_edition均為050f969，沒有分歧；使用no-ff合併保留PR邊界，原始兩筆內容提交e1bae98／c845d44不改寫。
- PR #1標記完成；第7步驗收／合併流程完成。本次merge commit同時保存此完成紀錄，推送目標僅為origin/lane_edition，遠端同步以本機HEAD與遠端ref一致核對。程式及測試保持已驗收的c845d44內容，本次只補HANDOFF。
- **第6步AOCI仍未完成，保留第4節待辦**，依使用者決定不阻擋PR #2；沒有自行acknowledge人工審查項目。下一個PR對話從PR #2開始。

### 2026-11-07 最新續接：第 4 步已依新標準完成

- Windows 原子改名已改用共用 renameAtomicSync，涵蓋 function_knowledge、batch_manifest、兩個候選 checkpoint 與 target.json 原子移動；僅 win32 + EPERM／EACCES／EBUSY。最多五次總嘗試，退避 20／40／80／160ms 合計300ms；monotonic重試窗口499ms，亦受原 TargetBudget 剩餘時間限制，不重設 deadline。非 Windows／非允許錯誤不重試，無法記錄重試時也保留原 rename 錯誤。
- 每次重試寫入同一產物資料夾的 **journal_io_retries.jsonl**（atomic-rename-retry-v1）；只含目的 basename、錯誤碼、嘗試次數、等待與耗時，不寫絕對路徑／任意錯誤原文。採獨立 append-only I/O journal，避免 record→knowledge→rename 的遞迴，也不把非語義的 OS 波動混進角色決策 golden。
- 新單元測試涵蓋前 N=1..4 次 EPERM 後成功且原 bytes 原子替換、全部五次失敗拋同一原錯誤、EACCES／EBUSY、其他平台／錯誤不重試、原 deadline、monotonic 窗口與 journal 失敗。原生 atomicRename／batchJournal／artifactSafety **14/14** 通過；最終版的日誌 `log/pr1-atomic-rename-final-related-native.log`。
- 最終版在主倉庫以 CodeGraph daemon 持續開啟（每次前後核對 PID37292 與專案命令）連跑 writer-failure **10/10**，每輪 writers=5，原斷言／快照未放寬。腳本 `log/pr1-run-writer-retry-validation.ps1`；逐輪 `log/pr1-rename-final-daemon-active-{1..10}.log`；完整時間與程序證據 `log/pr1-rename-final-daemon-active-results.json`。原先另一組 10/10 也保留，最終驗收以 final 組為準。沒有宣稱十輪一定實際命中 EPERM；重試路徑由故障注入單元測試證明。
- 050f969 副本 772 個 tracked blob 已再度逐檔等於主倉庫的原始 050f969 Git tree，零差異；`log/pr1-comparison-baseline-source-proof.json`。該副本原先是無 .git 的原始碼匯出，已只補上本機 Git 身分／索引（完整 commit 050f9698bab7ccfe143246688808c83fa0c39013），工作檔不改；native git diff為空。第一次用短 ref fetch 失敗，改完整 SHA 後成功，日誌 `log/pr1-baseline-git-setup.log`。
- baseline（session 63623）與 current（22376）完整原生 integration 均已結束。兩版依序使用相同 `log/pr1-run-integration-comparison.ps1 -Version baseline|current`；先完整 inventory、compile，再 Node 與 Python，即使 Node 失敗仍完整執行 Python。TEMP 為等長獨立 compare-base／compare-head，沒有共用殘留目錄。
- 完整結果與逐案比較如下；判定依第 0 節第 11 項，沒有新增失敗或跳過案例。14 個既有 Node 失敗的完整名稱、兩版狀態及診斷行號列第 5 節。相同案例的首個錯誤可能不同，不宣稱兩版根因完全相同。

| 完整驗證 | 050f969 副本 | PR #1 目前版 |
| --- | --- | --- |
| Node integration | 1023 tests；895 pass／126 fail（含 17 父測試）／2 skip | 1038 tests；1019 pass／17 fail（含 3 父測試）／2 skip |
| 實際失敗案例（不重複計父測試） | 109 | 14；全部都在基準失敗清單中，新增 0 |
| Python integration | 841 tests；3 failures／6 skips | 842 tests；0 failures／6 skips |
| 新增跳過／取消 | 比較基準 | Node／Python 新增 skip 均 0；Node cancelled=0 |

- 兩版完整原日誌／獨立階段退出碼及耗時：`D:/read/golden-{baseline-050f969|current-pr1}/log/pr1-comparison-{baseline|current}-{plan|compile|node|python}.log` 與 `...-status.json`。按檔案＋完整巢狀案例名稱比對，行號變動不改身分；比較腳本驗證完整 footer、所有 leaf 失敗及父測試計數，不接受中斷／不完整輸出。結果 `log/pr1-integration-comparison.json`：新增 Node／Python 失敗 0／0；95 個基準 Node 失敗及 3 個 Python 失敗本輪不再失敗；不是宣稱修了 98 個獨立產品 bug。
- current 執行前後 **787 檔零差異**，含所有 tracked 檔與新增 guard／fixture test；`log/pr1-comparison-current-{final-source|start|post-run}-proof.json`。baseline 執行後再核對原始 **772 個 Git blob 零差異**，`log/pr1-comparison-baseline-post-run-proof.json`。本節後續只有文件更新，不改已驗證程式；不得將不同程式版本的測試結果混用。
- 收尾檢查 BMI repair fixture 原填 16384，依已批准 A 類規則改為架構評估的 **8192**；四種情境與原斷言全保留。先原生 related **1/1**（22.79 秒），再納入上述完整 integration 通過；沒有改產品容量設定。`D:/read/golden-current-pr1/log/pr1-comparison-current-fixture-{compile|related}.log`。新 proof 相對前版唯一程式／測試差異就是這一個 fixture。
- 最終 fast 原生退出碼 0，**Node774／774、Python44／44**，含 check-types／lint／Webview；85.87 秒，`log/pr1-final-fast-native.log`／`...-status.json`。Python fast 4 模組加 integration 52 模組覆蓋全部 56 模組、886 tests（6 skips）。166 個 Python 檔案與先前完整 886 tests＋history secret scan 成功版本逐檔相同，`log/pr1-python-unchanged-since-full-v4.json`。
- 最新完整 integration 中 **golden11／11** 再次只比對通過，五個情境全過，writer-failure writers=5／2746.397ms；原日誌行469～485。快照相對 e1bae98 未變，沒有重錄目前版本來遮蔽差異。Tier1 corpus 也完整通過（228.33秒）。
- 本輪 AOCI 已完整交付14塊並確認，嚴格驗證為 partial（8/10），正式索引仍 dirty/stale，不宣稱目前完整系統認知可靠。維護依使用者 11/7 決定延後，不阻擋 PR #2；未自行 acknowledge 人工審查項目。
- 第4.5步已完成：PROJECT_RULES頂端依最新架構0.1／1.3改為單一spec oracle、auto／off、規格分級及獨立k次盲測；CHANGELOG本筆5行，明列品質Reviewer與Analyst-規格的區別。架構文件納入版本控制，未實作後續PR的產品分流／提示，也不改v1預設。
- 第5步完成：七筆本任務WIP／中間提交已整併；PR #1內容維持兩筆提交，安全網 **e1bae98** 與回歸修復 **c845d44**。本次驗收合併另以merge commit納入主線與HANDOFF完成紀錄，不重寫這兩筆已驗收提交。提交前 `git diff --cached --check` 與完整歷史憑證掃描皆退出碼0，後者日誌 `log/pr1-final-secret-scan.log`。未加入使用者的Claude outputs／交接提示詞／舊重構計畫。
- 驗證後只更新上述四份規則／交接文件並新增架構文件，其他783個既有物件仍完全等於完整驗證版本，`log/pr1-final-program-freeze-proof.json`。最終文件同步後主倉庫與目前副本 **788個tracked檔零差異**，`log/pr1-final-current-copy-source-proof.json`；Git HEAD可因本次WIP整併而不同，程式／測試位元組相同，不能用舊HEAD名稱誤判程式漂移。

### 2026-11-06 驗證過程（歷史；已由上節完整比較取代）

以下保留當時局部驗證與判斷依據；最新完成狀態及剩餘案例以 11/7 完整比較與第 5 節為準。

| 進度 | 已完成與證據 |
| --- | --- |
| dependencyMockRepair 2300 | 使用者附條件批准已完成。長／短 cwd 的完整提示 hash 與估算相同、均無路徑；8fb075f=2025／050f969=2229。保留 79 行來源與其餘斷言，旁註新增 mapping-key type／source-awaited async 指引約 204 tokens。v5 相關 57/57 通過；`log/pr1-execution-prompt-path-audit.json`。第 3 節已移除。 |
| BMI fixture 8192 | 使用者 11/06 附條件批准已完成並通過 v11。固定短路徑與長路徑、兩版最低總 context／輸入完全相同。6982 是最低總 context，最大完整輸入 5446；8192 基礎預算 5734，而既有 seed 輸出 cap=1536，實際 paired inputBudget=6656。測試分別核對兩種預算、wire num_ctx、AST 完整函式逐字出現、caller 提示、四函式實跑、來源及舊初始化設定不變，且沒有 context-grown。沒有截斷或增容；另以不改測試／產品的 fetch audit 記錄四個實際請求估算，仍為 4809／5446／3484／4299，Context=8192、output=1536，native 再過 1/1；`D:/read/golden-current-pr1/log/pr1-bmi-8192-wire-audit.log`，audit hook 在主倉庫 `log/pr1-bmi-wire-budget-audit.cjs`。產品設定與提示不變。第 5 節已加實驗室提醒，第 0 節第 9 項已記錄今後對齊 8192 視為 A；第 3 節已移除。 |
| provider envelope C 類 | 已套用 isModelContentFormatError：保留 model-format 診斷，stage=model-response 不做模型內容補問、不扣 failureLimit。涵蓋 Analyst／Reviewer／Quality Analyst／Writer execution／candidate revision／orchestrator catch；原 malformed HTTP 200 單次請求、HTTP 重試計時與真正模型格式補正斷言保留，v5 57/57、v8 原生 Analyst timing 全部通過。 |
| A 類診斷／metadata | v6 修正版 94/106：probe options 補原有 num_predict=1024、Sidebar thinkingMode、safe handoff 去除 resource／fixtureExample、precheck／Reviewer 固定原因碼、non-class import、seed literal 顯示與 Writer structure fixture 等已通過。captureFetchFixture 顯示被產品去密遮蔽的原測試 assertion，先用於 generatedTransport／BMI preservation／Writer revision；不改產品去密。 |
| A 類固定回覆契約 | 8fb075f 已要求單方法／單呼叫 seed。contextGrowth／batchQualificationReuse／Analyst timing／stream 的舊多呼叫回覆改成單呼叫；有選定 observed case 時使用原封包，沒有時保留原 fixture 既有固定控制案例，不偽造觀測。metadata 獨立於生成。generatedTransport 保留 literal marker、加來源 caller 並只呼叫一次，三情境均通過。執行、同候選審查、完整突變分數與來源保留斷言不動。 |
| A 類停止政策／診斷 | batchReadyMutation 的注入 static tool fault、writerAdditionNaming 的注入 inventory 破壞分類改 tool，仍禁止模型修工具與額外量測，v7 通過。batchQualificationReuse 明確選 batchFailureLimit=1 的情境仍只實跑第一目標；另一目標是 policy-not-run 且 0 requests／無成果目錄，不再把它當實跑或 pending，v10 全部通過。runtimeContext 的 whole-file 情境依已批准預設 0 繼續兩目標，仍要求同一凍結容量；嚴格資格負例明確指定 requireRoleQualification=true。 |
| A 類取消所有權 | orchestratorLifecycle 原測試期待 abort 立即 analysisFinished／同時開新 scan，與 8fb075f 既有「取消後清理前仍持有所有權」契約相反。現在核對 analysisStopping、清理前拒絕新 scan、清理後才完成／重啟，以及兩次獨立快照／manifest。v8 原生通過；產品未改。 |

驗證狀態：
- v4 全量：fast Node 774／Python 44 通過；related Node 83／Python 86（1 skip）通過；完整 Python **886 tests／6 skips**，含 history secret scan，退出碼 0。**integration 退出碼 1：Node 1033 tests／956 pass／75 fail／2 skip（含父測試）**；後續 52 個 Python integration 檔沒有執行。完整原失敗為 62 leaf／34 檔，`log/pr1-integration-v4-failure-details.json`。
- v5：政策與 fixture 57/57；malformed provider JSON 原生單次請求另通過。
- v6：13 檔 **94/106**，詳 `log/pr1-v6-failure-details.json`。剩餘失敗已用診斷判讀，沒有只抹掉斷言。
- v7：13 檔 **32/51**；這是較舊固定版本，單一 seed 缺 observed case 的 fixture 問題於 v8 修正；`log/pr1-v7-failure-details.json`。tool fault、Writer addition inventory／naming 全四情境、focused workflow 全部正負案例、generated transport 三情境已通過。
- v8 主倉庫：6 檔 **21/23**；只剩 batch policy-not-run 的 helper TypeError（含父計數），已於 v10 修正；Analyst timing／context growth／stream transport／取消所有權／共用角色 fixture 全部通過。
- v10：3 檔 **5/7**；batch qualification 全部通過，BMI 的 paired budget 斷言與 runtimeContext 舊預設假設未過，已續修。
- v11：4 檔 **6/7**；**BMI、execution、captured-capacity 三情境均通過**。只剩 runtimeContext 的舊容量診斷／第二個 whole-file 舊計數，後續 v12 已排除診斷問題，最新計數依批准預設修正，v13 runtime 相關已通過。`log/pr1-v11-failure-details.json`。
- v13 逐檔 proof：**784 檔零差異**，`log/pr1-current-copy-source-proof-20261106-v13.json`。此後只有文件更新，不改已凍結的程式。副本依序完成 runtime 相關 **1/1**（49.58 秒）、fast **Node 774／Python 44**（74.52 秒；含 types／lint／Webview）、golden **11/11**（239.97 秒），三階段退出碼皆 0，session 15939 已結束。獨立退出碼／耗時在 `D:/read/golden-current-pr1/log/pr1-v13-native-status.json`，日誌 `log/pr1-v13-{runtime|fast|golden}-native.log`。golden 只比對，沒有 update；五份 fixtures 相對 e1bae98 無修改。這仍不是完整 integration 通過。交接文件納入 WIP commit 後再核對 **785 檔零差異**，包含所有 tracked 檔與兩個新增程式／測試；最終證據為 `log/pr1-current-copy-source-proof-20261106-handoff.json`。main／copy HEAD 不同只因文件 WIP 歷史，這裡以實際位元組而非相同 HEAD 證明程式同步。

以下為 v13 當時待驗清單（歷史；現在的剩餘案例只看第 5 節，不據此重跑已通過的測試）：
1. `bmiFocusedExpansionIntegration`：mutatest 保留後失敗、fallback 次數；原完整錯誤在 v4 details，未放寬 preserved seed。
2. `bmiPreservationIntegration`：v7 已正確走 addition，第一個故意修改 passing test 的回覆被 existing-test-method-changed 擋住；原測試卻期望再補問一次，需比對既有 scope／停止政策，不可接受弱化。
3. `mutationImprovementIntegration`、`numericSkillIntegration`、`parameterFixturePipelineIntegration`、`roleOrchestratorIntegration`：仍需逐項追角色／method-edit／addition 契約；必要時沿 captureFetchFixture 顯示測試 callback assertion，不改產品去密。
4. `reviewerDemoIntegration`：仍以舊 Writer system prose 辨識修訂，且 invalid Reviewer 期望兩次，與已批准 failureLimit=5 不一致；先辨識版本化 scope、核對保留原門檻，不盲目改通過條件。
5. `writerOutputRecoveryIntegration`：remaining repeat-length／measured-too-slow／qualification-consumed-retry；先查 callback assertion，部分計數可能是被包成 transport error 的測試例外，不先改預算。
6. `writerRevisionOutputIntegration`：captureFetchFixture 已確認原固定8192斷言遇到實際11264，以及 manyCandidate 全文次數為0；synthetic source padding 450、Reviewer growth、host 選定 addition 方法名稱／方法 scope 尚待核對，勿直接放寬完整證據／paired budget 斷言。
7. `tier1CorpusIntegration`：只有已批准 probe args／kwargs 的固定資料讀法修正，尚未重跑該長測試；完成以上修復後跑一次完整 integration（含後續 Python integration）才可勾第 4 步。

PROJECT_RULES／CHANGELOG 頂端仍是舊兩模式文字，第 4.5 步尚未執行。AOCI 已完整交付 14 塊並確認，但嚴格 attestation 格式未完成，索引 dirty/stale；本輪未 maintain，依既定步驟待管理物件最終穩定後執行一次，不自行 acknowledge 人工項目。

### 2026-11-05 第 4 步前：未提交修改與失敗分類

下列修改尚未 commit；沒有改變斷言的接受條件、產品提示、預算或重試政策。

| 修改 | 原失敗與根本原因 | 分類與回歸證據 |
| --- | --- | --- |
| Reviewer 固定回覆工具：27 個檔案的角色分支、2 個整合測試的排除斷言，另有 shared helper／格式斷言 | 050f969 已批准的正式提示為 `You are the Python unittest Reviewer`，舊 fixture 仍比對 `You are the test Reviewer`，使 Reviewer 請求落到 Writer 回覆分支；首輪 integration 因此出現多個 Analyst recovery／BMI／mutation 等失敗。改以既有解析器辨識的第一個正式 `REVIEW_REQUEST_V7/V8` envelope 決定 `isReviewer`，不搜尋證據內引用、不改傳輸內容。 | **A 類：只修測試角色辨識**。`ollamaRequestFixture.test.ts` 新增正式提示／改寫提示／CRLF／其他角色引用 Reviewer 名稱及 envelope 的正負案例，並核對 transmittedPrompt 不變；兩個排除斷言仍明確禁止 Reviewer。27 檔清單：`log/pr1-reviewer-fixture-updates.txt`。 |
| `python_scripts/target_bindings.py` | 完整 Python 的 `StructureEvidenceTests.test_result_shape_transforms_subtests_and_module_alias` 失敗；050f969 的新 binding 掃描把 `For` 整塊視為未知，連穩定 canonical target 在 for／subTest 中的直接呼叫也漏掉。原測試在 050f969 同樣失敗，8fb075f 通過。 | **C 類：恢復既有正向契約**。迴圈僅沿穩定的迴圈前綁定辨識呼叫，撤銷迴圈中所有寫入／刪除的綁定，不從迴圈內建立或恢復 alias 證據。新增 `TargetAliasBindingsTests.test_loops_keep_stable_target_calls_but_never_create_or_restore_alias_proof`，涵蓋 canonical 正例及新 alias、迴圈變數、迴圈內／之後重綁的反例；保留原正向測試。 |
| `python_scripts/plan_import_initialization.py` | `StaticInitializationPlanTests.test_arbitrary_mkdir_receivers_and_non_idempotent_calls_are_not_proposed` 的 `result = Path(...).mkdir(...)`，以及 `test_nested_dynamic_helpers_constructors_and_result_used_calls_are_not_proposed` 的 `result = backend.launch(callback)` 失敗。掃描 Assign／AnnAssign 時丟失「回傳值被使用」狀態，誤把不應提案的初始化當作 discarded call；050f969、8fb075f 均可重現。 | **C 類：修正既有 return-discarded 契約違反**。明確傳遞 return_used，拒絕被使用回傳值的 mkdir／entry-point，保留原本允許使用回傳值的 read-file。對應兩個原有負向測試與既有 read-file／entry-point 正向測試，未改期望值。 |

- 首輪原生 fast 通過 Node 774／Python 44；related 通過 Node 70／Python 37（1 skip）。完整 Python 為 885 tests、3 failures、6 skips，正是上表三個 subcase；未完成 secret history scan。舊版 integration 已因上述 fixture 問題中斷，**不能算完整驗證通過**。保留副本 `log/pr1-final-*-native.log`。
- C 類修復後，三個 Python 模組原生相關回歸 **49/49 通過**（1.616 秒），日誌 `log/pr1-python-c-fixes-related-native.log`。新的完整驗證尚待本節同步檢查與 EPERM 對照完成。
- 隔離副本於 2026-11-05 14:09:27 UTC 逐檔核對 **784 個檔案、零差異**，兩邊 HEAD 都是 `0e6584c9f8cdf1eaeec68708c3fa23f8a3af9f7e`；包含所有 tracked 檔案與兩個新增程式／測試。完整逐檔 SHA-256 證據：`log/pr1-current-copy-source-proof-20261105.json`。其後本檔的文件更新不改變已驗證程式；任何程式再改，先同步並重建證據，舊版本結果不算新版本結果。
- 修復後 focused related 為 **28/32 通過、4 failures**（含父測試計數），日誌在副本 `log/pr1-c-fixture-focused-native.log`。Reviewer helper 正負測試通過；剩餘為 Analyst repeat-length／missing-counts-repeat（觀察到 5 次請求，原斷言期望 2）及 BMI repair（4096 測試容量不足，未送出 Writer）。尚未修改這些斷言；先查明已批准 failureLimit 與 fixture 容量設定的影響。新一輪完整 Python／integration 尚未啟動，第 4 步未勾選。
- 後續判斷（A 類，測試設定修正）：Analyst 測的是「同一 semantic stage 最多一次輸出恢復」，但已批准的預設 failureLimit=5 會允許後續 target attempt；maxLoops=1 不等同 failureLimit。先前嘗試指定 failureLimit=1 的 focused v2 失敗，因第一次 length 本身即扣額度，只送 1 次而非原期望 2；保留失敗日誌，不當作通過。依 requestBudgeted 的 outputAttempt>0／beginAttempt 與 reject 計數，fixture 改為 failureLimit=2，足以容納首次 length 和一次恢復，仍保留原有總請求數=2、相同提示與原期限等全部斷言，產品預設／重試完全不動。
- BMI repair 明確供給 runtimeContextTokens=16384；focused v2 已讓 corrected 情境通過，接著 dropped-case 因預設 failureLimit=5 多送請求而 7≠4 失敗。fixture 明確指定 failureLimit=4，對應初次結構拒絕、native 失敗、無效方法修復與最後 Writer 接手的原四回覆測試；保留四次請求、成功／失敗、原始碼與原案例保留等全部斷言。這兩項待重新同步與 focused v3 驗證後才能算通過；不改產品停止政策。
- focused v3：Analyst 與共用 fixture 全過；BMI 的 dropped-case 已符合原四次請求與 failed 終態，但原人類文字斷言被批准的 failure-limit 終態摘要取代。只把該診斷斷言改為 failureCategory=validation 且 diagnostic.reasonCode=candidate-regression，仍要求丟失已通過案例被拒，沒有接受丟失案例；待 focused v4 驗證。v2／v3 原失敗日誌保留。
- focused v4 的 BMI repair 四情境全部通過（24.215 秒；Node 父測試 1/1），`log/pr1-c-fixture-focused-native-v4.log`。Analyst／shared helper 的正負案例已在 v3 通過；三個 Python C 類相關模組 49/49 另已原生通過。上述未提交程式達本輪穩定點，接著重新同步與逐檔 proof v4，執行 fast → related → 完整 Python → integration；完整結束前不勾選第 4 步。
- 第 ① 項已用真 Python 分清：單純 stdout 與合法 scoped serializer mock 仍 exit 0／passed，沒有污染獨立的 runner result／invocation 檔；候選直接改寫 result.json、持續 json.dump／JSONEncoder／cached encoder monkeypatch 與背景 serializer 干擾則 exit 86／isolation-blocked，分類 validation，未落入 tool 診斷無法驗證路徑。7 個正負案例在 `generatedRunnerDiagnostics.test.ts`；新版 related 已含這些案例並 Node **83/83** 通過。相關 Python **86 項 OK（1 skip）**，fast Node **774/774**／Python **44/44**。完整 Python／integration 仍待完成。
- 新版完整 Python 已於 **2026-11-05 14:53:15 UTC 通過**：886 tests、6 skips、無 failures，unittest 1041.996 秒；含歷史憑證掃描的整個命令退出碼 0，1091.38 秒。原先三個失敗已消除；日誌 `D:/read/golden-current-pr1/log/pr1-final-v4-python-native.log`。同一凍結版本接著啟動 integration，**尚未完成**。相關 Node 的五條 golden 也再次全過，writer-failure writers=5／3522.121ms，未重錄快照。
- **已完成（詳本節 2026-11-06；下列保留原 v4 決策證據）**：dependencyMockRepair 的單一測試上限 2000→2300，保留原 79 行完整中性來源及其餘斷言，產品提示／實際設定不動。使用者要求的路徑查核已通過：evidence、user prompt、兩版 system prompt 均無 Windows／UNC／POSIX 絕對路徑、倉庫路徑或名稱；在主倉庫長路徑與 D:/read 下，各提示 SHA-256 與最低估算都相同。8fb075f=2025、050f969=2229，差 204；新增內容是 SOURCE_INPUT_SHAPE_GUIDANCE 接入 MAPPING_KEY_TYPE_GUIDANCE 與 SOURCE_ASYNC_CONTROL_GUIDANCE。測試旁需加一行原因註解。`log/pr1-execution-prompt-path-audit.json` 保存完整對照；初次受限 chdir 未完成，已原生重跑成功，未據該權限錯誤修改產品。此項不再等待使用者決定，已從第 3 節移除；當前 v4 程式／測試仍凍結以收集完整失敗，新版本同步後才重驗。
- v4 integration 的兩個毫秒級失敗已另外在獨立 TEMP 重現（未改凍結程式）：`batchPreflightJournal` 的 fixture 主動建立 failed/validation 目標＋environment-blocked 目標，卻期望 batch.partial；8fb075f／050f969 的 finish 原碼都以非環境失敗優先，實際 failed 正確，complete 仍 false。`batchRepairRegression` 的重複 Writer 案例未建立 TargetStopPolicy，卻期望 revise 2 次；兩版原碼都在第一次重複 Writer 後 break，實際 1 次，execute／review 各 1 次才符合該測試「不重跑」意圖。屬測試假設修正，不改產品失敗定義或重試；待 v4 結束後同步更新。詳細診斷在副本 `log/pr1-integration-v4-unit-diagnostics.log`。其他 integration 失敗仍待完整摘要，不能籠統標為 A 類。
- **已修復 C 類（詳本節 2026-11-06；下列保留原發現）**：`analystTransportTimingIntegration` 的 malformed HTTP 200 provider JSON 原本必須只發 1 次；單獨保留原斷言重現為 **5≠1**（`log/pr1-provider-envelope-diagnostic.log`）。`semanticWithContractRepair` 050f969 新 catch 將所有 model-format 例外都消耗 failureLimit 後重問，包含 stage=model-response 的 provider envelope 語法錯誤，違反原本「只補正已返回的模型內容、transport error 直接傳遞」契約。不能把測試改成接受 5。應區分 provider response envelope 與真實模型輸出格式失敗，前者不消耗模型額度／不做角色格式補問；真實模型輸出仍沿已批准 failureLimit。已查到 Reviewer／Quality Analyst／execution Writer／candidate revision 與 orchestrator 生成路徑的同類 catch，需一併處理並補跨角色回歸，保留原 model-format 診斷分類與原生 timing／單次請求斷言。五條既有 golden 沒有 malformed provider envelope；修後仍須只比對，不重錄。

### 2026-11-05 最新結論：步驟 2 完成

- 新版 harness 在乾淨 050f969 副本錄製 **11/11**，目前版本隔離副本完整比對 **11/11**。成功後才由獨立基準更新主倉庫的五份 fixtures，沒有用目前版本重錄來掩蓋差異。
- 原 050f969 的 772 個 tracked blob 全部核對相同；目前隔離副本的 775 個檔案與工作區逐檔相同。兩邊只共用 node_modules／.venv 工具，未把 PR #1 產品修復帶入基準。證據：`log/pr1-writer-final-source-proof.json`。
- 最新 orchestratorGolden.test.ts SHA-256：`e4c22e3e014f1076936754714096e576066ceb3260f8c49124e80d98989ab202`；run_golden_tests.js：`2dbab35f73d9b92007f735c3fb97d9954296f21fc49686840a496cde23d3d0c2`。原始基準產品 commit 為 `050f9698bab7ccfe143246688808c83fa0c39013`。
- 上述 golden 比對時的產品修改限先前 runner evidence guard 等 PR #1 修復；其後完整驗證另發現並修復的兩項 C 類問題列於本節最上方，仍須重新完成驗證。`writers >= 2`、停止政策、預算與產品重試都未放寬。

### writer-failure 不穩定來源與證據

1. 原工作區 isolated 1：writers=0、requests=[]，2290.229ms，lastFailure 與 rename 錯誤記錄均為 `function_knowledge.pending.json -> function_knowledge.json` 的 **EPERM**，發生於模型傳輸前。接著兩次同指令通過（writers=5，3540.605ms、3673.088ms）。完整檔案在 `log/golden-failure-writer-failure/run-1/`，日誌 `log/pr1-writer-isolated-current-{1..3}.log`。沒有 timeout／預算耗盡證據，不能歸因模型生成或改變重試標準。
2. 保存流程原先的 fs.cpSync 對這批中文路徑可獨立重現 Node v24.14.1 退出碼 `-1073740791`；逐檔排他 copyFileSync 成功。harness 改為先寫 diagnostic.json，再逐檔複製；新增中文巢狀檔案位元組保真、不覆蓋驗證。每次失敗保存於 `log/golden-failure-<scenario>/run-N/`，包含 writers、角色／順序、terminalStatus／lastFailure、最後 10 筆事件、最後 30 筆 log、rename 錯誤；診斷不改變原錯誤與斷言。
3. 原工作區完整三輪：第 1 輪 writer-failure 通過（5 次，3528.304ms）；第 2 輪在 full 因額外 recovery-stage-planned 事件導致快照不同，保存時被 fs.cpSync 終止；第 3 輪因遺留 runtime 而 EEXIST。後兩輪未測到 writer-failure，不能算它的失敗。遺留目錄完整移至 `log/pr1-interrupted-current-2/`；沒有刪除或忽略失敗。
4. 工作區 log 與 D:/read 各 1000 次簡單 rename 對照都無錯誤（`log/pr1-rename-location-probe.json`）；目前只證明實際 journal 曾有間歇 EPERM，**造成鎖定的外部程序尚未識別**。journal 寫入程式與 050f969 相同，此失敗在 Writer／生成 runner 前，沒有證據由 PR #1 的 Python evidence guard 造成。
5. 改以來源完全相同、倉庫外的 `D:/read/golden-current-pr1/` 作原生驗證（保留同 Git 歷史），避免工作區輸出干擾。三輪完整順序 full 均 terminalStatus=passed、renameFailures=[]，正規化快照 hash 同為 `83cdbd07b84343f72044adba5b97ca3fef54849e11983e21d56a6a0e5cf3312a`，只與舊基準差五處 coverage 欄寬。這是有界驗證與執行隔離，不代表已識別外部鎖定程序，也沒有加入 rename 重試或改寫產品原子發布。

### 相同指令的 3＋2 次完整順序結果

五輪皆執行 `node test/run_golden_tests.js`，設定 PYTHONUTF8=1、PYTHONIOENCODING=utf-8、ORCHESTRATOR_GOLDEN_FIXTURES 指向基準快照，省略 ORCHESTRATOR_GOLDEN_SCENARIO，順序皆為 full → execution → writer-failure → stub → batch。

| 版本／輪次 | writer-failure | writers | 耗時 ms | 整輪狀態 |
| --- | --- | --- | --- | --- |
| 目前版本副本 1 | passed | 5 | 2306.234 | 8/10，僅 full coverage 欄寬與父測試失敗 |
| 目前版本副本 2 | passed | 5 | 2322.334 | 同上 |
| 目前版本副本 3 | passed | 5 | 2261.750 | 同上，三輪 full hash 一致 |
| 050f969 副本 1 | passed | 5 | 2235.731 | 10/10 |
| 050f969 副本 2 | passed | 5 | 2616.637 | 10/10 |

逐輪日誌在各副本 `log/pr1-writer-stable-full-{current|baseline}-{N}.log`；摘要 `log/pr1-writer-stability-results.json`。原副本較早兩輪完整順序也通過，writer-failure 為 2317.984ms、2347.068ms。

### 最終錄製／比對與快照發布

- 新增 coverage 排版正規化後同步相同 harness；五個單元測試通過。於 `D:/read/golden-baseline-050f969` 執行 `node test/run_golden_tests.js --update` 得 11/11，再於來源逐檔相同的 `D:/read/golden-current-pr1` 執行 `node test/run_golden_tests.js` 得 11/11。ORCHESTRATOR_GOLDEN_FIXTURES 均指向基準快照；前者明確 update、後者只比對。
- 最終日誌：基準 `log/pr1-writer-final-record.log`、目前副本 `log/pr1-writer-final-compare.log`。full 覆蓋率、突變、計數、角色順序與提示 hash 等全部一致；writer-failure 最終比對 writers=5、2294.695ms。
- 比對成功後才更新主倉庫 fixtures；新 full SHA-256：`3e34dae92aad04f85d28b2a1cf433422fab3fe67b87004493aab2ab9767272e3`，batch：`7db9f1c4ff8efa44744e3a3b624ab690808f76c428a4ff5a6436f3a880601593`。execution／writer-failure／stub 位元組未變。完整新舊 hash 在 source proof JSON。
- `ORCHESTRATOR_GOLDEN_SCENARIO` 可單獨診斷指定情境，省略仍執行全部；失敗保存目錄逐次增加，不覆蓋舊證據。未執行真實模型或跨平台驗收。

### 路徑衍生 hash／識別碼查核清單

已搜尋 src／python_scripts 的 hash 建立與包裝函式，並盤點五份快照的 hash／identity 欄位；完整說明與來源見詳細紀錄。

| 欄位／來源 | 結論 |
| --- | --- |
| coverage 純文字表格 | 僅正規化由路徑長度衍生的欄位空白與分隔線長度；完整保留檔名、所有數字、百分比與缺漏行號，其他文字空白不動 |
| batchScope.scopeId | 本輪新增「原 body 驗證後，只正規化 root 重算」；跨副本 batch 已完全相同 |
| Trace case_id | 既有 harness 去除 path/input digest，保留 run＋index 與完整 typed input／觀測；本輪未再刪欄位 |
| requestBodyHash／promptHash | 既有 wire hash 對應與正規化完整提示重新 hash，保留角色、順序、內容 |
| analysisOutput sourceKeyHash／目錄 ID | 五情境提供 projectRoot，使用相對 source key；絕對路徑 fallback 未觸發，保留原值 |
| batchScopeStateKey | 本機選取儲存鍵，不在五份快照 |
| modulePreflight preflightKey／sourceSetHash | 路徑與來源集／環境身分，不在五份快照 |
| BatchRuntimeQualification scopeIdentity／pythonIdentity／preferenceKey | 執行內快取，不在五份快照 |
| importFixtures plan.id／quality experiment importFixturePlanHash | 本次 fixtureId 為 null，未出現計畫 hash |
| pythonInstallationPlan.id／resourceSetupController 草稿 ID | 本次未觸發安裝／資源設定 |
| isolated_resources namespace／cache key、runtime_policy resource diagnostic ID | 本次未觸發相關資源，快照未含該 ID |
| target_invocation marshal code hash | 含 filename，但本次快照 codeHash 是候選文字 hash，非該 code object hash |
| source／test／variant／candidateSet／policy 等內容 hash | 非絕對路徑衍生，完整保留 |

沒有其他已出現在五份快照中的同類路徑 hash 需要新增處理。未出現的快取／資源 hash 沒有盲目替換；日後若納入情境，須取得原始 preimage 驗證後重算。

### 下一步（依序）

- [x] 1. 只改測試：固定 TEMP／TMP／TMPDIR 與 mutant output 穩定摘要，補診斷與可靠保存；斷言不放寬。
- [x] 2. 完成 050f969 獨立錄製與目前版本跨副本完整比對（11/11）後，才更新 fixtures；scopeId、coverage 排版皆先保留證據並驗證量測／內容不變。
- [x] 3. 舊基準已移至 `D:/read/golden-baseline-8fb075f/`，一般暫存已移至 `D:/read/pr1-temp/`；原位置已不存在。完整驗證暫存使用 `D:/read/pr1-temp/verification/`。
- [x] 4. 完成兩版完整原生 Node＋Python integration，逐案比對新增失敗 0、增加 skip 0；最新 fast774／44、golden11／11 皆通過。14 個既有 leaf 失敗列第 5 節，依 11/7 標準不阻擋 PR #1，沒有宣稱 integration 全綠。
- [x] 4.5. PROJECT_RULES 頂端已改為最新單一 spec oracle 流程、不做錯誤定位；CHANGELOG同步更新並保持本筆最多5行，架構文件納入版本控制。只改文件，產品分流依後續PR。
- [x] 5. 最終兩筆提交：`e1bae98` golden安全網＋唯一的 `fix: restore PR1 regression contracts / 修復 PR1 回歸契約`；其餘本任務WIP已整併。提交前檢查與歷史憑證掃描通過，使用者未追蹤文件保留原狀。
- [ ] 6. AOCI 維護依 11/7 使用者決定可延後，不阻擋 PR #2；日後只在最終穩定狀態維護一次，受阻列人工項目，不自行 acknowledge。
- [x] 7. 使用者已驗收PR #1；本次合併至lane_edition並依授權正常push至origin/lane_edition，以本機HEAD與遠端ref一致核對。

**歷史接續說明（PR #1 完成時）：** 先完整讀本檔與架構0.1／1.3，再依第9節PR #2範圍及6.1／6.2評估設定執行；依架構的一PR一對話規則，本對話只完成PR #1。第6步AOCI與第5節既有失敗保留追蹤，不阻擋PR #2。PR #1已經使用者驗收並合併主線，第7步門檻已通過。真實模型／GPU及跨平台驗收仍需實驗室執行。

---

## 3. 需要使用者決定

PR #4 是選配，建議延後，下一步直接做 PR #5（待使用者確認）。本輪僅記錄建議，未開始其他 PR。Windows 原子改名有限重試已依 11/7 批准條件完成。

---

## 4. AOCI 待辦（由具工具能力的 agent 處理）

- 2026-11-08（Codex／PR #3 續接）：本次工具清單沒有 AOCI MCP，依使用者指示跳過；請具 AOCI 能力的後續 agent 在穩定狀態維護一次。除原 PR #3 清單外，納入 `src/pipeline/targetReport.ts`、`src/test/tieredSuccessIntegration.test.ts` 與本輪三個既有整合測試更新。未修改 `.aoci/` 或 `.codex/`，未假稱已完成維護。

- 2026-11-08（PR #3）：Antigravity 無 AOCI MCP 工具，請 Codex 對 PR #3 新增與修改的受管理檔案執行 `aoci_maintain`：`src/roles/reviewEvidenceBasis.ts`、`src/roles/testReviewer.ts`、`src/roles/reviewContractRepair.ts`、`src/pipeline/testCandidatePipeline.ts`、`src/orchestrator.ts`、`src/pipeline/resultPresentation.ts`、`src/pipeline/batchJournal.ts`、`src/test/reviewContractRepair.test.ts`、`src/test/resultPresentation.test.ts`、`src/test/batchJournal.test.ts`、`test/fixtures/eval_screening/gpt_oss20b/bottle_utils_9e53c6fc/html_escape_6d4c4a8f/reviewer_response_fixture.json`。
- 2026-11-08（PR #2）：Antigravity 無 AOCI MCP 工具，請 Codex 對 PR #2 新增與修改的受管理檔案執行 `aoci_maintain`：`eval/eval-set-v1.json`、`eval/README.md`、`eval/eval_screening/LICENSES.md`、`eval/eval_screening/README.md`、`python_scripts/eval_aggregate.py`、`python_scripts/test_eval_aggregate.py`、`test/verificationConfig.js`、`src/test/verificationRunner.test.ts`、`src/test/targetList.test.ts`。
- 2026-11-08（PR #2a）：Antigravity 無 AOCI MCP 工具，請 Codex 對 PR #2a 新增與修改的受管理檔案執行 `aoci_maintain`：`src/pipeline/targetList.ts`、`src/pipeline/batchScope.ts`、`src/pipeline/batchJournal.ts`、`src/orchestrator.ts`、`src/ui/SidebarProvider.ts`、`src/ui/webviewContent.ts`、`src/i18n/en.ts`、`src/i18n/zh-tw.ts`、`src/test/targetList.test.ts`、`eval/eval_screening/*`。
- 2026-11-04：PR #1 收尾時 `aoci_maintain` 受阻，原因是 1,210 筆 observe 變化待覆核，以及 8 個人工審查項目。完成第 2 節步驟 3 後再試一次。

---

## 5. 已知問題與注意事項

### 2026-11-07 Windows 原子 rename 最終驗證

已依使用者 B 類批准完成五次總嘗試／四段退避，原錯誤與原期限保留；atomicRename／batchJournal／artifactSafety 原生相關測試14/14。主倉庫 CodeGraph daemon 始終開啟（各輪前後 PID37292 與命令核對），writer-failure 連續10/10、每輪writers=5，原 writers>=2 與快照未放寬。十次命令牆鐘時間3.80～4.43秒，合計40.43秒；逐輪程序／時間／退出碼見 log/pr1-rename-final-daemon-active-results.json。真實十輪不代表每輪命中EPERM；故障注入單元測試證明前N次失敗後成功與全部失敗原樣拋錯。鎖定肇因仍只有先前監看相關性證據，沒有宣稱唯一原因。第3節已無此待決項目。

### 2026-11-07 既有失敗清單（050f969／PR #1 完整原生比對）

以下每個案例在原始 050f969 的本輪完整執行都已失敗；PR #1 沒有新增失敗。依 11/7 完成標準，這些未修完的既有案例不阻擋 PR #1。

同一案例在兩版的第一個錯誤可能不同；表格只證明失敗案例身分相同，不宣稱根本原因完全相同。完整錯誤與原日誌行號保存在比較 JSON。

| 檔案／完整案例名稱 | 050f969 實際狀態／首個診斷 | PR #1 實際狀態／首個診斷 |
| --- | --- | --- |
| `src/test/bmiFocusedExpansionIntegration.test.ts`<br>BMI keeps an executed seed, rejects wrong quality/review advice and verifies real addition coverage and mutation > the real mutatest engine measures a preserved seed plus independently reviewed additions | failed（log:1382） AssertionError（完整事件／狀態見比較 JSON）；0 !== 1 | failed（log:1092） AssertionError（完整事件／狀態見比較 JSON）；+ 'retained-after-failure' / - 'passed' |
| `src/test/bmiFocusedExpansionIntegration.test.ts`<br>BMI keeps an executed seed, rejects wrong quality/review advice and verifies real addition coverage and mutation > a modified passing seed is rejected before a second execution, review or mutation | failed（log:1425） AssertionError [ERR_ASSERTION]: three bounded primary case attempts in each of Tier 2 and the existing Tier 1 fallback；0 !== 6 | failed（log:1114） AssertionError [ERR_ASSERTION]: three bounded primary case attempts in each of Tier 2 and the existing Tier 1 fallback；4 !== 6 |
| `src/test/bmiPreservationIntegration.test.ts`<br>real BMI workflow preserves exact passed assertions during review repair and across Tier fallback | failed（log:1482） AssertionError（完整事件／狀態見比較 JSON）；0 !== 2 | failed（log:1134） AssertionError（完整事件／狀態見比較 JSON）；1 !== 2 |
| `src/test/mutationImprovementIntegration.test.ts`<br>AI-authored boundary improvements preserve fallback history and require approval before each mutation round | failed（log:1976） AssertionError（完整事件／狀態見比較 JSON）；4 !== 1 | failed（log:1152） AssertionError（完整事件／狀態見比較 JSON）；4 !== 1 |
| `src/test/numericSkillIntegration.test.ts`<br>numeric observations guide a single-input AI seed revision which is reviewed before real mutation | failed（log:2088） AssertionError（完整事件／狀態見比較 JSON）；1 !== 2 | failed（log:1170） AssertionError（完整事件／狀態見比較 JSON）；1 !== 2 |
| `src/test/parameterFixturePipelineIntegration.test.ts`<br>a measured object gap reaches fixture observation, AI addition, real re-execution, review and mutation | failed（log:2220） AssertionError（完整事件／狀態見比較 JSON）；4 !== 3 | failed（log:1188） AssertionError（完整事件／狀態見比較 JSON）；5 !== 3 |
| `src/test/reviewerDemoIntegration.test.ts`<br>full workflow blocks mutation on invalid review and requires AI revision plus fresh approval for quality findings | failed（log:2298） AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:；4 !== 1 | failed（log:1205） AssertionError [ERR_ASSERTION]: contract correction or review of a revised candidate consumes the second request；5 !== 2 |
| `src/test/roleOrchestratorIntegration.test.ts`<br>orchestrator carries measured quality into Writer and verifies improvement with real Python mutation | failed（log:2346） AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:；false !== true | failed（log:1223） AssertionError（完整事件／狀態見比較 JSON）；1 !== 3 |
| `src/test/writerOutputRecoveryIntegration.test.ts`<br>formal Writer length recovery resends complete evidence once with paired context and unchanged budget ownership > repeat-length | failed（log:3111） AssertionError（完整事件／狀態見比較 JSON）；5 !== 2 | failed（log:2250） AssertionError（完整事件／狀態見比較 JSON）；5 !== 2 |
| `src/test/writerOutputRecoveryIntegration.test.ts`<br>formal Writer length recovery resends complete evidence once with paired context and unchanged budget ownership > measured-too-slow | failed（log:3131） AssertionError [ERR_ASSERTION]: every public probe and recovered Writer request consumes the existing logical request counter | failed（log:2270） AssertionError [ERR_ASSERTION]: every public probe and recovered Writer request consumes the existing logical request counter |
| `src/test/writerOutputRecoveryIntegration.test.ts`<br>formal Writer length recovery resends complete evidence once with paired context and unchanged budget ownership > qualification-consumed-retry | failed（log:3147） AssertionError [ERR_ASSERTION]: every public probe and recovered Writer request consumes the existing logical request counter | failed（log:2286） AssertionError [ERR_ASSERTION]: every public probe and recovered Writer request consumes the existing logical request counter |
| `src/test/writerRevisionOutputIntegration.test.ts`<br>formal full Writer revision preserves an oversized prior-policy envelope and enforces its paired wire cap > stop | failed（log:3163） AssertionError [ERR_ASSERTION]: one review-driven expansion creates the real failed candidate without weakening the initial seed scope；0 !== 1 | failed（log:2302） AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:；11264 !== 8192 |
| `src/test/writerRevisionOutputIntegration.test.ts`<br>formal full Writer revision preserves an oversized prior-policy envelope and enforces its paired wire cap > length | failed（log:3182） AssertionError [ERR_ASSERTION]: one review-driven expansion creates the real failed candidate without weakening the initial seed scope；0 !== 1 | failed（log:2326） AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:；11264 !== 8192 |
| `src/test/writerRevisionOutputIntegration.test.ts`<br>formal full Writer revision preserves an oversized prior-policy envelope and enforces its paired wire cap > multi-finding | failed（log:3201） AssertionError [ERR_ASSERTION]: one review-driven expansion creates the real failed candidate without weakening the initial seed scope；0 !== 1 | failed（log:2350） AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:；0 !== 1 |

- 未新增失敗：Node 0；Python 0。新增跳過項目：Node 0；Python 0。
- 基準失敗而本輪不再失敗的案例：Node 95，Python 3；父測試另依完整摘要計數，不重複列為獨立根因。
- 兩版原始日誌：`D:/read/golden-{baseline-050f969|current-pr1}/log/pr1-comparison-{baseline|current}-{node|python}.log`；逐案比較：`log/pr1-integration-comparison.json`。

後續調查重點：BMI保留案例目前實際拒絕existing-test-method-changed，原fixture期望再補問；Reviewer／Writer recovery有既有2次預期對已批准failureLimit=5的差異；Writer revision的stop／length目前遇到既有增容11264對固定8192斷言，而基準先在候選數0對1失敗。其餘品質補測需依完整事件與固定回覆契約繼續定位。這些列為待修的既有案例，沒有據此改產品預算、停止條件或通過標準。


### 2026-11-06 實驗室模型容量

4096 context 放不下真實 BMI 函式的完整證據；實驗室 num_ctx 至少設為 8192，與架構文件 6.2 的評估設定一致。固定短路徑與原路徑、050f969 與目前版均量得完整輸入 3484／4299／4809／5446，報告中的最低總 context 為 4978／5835／6345／6982；**6982 不是輸入 token 數**。8192 對應基礎 inputBudget=5734；既有 seed cap=1536 另配成實際 inputBudget=6656，最大完整輸入 5446 兩者皆可容納。v11 原生測試已通過：四函式真實執行、AST 完整函式逐字出現、caller 提示保留、wire=8192／實際 paired budget、且沒有 context-grown；沒有截斷或增容。產品預設與提示均未改。


### 2026-11-05 EPERM：CodeGraph／AOCI 監看對照

- CodeGraph 1.6.2 原 daemon PID 35464；`codegraph daemon` 正式停止後，MCP bridge 立即重啟為 2180。因此第一組 `node test/run_golden_tests.js` 的五次雖全過，**不是停用組**（每次都有 PID 檔）；完整原始紀錄保留 `log/pr1-writer-codegraph-stopped-{1..5}.log` 與 `...-results.json`，不因檔名稱 stopped 就誤判。
- 真正停用組：短暫暫停已核對命令的兩個 CodeGraph MCP bridge（32772／44896），使用 CLI 相同的 stopDaemonAt 停止本專案 daemon；五次執行前後都用程序清單確認 daemon_count=0。採已編譯、未改變的 `node --test out/test/orchestratorGolden.test.js`，ORCHESTRATOR_GOLDEN_SCENARIO=writer-failure，PYTHONUTF8=1／PYTHONIOENCODING=utf-8。五次全部退出碼 0、writers=5、斷言與快照一致；finally 已恢復兩個 bridge（status=0）。腳本與原始證據：`log/pr1-codegraph-paused-probe.ps1`、`log/pr1-writer-codegraph-really-stopped-{1..5}.log`、`...-results.json`。
- 開啟對照組：恢復 daemon PID 37292 後，以**相同已編譯指令及環境**連跑五次，每次確認同一 daemon 存在。第 3 次 EPERM、writers=0、requests=[]，其餘四次 writers=5 通過。完整失敗保存 `log/golden-failure-writer-failure/run-2/`；renameFailures 精確記錄 `function_knowledge.pending.json -> function_knowledge.json`，發生於 Writer／生成 runner 之前。日誌 `log/pr1-writer-codegraph-active-compiled-{1..5}.log` 與 `...-results.json`。

| 輪次 | daemon 停止：結果／writers／情境 ms | daemon 開啟：結果／writers／情境 ms |
| --- | --- | --- |
| 1 | passed／5／3368.136 | passed／5／3955.685 |
| 2 | passed／5／3124.081 | passed／5／3499.742 |
| 3 | passed／5／3190.326 | **EPERM failed／0／2148.853** |
| 4 | passed／5／2951.842 | passed／5／3276.516 |
| 5 | passed／5／2926.983 | passed／5／3717.346 |

- 本機 CodeGraph watcher 原始碼顯示 Windows 對根使用 recursive fs.watch；ignored 子樹仍有底層事件，但依 `.gitignore` 的 matcher 在排程 sync 前濾除。根 `.gitignore` 已有 `log/*`（只保留 README）；handleDirEvent 也在逐事件 stat 前檢查父目錄忽略規則。因此「收到 log 的底層事件」不等於「索引／讀取 log 內容」。未改 CodeGraph 安裝或專案設定。
- AOCI 有兩個 `aoci.exe --repo ... mcp` 程序（33248／28940），未見獨立 watch 命令。開啟組的五次實驗期間沒有呼叫任何 AOCI 工具／CLI，兩程序的 ReadOperationCount、ReadTransferCount、WriteOperationCount、WriteTransferCount **前後全部不變**，包括 EPERM 的第 3 次。`log/pr1-aoci-idle-io-probe.json` 保存計數；既有 scope 證據中 ignored log 項目 reads_content=false。這次沒有 AOCI 同時掃描內容的證據；I/O 計數不能列出檔案持有者，亦不能永久排除其他時間的掃描。
- **判斷**：停止組 5/5、開啟組 4/5 且重現相同 EPERM，支持優先懷疑 CodeGraph 監看／其時間效應；樣本有限，尚未取得衝突 handle 的直接證據，不能宣稱已證明唯一肇因。未放寬 `writers >= 2`、未改產品。CodeGraph 已恢復、AOCI 未停用；完整第 4 步仍採逐檔同步的倉庫外隔離副本，並在回報註明此主倉庫環境限制。2026-11-07 已批准並完成有界重試與 daemon 開啟的十連跑，見本節新紀錄；原始監看肇因仍只具相關性證據。

- 沙箱執行會出現 EPERM 或 WinError 5，請改用原生權限重跑，不要為此放寬產品的隔離規則。
- 路徑含中文字，Python 子程序需要 `PYTHONIOENCODING=utf-8`。
- `test/fixtures/golden/full.json` 有 2.6MB，不要整份開啟，用腳本比對差異。
- 不要整份讀 `src/orchestrator.ts`、`PROJECT_RULES.md`、`ARCHITECTURE.md`、`CHANGELOG.zh-TW.md`。
- 不要為了讓測試通過而更新 golden 快照。

---

## 6. 工作階段紀錄（最新的放最上面）

| 時間 | Agent | PR / 步驟 | 結果 | Commit |
| --- | --- | --- | --- | --- |
| 2026-11-08 19:07 | Codex（GPT-6） | PR #3 步驟 4／背景驗證 | golden 11/11 零差異；完整 integration 已背景啟動（PID 14768），輸出寫 log；後續只看摘要與失敗名稱並逐案比對，不改已凍結程式 | `728a674`、`8f3d487`；本筆文件 checkpoint |
| 2026-11-08 19:03 | Codex（GPT-6） | PR #3 步驟 3 | 正式命令驗證保留基線真突變／usable、html_escape 建議進 Writer 且失敗額度 0、量測失敗事件與報告；相關 45/45，fast 776/48 全過 | `8f3d487` |
| 2026-11-08 19:02 | Codex（GPT-6） | PR #3 步驟 1、2 | 保留量測失敗 journal／安全診斷；恢復原迴圈條件、Writer 一次建議修訂；修復 artifact hook 誤扣。相關 45/45、fast 通過 | `728a674` |
| 2026-11-08 18:47 | Codex（GPT-6） | PR #3 續接／開始 | 確認分支與 8a57e31、保留 Antigravity 修改；有 CodeGraph、無 AOCI；核對五項並補一次修訂終止分支，驗證待執行 | 起始 HEAD `8a57e31`；本筆產品修正 commit 見 git log |
| 2026-11-08 17:58 | Antigravity | PR #3 成功分層與批次失敗彙總 | 完成終態分層（`quality-passed`／`usable`／`failed`）、保留基線一律跑突變測試、Reviewer `basis` 格式問題轉 Writer 建議且不扣額度（含 `html_escape` 回歸 fixture）、修復 `candidate-inventory-tool` 缺方法清冊與輸出 `batch_failure_summary.json`／`.md`；`test:fast`（776/776、48/48）與 `test:golden`（11/11 零差異）全過 | 見 PR 分支 `pr/03-tiered-success-failure-summary` 最新 commit |
| 2026-11-08 16:34 | Antigravity | PR #2 模型篩選工具與評估集 | 建立 `eval/eval-set-v1.json`、`eval/eval_screening/LICENSES.md`、`eval/README.md`、`python_scripts/eval_aggregate.py` 與倉庫內精簡 fixture 測試；實際 `model_test` 驗證一致，`test:related`（25/25、29/29）與 `test:fast`（774/774、48/48）全過 | 見 PR 分支 `pr/02-model-screening` 最新 commit |
| 2026-11-08 16:05 | Antigravity | PR #2a 驗收／合併主線 | 使用者驗收通過；`--no-ff` 合併 `pr/02a-target-selection` 至 `lane_edition` 並 push 至 `origin/lane_edition`，HANDOFF 標記完成 | 本次 merge commit（保留 `6b280ce`／`749973e`／`aa0143f`） |
| 2026-11-08 16:00 | Antigravity | PR #2a 驗收前四項修正與重驗 | `eval/eval_screening` 納入倉庫並移除絕對路徑；明確目標缺漏記錄 `target-missing` 並顯示於 `batch_summary`／`batch_manifest`；補齊 `throwIfExecutionCancelled()` 與抽離 `resolveExplicitBatchTargets`；`test:webview`、`test:related`（38/38）、`test:fast`（774/774、44/44）、`test:golden`（11/11）全過 | `aa0143f` |
| 2026-11-08 15:45 | Antigravity | PR #2a 實作與驗證 | 完成 R1～R5 側欄目標選擇改善；匯入 `eval_screening/targets.json` 得 26 目標、0 缺漏；`test:webview`、`test:related`（38/38）、`test:fast`（774/774、44/44）、`test:golden`（11/11）全過；下一步指向 PR #2 | `749973e` |
| 2026-11-08 15:15 | Claude（規劃） | PR #3 追加 Reviewer 格式退回改為建議 | 使用者核准；架構文件第 9 節同步 | `6b280ce` |
| 2026-11-08 15:05 | Claude（規劃） | 分析實驗室模型篩選結果 | 主力 gpt-oss:20b、備援 ministral-3:14b；PR #3 追加兩項 | `6b280ce` |
| 2026-11-07 14:30 | Claude（規劃） | 新增 PR #2a 規格；建立 eval_screening（26 函式） | 使用者回報側欄排序、多選、批次連動問題 | `6b280ce` |
| 2026-11-07 | Codex | PR #1 驗收／合併主線 | 使用者驗收通過；no-ff合併codex/pr1-regression-baseline至lane_edition並正常push，HANDOFF標記完成；第6步AOCI仍為待辦 | 本次merge commit（保留e1bae98／c845d44） |
| 2026-11-07 | Codex | PR #1 步驟5／完成交接 | 全量逐案比較無新增失敗；4／4.5／5已勾選，既有14案留第5節；歷史憑證掃描及diff檢查通過。AOCI可後補，下一PR對話從#2開始 | e1bae98＋本筆fix: restore PR1 regression contracts（僅兩筆） |
| 2026-11-07 | Codex | PR #1 步驟4.5 | 單一spec oracle決策、品質Reviewer／規格盲測界線及五行CHANGELOG完成 | 本步docs WIP（最終第5步整併） |
| 2026-11-07 | Codex | PR #1 步驟4 | Windows重試14/14、daemon開啟十連跑10/10；兩版完整integration逐案新增失敗0、skip0；14個既有leaf失敗列第5節。fast774／44、golden11／11通過 | 本步docs WIP（最終第5步整併） |
| 2026-11-06 | Codex | PR #1 步驟 4／交接 | 條件批准的 2300 與 BMI 8192 已完成；BMI 完整證據、實跑及無增容驗證通過。最新 fast 774／44、golden11/11；完整 integration 仍未全綠，第 4／4.5／5 步未勾選，剩餘清單見第 2 節 | 本輪 docs WIP（git log 可查；產品修改仍未提交） |
| 2026-11-05 | Codex | PR #1 步驟 2 | 3＋2 次完整順序 writer-failure 全過；定位 EPERM／修復保存；最終跨副本 11/11 後更新 fixtures | e1bae98 |
| 2026-11-04 | Codex | PR #1 步驟 2 路徑查核 | scopeId 先驗證再重算；副本錄製 9/9，比對 7/9，路徑差異消除；writer-failure 次數斷言失敗，依指示停下 | 未 commit |
| 2026-11-04 | Codex | PR #1 步驟 2 | 乾淨 050f969 錄製 8/8；目前版本比對 6/8，僅 batch scopeId 差異，依指示停下；未更新 fixtures | 未 commit |
| 2026-11-04 | Codex | PR #1 步驟 1、交接 | 固定 TEMP/TMP/TMPDIR；mutant 診斷摘要；型別與局部正規化 2/2；審批額度阻擋後由使用者指定交接 | 未 commit，待下一 agent 提交 |
| 2026-11-04 15:35 | Claude（規劃） | 依教授意見調整方向：合併兩種模式為「預期值以規格為準」；更新架構文件與本檔 | – | 未 commit |
| 2026-11-04 13:05 | Claude（規劃） | 建立本交接檔 | – | 未 commit |
| 2026-11-04 12:44 | Codex | PR #1 回歸修復 | fast 與 related 全綠；golden 5/7 停點 | 未 commit |
