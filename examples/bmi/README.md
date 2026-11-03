# BMI 計算與測試範例

使用 Python 3.10 以上，只用標準庫，沒有第三方套件需要安裝。身高單位是**公分**，體重是**公斤**。

## 執行

在此資料夾開啟終端機：

```powershell
python main.py 60 170
python -m unittest discover -s tests -v
```

計算結果：`BMI: 20.76，分類: 健康體位`。

## 在 LLM Unit Test 工具中測試

1. 受測專案資料夾選擇本資料夾 `examples/bmi`，不是車輛管理系統。
2. 驗證目標選「執行驗證」。
3. 檔案先選 `src/bmi.py`，函式先選 `calculate_bmi`。
4. 使用已完成測試連線的模型；或明確選擇手動 Tier。單函式成功後，再測 `src/bmi.py` 的所有函式或專案 `all`。
5. 輸出目錄設在專案資料夾以外，避免下次掃描包含輸出。

這個專案不需要匯入初始化替身。新版工具切換專案時，會保留但不套用其他根目錄的初始化設定。本範例內附測試是手寫驗收基準，不是 LLM 已生成成功的證據。

## 結構與規格

```text
bmi/
  main.py             命令列入口；匯入時不執行
  src/
    __init__.py
    bmi.py            四個可獨立探索的純函式
  tests/
    test_bmi.py       八個驗收方法，含邊界與無效輸入
```

| 函式 | 規格 |
| --- | --- |
| `positive_number(value)` | 接受有限、正的 int/float；bool、字串等拋出 TypeError；零、負數、非有限值及轉換超限拋出 ValueError |
| `calculate_bmi(weight_kg, height_cm)` | 計算公斤 ÷ 公尺平方；回傳未四捨五入的 float；超出可計算範圍拋出 ValueError |
| `classify_bmi(bmi)` | 範例分支規格：小於 18.5 為體重過輕；18.5 至未滿 24 為健康體位；24 至未滿 27 為體重過重；27 以上為肥胖 |
| `bmi_report(weight_kg, height_cm)` | 回傳 bmi、category 兩欄；先用原始結果分類，再將顯示數值四捨五入至兩位 |

例如原始 BMI 為 23.999，顯示為 24.00，但分類仍使用 23.999。這是本範例明確定義的行為，測試不得自行改成先四捨五入再分類。

`src/bmi.py` 沒有頂層 input、目錄建立、資料庫或 GUI 啟動。測試工具不必修改來源檔就能探索與隔離執行。
