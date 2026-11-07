# PR #1：回歸與基準審查（2026-11-04）

範圍：三週改版架構第 9 節 PR #1。交接與當前步驟以 `docs/HANDOFF.md` 為唯一入口；PR #2～12 尚未實作。

## 2026-11-07 完整比較：第 4 步完成

兩版完整原生 integration 已完成：050f969 Node 1023 tests／895 pass／126 fail／2 skip，PR #1 為1038／1019／17／2；排除重複計數的父測試後，109個基準失敗剩14個，全部在原基準清單中。Python為841 tests／3 failures／6 skips對842／0／6。新增失敗與新增跳過均為0；同一案例在兩版的首個錯誤可能不同，兩份診斷與行號完整保留，不據案例身分相同推定根因相同。

依使用者11/7更新的完成標準，14個既有失敗列於HANDOFF第5節、不阻擋PR #1。95個基準Node失敗及3個Python失敗本輪不再失敗；沒有降低門檻或改skip。完整比較為 `log/pr1-integration-comparison.json`，兩版原日誌見HANDOFF。

目前版執行前後787檔與主倉庫零差異；基準原始772個Git blob執行後仍完全等於050f969。最新fast Node774／Python44、types／lint／Webview通過；完整integration內golden11／11再次比對成功，快照未改。166個Python檔案與先前完整886 tests通過版本完全相同，本輪fast＋integration也覆蓋全部56個Python模組。

Windows原子rename已依B類批准實作：僅win32的EPERM／EACCES／EBUSY，最多五次總嘗試，四段20／40／80／160ms，窗口499ms且受原期限約束；每次寫獨立I/O journal，原樣拋出最終錯誤。故障注入與相關回歸14／14；主倉庫CodeGraph daemon持續開啟的writer-failure十連跑10／10，每輪writers=5。沒有宣稱已證明唯一鎖定肇因。

BMI repair fixture另依A類對齊8192，原四種情境與斷言保留，related1／1及完整integration通過。第4.5步的單一spec oracle文件及第5步提交已完成：安全網e1bae98＋唯一的 `fix: restore PR1 regression contracts / 修復 PR1 回歸契約`，七筆中間工作提交已整併。提交前diff檢查與歷史憑證掃描退出碼0，沒有納入使用者其他未追蹤文件。下一個PR對話從#2開始；AOCI依使用者決定後補。產品v2與真實模型／GPU及跨平台驗收仍依後續PR，這裡只記錄PR #1已實作與本輪回歸結果。

## 2026-11-06 驗證過程（歷史）

PR #1 尚未完成，第 4 步仍有 integration 失敗。完整 Python 已通過 886 tests／6 skips（含 history secret scan）；v4 integration 為 1033 tests／956 pass／75 fail／2 skip，後續 Python integration 未執行。v5 相關回歸 57/57；v6 診斷與修正回歸 94/106，剩餘含父測試共 12 個失敗。v13 最新 runtime 1/1、fast Node774／Python44、golden11/11 全部退出碼 0，未重錄快照；分組結果、逐檔同步與剩餘 integration 清單以 HANDOFF 為準。

| 項目 | 分類／授權 | 處理 |
| --- | --- | --- |
| dependencyMockRepair 2000→2300 | B，使用者附條件批准 | 長／短 cwd 的提示與估算相同且無路徑；2025→2229 的約 204 tokens 是 mapping-key type／source-awaited async 指引。保留 79 行證據，加一行原因註解；相關 57/57 已通過。 |
| provider envelope 被誤做模型內容補正 | C | stage=model-response 的 model-format 保留診斷分類，跨角色直接傳遞且不扣 failureLimit；原 HTTP 200 malformed JSON 單次請求斷言通過，真實模型內容格式補正仍按原批准政策。 |
| 單一 seed 與固定回覆／metadata 路由 | A | 8fb075f 已拒絕多方法／多呼叫；fixture 回覆須遵守現行 seed／addition scope，metadata 不算生成。保留真實執行、同候選審查與完整突變斷言；尚有未通過案例，逐項診斷，不降低門檻。 |
| BMI integration 4096→8192 fixture | B，使用者附條件批准，已完成 | v11 四函式真實執行與完整 AST 文字／caller 保留全過，wire=8192，無截斷／增容。6982 是最低總 context，最大完整輸入 5446；基礎預算 5734，既有 seed paired inputBudget=6656／output=1536。產品設定不變；今後 fixture 只對齊評估 8192 視為 A。HANDOFF 第 3 節已移除，第 5 節已記錄。 |

## 2026-11-05 審查與決策記錄（當前進度以 HANDOFF 為準）

golden 已在原始 050f969 副本獨立錄製 11/11，再於目前版本副本只比對 11/11，完全一致後才更新主倉庫快照。安全網 commit `e1bae98`。其後完整驗證發現下表 C 類問題與測試 fixture 問題，已修復並補相關回歸；完整第 4 步仍在進行，不能宣稱 PR #1 完成。

| 項目 | 分類／授權 | 最終處理與驗證要點 |
| --- | --- | --- |
| golden 路徑與診斷穩定性 | A，使用者明確授權 | 固定 TEMP／TMP／TMPDIR 至 log/golden-runtime/tmp；mutants[].output 只摘要 hasOutput／lastException；scopeId 先核原 body hash，再以正規化 root 及完整檔案集合重算；coverage 只去除路徑長度造成的表格欄寬／分隔線。保留所有量測、狀態、原因、角色順序、提示與非路徑內容 hash。完整 hash 查核表在 HANDOFF。 |
| writer-failure 診斷與保存 | A，使用者明確授權 | 保留 writers>=2；失敗保存完整資料與角色順序、terminal／lastFailure、最後十事件及 rename 錯誤。手動排他逐檔複製避開 fs.cpSync 的本機 Node 崩潰；測試預設仍跑全部情境。 |
| runner 證據無法驗證 | A＋C | 宿主／工具損壞維持 tool。單純 stdout 不污染獨立診斷檔，與合法 scoped mock 一樣仍可 passed；候選直接寫輸出檔、持續 serializer／encoder monkeypatch 或背景干擾則 validation（exit 86）。新增 evidence guard，在防護仍啟用時恢復並拒絕持續 monkeypatch。 |
| 停止政策 | B，使用者已批准 | 保留預設 5／3／0；環境、工具及 HTTP 重試不扣 failureLimit。stopPolicy 正負回歸涵蓋 validate／execute／review 受阻及 503／429 成功與耗盡。部分路由測試明確設定該情境的既有 failureLimit，保留原請求數與成功／失敗斷言，不改產品預設。 |
| supplemental probe | B，使用者已批准 | 保留連續 positional-or-keyword 使用 args；缺口後改 kwargs；keyword-only 一律 kwargs，positional-only 一律 args，新增三種測試。 |
| Reviewer 正式提示與約 30 個測試的辨識 | 正式提示 B 已批准；fixture A | 正式提示不改。fixture 原比對舊英文角色名，改辨識第一個 REVIEW_REQUEST_V7／V8 envelope，不把證據內引用誤認成角色；新增 CRLF、提示改寫、引用反例與 wire 不變驗證。 |
| for／subTest 的 canonical target 證據 | C | target_bindings 不應丟失穩定的 canonical 呼叫；修復原正例，同時新增 loop alias／重綁不授證的負例。 |
| 初始化規劃的 consumed return | C | Assign／AnnAssign 傳遞 return_used，拒絕使用 mkdir／startup 回傳值的提案，保留 read-file 使用回傳值的既有契約；原兩個負例與全部相關正例保留。 |
| Windows 原子 rename 有限重試 | B，11/7 已批准並完成 | 限定平台／錯誤碼、五次總嘗試、四段退避、原期限、每次 journal 與原錯誤；單元及相關14/14、daemon開啟十連跑10/10。先前停用5/5與開啟4/5仍只支持相關性，不宣稱唯一肇因。 |

路徑以外的產品修復未透過重錄目前版本 golden 隱藏。兩項 Python C 類相關回歸原生 49/49；Analyst 與共用 helper 正負例通過，BMI 四情境通過（Node 父測試 1/1）。前次完整 Python 的 885 tests／3 failures／6 skips 及中斷的 integration 均保留為失敗紀錄，不算新版本通過。

2026-11-05 14:26:26 UTC，784 檔與主倉庫逐檔 SHA-256 相同，兩邊 HEAD 都是 c449678；proof：`log/pr1-current-copy-source-proof-20261105-v4.json`。本輪 fast → related → 完整 Python → integration 在 `D:/read/golden-current-pr1` 執行，日誌 `log/pr1-final-v4-*-native.log`，退出碼／耗時 `log/pr1-final-v4-native-status.json`。後續只改文件時不冒稱程式又變；程式若再變，需重建同步證據並重驗。

目前完整 Python 已通過 886 tests（6 skips），歷史憑證掃描通過；命令退出碼 0，1091.38 秒。fast 為 Node 774／Python 44；related 為 Node 83／Python 86（1 skip），皆成功。五條 golden 再次比對成功、未重錄。integration 於 2026-11-05 14:53:15 UTC 開始，尚待完整結果。

仍待實驗室：真實模型／GPU 完整批次與跨平台驗收。未合併、未 push。

## 以下為歷史調查（舊停點均已被上文取代）

## 最新驗證：路徑修復後的新停點

使用者已批准 scopeId 與同類路徑識別碼的 A 類測試修復。新增 scope 原始 body hash 驗證後重算正規化 root 的 hash；三個正規化單元測試與編譯通過。兩邊 harness hash 均為 `b7029823ecf458cb244dfe1659d38c2c585d44fd7773a0910053eca6381fb5e2`，772 個副本 tracked blob 與 050f969 仍全部相同。

副本新錄製 9/9；目前版本跨副本比對 7/9。full、execution、stub、batch 已完全一致，scopeId 與 mutant output 的路徑差異消除。writer-failure 在快照比對之前未滿足 `assert.ok(writers >= 2)`，連帶父測試失敗，故未產生此情境 actual 快照；runtime 已由 finally 清理。尚無足夠證據推論次數不足的原因，不能宣稱產品回歸。依使用者非路徑差異停點停止，五份本倉庫 fixtures 均未更新；第 3～5 步未開始。

證據：副本 `log/pr1-step2-path-record.log`，主倉庫 `log/pr1-step2-path-compare.log`、`log/pr1-step2-path-proof.json`。HANDOFF 已列完整路徑識別碼查核清單並移除舊 scopeId 待決事項；下文 8/8、6/8 與舊 hash 均為歷史紀錄。

## 最新：HANDOFF 步驟 2（2026-11-04，未完成）

### 路徑衍生識別碼查核（使用者已授權同類 A 類修正）

已搜尋 src 與 python_scripts 的 createHash／evidenceHash／hashlib 與其包裝函式，並盤點五份快照的 hash、identity、case_id、fixtureId、scopeId 欄位。

| 識別碼／來源 | 快照狀態與處理 |
| --- | --- |
| batchScope.scopeId（batchScope.ts） | 新增測試端處理：先驗證原 hash 等於原 root＋完整 knownFiles／selectedFiles 的 JSON hash，再僅替換 root 重算比較用 hash。竄改原 hash／body 會失敗；不同檔案範圍仍不同。 |
| batchScopeStateKey | 本機選取儲存鍵，五份快照未包含；不改產品。 |
| Trace case_id（dynamic_tracer.py） | 既有 harness 處理 path/input digest，保留 run 對應與 case index；完整 typed input／觀測仍比對，未新增丟棄欄位。 |
| requestBodyHash／promptHash | 既有 harness 在 wire 捕捉點對原始 requestBodyHash 建對應，再對正規化完整提示重新 hash；角色順序及提示內容仍比對。 |
| analysisOutput sourceKeyHash／目錄 ID | 五條情境都提供 projectRoot，走相對 source key，內容不受副本絕對位置影響；path.resolve fallback 未進入快照，保留現有目錄 ID。 |
| modulePreflight preflightKey／resourceScope.sourceSetHash | 路徑＋來源集或執行環境的快取／閉包身分；五份快照未包含這些 hash，無需新增正規化。 |
| BatchRuntimeQualification scopeIdentity／pythonIdentity／preferenceKey | 路徑、來源或 interpreter metadata 的執行內資格快取；五份快照未包含，未移除資格或來源身分檢查。 |
| importFixtures plan.id／quality experiment importFixturePlanHash | 五條情境未啟用初始化資源，fixtureId 為 null，未出現計畫 hash；不以固定佔位符抹除。 |
| pythonInstallationPlan.id／resourceSetupController 草稿檔名 | 含來源／環境路徑的安裝或設定身分；五條快照未觸發。 |
| isolated_resources 外部／UNC namespace、for_plan cache key；runtime_policy resource diagnostic ID | 資源映射與診斷含路徑；五條快照未觸發相應資源，沒有需新增正規化的欄位。 |
| target_invocation code hash（marshal code 含 filename） | 本次只取選定報告、journal 與 manifest，快照內 codeHash 是候選文字摘要，並非此 code object hash；不混淆兩者。 |
| source／test／variant／candidateSet／policy 等內容 hash | 非絕對路徑衍生，逐字保留，不正規化。 |

沒有新增快照中的同類路徑欄位需要處理；若後續擴充情境納入目前未出現的計畫／快取身分，必須取得完整原始 preimage，先驗證再重算，不可泛化刪除 hash 欄位。

新版 harness 只改測試：TEMP／TMP／TMPDIR 固定為測試根下的 `tmp` 並於 finally 還原；`mutants[].output` 改為 `{hasOutput,lastException}`，突變狀態、位置、計數、分數及其他 output 保留。測試專用 `ORCHESTRATOR_GOLDEN_FIXTURES` 可直接比較獨立副本快照，預設路徑不變。

`D:/read/golden-baseline-050f969/` 的 772 個受追蹤檔案 blob 與精確 commit `050f9698bab7ccfe143246688808c83fa0c39013` 全數一致；只額外加入相同 harness，沒有帶入 PR #1 產品修改。副本錄製 8/8 通過；目前版本以副本 fixtures 比對為 6/8，batch 與父測試失敗。full、execution、writer-failure、stub 全部相同，原 mutant output 差異已消除。

唯一差異為 `batch_manifest.json.scope.scopeId`：副本 `157ff848913a3d99e7af10dcc17cd567a0e77f322a9d58c1a46a68d48c352baa`、目前 `907dc5a29b9b1fc4f98be1e7035c348882a8ad65a6f74d92f5aef5b265aedd66`。此 hash 的原始 body 含絕對 root；兩個目錄不同。依使用者既有差異停點停止，不新增正規化或覆蓋 fixtures。五份本倉庫快照的 hash 均與執行前一致。

證據在 `log/pr1-step2-source-proof.json`、`log/pr1-step2-remaining-diff.json`、`log/pr1-step2-current-compare.log`；副本錄製日誌在其 `log/pr1-step2-baseline-record.log`。新版 harness SHA-256：`225e89e05d149b1b4ae61c7414417b67b483f07ab193a21f06008701d7f1bf1c`。主倉庫編譯與 lint 通過。完整 Python、integration、決策文件更新與 PR 驗收仍待後續步驟；下文為先前歷史紀錄。

## 行為差異與裁決

| 項目 | 分類／裁決 | 本次處理與證據 |
| --- | --- | --- |
| runner 診斷無法驗證：validation → tool | A，使用者同意，附帶候選歸責條件 | 更新 `generatedRunnerDiagnostics` 的錯誤分類斷言；損壞 JSON、摘要／身分不符仍拒絕，未改成功門檻。 |
| 候選 stdout | 實測不會污染診斷檔 | 原生 runner 從獨立檔案讀寫結構化結果，不以 stdout 當 JSON。新增含無效 JSON 文字的 stdout 案例。 |
| 候選直接寫結果檔 | 維持 validation | 實測隔離阻擋（exit 86）；新增測試核對有效 isolation-blocked 產物與 validation 分類。 |
| 候選留下 json.dump／encoder 覆寫 | C，已重現產品 bug，直接修復 | 修復前可產生無效 JSON，誤歸 tool。新增 runner evidence guard，待背景執行緒結束後偵測並還原未收尾覆寫；候選失敗保留 validation。正常有作用域的 mock 仍可使用。 |
| supplemental probe 改用連續 args | B，使用者同意保留 | 更新舊預期；補上中間省略後轉 kwargs、keyword-only 使用 kwargs、positional-only 使用 args。 |
| Reviewer 提示更新 | B，使用者同意限 quality | fixture 依正式 review-json 格式識別角色；不再依英文提示片語。產品提示未再修改。CHANGELOG 記錄未來 bug-hunt 的盲測要求。 |
| failureLimit=5、無改善=3、批次失敗限制=0 | B，使用者同意保留 | 補強 validation／execution／review 階段的 environment、tool 錯誤不扣額度；HTTP 暫時重試成功與耗盡均不扣 failureLimit。 |
| 停止政策與報告欄位 | A，保留 | 不刪除 golden 中的決策、門檻、計數及品質證據。 |
| 沙箱暫存／硬連結 EPERM | 執行環境限制 | 保留失敗日誌，改用原生權限重跑，不以放寬產品寫入規則消除失敗。 |

## 已實作

- `PROJECT_RULES.md` 頂端加入使用者的三週改版決策與優先順序；產品分層與 v2 留在後續指定 PR 實作。
- `python_scripts/runner_evidence_guard.py`、`generated_test_runner.py`、`runtime_policy.py`：候選未收尾的產物序列化覆寫須產生有效隔離失敗證據，保留原有副作用防護。
- 四個 Node suite：`generatedRunnerDiagnostics`、`modelQualification`、`supplementalProbeInputs`、`stopPolicy`。
- `CHANGELOG.zh-TW.md`：本筆不超過 5 行，記錄品質模式與未來 Oracle 的界線。
- 已有的 golden 安全網：`src/test/orchestratorGolden.test.ts`、`test/run_golden_tests.js`、`test/fixtures/golden/`、`package.json`、`test/verificationConfig.js`，與修復分開提交。
- 基準副本移至 `D:/read/專題/test/log/pr1-baselines/golden-baseline-8fb075f-verified/`；原副本不再位於本倉庫。

## 回歸驗證

完整輸出保存在忽略的 `log/pr1-*.log`。中斷或沙箱失敗的日誌不當作通過證據。

| 指令 | 結果 |
| --- | --- |
| `npm run test:fast` | 原生權限通過：Node 774/774、Python 44/44；包含 check-types、lint、Webview syntax。 |
| `npm run test:related -- --node generatedRunnerDiagnostics --node modelQualification --node supplementalProbeInputs --node stopPolicy --python test_generated_test_runner --python test_runtime_policy` | 原生 UTF-8 環境通過：Node 43/43、Python 37 項，1 項既有 skip。 |
| `npm run test:golden` | 5/7；full 子測試與父測試失敗，另外四條路徑通過。未重錄。 |
| `npm run test:python` | 已啟動，因 golden 差異依使用者指示停止；沒有完整通過證據。 |
| `npm run test:integration` | 初次沙箱執行有權限失敗並中斷；尚未完成原生重跑。 |
| `git diff --check` | 通過。 |

### 停點：golden 差異

`log/pr1-golden-full-diff.json` 保存 44 個精確欄位差異，全部是 function knowledge 與角色事件內的 `mutation.mutants[*].output` 文字；可見舊系統 TEMP 與本次工作區 TEMP 的路徑／截斷位置差異，包含非 ASCII 路徑的亂碼。尚未修改正規化器或產品輸出處理。

其餘所有欄位相同，包括角色請求順序／提示 hash、terminalStatus=passed、行覆蓋率 100%、突變分數 90.625%，以及 available/selected/executed=96、killed=87、survived=9、error/timeout/notRun=0。這不代表 golden 通過。

依使用者最新指示停止後續實作與基準更新；PR #1 未驗收，尚未建立安全網或修復 commit，亦未 push。AOCI 收尾結果另列於交付說明，不能宣稱治理已對齊。

## 尚需實驗室實測

未呼叫真實模型、未進行模型篩選、車輛整批或跨平台驗收。固定模型回覆搭配真實隔離 Python／突變的 golden 不能替代這些實測。
