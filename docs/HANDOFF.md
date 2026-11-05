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

---

## 1. PR 進度總表

| PR | 內容 | 狀態 | 分支 | 最後更新 |
| --- | --- | --- | --- | --- |
| 1 | 修復 050f969 回歸、golden 安全網、決策寫入 PROJECT_RULES | **步驟 2 完成，待完整驗證** | `codex/pr1-regression-baseline` | 2026-11-05 Codex |
| 2 | 模型篩選工具與評估集 | 未開始 | | |
| 3 | 成功分層與批次失敗彙總 | 未開始 | | |
| 4 | 測試範圍預設排除備份與副本 | 未開始 | | |
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

## 2. 目前進行中：PR #1

詳細紀錄：`docs/refactor/pr1-regression-review-2026-11-04.md`。本節為最新續接狀態；第 6 節保留歷史。

### 2026-11-05 最新結論：步驟 2 完成

- 新版 harness 在乾淨 050f969 副本錄製 **11/11**，目前版本隔離副本完整比對 **11/11**。成功後才由獨立基準更新主倉庫的五份 fixtures，沒有用目前版本重錄來掩蓋差異。
- 原 050f969 的 772 個 tracked blob 全部核對相同；目前隔離副本的 775 個檔案與工作區逐檔相同。兩邊只共用 node_modules／.venv 工具，未把 PR #1 產品修復帶入基準。證據：`log/pr1-writer-final-source-proof.json`。
- 最新 orchestratorGolden.test.ts SHA-256：`e4c22e3e014f1076936754714096e576066ceb3260f8c49124e80d98989ab202`；run_golden_tests.js：`2dbab35f73d9b92007f735c3fb97d9954296f21fc49686840a496cde23d3d0c2`。原始基準產品 commit 為 `050f9698bab7ccfe143246688808c83fa0c39013`。
- 目前產品修改仍只有先前的 runner evidence guard 等 PR #1 回歸修復；本輪新增修改限測試、診斷與文件。`writers >= 2`、停止政策、預算與產品重試都未放寬。

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
- [ ] 3. 把 `D:/read/專題/test/log/pr1-baselines/golden-baseline-8fb075f-verified/` 移至 `D:/read/golden-baseline-8fb075f/`；本倉庫 `log/pr1-temp/` 移出。兩者仍在原位置，尚未搬移。
- [ ] 4. 在來源相同的獨立副本原生執行完整 Python／integration、fast／related，輸出到 log，只讀摘要；B 類先停。
- [ ] 4.5. PROJECT_RULES 頂端改為最新單一 spec oracle 流程，不做錯誤定位；CHANGELOG 同步更新，只改文件。
- [ ] 5. 分開提交 golden 安全網、回歸修復與決策文件，中英雙語；目前準備第 1 個安全網 commit，未合併／push。
- [ ] 6. Codex 收尾呼叫一次 aoci_maintain，受阻時列人工項目，不自行 acknowledge。
- [ ] 7. 回報使用者驗收，驗收後才合併 lane_edition 與 push。

---

## 3. 需要使用者決定

目前沒有。scopeId 與 writer-failure 均已依使用者 A 類指示處理；仍保留工作區原生 EPERM 的已知執行環境限制與診斷，未改產品重試標準。

---

## 4. AOCI 待辦（由 Codex 處理）

- 2026-11-04：PR #1 收尾時 `aoci_maintain` 受阻，原因是 1,210 筆 observe 變化待覆核，以及 8 個人工審查項目。完成第 2 節步驟 3 後再試一次。

---

## 5. 已知問題與注意事項

- 沙箱執行會出現 EPERM 或 WinError 5，請改用原生權限重跑，不要為此放寬產品的隔離規則。
- 路徑含中文字，Python 子程序需要 `PYTHONIOENCODING=utf-8`。
- `test/fixtures/golden/full.json` 有 2.6MB，不要整份開啟，用腳本比對差異。
- 不要整份讀 `src/orchestrator.ts`、`PROJECT_RULES.md`、`ARCHITECTURE.md`、`CHANGELOG.zh-TW.md`。
- 不要為了讓測試通過而更新 golden 快照。

---

## 6. 工作階段紀錄（最新的放最上面）

| 時間 | Agent | PR / 步驟 | 結果 | Commit |
| --- | --- | --- | --- | --- |
| 2026-11-05 | Codex | PR #1 步驟 2 | 3＋2 次完整順序 writer-failure 全過；定位 EPERM／修復保存；最終跨副本 11/11 後更新 fixtures | 安全網 commit 準備中 |
| 2026-11-04 | Codex | PR #1 步驟 2 路徑查核 | scopeId 先驗證再重算；副本錄製 9/9，比對 7/9，路徑差異消除；writer-failure 次數斷言失敗，依指示停下 | 未 commit |
| 2026-11-04 | Codex | PR #1 步驟 2 | 乾淨 050f969 錄製 8/8；目前版本比對 6/8，僅 batch scopeId 差異，依指示停下；未更新 fixtures | 未 commit |
| 2026-11-04 | Codex | PR #1 步驟 1、交接 | 固定 TEMP/TMP/TMPDIR；mutant 診斷摘要；型別與局部正規化 2/2；審批額度阻擋後由使用者指定交接 | 未 commit，待下一 agent 提交 |
| 2026-11-04 15:35 | Claude（規劃） | 依教授意見調整方向：合併兩種模式為「預期值以規格為準」；更新架構文件與本檔 | – | 未 commit |
| 2026-11-04 13:05 | Claude（規劃） | 建立本交接檔 | – | 未 commit |
| 2026-11-04 12:44 | Codex | PR #1 回歸修復 | fast 與 related 全綠；golden 5/7 停點 | 未 commit |
