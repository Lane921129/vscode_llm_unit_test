# 真實歷史 bug 評估（PR #14）

來源：現有測試專案（bottle、python-validators）在 GitHub 上真實發生過的修復。
每個資料夾格式與 `eval/seeded_bugs/` 相同（`meta.json` + `patch`）：

- 乾淨版 = 現行 `eval/eval_screening/` 檔案（已包含修復）。
- bug 版 = 在乾淨版上只還原該次修復的程式與 docstring 變更，其他不動。
- `meta.json` 的 `upstream` 記錄原始 commit；`witness` 是實際執行兩版得到的差異輸入。
- `hist_08` 的 `reconstructed: true`：2020 年的原始碼結構與現行差異太大，是依現行結構改寫的修復前行為。
- `batch`：1 = 第一批建議，2 = 第二批。

| id | 函式 | 上游 commit | 差異輸入 | 乾淨版 → bug 版 |
|---|---|---|---|---|
| hist_01 | mac_address | validators 6ffd862 | `"01:23:45:67:ab:CD\n"` | 無效 → 有效 |
| hist_02 | mac_address | validators 402b351 | `"01:23-45:67-ab:CD"` | 無效 → 有效 |
| hist_03 | slug | validators bea386c | `"my-slug\n"` | 無效 → 有效 |
| hist_04 | iban | validators b93327e | `"de29100500001061045672"` | 有效 → 無效 |
| hist_05 | iban | validators d9ec2ff | `"GB82WEſT12345698765432"` | 無效 → 有效 |
| hist_06 | validator | validators 3ae7b78 | `r_ve=False` | 回傳 ValidationError → 丟出例外 |
| hist_07 | html_quote | bottle 9b3ade8 | `"a\nb"` | `&#10;` → `%#10;` |
| hist_08 | uuid | validators 0ea54dd | `UUID(...)` 物件 | 有效 → AttributeError |

## 執行

流程與 `eval/README.md` 第 6 節相同，只多加 `--bugs-dir eval/historical_bugs`：

```bash
python python_scripts/eval_seeded_bugs.py prepare -o C:/r/hist --bugs-dir eval/historical_bugs
# 擴充套件：開 C:/r/hist，載入 targets.json（bug 版）與 clean/targets.json（乾淨版），v1、v2 各跑一次
# 對照組：eval_baseline_plain_llm.py --targets C:/r/hist/targets.json ...（clean 也跑一次）
python python_scripts/eval_seeded_bugs.py analyze --bugs-dir eval/historical_bugs --clean-dir C:/r/hist/clean ...
```
