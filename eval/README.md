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
