# 評估集與模型篩選工具操作說明（`eval-set-v1`）

本目錄存放模型篩選與後續改版評估所使用的固定評估集定義（`eval/eval-set-v1.json`）與篩選用受測原始碼（`eval/eval_screening/`）。

---

## 1. 評估集範圍（`eval/eval-set-v1.json`）

目前版本（`schemaVersion: "eval-set-v1"`，同時相容側欄目標清單匯入格式 `version: "eval-screening-v1"`）以倉庫內的 `eval/eval_screening/` 為準，共 **7 個檔案、26 個函式**，版本與各檔案 SHA-256 雜湊皆固定：

| 檔案 | 專案來源 | 目標函式數 | 有規格來源 | 無規格來源 | 類型說明 |
| --- | --- | ---: | ---: | ---: | --- |
| `bmi.py` | `test/data/bmi.py` | 1 | 1 | 0 | 純函式基準（`calculate_bmi`） |
| `bottle_utils.py` | `bottle`（MIT） | 8 | 6 | 2 | 純工具函式（`tob`、`touni` 無 docstring，其餘 6 個有 docstring） |
| `validators_basic.py` | `validators`（MIT） | 6 | 6 | 0 | 驗證函式（皆含 docstring、型別註記與 `@validator` 裝飾器） |
| `validators_utils.py` | `validators`（MIT） | 2 | 2 | 0 | 裝飾器工廠與參數輔助函式（皆含 docstring 與型別註記） |
| `vehicle_app_paths.py` | 車輛管理系統 `config.py` | 1 | 1 | 0 | 路徑與執行環境（`get_app_dir`） |
| `vehicle_db.py` | 車輛管理系統 `database.py` | 4 | 1 | 3 | SQLite 資料庫相依（僅 `is_car_allowed_for_destination` 有 docstring） |
| `vehicle_time_utils.py` | 車輛管理系統 `main.py` | 4 | 1 | 3 | 時間解析與格式化（僅 `parse_excel_datetime` 有 docstring） |
| **合計** | | **26** | **18** | **8** | |

- **第三方開源授權聲明**：`bottle_utils.py`、`validators_basic.py`、`validators_utils.py` 複製自 Bottle 與 validators（皆為 MIT 授權），原作者版權聲明與 MIT 授權全文見 [`eval/eval_screening/LICENSES.md`](./eval_screening/LICENSES.md)。
- **後續擴充項目**（列於 `eval/eval-set-v1.json` 的 `plannedExtensions`，不在 PR #2 範圍）：
  - `markupsafe`（全部公開函式）
  - `validators`（擴充至 30 個公開函式）
  - `learn-python`（固定抽樣 20 個函式）
  - `bottle`（擴充至 30 個公開函式或方法）
  - `add`（全部函式）
  - 車輛管理系統主程式其餘目標（排除副本與 `old backup/`）

---

## 2. 實驗室執行模型篩選步驟

1. **準備模型**：依 `docs/三週改版架構_2026_11_04.md` 附錄 A 選擇非中國大陸開發之候選模型（如 `gpt-oss:20b`、`ministral-3:14b`、`phi4:14b`、`mistral-nemo:12b` 及對照組 `codellama:13b`），先執行 `ollama pull <tag>` 並透過擴充套件側欄「測試連線」確認可用。
2. **統一評估設定**：
   - 專案目錄選擇 `eval/eval_screening`（或複製至實驗室本機路徑的 `eval_screening` 資料夾）。
   - 可直接以批次範圍 `all`（整個資料夾共 26 個函式）執行，或在側欄「目標清單」匯入 `eval/eval-set-v1.json`（或 `eval/eval_screening/targets.json`）後按批次執行。
   - 所有模型統一使用相同設定：
     - `llmUnitTest.runtimeContextTokens`（`num_ctx`）= **`8192`**
     - `llmUnitTest.validationMode` = **`full`**
     - 停止政策：`failureLimit=5`、`qualityNoImprovementLimit=3`、`batchFailureLimit=0`
     - 相同的溫度與突變測試引擎設定
3. **分開保存結果目錄**：
   - 每個模型的輸出目錄獨立存放於同一個父資料夾下，例如：
     ```text
     model_test/
       codellama13b/
         batch_manifest.json
         ...
       gpt_oss20b/
         batch_manifest.json
         ...
       ministral3_14b/
         batch_manifest.json
         ...
     ```

---

## 3. 執行篩選彙總工具（`python_scripts/eval_aggregate.py`）

### 基本用法

傳入包含多個模型結果子資料夾的根目錄（每個子資料夾各有 `batch_manifest.json`），或直接傳入多個批次資料夾路徑：

```bash
# 讀取整個 model_test 目錄並於終端機輸出 Markdown 報告
python python_scripts/eval_aggregate.py D:/read/專題/test/result/model_test

# 輸出 JSON 格式
python python_scripts/eval_aggregate.py D:/read/專題/test/result/model_test --format json

# 將報告寫入指定檔案
python python_scripts/eval_aggregate.py D:/read/專題/test/result/model_test --output docs/eval_report.md
```

### 輸出指標說明

`eval_aggregate.py` 會針對每個**已完成**的模型批次輸出：

- **完整通過（高品質）**：`terminalStatus` 為 `passed`（或 `quality-passed`）的目標數與比例。
- **保留可用**：`terminalStatus` 為 `retained-after-failure`（或 `usable`、`execution-passed`）的目標數。
- **審查阻擋**：`terminalStatus` 為 `review-blocked` 的目標數。
- **失敗**：`terminalStatus` 為 `failed` 的目標數（若有 `no-mutation-candidates` 等其他終態亦會列出）。
- **產生可執行測試數**：實際執行過候選測試並量得目標函式覆蓋率的目標數與比例（如 `25／26（96%）`）。
- **平均覆蓋率**：有可執行測試之目標的平均目標行覆蓋率（`selectedTarget` 的已執行行數比例）。
- **量到突變分數的數量**：已完成突變測試並記錄 `mutationScore` 的目標數（並附平均突變分數）。
- **耗時**：批次總耗時（分鐘）與平均每目標耗時（秒）。
- **請求數**：批次總模型請求數（`cost.modelRequests`）。
- **輸出 tokens**：模型總輸出 token 數（`cost.outputTokens`）。
- **輸出截斷次數**：掃描各目標 `role_events.jsonl` 中 `completionReason == "length"` 的次數（若僅有精簡 manifest 則退回讀取 `lengthStoppedTransports`）。
- **有規格來源 vs 無規格來源分開統計**：依 `eval/eval-set-v1.json` 中每個函式的 `hasSpec` 標記，分別統計有規格來源（18 個）與無規格來源（8 個）的通過、保留可用、可執行測試與平均覆蓋率。
- **被取消或未完成的批次**：若某批次的 `status` 為 `cancelled`、`incomplete`、`running`、`policy-stopped`，或 `finishedTargets < expectedTargets`、含有 `pending`／`cancelled` 目標（例如實驗中途因 API 錯誤取消的 `mistralnemo12b_2`），工具會將它單獨標示於「被取消或未完成的批次（不列入比較）」區塊，**絕不混入模型比較總表**。
- **方法欄（PR #12a）**：依 manifest 的 `method` 判斷；未標示時，有 `v2_result.json` 的批次視為 `v2-case-table`，其餘為 `v1`。
- **v2 專屬三欄**：「可用列比例」（各目標 `testPassedRows` 加總／`totalRows` 加總）、「規格不符數」、「needs-review 數」；v1 與對照組顯示 `—`。v2 的終態、突變分數與覆蓋率讀自各目標 `v2_result.json`。
- **未記錄 ≠ 0**：若 `role_events.jsonl` 只有占位事件（沒有角色名稱），「輸出 tokens」與「輸出被截斷」顯示「未記錄」，不會顯示 0。

---

## 4. 一般 LLM 對照組（`python_scripts/eval_baseline_plain_llm.py`，架構 6.3）

對照組只發一次請求，提示詞固定為三段：第一行「以下是一個 Python 函式，請為它寫 unittest」，第二行「檔案：<檔名>.py」，空一行後接完整函式原始碼（含裝飾器），不加任何其他說明；`temperature=0`，`num_ctx` 與思考模式可設定。回覆中取最長的程式碼區塊，以與主流程相同的隔離 runner（`generated_test_runner.py`）執行，覆蓋率用 `coverage_read.py`，突變用同一套引擎。

```bash
python python_scripts/eval_baseline_plain_llm.py \
  --targets eval/eval_screening/targets.json \
  --model gpt-oss:20b --num-ctx 8192 --thinking provider-default \
  --mutation-engine builtin --output D:/read/專題/test/result/model_test/gpt_oss20b_plain
```

- `--targets` 格式同側欄目標清單（`{"targets": {"檔名.py": ["函式名", ...]}}`），檔名相對於清單所在資料夾。
- `--output` 必須是新資料夾或空資料夾。產出 `batch_manifest.json`（`method: "plain-llm"`，模型名稱後綴 `(plain-llm)`）以及每個目標的 `function_knowledge.json`、`role_events.jsonl`（角色 `plain-llm`）。
- **所有失敗都算進分母**：呼叫失敗（`model-call-failed`）、沒有程式碼區塊（`no-test-code`）、語法錯誤（`syntax-error`）、沒有測試方法（`no-test-methods`）、測試逾時或失敗、未呼叫目標函式（`target-not-called`）都記為 `failed`；只有測試全部通過、確實呼叫真實目標、且量到突變分數才記為 `usable`（與 v1、v2 的 usable 標準完全相同）；突變量不到時為 `failed`（`reasonCode: "mutation-unmeasured"`，原因記錄於 `detail`）。

### 比較時的注意事項

1. **輸出長度上限的差異（對對照組有利，結果偏保守）**：對照組單次請求沒有設定個別角色的輸出長度上限（`num_predict`），而 v1 與 v2 流程有嚴格的各角色輸出上限（例如種子測試 1536 tokens 等）。這使得對照組不會因為角色預算上限而發生長度截斷，對對照組有利，所得的比較結果偏向保守。
2. **模組名稱提供**：對照組提示詞第二行提供檔案名稱（`檔案：<檔名>.py`），使模型可推知正確的 import 來源模組，減少因猜錯檔名而導致的非本質失敗。

## 5. 三組並列比較與實驗室執行順序

把 v1、v2（`llmUnitTest.pipelineVersion = v2-case-table`）與對照組的輸出資料夾放在同一個父資料夾下，再執行一次彙總：

```bash
python python_scripts/eval_aggregate.py D:/read/專題/test/result/model_test --output docs/eval_three_groups.md
```

- 三組請**依序**執行（先 v1，再 v2，最後對照組），不要同時跑；同時跑會搶 GPU 與 Ollama 佇列，耗時與逾時數據就不能比較。
- 三組使用同一個模型、同一個 `num_ctx`、同一個突變引擎與相同目標清單。
- 倉庫內的範例資料在 `test/fixtures/eval_three_groups/`（測試用，數字非實驗結果）。

---

## 6. 埋 Bug 評估流程（`eval/seeded_bugs/`、`python_scripts/eval_seeded_bugs.py`，架構 6.4）

埋 bug 評估在 `eval/seeded_bugs/` 中人工設計 16 個語意 bug，涵蓋 6 大類型（邊界運算子、單位或換算、漏處理的例外、錯誤的預設值、回傳錯欄位、條件反向），驗證測試生成系統能否有效區分正確規格與人為錯誤。

### 四步驟評估流程

#### 步驟 1：準備評估副本（prepare）
在工作區外建立乾淨版與 16 個獨立 bug 副本，並產生合併目標清單：

```bash
python python_scripts/eval_seeded_bugs.py prepare -o D:/read/專題/test/seeded_bugs_eval
```

- 產出 `clean/`（含 `clean/targets.json`）與 `bugs/<bug_id>/`（每個 bug 一個獨立副本）。
- 產出合併的 `targets.json`（路徑格式為 `bugs/<bug_id>/<sourceFile>`）。

#### 步驟 2：擴充套件執行 v1 與 v2
1. 以 VS Code 開啟 `D:/read/專題/test/seeded_bugs_eval` 資料夾。
2. 側欄目標清單點擊「從檔案載入目標清單…」，選擇該目錄下的 `targets.json`。
3. 先以 v1 執行批次（輸出到例如 `result/v1_bugs`）。
4. 切換管線版本為 `v2-case-table`，執行批次（輸出到例如 `result/v2_bugs`）。
5. 針對乾淨版誤報評估：載入 `clean/targets.json`，以 v2 執行批次（輸出到例如 `result/v2_clean`）。

#### 步驟 3：執行對照組
對相同合併目標清單執行對照組單次請求腳本：

```bash
python python_scripts/eval_baseline_plain_llm.py \
  --targets D:/read/專題/test/seeded_bugs_eval/targets.json \
  --model gpt-oss:20b --num-ctx 8192 \
  --output D:/read/專題/test/result/control_bugs
```

#### 步驟 4：彙總分析（analyze）
讀取各組在 bug 版與乾淨版上的結果資料夾，重跑乾淨版驗證並產出報告：

```bash
python python_scripts/eval_seeded_bugs.py analyze \
  --clean-dir D:/read/專題/test/seeded_bugs_eval/clean \
  --v2-bugs-result D:/read/專題/test/result/v2_bugs \
  --v2-clean-result D:/read/專題/test/result/v2_clean \
  --v1-bugs-result D:/read/專題/test/result/v1_bugs \
  --control-bugs-result D:/read/專題/test/result/control_bugs \
  --output-dir D:/read/專題/test/result/seeded_bugs_summary
```

- 產出 `seeded_bug_report.md` 與 `seeded_bug_report.json`。
- 計算三大指標：
  1. **偵測率**：v2 將該 bug 標記為 `spec-mismatch`（及包含 `needs-review`）之比例（v1 與對照組標為 N/A）。
  2. **Bug 被寫成正確答案比例**：正式測試在有 bug 的程式上通過、且以 `generated_test_runner.py` 對乾淨版重跑時失敗的比例（三組均量測，為核心比較指標）。
  3. **乾淨版誤報**：v2 在未埋 bug 的乾淨版上，每函式平均產生的 `spec-mismatch` 數（v1 與對照組標為 N/A）。

