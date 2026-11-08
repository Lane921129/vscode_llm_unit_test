# 模型篩選用評估資料夾（eval-screening-v1）

這個資料夾只放模型篩選要測的函式，**用批次選整個資料夾跑一次就好**，不用手選函式。

每個檔案的函式都是用腳本從原始專案**逐字複製**的，邏輯沒有修改，只調整了 import，讓檔案可以獨立執行。來源寫在每個檔案開頭。

## 怎麼跑

1. 把整個 `eval_screening` 資料夾複製到實驗室，例如 `D:\eval\eval_screening\`。
2. 側欄的「專案目錄」選 `eval_screening`，檔案選擇維持 **all（整個專案）**，然後按批次執行。
3. 輸出目錄每個模型分開，例如 `D:\eval\results\phi4-14b\`。
4. 每個模型都用相同設定：
   - `num_ctx` = **8192**（4096 放不下完整證據）
   - 相同的溫度與其他設定
   - 執行前先按「測試連線」
5. 每個模型跑完，記下批次結果：通過、保留可用測試、失敗的數量，以及平均突變分數和總耗時。

## 測試目標（共 26 個函式）

| 檔案 | 函式 | 來源 | 類型 |
| --- | --- | --- | --- |
| `bmi.py` | calculate_bmi | test/data/bmi.py | 純函式 |
| `bottle_utils.py` | html_escape、html_quote、parse_auth、parse_date、parse_range_header、path_shift、tob、touni | bottle-main/bottle.py | 純工具函式，有 docstring |
| `validators_basic.py` | _char_value、_mod_check、iban、mac_address、slug、uuid | validators（iban、mac_address、slug、uuid） | 有 docstring 與範例，使用裝飾器 |
| `validators_utils.py` | _func_args_as_dict、validator | validators/utils.py | 裝飾器與輔助函式 |
| `vehicle_app_paths.py` | get_app_dir | 車輛 config.py | 路徑與環境 |
| `vehicle_db.py` | _connect、authenticate_user、get_destination_minutes、is_car_allowed_for_destination | 車輛 database.py | 資料庫相依 |
| `vehicle_time_utils.py` | format_eta_time、get_remaining_text、parse_actual_finish_time、parse_excel_datetime | 車輛 main.py | 純函式（時間） |

完整清單也在 `targets.json`，之後 PR #2 會用它建立 `eval/eval-set-v1.json`。

## 注意事項

- `vehicle_db.py` 原本的資料庫路徑來自 `config.DB_PATH`。這裡改成同資料夾下的 `vms_eval.db`，**這個檔案不存在，也不需要建立**。測試應該用 Mock 或 SQLite `:memory:`，不能碰到真的資料庫。
- `get_remaining_text` 使用 `datetime.now()`，結果會隨時間變化。這是故意保留的，用來觀察模型會不會處理時間相依。
- validators 的函式有裝飾器，失敗時回傳的是 `ValidationError` 物件，不是 `False`。
- 不要在這個資料夾裡放其他 `.py` 檔，否則批次會一起測到。

## 結果記錄表（每個模型一列）

| 模型 | 通過 | 保留可用 | 失敗 | 平均突變分數 | 總耗時 | 備註 |
| --- | --- | --- | --- | --- | --- | --- |
| codellama:13b | | | | | | 對照組 |
| phi4:14b | | | | | | |
| gpt-oss:20b | | | | | | |
| ministral-3:14b | | | | | | |
