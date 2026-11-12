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

**2026-11-12 使用者指定 PR #15（C 類修復）**：從 `lane_edition=origin/lane_edition=5fc43b6` 建立 `pr/15-v2-setup-guard`，不合併、不 push。v2 Writer setup 重用既有結構檢查，禁止環境／模組修改；違反列為 capture-failed／setup-forbidden-mutation，不找 Bug Fixer。runner 逾時或異常結束須落 failed 與 reasonCode，後續目標仍須能核對報告。v1、提示詞、預算、預設值與 golden 均不改。

PR #11／#9／#14 的既有成果仍各在 `87c18ea`／`e90c1e5`／`9b65391`，尚未合併至主線；本 PR 依使用者要求從 `5fc43b6` 獨立開始，不帶入該三 PR 的程式。

**2026-11-09 22:45 使用者決定（過夜任務四階段）**：
1. `usable` 的標準在 v1、v2、對照組完全相同：測試通過、確實呼叫真實目標、且量到突變分數。（已實作於 `57acf0d`）
2. 對照組提示詞在原始碼前加一行「檔案：<檔名>.py」，其餘照架構 6.3 原文。（即原第 3 節「對照組提示詞沒有模組名稱」的選項 (B)；已實作於 `57acf0d`，11/11 自第 3 節移除）
3. 對照組沒有輸出長度上限、v1／v2 有：只在 `eval/README.md` 註明，不改設定。
4. PR #13 側欄精簡照使用者核准配置做（主要控制常駐、進階設定收合、移除事先資格勾選框、測試連線顯示角色結果、「已選 N／M」即時計數）。摺疊狀態記住使用者上次的選擇；Webview 重建時的還原錯誤已於 11/11 修正（`b994811`）。
5. PR #10 授權依架構第 5 節撰寫 Quality Analyst 存活突變提示詞（只放在新的 v2 函式），全文加進 `docs/v2_提示詞_待審.md`，標為「待審（PR #10）」，使用者審閱前不可用於實驗室；每個目標最多處理 3 個存活突變（沿用已核准的 qualityNoImprovementLimit=3）。
仍然禁止：修改 v1 的提示詞、預算、重試、停止條件、通過標準或預設值；更新 v1 golden；修改 PR #6～#8 已核准的 v2 提示詞。

**2026-11-09 使用者決定**：
- 21:17 使用者已審閱並**核准 v2 提示詞用於實驗室**（`docs/v2_提示詞_待審.md`，檔名不改，開頭狀態已改為「已核准（2026-11-09 使用者）」）。
- 22:15 使用者驗收 PR #5～#8；監督已在本機以四個 no-ff 等效合併 commit 併入 `lane_edition`：#5 `29b4c9d`、#6 `674dab1`、#7 `a52900f`、#8 `8126f94`（內容等於 `d79f3fa`），並刪除已合併的本機 `pr/*` 分支。
- 實驗室的 v1／v2 比較**依序執行、不並行**。
**2026-11-09 監督核對 PR #6～#8 後的決定（在 `pr/08-spec-oracle` 上修正）**：
1. （C 類）單列 Bug Fixer 修正後必須同時滿足：(a) 對被測目標的每一次呼叫（名稱與全部參數）與修正前 AST 相同；(b) 每個 `self.assert*` 呼叫整個（含第一個參數）與修正前 AST 相同、數量相同；(c) 所有 patch／mock 設定相同；(d) 不可新增包住被測呼叫或斷言的 try／except、if 或 return。只允許改 setup、import 等周邊程式；違反任一項就拒絕，照舊算在 2 次額度內。
2. （B 類，使用者 11/09 核准）規格預測請求使用 temperature 0.7，其他角色維持原本設定；`requestModel` 可帶單次請求選項，v1 呼叫路徑與預設值不變。
3. （B 類，使用者 11/09 核准）規格預測提示詞（含修正提示詞）拿掉 Scenario 行，只保留呼叫、mock 與規格來源。
4. （B 類，使用者 11/09 核准）規格提示詞的呼叫寫成一般寫法，例如 `f(70, 1.75)`、`f(1, key='a')`，kwargs 為空時不顯示。
5. （A 類）v2 合併後的正式測試檔用既有 coverage 工具量行與分支覆蓋，寫入結果與報告；覆蓋率失敗只記原因碼，不影響 usable。
6. （A 類）結果卡片顯示終態層級、可用列數／總列數、規格不符數。
7. （A 類）補 capture 的 patch 位置測試：`from pkg import dep` 與 `import pkg` 兩種寫法都要 patch 在受測模組實際查找的位置。
8. 改完重新產生 `docs/v2_提示詞_待審.md`；v2 golden 若因 1～5 改變可用 `UPDATE_CASE_TABLE_GOLDEN=1` 重錄，但要逐項列出差異與原因；v1 golden 一律不准動。

**2026-11-09 13:00 監督追加（C 類，單列修正契約加嚴）**：
1. 從方法中第一個「含有被測呼叫的陳述式」到方法結尾，所有陳述式必須與修正前 AST 逐一相同；違反為 `post-call-changed`。
2. 第一個被測呼叫之前的 setup 可以修改，但不准：對 `target_module` 或被測類別屬性做指定／刪除／augmented assignment、`setattr`／`delattr`、重新指定被測函式名稱、新增指向被測目標的 `mock.patch`／`patch.object`、import 被測模組後重新綁定；違反為 `target-rebound`。
3. 原本的 `target-call-changed`、`assertion-changed`、`mock-changed`、`control-flow-added` 保留。
4. 沒有執行真實目標的方法不可算 `test-passed`。

**2026-11-09 13:45 監督追加（C 類）**：`target-rebound` 再加一條：第一個被測呼叫之前的 setup，不准把 `target_module`、被測函式名稱、`instance.<method>`，或從受測模組 import 進來的名稱，指定給任何其他名稱（含 tuple unpacking、walrus、for 目標、with ... as、`getattr(target_module, ...)` 的結果）。

**2026-11-08 23:50 使用者授權：PR #6～#8 連續進行（疊加分支）**：
- 可以不等驗收，連續做完 PR #6、#7、#8。分支疊加：`pr/06-v2-scenario` 從 `pr/05-case-table` 開，`pr/07-capture-rows` 從 `pr/06` 開，`pr/08-spec-oracle` 從 `pr/07` 開。不合併到 `lane_edition`，不 push。PR #8 完成後不開始 PR #9～#12。
- 提示詞授權：可依架構第 5 節自行撰寫 v2 新提示詞（Analyst-情境、單列 setup、單列 Bug Fixer、Analyst-規格），但只能放在新的 v2 函式；`llmUnitTest.pipelineVersion` 預設 `"v1"`。每份提示詞全文（system＋user 範本＋唯一範例）整理到 `docs/v2_提示詞_待審.md`，註明檔案與函式名稱；使用者審閱前不可用於實驗室。
- 架構文件已寫明的數值視為已核准：最多 8 列、規格預測 k=3、單列 Bug Fixer 最多 2 次、格式錯誤只針對那一行重問 1 次。
- 仍然禁止：修改 v1 的提示詞、預算、重試、停止條件、通過標準或預設值；更新 v1 golden（`test/fixtures/golden/*.json`）；在 `src/orchestrator.ts` 加入「依 `pipelineVersion` 分流」以外的邏輯。

**2026-11-08 PR #5 案例表設計決策（監督審查 `c7e17fe` 後決定）**：
1. `kwargs`、`mocks`、`requirement` 可空；`scenario`、`category`、`args` 必填。維持。
2. **（使用者 11/08 核准，B 類）** `args` 解析出來不是 tuple 時，由驗證器包成單元素 tuple 再做簽名綁定。驗證結果回傳 `normalizedArgs`（例如 `"(70,)"`）與 `normalizations: ["args-wrapped-single"]`；TS 端套用到 `CaseRow.call.args`，並在列上保留 `normalizations`。tuple 照舊不動；不是字面值的仍拒為 `args-not-literal`。
3. `mocks` 只在「字串字面值與括號之外」的 `;` 切段，值裡的 `;` 與 `->` 不能切壞；格式契約不變。
4. 列數上限留給 PR #6，PR #5 不做。
5. PR #5 補做架構第 4 節第 2 列的兩項：`case_table.json` 讀寫（`{version: "case-table-v1", target, rows}`，以 `renameAtomicSync` 原子寫入；讀取驗證版本與欄位，壞檔拋出明確錯誤，不回傳空表），以及狀態轉移純函式（只允許 `proposed→invalid|captured|capture-failed`、`captured→test-generated`、`test-generated→test-passed|test-failed`，其他拋錯）。不接 orchestrator。
6. 有裝飾器的目標維持用 `def` 參數判斷，驗證報告加上 `decorated: true`（不寫入裝飾器名稱）。

**2026-11-08 23:30 監督確認 PR #5 第二版的三項解讀（維持）**：
7. `decorated` 不計 `staticmethod`／`classmethod`，其他任何裝飾器一律 `true`。
8. 列轉到 `invalid`／`capture-failed`／`test-failed` 必須給原因碼，否則拋錯；轉到其他狀態清掉舊原因。
9. `case_table.json` 讀取採嚴格模式（未知欄位拋錯），並以「所有選填欄位＋needsSetup call」的一列做 write→read 往返 deepEqual 測試保護。

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
| 3 | 成功分層與批次失敗彙總 | 已驗收並合併至主線（5fc43b6） | `lane_edition` | 2026-11-12 使用者確認 |
| 4 | 測試範圍預設排除備份與副本 | 延後（使用者 11/08 決定） | | |
| 5 | case-table-v1 結構與驗證 | **完成：使用者驗收（11/09 22:15），已合併主線（`29b4c9d`）** | `lane_edition` | 2026-11-09 監督 |
| 6 | 設定分流、Analyst-情境提示、UI 設定 | **完成：使用者驗收（11/09 22:15），已合併主線（`674dab1`）** | `lane_edition` | 2026-11-09 監督 |
| 7 | Capture run、列轉測試、逐方法執行、Bug Fixer 單列修正 | **完成：使用者驗收（11/09 22:15），已合併主線（`a52900f`）** | `lane_edition` | 2026-11-09 監督 |
| 8 | **規格預測**（規格來源、Analyst-規格、比對分級、規格不符報告） | **完成：使用者驗收（11/09 22:15），已合併主線（`8126f94`）** | `lane_edition` | 2026-11-09 監督 |
| 9 | Reviewer 改審案例表 | 已實作待驗收；程式未帶入 PR #15 | `pr/09-case-table-review`（e90c1e5） | 2026-11-12 Codex |
| 10 | Quality Analyst 存活突變轉案例列 | 已驗收並合併至主線（5fc43b6） | `lane_edition` | 2026-11-12 使用者確認 |
| 11 | 需求涵蓋表與設計疑點 | 已實作待驗收；程式未帶入 PR #15 | `pr/11-requirements-coverage`（87c18ea） | 2026-11-12 Codex |
| 12a | 評估紀錄與一般 LLM 對照組 | 已驗收並合併至主線（5fc43b6） | `lane_edition` | 2026-11-12 使用者確認 |
| 12b | 埋 bug 評估 | 已驗收並合併至主線（5fc43b6） | `lane_edition` | 2026-11-12 使用者確認 |
| 13 | 側欄精簡與進階設定收合 | 已驗收並合併至主線（5fc43b6） | `lane_edition` | 2026-11-12 使用者確認 |
| 14 | 真實歷史 bug 候選（15 項，未執行 witness） | 已產出待挑選；程式未帶入 PR #15 | `pr/14-historical-bugs`（9b65391） | 2026-11-12 Codex |
| 15 | v2 setup 結構守門與 runner 失敗收尾 | 完成待驗收：Windows fast／Python／相關／golden 通過 | `pr/15-v2-setup-guard`（起點 5fc43b6） | 2026-11-12 Codex |

評估集以架構文件 6.1 節為準：BMI、add、markupsafe、validators、learn-python、bottle、車輛管理主程式（排除副本與 `old backup/`）。

---

## 2. PR #15 v2 setup 與 runner 收尾（最新）

- Agent：Codex（GPT-6），Windows 原生；有 CodeGraph MCP、無 AOCI MCP，未呼叫 AOCI，收尾待辦見第 4 節。原有未追蹤 `Claude outputs/`、舊重構計畫均保留；本分支從主線 `5fc43b6` 開立。
- [x] setup 守門：重用 `case_row_assertions.py` 的 `_rebinds_target`，只在 v2 setup／fixer 模式加入環境與匯入模組 roots、sys.modules 寫入、setattr／delattr 與外部 patch 檢查；既有 compare 預設契約保持原狀。一般列與 Quality Analyst 列在 capture 前驗證，Python capture 入口亦使用同一檢查。保留被測模組使用點的 mock.patch。
- [x] 失敗收尾：v2 在 AST／需求讀取前保留目標目錄，任何階段例外皆寫 case_table、v2_result、final_report、run_manifest、function_knowledge 與 role_events，再傳出錯誤；runner 異常／逾時分別記 runner-crashed／runner-timeout，批次以既有 refresh 核對，沒有改 BatchJournal 或 v1。
- [x] 固定回覆測試：禁止的 sys.frozen／sys.executable setup 被拒，後續列與下一目標完成；實際終止 generated-test runner、實際 capture 逾時、capture 前模型錯誤均有 failed 報告與下一目標完成。Windows 首輪修正後的新整合 4/4、相關 Python 27/27 通過；最終新增到 6 個 Node 案例，結果見下表（`log/pr15-guard-final-windows.log`）。初輪 kill fixture 把就緒訊號寫入 stdout 干擾 JSON，改用 stderr 後真正走到 runner kill；未放寬斷言。
- [x] 最後兩個 runner 邊界：雙版本內層遺失 JSON（即使外層回覆 distinguishable）、非零退出卻留下 passed 報告，均為 runner-crashed；正常 completed unittest failure 仍可照舊修正。
- [x] **Windows 原生驗證**（本輪無 VM 結果）：

  | 項目 | 結果 | 日誌 |
  | --- | --- | --- |
  | check-types | exit 0（最後兩個邊界加入後） | `log/pr15-check-types-final-windows.log` |
  | lint | exit 0（最後兩個邊界加入後） | `log/pr15-lint-final-windows.log` |
  | test:fast | Node 817/817、Python fast 52/52；含型別、lint、Webview 語法通過 | `log/pr15-fast-windows.log` |
  | test:python | 965 tests OK，skipped=4；歷史憑證掃描 exit 0 | `log/pr15-python-windows.log` |
  | 新 Node 回歸＋v2 golden | 9/9：6 個 setup／runner／報告案例、3 個既有 v2 golden | `log/pr15-runner-golden-final-windows.log` |
  | 相關 Python | 27/27；含共用 guard 與直接 capture 入口 | `log/pr15-guard-final-windows.log` |
  | 原相關 Node | 14 個原 caseRowStage／caseTablePipeline／survivorRow 案例通過；初輪另 4 個新案中 kill fixture 失敗，修正 fixture 後上述 6 新案全過 | `log/pr15-related-initial-windows.log` |
  | test:golden | v1 11/11、v2 3/3；後續只加 v2 runner 邊界，v2 已再驗 3/3；v1 沿用原通過結果 | `log/pr15-golden-windows.log`、上方最後相關日誌 |
  | source 稽核 | v1、共用 runner／BatchJournal、所有提示詞、設定、`.codex/`／`.aoci/`、所有既有 golden 均零變更 | `log/pr15-source-audit-windows.json` |

  **Golden 差異逐項：無。** 不重錄、不更新、不新增任何快照。完整 integration 本輪未重跑；第 5 節既有 14 個葉節點失敗保留，沒有宣稱 integration 全綠。完整 Python 花費約 15 分鐘，未中斷或縮減模組。


### 實驗室原始證據與能確認的原因

唯讀檢查 `D:/read/專題/test/result/v2/eval_screening_2026_11_12_14_40`：26 目標中 4 個 incomplete-report；get_app_dir 只有 target.json 與 v2_runs，該 row_c3 測試／invocation 的狀態皆 passed，其他三個失敗目標只有 target.json。四個目標之間，get_destination_minutes 等目標仍有完成報告。

`captureRow`、`runTestFile` 皆透過 runSpawn 啟動獨立 Python 子程序；Node 主程序不執行 Python setup，程序結束後也不會把 sys 狀態複製回主機。可確定的缺口是 v2 原本只在正常結尾保存終態／角色事件，途中例外沒有失敗報告，BatchJournal.refresh 才會設 running／incomplete-report。原四筆沒有保存拋出的例外，無法從現存資料還原各自觸發點；重跑後可由新報告的 reasonCode／failure／failureStage 查明。沒有將四筆都宣稱為同一個跨程序污染。

### 下一步與驗收

本輪程式提交：本筆 `fix(pr15)`（收尾回填 hash）。請使用者在實驗室以原設定重跑 v2 的 26 目標，確認禁止 setup 的列為 `capture-failed / setup-forbidden-mutation`、四個原 incomplete 目標現在有 failed 或其他可核對終態，以及後續目標正常完成。若仍失敗，保留新的 final_report／function_knowledge／role_events，依 reasonCode 查明各自原因。未改提示詞、預算、重試、預設值與通過標準，不需要新增 B 類決定。完成本 PR 後停止，不接續其他 PR。

本機重驗指令（Windows，在 `pr/15-v2-setup-guard`）：

```powershell
npm run test:fast
npm run test:python
npm run test:related -- --node caseSetupGuardIntegration --node caseRowStageIntegration --node caseTablePipelineIntegration --node survivorRow --python test_case_row_assertions --python test_case_capture_runner
npm run test:golden
```

如另做完整 `npm run test:integration`，須背景輸出到 log/，只讀摘要並與第 5 節既有 14 案逐案比對。

---

## 2. PR #12a～#13 一次驗收（歷史）

### 2026-11-11 23:00 進階設定重建還原修正（Claude Code，`pr/13-sidebar`）

- **最終 HEAD**：程式與測試在 `b994811`（`fix(pr13)`）；其後只有本筆 docs commit（只改 HANDOFF），測試對象即 `b994811` 的程式。未合併、未 push。
- **原因**：Webview 腳本先依保存的 `envType` 呼叫 `applyEnvTypeUi` → `saveUiState`，後者讀 DOM 當下的 `details.open`（仍是 HTML 預設 false）寫回狀態，把已保存的 `advancedSettingsOpen: true` 蓋掉，之後的還原段讀到 false。
- **修正**（只改 `src/ui/webviewContent.ts` 還原順序）：先還原 `advanced-settings-details.open`，再還原 `envType`，最後登記 `toggle` 監聽。HTML 未改，預設仍收起；`sidebarSimplification` 的預設收起斷言照過。
- **測試**：`sidebarDashboardReplay.test.ts` 加回完整狀態重建檢查，展開與收起各一次：重建後 `open` 等於保存值、`env-type` 等於保存值、保存值未被覆寫，並補一次延遲 `toggle` 通知後仍不變。修正前此檢查失敗（`log/pr13-details-before-fix-vm.log`，expected true／actual false），修正後 13/13（含 sidebarSimplification，`log/pr13-details-fix-vm.log`）。
- **本機驗證（非正式）**：本次對話的 shell 是使用者筆電上的 Linux VM，不是 Windows 原生；以下皆為 VM 結果。
  - `npm run test:fast`：check-types、lint、compile 皆過；Node 753/759，6 個失敗全為 VM 平台問題（測試找 `.venv/bin/python`，但倉庫 `.venv` 是 Windows 版；`@esbuild/win32-x64` 不能在 Linux 執行），與本次修改無關。runner 在 Node 失敗後停止，另以 `python3 -B -m unittest` 跑 fast 的 5 個 Python 模組：52 OK。log：`log/pr13-final-fast-vm.log`、`log/pr13-final-fast-python-vm.log`。
  - `npm run test:golden`（分段執行）：編譯 0；**v2 3/3**（bmi、bmi-quality-analyst、database），快照未變動，VM 無 coverage 故覆蓋率成功路徑未驗證（`log/pr13-final-golden-v2-vm.log`）。**v1 在 VM 無法驗證**：VM 的 Python 沒有 coverage 且無法安裝（網路 403），`full`／`execution`／`batch` 在 coverage-preflight 判為環境受阻（`log/pr13-final-golden-v1-vm.log`），不是快照差異。沒有遇到 `log/golden-runtime` EEXIST。
  - `npm run test:related -- --node caseSpecOracleIntegration --node sidebarDashboardReplay`：10/10（`log/pr13-final-related-vm.log`）。
- **待使用者在 Windows 執行**：`npm run test:fast`、`npm run test:golden`（v1 必須 11/11、v2 必須 3/3；若遇 `log/golden-runtime` EEXIST 先改名保留再重跑）、`npm run test:related -- --node caseSpecOracleIntegration --node sidebarDashboardReplay`。完整 integration 留到 11/15 凍結前。

### 2026-11-11 測試回歸修正（Codex，Windows）

- **僅修改測試與本交接文件**：產品程式、設定、提示詞、所有 golden 快照與 CHANGELOG 均保持 `pr/13-sidebar` 原 `7d27a02` 的內容。未合併主線、未 push。
- **PR #10**：從 `d11ee25` 建立 `9d8c69a`（`test(pr10)`）。`caseSpecOracleIntegration.test.ts` 的共用 pipeline fixture 明確傳入 `qualityAnalyst: 'off'`，涵蓋原有三個規格預測測試；原列內容與所有斷言不變。
- **PR #13**：原有三筆提交已 rebase 到 `9d8c69a`，沒有衝突。`sidebarDashboardReplay.test.ts` 的假 DOM 登記加入 `details` 並讀取 `open` 布林屬性，沿用可延遲派送的 `toggle` 事件。原有六個測試及斷言不變；另加一個中英文 replay 案例，驗證進階設定的開合／toggle 保存、角色資格摘要、存活突變下拉選單的設定訊息。
- 使用者 11/11 完整驗收原有九個新增失敗是本次修正對象；完整 integration 仍需按下方指令重跑並與第 5 節既有 14 案逐案比對，不能以本輪局部通過代替完整驗收。

| 本輪驗證 | 環境 | 結果 | 日誌 |
| --- | --- | --- | --- |
| PR #10 `test:related -- --node caseSpecOracleIntegration` | **Windows 原生** | 3/3 通過，退出碼 0 | `log/pr1111-pr10-spec-windows.log` |
| `npm run check-types` | **Windows 原生** | 通過，退出碼 0 | `log/pr1111-check-types-windows.log` |
| `npm run lint` | **Windows 原生** | 通過，退出碼 0 | `log/pr1111-lint-windows.log` |
| `npm run test:related -- --node caseSpecOracleIntegration --node sidebarDashboardReplay` | **Windows 原生** | 10/10 通過（規格 3、原 sidebar 6、新增 replay 1），退出碼 0 | `log/pr1111-related-windows-final.log` |


### 四個分支最終疊加順序與 HEAD 雜湊
本條線由 4 個 PR 依序疊加（非合併至主線、未 push）：
`lane_edition(8126f94)` → `pr/12a-eval-recording(57acf0d)` → `pr/12b-seeded-bugs(b11cce0)` → `pr/10-survivor-rows(9d8c69a)` → `pr/13-sidebar`

- **`pr/12a-eval-recording`**：HEAD `57acf0d`
- **`pr/12b-seeded-bugs`**：HEAD `b11cce0`
- **`pr/10-survivor-rows`**：HEAD `9d8c69a`
- **`pr/13-sidebar`**：最新 HEAD 見 git log

### 各 PR 實際交付內容摘要（只列程式庫中真實存在者）
1. **PR #12a（評估紀錄與對照組）**：
   - `src/pipeline/caseTable/runCaseTablePipeline.ts`、`runRowStage.ts`：以 v1 `role_events.jsonl` 格式記錄所有 v2 模型呼叫事件（角色名、tokens、耗時、結束原因），產出 `function_knowledge.json` 與 `run_manifest.json` 供批次彙總。
   - `python_scripts/eval_aggregate.py`：支援讀取 `v2_result.json`，新增方法、可用列比例、規格不符數、needs-review 數欄位；占位事件 tokens 標示為「未記錄」。
   - `python_scripts/eval_baseline_plain_llm.py`：一般 LLM 對照組（固定 3 段提示詞：任務說明、`檔案：<檔名>.py`、函式源碼；temperature 0；突變量測失敗標為 `failed`／`mutation-unmeasured`，標準與 v2 統一）。
   - 測試與文件：`python_scripts/test_eval_baseline_plain_llm.py`、`test_eval_aggregate.py`；`eval/README.md` 說明輸出長度無上限差異。

2. **PR #12b（埋 Bug 評估）**：
   - `eval/seeded_bugs/`：建立 16 個語意 bug 目錄（含 `patch.diff`、`mutated.py`、`metadata.json` 與 `witness.py`），涵蓋 6 大類別，均通過語法與行為差異驗證。
   - `python_scripts/eval_seeded_bugs.py`：
     - `prepare` 子命令：將 16 個 bug patch 套用至評估目標副本。
     - `analyze` 子命令：以隔離 runner 在 bug 版環境重跑交付之正式測試檔（支援 `quality_baseline.json` 與 `executable_baseline.json`；無測試檔記為「沒有測試」計入分母）；乾淨版重跑時，僅當 runner 正常、目標被呼叫且來自目標引發之 failure/error 時才算 `failedOnClean=True`（非目標問題記為 `cleanRecheck='unavailable'` 並分開列出）。
   - 測試：`python_scripts/test_eval_seeded_bugs.py`（8/8 全過）。

3. **PR #10（案例表存活突變列）**：
   - `src/roles/qualityAnalyst.ts`：新增 `getSurvivorRowPrompt`（每輪針對單一存活突變提議一組輸入，不寫預期值）與 `parseSurvivorRow`。
   - `python_scripts/basic_mutation_runner.py`：新增 `--capture-mutant` 旗標與 `dual_capture_mutant`（雙版本環境獨立執行比對，相同則判定 `survivor-row-indistinguishable`）。
   - `src/pipeline/caseTable/runRowStage.ts`：整合存活突變補強迴圈（最多 3 次嘗試且依 `qualityNoImprovementLimit=3` 停止；提升分數之案例合併進正式測試）。
   - `src/pipeline/caseTable/rowExecution.ts`：新增 `captureSurvivorRow`；`measureCoverage` 採用動態唯一模組名稱，避免多次量測碰撞。
   - `src/orchestrator.ts`、`package.json`、`package.nls*.json`：新增設定項 `llmUnitTest.qualityAnalyst`（`auto` | `off`，預設 `auto`）。
   - 快照與測試：新增 `test/fixtures/golden/v2/bmi-quality-analyst.json`（已錄製通過），既有 `bmi.json` 與 `database.json` 零變更；`python_scripts/test_mutant_capture.py`（5/5）、`src/test/survivorRow.test.ts`（7/7）、`src/test/caseTableGolden.test.ts`（3/3）。

4. **PR #13（側欄精簡與進階設定收合）**：
   - `src/ui/webviewContent.ts`、`src/ui/SidebarProvider.ts`：
     - 精簡側欄版面配置：主要控制常駐顯示；進階設定（context、thinking、突變設定、需求檔、目標清單匯出入）預設收合且保存使用者狀態。
     - 移除側欄「開始前要求通過角色資格測試」勾選框，「測試連線」直接執行角色資格測試並顯示狀態摘要。
     - 函式選擇改為勾選／取消勾選全檔函式，新增動態「已選 N／M」即時計數。
     - 在「v2 設定」區塊新增「存活突變補強」下拉選單（`auto` 開啟預設 | `off` 關閉），綁定 `llmUnitTest.qualityAnalyst`。
   - 字典與測試：`src/i18n/zh-tw.ts` 與 `src/i18n/en.ts` 中英更新；`src/test/sidebarSimplification.test.ts`（6/6 全過）、`src/test/sidebarPreferences.test.ts`、`src/test/connectionQualification.test.ts`。

### 使用者驗收指令（11/11 測試修正後，在 `pr/13-sidebar` 上原生 Windows 執行）
Python 沿用使用者 11/11 的全過結果；本輪只改 Node 測試。請依序執行以下三個指令：
```powershell
npm run test:fast
npm run test:golden
npm run test:integration
```
> **注意**：`npm run test:integration` 約需 37 分鐘，請在背景執行並只讀取摘要，失敗清單須與第 5 節之 14 個既有失敗逐案比對，不得新增任何失敗。

### 實驗室使用前審閱提醒
> `docs/v2_提示詞_待審.md` 中標示「待審（PR #10）」的 Quality Analyst 存活突變提示詞段落，必須經使用者審閱核准後，方可用於實驗室正式評估。

---

## 2. PR #10 進度（歷史）

### PR #10 案例表存活突變列（2026-11-10 Antigravity）

- 依架構第 5 節、第 1.2 節與使用者 2026-11-09 22:45 決定實作：
  - **Quality Analyst 存活突變提示詞**：`src/roles/qualityAnalyst.ts` 新增 `getSurvivorRowPrompt`（每輪針對單一存活突變，看得到簽名、相依、原始碼與突變點，提議 1 列區分用輸入情境，不允許寫預期值）與 `parseSurvivorRow`（解析為 `CaseRow`，`origin: 'quality-analyst'`）；提示詞全文加進 `docs/v2_提示詞_待審.md` 並標為「待審（PR #10）」。
  - **雙版本捕獲（Dual-version capture）**：`python_scripts/basic_mutation_runner.py` 新增 `get_mutant_source`（AST 替換精確取得突變後原始碼）、`dual_capture_mutant`（在乾淨環境與突變環境分別跑獨立子行程執行並比對結果，相同時回傳 `distinguishable: false`、`reason: 'survivor-row-indistinguishable'`）與 CLI `--capture-mutant` 旗標；`src/pipeline/caseTable/rowExecution.ts` 新增 `captureSurvivorRow`。
  - **案例表存活迴圈整合**：`src/pipeline/caseTable/runRowStage.ts` 於合併測試後，若有存活突變且 `qualityAnalyst !== false`，執行存活突變處理迴圈。每次挑選一個存活突變，請 Quality Analyst 提議一列，雙版本捕獲若無法區分則標為 `survivor-row-indistinguishable`；若能區分則產出單列測試由 runner 執行（可由 Bug Fixer 修正），通過後與既有測試集合併量測突變分數，分數提升則保留合併檔並重設 `noImprovementCount=0`；若未提升則恢復原本基線；受最多 3 次嘗試與 `qualityNoImprovementLimit=3` 門檻控制。
  - **設定開關**：`src/pipeline/caseTable/runCaseTablePipeline.ts` 新增 `qualityAnalyst: 'auto' | 'off'` 設定與型別支援，基線 golden 測試以 `'off'` 執行保持快照零差異。
- 新增單元與整合測試：
  - `python_scripts/test_mutant_capture.py`（5/5 通過，驗證 AST 突變原始碼取得、乾淨/突變環境獨立執行、能區分與不能區分判定、CLI 旗標）。
  - `src/test/survivorRow.test.ts`（7/7 通過，驗證 prompt 格式、解析器、無法區分時標記丢棄、能區分且提升分數時成功合併、最多 3 次嘗試與停止政策）。
- 驗證全數通過：`npm run check-types`（0）、`npm run lint`（0）、`python python_scripts/secret_scan.py`（通過）、`python_scripts/test_mutant_capture.py`（5/5 通過）、Node 整合測試（`survivorRow.test.ts` 7/7、`caseRowStageIntegration.test.ts` 3/3）、`caseTableGolden.test.ts`（2/2 通過，BMI 與 database 快照零差異未重錄）。

---

## 2. PR #12b 進度（歷史）

### PR #12b 埋 bug 評估（2026-11-09 Antigravity，11/10 監督核對後修正）

- 依架構 6.4 節於 `eval/seeded_bugs/` 建立 16 個語意 bug，涵蓋 6 大類型（每類至少 2 個、每個目標最多 2 個，目標選自 `eval_screening/` 有規格來源之函式）：
  - 邊界運算子 (boundary-operator)：3 個（bug_01_bmi_upper_boundary、bug_02_range_non_inclusive、bug_03_char_value_digit_boundary）。
  - 單位或換算 (unit-or-conversion)：2 個（bug_04_bmi_height_unit_scale、bug_05_mod_check_rearrange）。
  - 漏處理的例外 (unhandled-exception)：2 個（bug_06_parse_date_overflow、bug_07_parse_excel_datetime_unhandled_type）。
  - 錯誤的預設值 (wrong-default)：3 個（bug_08_parse_range_default_maxlen、bug_09_html_quote_tab_replacement、bug_10_path_shift_default_shift）。
  - 回傳錯欄位 (wrong-field)：3 個（bug_11_get_remaining_text_return_order、bug_12_parse_auth_reversed_user_pwd、bug_13_format_eta_time_field_order）。
  - 條件反向 (condition-inversion)：3 個（bug_14_html_escape_quote_inversion、bug_15_iban_empty_string_check、bug_16_char_value_digit_condition）。
  - 每個 bug 均驗證：unified diff patch 能乾淨套用、套用後模組仍可 import、witness 呼叫在乾淨版與 bug 版產出不同輸出（記錄於 `meta.json`）。
  - `vehicle_time_utils.py` 原無 docstring，僅在評估副本補上並註明 `docstringAdded: true`。
- `python_scripts/eval_seeded_bugs.py`：
  - `prepare` 子命令：將每個 bug 套用到獨立副本（輸出於指定資料夾，不寫入 repo），產生乾淨版副本與它的 `targets.json`，以及合併所有 bug 的 `targets.json`（路徑為 `bugs/<bug_id>/<sourceFile>`）。
  - `analyze` 子命令（11/10 依監督指示修正）：
    1. 不再以 `terminalStatus` 推斷 bug 版通過，改為只要交付正式測試檔即在 bug 版重跑隔離 runner；未交付測試檔列為「沒有測試」（計入分母、不計分子）。
    2. 乾淨版重跑要求 runner 正常完成、目標確實被呼叫且測試為 failure 或 error（來自目標行為）才算 `failedOnClean=True`；其他非被測行為錯誤列為 `cleanRecheck='unavailable'`（不計分子並另列）。
    3. `find_formal_test_file` 補齊 v1 `quality_baseline.json` 與 `executable_baseline.json` 讀取，支援 `retained-after-failure` 重跑。
- `python_scripts/test_eval_seeded_bugs.py`（8/8 通過）：驗證 patch 套用、`prepare` 結構、三大指標計算、乾淨版 runner 失敗 unavailable 分離、bug 版通過＋乾淨版 assertion 失敗計入、bug 版通過＋乾淨版例外 error 計入、以及 v1 retained-after-failure 測試重跑判定。
- `eval/README.md` 補齊四步驟操作流程說明（第 6 節）。
- 驗證（Windows 原生）：`npm run check-types`（0）、`npm run lint`（0）、`python python_scripts/secret_scan.py`（通過）、`test_eval_seeded_bugs.py`（8/8 通過）。

---

## 2. PR #12a 進度（歷史）

### PR #12a 修正（2026-11-09 Antigravity）

- 依監督 22:50 指示修正：
  1. `eval_baseline_plain_llm.py`：量不到突變分數時 `terminalStatus='failed'`、`reasonCode='mutation-unmeasured'`，保留原因細節；`test_eval_baseline_plain_llm.py` 新增「突變量不到 → failed」測試，3/3 通過。
  2. 對照組提示詞改為三段：第一行「以下是一個 Python 函式，請為它寫 unittest」，第二行「檔案：<檔名>.py」，空一行後接完整函式原始碼；測試斷言完全等於此格式。
  3. `eval/README.md` 寫明輸出長度上限差異（對對照組有利，結果偏保守）。
- Windows 原生驗證：`test_eval_baseline_plain_llm.py` 3/3 通過、`test_eval_aggregate.py` 8/8 通過。

### PR #12a `pr/12a-eval-recording`（2026-11-09 Claude Code）

- `13e3047` docs：記錄 PR #5～#8 驗收合併（`29b4c9d`／`674dab1`／`a52900f`／`8126f94`）、v2 提示詞核准、v1／v2 實驗室比較依序執行。
- `6725a16` feat：v2 每個模型請求以 v1 格式寫 `role_events.jsonl`，角色名 `analyst-scenario`、`analyst-scenario-correction`、`writer-row-setup`、`bug-fixer-row`、`analyst-spec`、`analyst-spec-correction`；timing 事件帶 tokens、`completionReason`、耗時。另寫 `function_knowledge.json`（含 `caseTableResult`）與 `run_manifest.json`，沒有有效列的失敗也寫。orchestrator 只把 `onTiming` 轉傳給既有 `requestLlmApi`，v1 請求不變。
- 本筆 feat／test：
  - `eval_aggregate.py`：讀 `v2_result.json`（終態、突變分數、行覆蓋率、列數、規格不符、needs-review）；新增「方法」與三個 v2 欄；只有占位事件時 tokens／截斷為「未記錄」（JSON 為 `null`），不顯示 0。v1 數字不變（既有 4 個測試照過）。
  - `eval_baseline_plain_llm.py`：提示詞逐字為「以下是一個 Python 函式，請為它寫 unittest」＋完整函式原始碼；temperature 0、`num_ctx`、思考模式可設；同一個隔離 runner、`coverage_read.py`、突變引擎；所有失敗（呼叫失敗、沒有程式碼、語法錯誤、沒有測試方法、逾時、測試失敗、未呼叫目標）都計入分母。`usable` 定義同 v2：測試全過且確實呼叫目標；突變量不到時仍為 usable，原因另記、不算「量到突變分數」。
  - 測試：`test_eval_aggregate.py` 新增三組並列（v1 `eval_screening/gpt_oss20b`、v2 有真實事件、v2 占位事件、對照組；fixture 在 `test/fixtures/eval_three_groups/`）；`test_eval_baseline_plain_llm.py` 以固定回覆假模型驗證可執行／語法錯誤／沒有測試方法／呼叫失敗四種，並確認可被彙總。新模組已登記於 `test/verificationConfig.js`（Python 模組數 62→63）。
  - `eval/README.md` 新增第 4、5 節（對照組用法、三組並列與依序執行）。
- VM 驗證（**非正式**，Linux VM）：check-types 0（`log/pr12a-checktypes-vm.log`）、lint 0（`log/pr12a-lint-vm.log`）、related Node 26/26（caseRowStageIntegration、caseSpecOracleIntegration、verificationRunner、caseTablePipelineIntegration；`log/pr12a-related-node.log`）、Python 10/10（`log/pr12a-python-vm.log`）、v2 整合 10/10（`log/pr12a-v2-integration-vm.log`）、v2 golden 2/2 無差異、快照未動（`log/pr12a-v2-golden-vm.log`）。v1 golden 未動。
- **待使用者在 Windows 執行**：`npm run test:fast`、`npm run test:python`、`npm run test:golden`（v2 有改動）、`npm run test:integration`。

---

## 2-old2. PR #6～#8 進度（疊加分支，見第 0 節 23:50 授權）

### 2026-11-09 13:33 Windows 原生驗證結果（使用者執行，`pr/08-spec-oracle`）

證據：`log/pr6-8-windows-fast-python-golden.log`（使用者貼上的完整輸出）。log 本身沒有印出 commit；執行時分支最新 commit 是 `7fe7530`，盤點數量（Node 101/292、Python 62 個檔）也和該版本一致。

| 指令 | 結果 |
| --- | --- |
| `npm run test:fast` | check-types、lint、compile 通過；Node 811 tests／811 pass／0 fail／0 skip（776＋v2 fast 測試 35：caseTable 20、caseScenarioPrompt 6、caseRowTests 6、specPromptBlindness 3）；Webview 語法通過；Python fast 48/48；結尾印出 `Selected scope passed` |
| `npm run test:python` | 62 個檔、939 tests，OK（4 skips）；history secret scan 通過 |
| `npm run test:golden` | **v1 11/11**（full、execution、writer-failure、stub、batch 五個情境皆 passed，快照零差異）；**v2 2/2**（bmi、database 在 Windows Python 3.13 上與 VM 錄製的快照一致，未重錄） |

仍待執行：完整 `npm run test:integration`，跑完後逐案比對第 5 節既有的 14 個失敗；v2 覆蓋率成功路徑也要在 Windows 確認（`caseRowStageIntegration` 屬於 integration，這次沒有跑）。


### PR #6 `pr/06-v2-scenario`（2026-11-09 Claude Code）

- **修改／新增檔案**：
  - 設定：`package.json`、`package.nls.json`、`package.nls.zh-tw.json` 新增 `llmUnitTest.pipelineVersion`（v1｜v2-case-table，預設 v1）、`llmUnitTest.specOracle`（auto｜off，預設 auto）、`llmUnitTest.requirementsFile`（預設空）。
  - 分流：`src/orchestrator.ts` 只在 `executeSingleFileAnalysis` 加 12 行：讀設定，是 v2 就在原本的 import fixture 與 target budget 範圍內呼叫 `runCaseTablePipeline`；v1 路徑不變。
  - v2 入口：`src/pipeline/caseTable/runCaseTablePipeline.ts`（facts → 需求檔 → 情境請求 → 最多 8 列 → 格式錯誤行重問一次 → Python 驗證 → `case_table.json`＋`case_table_rejections.json`；沒有任何有效列時拋 `model-format`／`no-valid-case-rows`，但表格仍寫入）。
  - 事實擷取：`python_scripts/case_table_facts.py`（新）＋ `src/pipeline/caseTable/caseTableFacts.ts`。相依名稱＝目標模組可解析的點名稱（`_connect`、`sqlite3.connect`、`os.path.exists`），或由這些呼叫綁定的區域變數上的呼叫（`cur.fetchone` → patch `_connect`、chain `()`,`cursor`,`()`,`fetchone`）；`with … as x` 會加上 `__enter__`；builtins 只收 `open`、`input`（`create: true`）。巢狀函式不掃描。
  - 需求檔：`src/pipeline/caseTable/requirements.ts`（每行 `R1: 描述`，接受全形冒號與清單符號，重複 id 拋錯；讀不到或重複時是 `environment` 失敗，在任何模型請求之前）。
  - 提示詞：`src/roles/semanticAnalyzer.ts` 末尾新增 `CASE_SCENARIO_ROW_LIMIT=8`、`getCaseScenarioPrompt`、`getCaseRowCorrectionPrompt`、`parseCaseRows`（包裝 PR #5 的解析器並套用列數上限）。舊函式沒動。全文見 `docs/v2_提示詞_待審.md`（新）。
  - `PYTHON_TOOLS` 新增 `caseTableFacts`、`caseRowValidator`。
  - PR #5 解析器回傳新增 `rowLines`（每列原始行號）。
  - 側欄：`src/ui/webviewContent.ts`、`src/ui/SidebarProvider.ts`、`src/i18n/{en,zh-tw,messages}.ts`：「流程版本」選單、v2 時顯示「預期值來源」選單與需求檔選擇／清除。設定值只接受宣告的列舉，分析進行中不可改。
  - 測試：`src/test/caseScenarioPrompt.test.ts`（fast，6）、`src/test/caseTablePipelineIntegration.test.ts`（integration，4，固定回覆＋真 Python 工具）、`python_scripts/test_case_table_facts.py`（5）；`verificationRunner.test.ts` Python 模組數 58→59。
- **設計判斷（請監督確認）**：
  1. 重問只針對以 `{` 開頭的壞行；純文字說明行（例如「Here are the scenarios:」）直接記錄、不重問，避免浪費請求。
  2. 驗證器判為無效（簽名不符、相依不存在）的列標 `invalid`，**不重問**；重問只限解析層的格式錯誤。
  3. 超過 8 列的處理：先收下前 8 個有效列，其餘記錄 `row-limit`；已滿 8 列時壞行也不再重問。
  4. 批次模式下 v2 目標會 attach 到批次資料夾，但 PR #6 還沒有寫終態，批次彙總會把它算成未完成；終態在 PR #7 補上。
- **驗證（Linux VM，不是正式結果）**：check-types 0（`log/pr6-check-types.log`）、lint 0／0 warning（`log/pr6-lint.log`）、test:webview 通過（`log/pr6-webview.log`）、related 71/71（caseScenarioPrompt、caseTable、caseTablePipelineIntegration、verificationRunner、localization、webviewContent、sidebarPreferences、readabilityImprovements；`log/pr6-related-node.log`）、Python 新模組 24/24（test_case_table_facts＋test_case_row_validator，VM Python 3.10）。
- **待使用者在 Windows 執行**：`npm run test:fast`、`npm run test:python`、`npm run test:golden`（v1 必須零差異：v1 路徑只多一個讀設定的判斷）。

### PR #7 `pr/07-capture-rows`（2026-11-09 Claude Code）

- **新增**：
  - `python_scripts/case_capture_runner.py`：一列一個行程；在 `runtime_policy.guarded_runtime` 內 import 目標模組並呼叫。依 PR #6 facts 的 `patch`／`chain` 在目標模組命名空間 patch（`mock.patch.object`），區域呼叫鏈設定在同一個 MagicMock 上；`raise` 的例外名稱先找 builtins，再從目標模組解析。輸出回傳值（必須能 `repr`→`literal_eval` 還原）或例外（名稱、MRO、測試可用的參照）。行程會設 `sys.dont_write_bytecode`，TS 呼叫時也加 `-B`（寫 `__pycache__` 在 guard 下會被擋）。
  - `python_scripts/case_row_assertions.py`：比對 Bug Fixer 修正前後每個 `self.assert*` 的預期部分。
  - `src/pipeline/caseTable/rowToTest.ts`、`rowExecution.ts`、`runRowStage.ts`；`runCaseTablePipeline.ts` 在案例表之後跑 row stage，寫出 `v2_result.json`、`final_report.md`、`v2_runs/`（每次執行的測試檔與 runner 證據）、`test_case_table.py`。
  - 提示詞：`unittestWriter.ts` 的 `getRowSetupPrompt`／`parseRowSetupResponse`、`bugFixer.ts` 的 `getRowFixPrompt`／`parseRowFixResponse`（全文已列入 `docs/v2_提示詞_待審.md`）。
  - v2 golden：`src/test/caseTableGolden.test.ts`＋`test/fixtures/golden/v2/{bmi,database}.json`；`test/run_golden_tests.js` 在 v1 之後執行它。**`--update` 只影響 v1；v2 只能用 `UPDATE_CASE_TABLE_GOLDEN=1` 錄製。**
  - 測試：`src/test/caseRowTests.test.ts`（fast，6）、`src/test/caseRowStageIntegration.test.ts`（integration，2）、`python_scripts/test_case_capture_runner.py`（6，每案子行程）、`python_scripts/test_case_row_assertions.py`（3）；Python 模組數 59→61。
- **修改**：`src/orchestrator.ts` 分流多傳 1 行 mutation 設定（沿用 v1 的 `mutationEngine`／`mutationWorkers`／`normalizeExecutionSettings(params).mutpyTimeout`）；`pythonTools.ts` 新增 `caseCapture`、`caseRowAssertions`；PR #6 整合測試改傳 `runRows: false`（只測案例表階段）。
- **與指示不同之處（請監督確認）**：
  1. 沒有重用 `tier1TestFileBuilder`：它的輸入是 trace 事實、沒有 mock 支援，而 v2 每列都可能 patch 相依；改由 `rowToTest.ts` 依相同結構產生。
  2. 沒有重用 `mock_scaffold_generator.py` 與 `trace_value_codec.py`：patch 位置改由 PR #6 facts 決定（目標模組命名空間＋呼叫鏈）；值只接受字面值（`repr` 可被 `literal_eval` 還原），回傳物件的列標 `capture-failed`（`return-not-literal`）。
  3. 覆蓋率還沒量：`usable` 不需要覆蓋率，留到 PR #9 的 `quality-passed`。
  4. 執行單一方法時不傳 `--test-progress`：該功能用到 Python 3.11 的 `co_qualname`，VM 的 3.10 會壞；v2 不需要進度串流（v1 不受影響）。
  5. v2 golden 用 builtin 突變引擎（不依賴外部套件，結果可攜）。
- **限制**：模組以檔名 stem import（目標資料夾與專案根加入 import path），套件內相對 import 的模組目前會 capture 失敗；實例方法每列都需要一次 Writer setup。
- **驗證（Linux VM，不是正式結果）**：check-types 0（`log/pr7-check-types.log`）、lint 0／0 warning（`log/pr7-lint.log`）、related 62/62（`log/pr7-related-node.log`）、Python 四個新模組 33/33（`log/pr7-python-vm.log`）。v2 golden：在 VM（Python 3.10）錄製（`log/pr7-v2-golden-record-vm.log`）後再比對 2/2（`log/pr7-v2-golden-compare-vm.log`）：BMI usable，5 列中 4 列通過、1 列 invalid，builtin 突變 63/96＝65.6；資料庫 usable，3 列通過、1 列未 mock 而 `capture-failed`（isolation-blocked），突變 27/34＝79.4。v1 golden 檔案未改動。
- **待使用者在 Windows 執行**：`npm run test:fast`、`npm run test:python`、`npm run test:golden`（v1 必須零差異；v2 在 Windows Python 3.13 上比對。若 v2 有差異，**先回報差異，不要直接重錄**，因為快照是在 VM 的 3.10 上錄的）。

### PR #8 `pr/08-spec-oracle`（2026-11-09 Claude Code）

- **新增**：`src/pipeline/caseTable/specSources.ts`、`src/roles/specOracle.ts`、`src/pipeline/caseTable/oracleDecision.ts`、`src/pipeline/caseTable/specMismatchReport.ts`、`python_scripts/case_oracle_compare.py`；測試 `src/test/specPromptBlindness.test.ts`（fast，2）、`src/test/caseSpecOracleIntegration.test.ts`（integration，3）、`python_scripts/test_case_oracle_compare.py`（4）；Python 模組數 61→62。
- **修改**：`runCaseTablePipeline.ts`：`specOracle=auto` 且有規格來源時，把 `createSpecDecider` 當作 row stage 的 `decideExpected`；寫出 `spec_mismatch.json/md`、`test_spec_mismatch.py`；`v2_result.json`／`final_report.md` 加入規格統計；另外寫 `function_knowledge.json`、`run_manifest.json`、`role_events.jsonl`，讓批次彙總讀得到 v2 目標。`runRowStage.ts` 回傳每列 setup。`batchJournal.ts`：`specMismatchCount` 改為累加各目標 `function_knowledge.json` 的值（v1 目標沒有這個欄位，仍是 0）。`pythonTools.ts` 新增 `caseOracleCompare`。
- **設計判斷（請監督確認）**：
  1. 「有規格」＝有 docstring 或需求檔；只有型別註記不算（型別無法決定值）。README 尚未納入。
  2. basis 驗證只比對 docstring 與需求描述（去掉 `docstring:`、`R2:` 之類的標籤、空白正規化、至少 6 個字元）；型別註記與函式名稱都算弱依據。3 次預測的 basis **全部**驗證通過才算 `spec-mismatch`，否則 `needs-review`。
  3. 任何一次預測（含一次修正）仍無法解析，或 3 次不一致 → `prediction-unstable`；實際結果不是字面值 → 維持 `observed-unconfirmed`，不列規格不符。
  4. 規格不符的列狀態停在 `captured`（不產生正式測試）。`test_spec_mismatch.py` 的例外若不是常見內建例外，會用 `Exception` 加類別名稱檢查。
  5. 「側欄顯示規格不符數」目前透過側欄的執行紀錄（log）顯示一行統計；結果卡片的 UI 整合留到之後。
- **驗證（Linux VM，不是正式結果）**：check-types 0（`log/pr8-check-types.log`）、lint 0／0 warning（`log/pr8-lint.log`）、related 70 個中 69 個通過（`log/pr8-related-node.log`）；唯一失敗是 v1 的 `batchJournalIntegration`「real batch command…」，原因是 VM 的 Python 沒有 `coverage`（`coverage-preflight`／environment），與本 PR 無關，須在 Windows 重跑確認。規格整合測試 3/3（`log/pr8-spec-integration-vm.log`）、Python 五個 v2 模組全過（`log/pr8-python-vm.log`）、v2 golden＋row stage 4/4（`log/pr8-v2-golden-and-rows-vm.log`；v2 golden 用 `specOracle: 'off'`，所以不受影響）。v1 golden 檔案未改。
- **待使用者在 Windows 執行**（PR #6～#8 一起）：`npm run check-types`、`npm run lint`、`npm run test:fast`、`npm run test:python`、`npm run test:golden`（v1 必須零差異，v2 必須通過）；時間足夠時背景跑 `npm run test:integration`，逐案比對第 5 節既有的 14 個失敗。

### 2026-11-09 19:15 Windows 完整 integration 結果（使用者執行，`pr/08-spec-oracle`）

- 證據：`log/pr6-8-windows-integration.log`（使用者貼上的完整輸出）。log 沒有印出 commit；從 log 內的時間戳（07:46 UTC＝15:46 台灣時間）判斷，執行時分支最新 commit 是 `ce9d286`，程式內容等同 `7bbf8a5`，之後沒有程式變動。
- **Node integration**：191 個檔、1065 tests／1048 pass／17 fail（14 個葉節點＋3 個父測試）／0 skip／0 cancelled。
- **與第 5 節既有 14 個失敗逐案比對：檔案、完整案例名稱與第一個錯誤全部相同，新增失敗 0。**
  - bmiFocused preserved-seed：`retained-after-failure` vs `passed`；modified-seed：`4 !== 6`
  - bmiPreservation：`1 !== 2`
  - mutationImprovement：`4 !== 1`
  - numericSkill：`1 !== 2`
  - parameterFixture：`5 !== 3`
  - reviewerDemo：`5 !== 2`
  - roleOrchestrator：`1 !== 3`
  - writerOutputRecovery：repeat-length `5 !== 2`；measured-too-slow 與 qualification-consumed-retry 為同一句計數斷言
  - writerRevision：stop／length `11264 !== 8192`、multi-finding `0 !== 1`
  - 3 個父測試也和以前相同（BMI keeps an executed seed…、formal Writer length recovery…、formal full Writer revision…）。
- 與 PR #3 那次比較：Node tests 1053→1065（PR #5～#8 新增的 integration 測試）。v2 新增的整合測試全部通過，共 10 項：caseTablePipelineIntegration 4、caseRowStageIntegration 3、caseSpecOracleIntegration 3。v1 的 `batchJournalIntegration`「real batch command…」在 Windows 通過（VM 失敗只是因為缺 coverage）。
- **Python integration 這次沒有執行**：verification runner 在 Node 失敗後就停止（`[failed] Node regressions`），和 PR #3 時 Codex 用自訂腳本強制補跑不同。Python 的佐證如下：
  - `npm run test:python`（62 個檔全量，包含 57 個 integration 檔）在 `7fe7530` 已通過 939 tests；
  - 之後 Python 只改了 `case_row_assertions.py`（別名規則）與五個 v2 測試模組（匯入路徑），這五個模組已在 `7bbf8a5` 用 Windows related 通過 50/50；
  - 其餘 Python 檔自 `7fe7530` 起沒有變動。
  - 若要嚴格的同版本證據，可再跑一次 `npm run test:python`（約 13 分鐘）。
- 結論：PR #5～#8 已完成驗證清單上的所有 Windows 項目，可交監督與使用者驗收。

### 2026-11-09 15:00 Windows 結果與 Python 測試單獨執行修正（`pr/08-spec-oracle`，Claude Code，test(pr07)）

- **使用者 Windows `npm run test:golden`（`aa9d619`）**：v1 11/11（五個情境皆 passed），v2 2/2。Windows `.venv` 有 coverage，輸出中沒有「未驗證」提示行，而 v2 golden 仍通過，表示 bmi 與 database 都通過 `coverage.available === true`、`linePercent` 在 0～100、`executableLines > 0` 的斷言：**v2 覆蓋率成功路徑已在 Windows 驗證**。
- **使用者 Windows `npm run test:related -- --python test_case_row_assertions` 失敗**：`ModuleNotFoundError: No module named 'case_row_assertions'`。原因是 v2 新增的五個 Python 測試模組沒有把 `python_scripts` 加入 `sys.path`；既有測試模組都會自己加。在完整 `test:python` 中能通過，只是因為同一行程中較早的模組已經加過路徑。屬於測試檔的 C 類問題，產品程式不受影響。
- **修正**：`test_case_row_validator.py`、`test_case_table_facts.py`、`test_case_capture_runner.py`、`test_case_row_assertions.py`、`test_case_oracle_compare.py` 都在 import 前加入 `sys.path.insert(0, <本檔所在目錄>)`，比照既有模組。
- **驗證（Linux VM，不是正式結果）**：五個模組各自在 repo 根目錄、不設 `PYTHONPATH` 單獨執行全部通過（19、5、9、13、4 項；`log/pr7f-<模組>-alone.log`）；五個一起執行 50 項通過（`log/pr7f-python-together-vm.log`）。
- **使用者 Windows 重跑（`7bbf8a5`，2026-11-09 15:03）**：`npm run test:related -- --python test_case_row_assertions --python test_case_row_validator --python test_case_table_facts --python test_case_capture_runner --python test_case_oracle_compare` → 5 個模組 50 tests OK，結尾印出 `Selected scope passed`。完整 `npm run test:integration` 仍待執行。

### 2026-11-09 14:45 v2 golden 強制驗證覆蓋率成功路徑（`pr/08-spec-oracle`，Claude Code，test(pr07)）

- 監督核對：`caseRowStageIntegration` 對覆蓋率只斷言「available 或有原因碼」，v2 golden 不記錄覆蓋率，VM 也沒有 coverage 套件，所以 v2 覆蓋率的成功路徑從未被驗證過。
- `src/test/caseTableGolden.test.ts`：先用 pipeline 同一個直譯器（`resolvePythonExecutable`）執行 `python -c "import coverage"`。
  - 成功時（例如 Windows `.venv` 的 coverage 7.16.0），bmi 與 database 兩個情境都必須 `coverage.available === true`、`linePercent` 在 0～100、`executableLines > 0`；不符合就失敗，訊息會印出 `reasonCode`。
  - 失敗時（VM），照常比對快照，並以 `console.log` 與 test diagnostic 印出「[v2 golden] coverage 套件不存在，覆蓋率成功路徑未驗證」。
  - 覆蓋率數值不寫入快照，快照未重錄。
- **驗證（Linux VM，不是正式結果）**：check-types 0（`log/pr7e-check-types.log`）、lint 0／0 warning（`log/pr7e-lint.log`）、v2 golden 2/2，有印出提示行（`log/pr7e-v2-golden-vm.log`）。v1 golden 未動。
- **待使用者在 Windows 跑 `npm run test:golden` 與 `npm run test:related -- --python test_case_row_assertions`**。Windows 有 coverage，`test:golden` 這次會真正斷言 v2 覆蓋率成功路徑。如果因為覆蓋率而失敗，表示 v2 的覆蓋率程式本身有問題（請貼出訊息裡的 `reasonCode`），**不要放寬斷言**，改列入第 3 節處理。完整 `npm run test:integration` 也仍待執行。

### 2026-11-09 13:50 別名規則（`pr/08-spec-oracle`，Claude Code，fix(pr07)）

- `case_row_assertions.py` 的 `target-rebound` 新增別名檢查：呼叫前 setup 的綁定來源（`=`、註記指定、`+=`、walrus、`for`／comprehension 的 iter、有 `as` 的 with、函式與 lambda 的預設值）只要**運算結果就是受保護物件本身**就拒絕。受保護物件包括：`target_module`、受測模組別名、從受測模組 import 的名稱、被測函式名稱與類別名稱、`X.<目標名稱|類別名稱|__dict__>`（X 為上述根名稱或 `instance`）、`getattr`／`vars` 套在受保護物件上的結果、以及包含它們的 tuple／list／set／dict／條件運算式。只是「使用」模組的運算式不算別名，例如 `target_module.Helper(scale=2)`、`target_module.LIMIT`。
- 測試（`test_case_row_assertions.py`，13 項）：監督的例子、`t = target_module`、`f = getattr(target_module, 'bmi')`、`(t,) = (target_module,)`、`t, n = target_module, 1`、`f = target_module.bmi`、模組別名轉綁、from-import 名稱轉綁、walrus、for、comprehension、註記指定、預設參數、`vars(target_module)`、`__dict__[...]`、條件運算式都被拒；只改 setup（建構物件、補 import、讀常數、comprehension 建物件）仍被接受。
- **已知殘留（請監督判斷）**：把受保護物件當成**呼叫參數**傳給 setup 裡另外定義的函式（例如 `def f(m): m.bmi = ...` 接著 `f(target_module)`），靜態規則沒有攔，因為 `mock.patch.object(target_module, '其他相依')` 這類合法 setup 也是同一種寫法。真實目標仍須被執行（`targetObserved`），但回傳值可能被包裝。若要禁止，屬於規則變更，需要另外決定。
- **驗證（Linux VM，不是正式結果）**：Python 五個 v2 模組 50 項全過（`log/pr7d-python-vm.log`）；row stage 3/3＋**v2 golden 2/2 無差異**（`log/pr7d-rows-golden-vm.log`）。TS 沒有修改，所以不重跑 check-types／lint。v1 golden 未動。
- **待使用者在 Windows 跑 `npm run test:integration`**（完整背景執行，跑完後逐案比對第 5 節既有的 14 個失敗；同時確認 v2 覆蓋率 `coverage.available`）。`test:python` 有改到 python_scripts，建議一併重跑。

### 2026-11-09 13:00 單列修正契約加嚴（`pr/08-spec-oracle`，Claude Code，fix(pr07)）

- `python_scripts/case_row_assertions.py`：新增 `post-call-changed`（比對方法本體從第一個含被測呼叫的頂層陳述式到結尾的 `ast.dump` 序列；我們產生的方法中，該陳述式通常是包住呼叫的 `with mock.patch...`，所以 mock 設定也一併凍結），以及 `target-rebound`（只檢查呼叫前的 setup）。受保護的根名稱包含 `target_module`、`import <受測模組> [as X]` 的別名、`from <受測模組> import Y` 的名稱；屬性或下標的指定、刪除、augmented assignment 只要寫入的運算式中出現受保護名稱就算違反，例如 `vars(target_module)['f'] = …`。重新指定 `target_module`、被測函式名稱、類別名稱或 `instance.<方法>`，對它們呼叫 `setattr`／`delattr`，或以 `mock.patch('模組.目標')`／`patch.object(受保護物件, '目標')` patch 被測目標，都算違反。請求新增 `module`、`target` 欄位，由 `rowExecution.fixPreservesContract` 帶入。
- 第 4 點核對結果：**已經有**。`rowExecution.runTestFile` 的 `targetObserved` 讀 runner 的 target-invocation 證據（`observed`：只有來源檔中真正的目標 code object 被執行時才為 true，且 `status` 必須是 passed）；`runRowStage` 只有 `passed && targetObserved` 才轉 `test-passed`，否則為 `test-failed`（`target-not-called`），合併測試與覆蓋率也同樣要求。新增整合測試證明：用 lambda 換掉目標的測試，unittest 會通過，但 `targetObserved=false`。
- 測試：`test_case_row_assertions.py` 12 項（原 7 項，加上 A 例重新指定結果→`post-call-changed`、B 例 lambda 換目標→`target-rebound`、呼叫後加 `print` 或 `pass` 被拒、只改註解被接受、`setattr`／`del`／`+=`／`patch.object` setup／`mock.patch('health.bmi')`／別名重綁／`vars()` 寫入／重綁 `target_module`／重綁目標名稱都被拒、用 `with patch.object` 包住呼叫→`post-call-changed`、只改呼叫前 setup 與 docstring 被接受）；`caseRowStageIntegration.test.ts` 新增 targetObserved 測試（3/3）。
- **驗證（Linux VM，不是正式結果）**：check-types 0（`log/pr7c-check-types.log`）、lint 0／0 warning（`log/pr7c-lint.log`）、related 45/45（`log/pr7c-related-node.log`）、row stage 3/3（`log/pr7c-rows-vm.log`）、Python 五個 v2 模組共 49 項全過（`log/pr7c-python-vm.log`）、**v2 golden 2/2 無差異**（`log/pr7c-v2-golden-vm.log`）。v1 golden 未動。
- **待使用者在 Windows 執行**：`npm run test:fast`、`npm run test:python`、`npm run test:golden`。

### 2026-11-09 監督核對後修正（`pr/08-spec-oracle`，Claude Code）

依第 0 節「2026-11-09 監督核對 PR #6～#8 後的決定」逐項處理：
1. **Bug Fixer 契約（C 類）**：`python_scripts/case_row_assertions.py` 重寫，回傳 `accepted` 與 `violations`（`target-call-changed`、`assertion-changed`、`mock-changed`、`control-flow-added`、`method-renamed`、`unparseable`）。每個被測呼叫與每個 assert 呼叫都比對整個 AST，以及外層的 try／if／迴圈／非 patch 的 with 結構；return 數不得增加。`rowExecution.fixPreservesContract` 取代舊函式，被拒原因寫入 log。測試涵蓋改參數、改 kwargs、結果換常數、改或刪斷言、刪或改 mock、加 try/except、加 if、加 return 都被拒，只改 setup 被接受（`test_case_row_assertions.py` 7 項）；PR #7 整合測試第二次修正改成只動 setup（被接受但預期值仍錯，所以 test-failed）。
2. **temperature 0.7**：`AnalysisParams.requestTemperature`（選填）。只在有值時改變請求：本機 `options.temperature`（沒值時仍是原本的 0）；Custom 與 Cloud 只在有值時才加入 temperature 欄位（沒值時請求內容與原本完全相同）。v2 分流的 `requestModel` 第三個參數帶 `{ temperature }`；只有 `oracleDecision` 的規格預測與它的修正請求傳 `SPEC_PREDICTION_TEMPERATURE = 0.7`。整合測試斷言只有規格請求帶 0.7。
3. **拿掉 Scenario**：`specOracle.ts` 的規格提示詞與修正提示詞都不含情境；`specPromptBlindness.test.ts` 加入「不含情境文字」斷言，規格整合測試也逐一檢查實際提示詞。
4. **一般呼叫寫法**：`formatSpecCall`，例如 `bmi(70, 1.75)`、`f(1, key='a')`、kwargs 為空時不顯示；key 不是合法識別字時保留 `**{...}`。
5. **覆蓋率（A 類）**：`rowExecution.measureCoverage`：合併測試通過後，另外以 `--coverage-source` 跑一次，再用 `coverage_read.py`＋`assessTargetCoverageEvidence` 算目標行覆蓋百分比、缺漏行與分支；結果寫進 `v2_result.json`（`coverage`）與 `final_report.md`。失敗時記錄原因碼（`coverage-run-failed`、`coverage-read-failed`、`coverage-failed` 或工具給的原因），不影響 usable。**VM 沒有 coverage 套件，只驗證到失敗路徑；成功路徑待 Windows。**
6. **結果卡片（A 類）**：v2 結束時送出 `updateCoverage`（突變分數、行覆蓋）與 `updateOutcome`（`outcome` 標籤加上 `caseTable: { tier, usableRows, totalRows, specMismatch }`）；`webviewContent.ts` 新增 `getCaseTableBadge`，i18n 新增 `caseTableRows`、`caseTableSpecMismatch`、`caseTableTitle`（中英）。orchestrator 分流只多傳 `postMessage`。
7. **patch 位置測試（A 類）**：`test_case_capture_runner.py` 新增 `PatchLocationTests`：`from pkg import dep` 的 facts 為 patch `dep`（受測模組命名空間），`import pkg` 為 patch `pkg.dep`；真正的 `pkg.dep` 會拋例外，capture 回傳 42 證明 patch 位置正確；另驗證未 mock 時真的呼叫到原相依。
8. `docs/v2_提示詞_待審.md` 已重新產生（規格提示詞與 Bug Fixer 說明更新）。**v2 golden 比對 2/2，沒有差異，未重錄**（golden 用 `specOracle: 'off'`、沒有走 Bug Fixer，覆蓋率不在快照內）。v1 golden 未動。
- **驗證（Linux VM，不是正式結果）**：check-types 0（`log/pr8b-check-types.log`）、lint 0／0 warning（`log/pr8b-lint.log`）、test:webview 通過（`log/pr8b-webview.log`）、related 95/95（含 cloudApi、customApi、webviewContent、localization；`log/pr8b-related-node.log`）、row stage＋規格整合 5/5（`log/pr8b-rows-spec-vm.log`）、Python 五個 v2 模組全過（`log/pr8b-python-vm.log`）、v2 golden 2/2（`log/pr8b-v2-golden-vm.log`）。
- **待使用者在 Windows 執行**：`npm run test:fast`、`npm run test:python`、`npm run test:golden`（v1 必須零差異：v1 請求在沒有 `requestTemperature` 時內容不變；v2 必須通過），以及 v2 覆蓋率成功路徑（跑一次 v2 或 `caseRowStageIntegration`，確認 `coverage.available` 為 true）。

## 2-old. PR #5 進度與下一步

### 2026-11-08 Claude Code 開始 PR #5

- 起點：`lane_edition` 本機 HEAD `474e4e5`（PR #3 合併），開分支 `pr/05-case-table`。
- PR #3 push 待辦：VM 對 `github.com` 的連線被代理擋下（HTTP 403），無法確認遠端 ref，也無法 push。使用者要在 Windows 執行：`git fetch origin`，確認 `git rev-parse origin/lane_edition` 是 `19d7394`，然後 `git push origin lane_edition`。若遠端不是 `19d7394`，不要 rebase 或 force，先回報。
- 範圍（使用者指定）：只建 `src/pipeline/caseTable/` 型別、逐行解析、`python_scripts/case_row_validator.py` 與單元測試；不接 orchestrator、不改 v1、不寫提示詞。
- 環境限制：本 agent 的 shell 是使用者電腦上的 Linux VM。`.venv` 是 Windows 的 Python 3.13，VM 裡不能用，所以 Python 測試先用 VM 的 Python 3.10 驗證；正式 `test:fast`／`test:python` 要在 Windows 原生執行。

#### 下一步

- [x] 1. `caseTable.ts` 型別、`caseRowParser.ts` 逐行解析、`caseRowValidation.ts`（驗證器請求與結果套用）＋ `src/test/caseTable.test.ts`（13 tests）
- [x] 2. `case_row_validator.py` ＋ `test_case_row_validator.py`（13 tests）
- [x] 3. 加進 fast（`caseTable`）與 `test:python` 清單；`verificationRunner.test.ts` 的 Python 模組數 57→58、末尾清單補上新模組（與 PR #2 同樣做法）；CHANGELOG 4 行。commit `c7e17fe`
- [x] 3b. 依第 0 節「PR #5 案例表設計決策」補強（commit `0dcec49`）：args 單元素包裝、`decorated`、`mocks` 安全切段、`case_table.json` 讀寫（`caseTableStore.ts`）、狀態轉移純函式 `transitionCaseRow`。
- [ ] 4. **Windows 原生驗證**：`npm run test:fast` ✅ 2026-11-08 23:37 使用者執行，結束時印出 `Selected scope passed`：check-types、lint、compile、Node 796 tests／796 pass／0 fail／0 skip（比 PR #3 的 776 多出 caseTable 20 個）、Webview 語法、Python fast 48/48 OK（`log/pr5-fast-windows.log`）。`npm run test:python` ❌ 尚未執行（指令誤貼成 `test:pythonnpm`，npm 回報 Missing script），**仍待使用者執行**。原文：`npm run test:fast` 與 `npm run test:python`，貼摘要（通過／失敗數）。預期 Node fast 比 PR #3 的 776 多出本 PR 的 `caseTable.test.ts`（20 tests），`test:python` 多 1 個模組（19 tests）。全過後交監督驗收。PR #5 完成後不自行開始 PR #6

#### 第二版（`0dcec49`）內容

- `case_row_validator.py`：`args` 解析出來不是 tuple 時包成 `(value,)` 再綁定；成功時回傳 `normalizedArgs`（`repr` 產生，例如 `"(70,)"`、`"([1, 2],)"`）與 `normalizations: ["args-wrapped-single"]`；包裝後仍綁不上就照舊拒為 `signature-mismatch`，且不回傳 `normalizedArgs`。報告新增 `decorated`（布林，永遠存在）。**解讀**：`staticmethod`、`classmethod` 不算，因為驗證器已依它們調整 self／cls；其他任何裝飾器都算 `decorated: true`。裝飾器名稱不寫入報告。
- `applyCaseRowValidation` 改為回傳 `{ rows, decorated }`；套用 `normalizedArgs` 到 `call.args` 並把 `normalizations` 存在列上。報告缺 `decorated`、`normalizedArgs` 與 `normalizations` 不成對、或對 needs-setup 列回傳 `normalizedArgs` 時，視為工具錯誤並拋錯。
- `parseCaseMocks`：只在字串字面值（單／雙引號，含 `\` 跳脫）與括號之外的 `;` 切段；引號或括號不成對時拒為 `invalid-mocks`。`->` 本來就只在相依名稱後第一次出現處切開，值裡的 `->` 不受影響。
- `caseTableStore.ts`：`writeCaseTable(directory, table)` 先驗證，再寫 `case_table.pending.json` 並 `renameAtomicSync` 成 `case_table.json`；`readCaseTable(directory)` 驗證 `version`、`target`、每一列的每個欄位（含未知欄位、重複 id、列舉值），錯誤拋 `CaseTableFormatError`（`code: 'case-table-invalid'`，`field` 指出位置，如 `rows[0].status`）。檔案不存在時保留原本的 `ENOENT`。
- `transitionCaseRow(row, next, reason?)`：只允許 `proposed→invalid|captured|capture-failed`、`captured→test-generated`、`test-generated→test-passed|test-failed`；其他拋 `case-row-transition-invalid`。轉到失敗狀態（invalid、capture-failed、test-failed）必須給原因碼，否則拋 `case-row-transition-reason-required`；轉到其他狀態會清掉舊的 `reason`。

#### 第二版驗證（Linux VM，**不是正式結果**）

| 驗證 | 結果 | 證據 |
| --- | --- | --- |
| check-types | 結束碼 0 | `log/pr5-v2-check-types.log` |
| lint | 結束碼 0，0 warning | `log/pr5-v2-lint.log` |
| test:related（Node：caseTable、verificationRunner、atomicRename） | 39/39 通過（caseTable 19） | `log/pr5-v2-related-node.log` |
| Python 新模組（VM Python 3.10，`PYTHONPATH=python_scripts`） | 19/19 通過 | `log/pr5-v2-python-vm.log` |
| secret scan（tracked files） | 通過 | `log/pr5-v2-secret-scan.log` |
| golden／integration | 未跑：本 PR 不碰 v1，`test/fixtures/golden/` 無修改 | – |

**第三版（監督 23:30）**：新增「所有選填欄位＋needsSetup call」往返測試，caseTable 20 tests。VM：check-types 0（`log/pr5-v3-check-types.log`）、lint 0／0 warning（`log/pr5-v3-lint.log`）、related 40/40（`log/pr5-v3-related-node.log`）。Python 未改，維持 19/19。**仍不是正式結果。**

**待使用者在 Windows 執行**：`npm run test:fast`、`npm run test:python`（見第 4 步；Node fast 預期多 20 個 caseTable tests）。VM 的 Python 是 3.10、Windows `.venv` 是 3.13，新驗證器已避開版本差異（stub 用 `ast.unparse` 產生原始碼），但仍需 Windows 實跑確認。

#### 實作內容

- `parseCaseRows(text, {origin, requirementIds, firstIndex})`：逐行解析；空行與 ``` 圍欄行略過；其他無法成列的行記入 `rejected`（行號＋原因碼＋欄位，不保存原文），不影響其他行。原因碼：`invalid-json`、`not-an-object`、`missing-field`、`field-type`、`scenario-empty`、`scenario-too-long`、`unknown-category`、`invalid-needs-setup`、`invalid-mocks`、`unknown-requirement`。只有成功的列才分配 id（C1、C2…），`nextCaseRowIndex` 讓後續角色接續編號。
- `case_row_validator.py`：stdin 一份 JSON 請求、stdout 一份報告。受測模組只解析不 import；簽名由 AST 重建成只有參數、預設值全換成 None 的 stub 再 `inspect.signature().bind`；方法會去掉 self／cls（staticmethod 不去）；同名定義取最後一個。列層級原因碼：`args-not-literal`、`args-not-tuple`、`args-too-long`、`kwargs-not-literal`、`kwargs-not-dict`、`signature-mismatch`、`unknown-dependency`、`mock-value-not-literal`、`mock-exception-invalid`、`invalid-row`；請求層級錯誤（`target-not-found`、`source-syntax-error`、`invalid-target`、`invalid-request`、`invalid-json`）回傳 `error`、結束碼 1。
- `applyCaseRowValidation`：報告格式錯誤、缺少某列結果或重複結果時直接拋錯（工具問題），不會把列默默判成有效或無效。
- 沒有接入 orchestrator、沒有改 v1、沒有寫提示詞、沒有在 `PYTHON_TOOLS` 註冊（PR #6／#7 接線時再加）。

#### 本輪驗證（Linux VM，非正式；正式數字以第 4 步 Windows 為準）

| 驗證 | 結果 | 證據 |
| --- | --- | --- |
| check-types | 結束碼 0 | `log/pr5-check-types.log` |
| lint | 結束碼 0，0 warning | `log/pr5-lint.log` |
| test:related（Node：caseTable、verificationRunner） | 29/29 通過 | `log/pr5-related-node.log` |
| Python 新模組（VM Python 3.10，`PYTHONPATH=python_scripts`） | 13/13 通過 | `log/pr5-python-vm.log` |
| Node fast 98 檔分四批直接 `node --test` | 731 tests：725 pass／6 fail。6 個全是 VM 環境：5 個 `.venv/bin/python` ENOENT（mutationResult×2、qualityPolicy、reviewerCommunicationContract×2）、1 個 `node_modules` 裡是 Windows 版 esbuild（roleTransportMatrix）。都不在本 PR 修改的檔案。總數比 Windows 少，是因為這些檔案提早失敗、巢狀子測試沒有註冊 | `log/pr5-fast-vm-part{0..3}.log` |
| secret scan（tracked files） | 通過 | `log/pr5-secret-scan.log` |
| golden | 未跑：本 PR 不碰 v1，`test/fixtures/golden/` 無修改 | – |

#### 第一版設計選擇（已由監督決定，見第 0 節；以下保留歷史）

1. `kwargs`、`mocks`、`requirement` 缺少或為 null 時視為空（kwargs 補 `{}`）；`scenario`、`category`、`args` 必填。
2. `args` 必須是 tuple 字面值：`"(70)"` 會被拒為 `args-not-tuple`，不會自動補成 `(70,)`。
3. `mocks` 以 `;` 切段，值裡含 `;` 的字串字面值會被切壞（多半變成 `invalid-mocks`）。
4. 沒有實作「最多 N 列」上限；N=8 屬於 PR #6 的提示與 host 政策。
5. `case_table.json` 讀寫沒有放進本 PR（使用者指定範圍不含），留給 PR #6。
6. 有其他裝飾器的函式，以 `def` 本身的參數判斷，不追蹤裝飾器包裝後的簽名。

## 2. PR #3 完成紀錄（歷史）

詳細說明：`eval/README.md`、`docs/模型篩選結果_2026_11_08.md`。本節為最新續接狀態；第 6 節保留歷史。

### 2026-11-08 22:50 Claude Code 續接 PR #3（最新狀態）

- 開始狀態：分支 `pr/03-tiered-success-failure-summary`，HEAD `1db24e2`；沒有未提交的程式修改，只有使用者原本未追蹤的 `Claude outputs/` 與舊重構計畫（不納入提交）。與本檔描述一致。
- 本 agent 經由使用者電腦的 Linux VM shell 操作；沒有 AOCI MCP，也沒有 CodeGraph，未呼叫任何 AOCI 工具。本輪**沒有修改任何程式或測試**，也沒有重跑任何測試，只判讀 Codex 已在 Windows 原生完成的背景 integration。
- **第 4 項完成**：`log/pr3-codex-integration.status.json` 為 `complete`，耗時 3372 秒，`changedSources` 為空。
  - Node：1053 tests／1036 pass／17 fail（14 leaf＋3 父測試）／0 skip／0 cancelled。
  - Python：842 tests，OK（4 skips）。
  - 14 個 leaf 失敗依「檔案＋完整案例名稱」逐一對照第 5 節既有清單：**完全相同，新增失敗 0**。每案的首個斷言與數值也與 PR #1 欄一致（例如 bmiFocused `retained-after-failure` vs `passed`、`4 !== 6`；bmiPreservation `1 !== 2`；mutationImprovement `4 !== 1`；numericSkill `1 !== 2`；parameterFixture `5 !== 3`；reviewerDemo `5 !== 2`；roleOrchestrator `1 !== 3`；writerOutputRecovery repeat-length `5 !== 2`；writerRevision stop／length `11264 !== 8192`、multi-finding `0 !== 1`）。
  - 與 PR #1 比較：Node tests 1038→1053（PR #2a／#2／#3 新增測試）、Node skip 2→0、Python skip 6→4；跳過數減少，沒有新增跳過或取消。跳過減少的原因未追查。
  - 來源一致性：`log/pr3-codex-integration.source-after.json` 列出的 629 個原始檔，與目前工作區逐檔 SHA-256 零差異；`8f3d487..HEAD` 只差 `docs/HANDOFF.md`。所以這份結果代表目前 HEAD 的程式。
- **第 5 項完成**：golden 11/11、五組快照零差異（Codex 19:07 紀錄，`log/pr3-codex-golden.log`），之後沒有程式變動，不重跑。沒有更新任何快照。
- 監督已在 repo 獨立核對同一批證據並與上述一致：`log/pr3-codex-integration.log`、`log/pr3-codex-integration.status.json`（npmExitCode=1、pythonExitCode=0、changedSources=[]）、`log/pr3-codex-integration-python.log`；golden `log/pr3-codex-golden.log`（11/11，`test/fixtures/golden/` 無修改）；fast `log/pr3-codex-fast.log`（結束碼 0）。
- **使用者已於 2026-11-08 驗收 PR #3。**

### 2026-11-08 Codex（GPT-6）續接 PR #3

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
- [x] 4. lint、test:related、test:fast、test:golden 已通過；完整 integration 已結束並逐案比對第 5 節既有 14 個失敗：新增 0（Claude Code 22:50 判讀，見上節）。
- [x] 5. golden 11/11 零差異，未更新快照；完成交接，待使用者驗收。

| 本輪驗證 | 結果 | 證據 |
| --- | --- | --- |
| check-types / lint | 最終 fast 再驗通過 | `log/pr3-codex-fast.log` |
| related | 最終 45/45 全過；初輪其他相關案例通過紀錄保留 | `log/pr3-codex-fixtures-v4.log`、`log/pr3-codex-related.log` |
| fast | Node 776/776、Python 48/48，含型別、lint、Webview；退出碼 0 | `log/pr3-codex-fast.log`、`log/pr3-codex-fast.status.json` |
| golden | 11/11 通過；五組快照零差異，來源雜湊無變更 | `log/pr3-codex-golden.log`、`log/pr3-codex-golden.status.json` |
| 完整 integration | 已結束（3372 秒）：Node 1053 tests／1036 pass／17 fail（14 leaf＋3 父）／0 skip；Python 842 tests OK（4 skips）。14 個 leaf 失敗與第 5 節完全相同，新增 0 | `log/pr3-codex-integration.log`、`log/pr3-codex-integration.status.json`；來源版本證據 `log/pr3-codex-integration.source-before.json` |

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

目前沒有待決項目。

- 已決定：**PR #4 延後（使用者 11/08 決定）**，下一步直接做 PR #5。
- Windows 原子改名有限重試已依 11/7 批准條件完成。

---

## 4. AOCI 待辦（由具工具能力的 agent 處理）

- 2026-11-12（Codex／PR #15）：本次無 AOCI MCP。請具能力的 agent 維護 `git diff 5fc43b6..pr/15-v2-setup-guard --name-only` 所列受管理檔；未改 `.aoci/`、`.codex/`。

- 2026-11-11（Claude Code／PR #13 重建還原修正）：沒有 AOCI MCP。修改 `src/ui/webviewContent.ts`、`src/test/sidebarDashboardReplay.test.ts`、`CHANGELOG.zh-TW.md`、本交接文件。
- 2026-11-11（Codex／測試修正）：本次沒有 AOCI MCP，未呼叫工具；受管理修改僅 `src/test/caseSpecOracleIntegration.test.ts`、`src/test/sidebarDashboardReplay.test.ts` 與本交接文件，留待具工具能力的 agent 維護。

- 2026-11-10（Antigravity／PR #13 側欄精簡）：無 AOCI 工具，請具工具能力的 agent 處理。新增／修改的受管理檔案：`src/ui/webviewContent.ts`、`src/ui/SidebarProvider.ts`、`src/i18n/en.ts`、`src/i18n/zh-tw.ts`、`src/test/sidebarSimplification.test.ts`、`src/test/sidebarPreferences.test.ts`、`src/test/connectionQualification.test.ts`、`test/verificationConfig.js`。
- 2026-11-10（Antigravity／PR #10 存活突變轉案例列）：沒有 AOCI MCP。新增 `python_scripts/test_mutant_capture.py`、`src/test/survivorRow.test.ts`、`test/fixtures/golden/v2/bmi-quality-analyst.json`；修改 `package.json`、`package.nls*.json`、`src/orchestrator.ts`、`python_scripts/basic_mutation_runner.py`、`src/pipeline/caseTable/rowExecution.ts`、`src/pipeline/caseTable/runCaseTablePipeline.ts`、`src/pipeline/caseTable/runRowStage.ts`、`src/roles/qualityAnalyst.ts`、`src/test/caseScenarioPrompt.test.ts`、`src/test/caseRowStageIntegration.test.ts`、`src/test/caseTableGolden.test.ts`、`test/verificationConfig.js`、`docs/v2_提示詞_待審.md`、`CHANGELOG.zh-TW.md`、`docs/HANDOFF.md`。
- 2026-11-09（Antigravity／PR #12b 埋 bug 評估）：沒有 AOCI MCP。新增 `eval/seeded_bugs/**`、`python_scripts/{eval_seeded_bugs,test_eval_seeded_bugs,setup_seeded_bugs}.py`；修改 `test/verificationConfig.js`、`src/test/verificationRunner.test.ts`、`eval/README.md`、`CHANGELOG.zh-TW.md`、`docs/HANDOFF.md`。
- 2026-11-09（Antigravity／PR #12a 修正）：沒有 AOCI MCP。修改 `python_scripts/{eval_baseline_plain_llm,test_eval_baseline_plain_llm}.py`、`eval/README.md`、`docs/HANDOFF.md`。
- 2026-11-09（Claude Code／PR #12a）：沒有 AOCI MCP。新增 `python_scripts/{eval_baseline_plain_llm,test_eval_baseline_plain_llm}.py`、`test/fixtures/eval_three_groups/**`；修改 `python_scripts/{eval_aggregate,test_eval_aggregate}.py`、`src/pipeline/caseTable/{runCaseTablePipeline,runRowStage,oracleDecision}.ts`、`src/orchestrator.ts`、`src/test/{caseRowStageIntegration,caseSpecOracleIntegration,verificationRunner}.test.ts`、`test/verificationConfig.js`、`eval/README.md`。
- 2026-11-09（Claude Code／PR #7 契約加嚴）：修改 `python_scripts/{case_row_assertions,test_case_row_assertions}.py`、`src/pipeline/caseTable/rowExecution.ts`、`src/test/caseRowStageIntegration.test.ts`。
- 2026-11-09（Claude Code／PR #7、#8 監督核對後修正）：修改 `python_scripts/{case_row_assertions,test_case_row_assertions,test_case_capture_runner}.py`、`src/pipeline/caseTable/{rowExecution,runRowStage,runCaseTablePipeline,oracleDecision}.ts`、`src/roles/specOracle.ts`、`src/orchestrator.ts`、`src/ui/webviewContent.ts`、`src/i18n/{en,zh-tw}.ts`、`src/test/{specPromptBlindness,caseSpecOracleIntegration,caseRowStageIntegration}.test.ts`、`docs/v2_提示詞_待審.md`。
- 2026-11-09（Claude Code／PR #8）：新增 `src/pipeline/caseTable/{specSources,oracleDecision,specMismatchReport}.ts`、`src/roles/specOracle.ts`、`python_scripts/{case_oracle_compare,test_case_oracle_compare}.py`、`src/test/{specPromptBlindness,caseSpecOracleIntegration}.test.ts`；修改 `runCaseTablePipeline.ts`、`runRowStage.ts`、`batchJournal.ts`、`pythonTools.ts`、`test/verificationConfig.js`、`verificationRunner.test.ts`、`docs/v2_提示詞_待審.md`。
- 2026-11-09（Claude Code／PR #7）：新增 `python_scripts/{case_capture_runner,case_row_assertions,test_case_capture_runner,test_case_row_assertions}.py`、`src/pipeline/caseTable/{rowToTest,rowExecution,runRowStage}.ts`、`src/test/{caseRowTests,caseRowStageIntegration,caseTableGolden}.test.ts`、`test/fixtures/golden/v2/*.json`；修改 `runCaseTablePipeline.ts`、`unittestWriter.ts`、`bugFixer.ts`、`pythonTools.ts`、`orchestrator.ts`、`test/run_golden_tests.js`、`test/verificationConfig.js`、`verificationRunner.test.ts`。
- 2026-11-09（Claude Code／PR #6）：沒有 AOCI MCP。新增：`python_scripts/case_table_facts.py`、`python_scripts/test_case_table_facts.py`、`src/pipeline/caseTable/{runCaseTablePipeline,caseTableFacts,requirements}.ts`、`src/test/caseScenarioPrompt.test.ts`、`src/test/caseTablePipelineIntegration.test.ts`、`docs/v2_提示詞_待審.md`。修改：`src/orchestrator.ts`、`src/roles/semanticAnalyzer.ts`、`src/pipeline/pythonTools.ts`、`src/pipeline/caseTable/caseRowParser.ts`、`src/ui/webviewContent.ts`、`src/ui/SidebarProvider.ts`、`src/i18n/{en,zh-tw,messages}.ts`、`package.json`、`package.nls*.json`、`test/verificationConfig.js`、`src/test/verificationRunner.test.ts`。
- 2026-11-08（Claude Code／PR #5 第二版）：再加上新檔 `src/pipeline/caseTable/caseTableStore.ts`；第一版清單中的檔案本輪也有修改。
- 2026-11-08（Claude Code／PR #5）：沒有 AOCI MCP，未呼叫。新增／修改的受管理檔：`src/pipeline/caseTable/caseTable.ts`、`caseRowParser.ts`、`caseRowValidation.ts`、`src/test/caseTable.test.ts`、`python_scripts/case_row_validator.py`、`python_scripts/test_case_row_validator.py`、`test/verificationConfig.js`、`src/test/verificationRunner.test.ts`。
- 2026-11-08（Claude Code／PR #3 收尾）：沒有 AOCI MCP，未呼叫。本輪只改 `docs/HANDOFF.md`，受管理檔清單同下方 Codex 那一筆，不需新增。
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

- **CaseRow 欄位與 `case_table.json`（2026-11-08 起）**：之後任何 PR 新增或改名 `CaseRow` 欄位時，必須同時更新 `src/pipeline/caseTable/caseTableStore.ts` 的讀取驗證（嚴格模式會拒絕未知欄位），以及 `src/test/caseTable.test.ts` 中「a row with every optional field … round-trips」的往返測試列。
- 沙箱執行會出現 EPERM 或 WinError 5，請改用原生權限重跑，不要為此放寬產品的隔離規則。
- 路徑含中文字，Python 子程序需要 `PYTHONIOENCODING=utf-8`。
- `test/fixtures/golden/full.json` 有 2.6MB，不要整份開啟，用腳本比對差異。
- 不要整份讀 `src/orchestrator.ts`、`PROJECT_RULES.md`、`ARCHITECTURE.md`、`CHANGELOG.zh-TW.md`。
- 不要為了讓測試通過而更新 golden 快照。

---

## 6. 工作階段紀錄（最新的放最上面）

| 時間 | Agent | PR / 步驟 | 結果 | Commit |
| --- | --- | --- | --- | --- |
| 2026-11-12 17:37 | Codex（GPT-6） | PR #15 | 從 5fc43b6 建分支；唯讀調查實驗室結果；setup 共用 AST 守門、v2 runner 例外報告與四項整合測試；Windows fast 817/52、Python 965 OK（4 skips）與歷史掃描、Node 新案 6/6、v1/v2 golden 11/3 全過且零差異 | 本筆 fix(pr15)，收尾回填 |
| 2026-11-11 23:00 | Claude Code | PR #13 進階設定重建還原修正；清理第 3 節 | 先還原 details 再還原 envType；replay 加回完整狀態重建（展開／收起）。VM 非正式：fast Node 753/759（6 個 VM 平台失敗）＋Python 52 OK、v2 golden 3/3、v1 golden VM 無 coverage 無法驗證、related 10/10；待使用者 Windows fast／golden／related | `b994811`＋本筆 |
| 2026-11-11 22:19 | Codex（GPT-6） | PR #10／#13 測試修正 | 原規格 3 案隔離 Quality Analyst；假 DOM 加入 details 與 PR13 控制項 replay；原斷言保留。Windows check-types、lint、指定 related 10/10 通過；PR13 已疊到修後 PR10，未合併、未 push | PR10 `9d8c69a`；本筆 `test(pr13)`（HEAD 見 git log） |
| 2026-11-10 16:45 | Antigravity | PR #12a～#13 疊加與一次驗收收尾 | 完成 4 個 PR 線性疊加（#12a 57acf0d → #12b b11cce0 → #10 d11ee25 → #13）；v2 側欄新增存活突變補強選單（auto/off，綁定 qualityAnalyst）；Windows 原生 fast、webview、related、v2 golden 全過 | 本筆 |
| 2026-11-10 09:40 | Antigravity | PR #13 側欄精簡 | 模型選擇常駐並顯式連線與角色資格摘要、進階設定預設收合、移除事先資格勾選框、函式勾選與「已選 N／M」即時計數、目標清單按鈕改名；check-types／lint 0、test:webview 通過、related 16/16 全過、secret scan 通過 | `ef4e723` |
| 2026-11-10 10:25 | Antigravity | PR #10 存活突變轉案例列 | 實作 Quality Analyst 提示詞、雙版本捕獲與存活突變迴圈；check-types/lint 0、secret scan 通過、Node 10/10、Python 5/5、v2 golden 3/3 無差異；提示詞納入待審檔 | `f19e7d1` |
| 2026-11-10 00:15 | Antigravity | PR #12b 埋 bug 評估 | 建立 16 個語意 bug 與 witness；實作 eval_seeded_bugs.py（prepare/analyze）；新增 test_eval_seeded_bugs.py（8/8 通過）；更新 README 與註冊測試；check-types/lint 0、secret scan 通過 | `b11cce0` |
| 2026-11-09 23:55 | Antigravity | PR #12a 修正 | 恢復對照組 usable 與 v2 一致（突變量不到為 failed）、提示詞加檔名、README 註明輸出上限差異；Windows原生 test_eval_baseline_plain_llm 3/3、test_eval_aggregate 8/8 通過 | `57acf0d` |
| 2026-11-09 15:05 | Claude Code | PR #7 記錄 Windows related | 使用者 Windows：5 個 v2 Python 模組單獨 related 50/50 OK。待 integration | 本筆 |
| 2026-11-09 15:05 | Claude Code | PR #7 Windows 結果與 Python 測試路徑 | Windows golden v1 11/11、v2 2/2（覆蓋率成功路徑通過）；related 單獨跑失敗→五個 v2 Python 測試補 sys.path，VM 單獨與合併執行皆通過。待使用者重跑 related 與 integration | 本筆 |
| 2026-11-09 14:50 | Claude Code | PR #7 v2 golden 覆蓋率斷言 | 有 coverage 時強制斷言成功路徑，沒有時印出未驗證提示；VM：check-types／lint 0、v2 golden 2/2 並印出提示。待使用者在 Windows 跑 test:golden 與 test:related -- --python test_case_row_assertions | 本筆 |
| 2026-11-09 13:55 | Claude Code | PR #7 別名規則 | target-rebound 加別名檢查；VM：Python 50 項、row stage＋v2 golden 5/5 無差異。待使用者在 Windows 跑 test:integration | 本筆 |
| 2026-11-09 13:40 | Claude Code | PR #6～#8 記錄 Windows 結果 | 使用者 Windows：fast Node 811/811、Python fast 48/48；test:python 939 OK（4 skips）＋secret scan；golden v1 11/11、v2 2/2。integration 尚未執行 | 本筆 |
| 2026-11-09 14:00 | Claude Code | PR #7 單列修正契約加嚴 | post-call-changed、target-rebound；確認 targetObserved 已強制並補測試；VM：check-types／lint 0、related 45/45、Python 49 項、row stage 3/3、v2 golden 2/2 無差異。Windows 待執行 | 本筆 |
| 2026-11-09 13:30 | Claude Code | PR #7／#8 監督核對後修正 | Bug Fixer AST 契約、規格 temperature 0.7、拿掉情境、一般呼叫寫法、v2 覆蓋率、結果卡片、patch 位置測試；VM：check-types／lint 0、related 95/95、整合 5/5、Python 全過、v2 golden 2/2 未變。Windows 待執行；不開始 PR #9 | 本筆（pr07＋pr08 兩筆） |
| 2026-11-09 04:30 | Claude Code | PR #8 完成 | 規格來源、Analyst-規格（k=3）、分級、規格不符報告與測試檔、批次累加；VM：check-types／lint 0、related 69/70（唯一失敗是 VM 缺 coverage）、規格整合 3/3、Python 全過、v2 golden 2/2。Windows 待執行；不開始 PR #9 | 本筆 |
| 2026-11-09 03:00 | Claude Code | PR #7 完成 | capture、程式產生測試、逐方法執行、單列修正、突變、v2 golden（VM 錄製）；VM：check-types／lint 0、related 62/62、Python 33/33、v2 golden 2/2。Windows 待執行 | 本筆 |
| 2026-11-09 01:30 | Claude Code | PR #6 完成 | 設定分流、Analyst-情境、facts、需求檔、側欄；VM：check-types／lint 0、webview 通過、related 71/71、Python 24/24。Windows fast／python／golden 待執行 | 本筆 |
| 2026-11-08 23:40 | Claude Code | PR #5 第 4 步（記錄 Windows 結果） | 使用者 Windows `test:fast` 通過：Node 796/796、Python fast 48/48；`test:python` 指令誤貼未執行，仍待使用者 | 本筆 |
| 2026-11-09 00:45 | Claude Code | PR #5 第三版（監督確認三項解讀） | 第 0 節補第 7～9 項；新增全選填欄位往返測試；第 5 節加 CaseRow 欄位維護註記。VM：check-types／lint 0、related 40/40；Windows fast／python 待使用者執行 | 本筆 |
| 2026-11-09 00:30 | Claude Code | PR #5 第二版（審查決定） | 第 0 節寫入六項決策；args 單元素包裝、decorated、mocks 安全切段、case_table.json 讀寫、狀態轉移。VM：check-types／lint 0、related 39/39、Python 19/19；Windows fast／python 待使用者執行 | `0dcec49`＋本筆 docs |
| 2026-11-08 23:55 | Claude Code | PR #5 步驟 1～3 | 案例表型別、逐行解析、驗證器與單元測試（Node 13、Python 13）；check-types／lint 0、related 29/29；VM 版 fast 只有 6 個環境失敗。待使用者在 Windows 跑 fast／python | `c7e17fe`＋本筆 docs |
| 2026-11-08 23:10 | Claude Code | PR #3 合併／PR #5 開始 | 本機 `--no-ff` 合併 PR #3 到 `lane_edition`（`474e4e5`）；VM 連不到 GitHub，push 待使用者在 Windows 執行；開 `pr/05-case-table` | 本筆 docs commit |
| 2026-11-08 23:00 | Claude Code | PR #3 驗收紀錄 | 監督核對結果一致；使用者驗收 PR #3；PR #4 延後（使用者決定） | 本筆 `docs(pr03): record full integration comparison` |
| 2026-11-08 22:50 | Claude Code | PR #3 步驟 4、5／收尾 | 判讀背景 integration：Node 1053／1036 pass／17 fail（14 leaf，與既有清單完全相同，新增 0）、Python 842 OK；629 檔來源與 HEAD 零差異；golden 11/11 不重跑。未改程式，PR #3 待驗收 | 本筆 docs commit |
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
