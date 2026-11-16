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
| hist_09 | touni | bottle 8804dd9 | `bytearray(b"abc")` | `"abc"` → `"bytearray(b'abc')"` |
| hist_10 | tob | bottle 06cc47b | `None` | `b""` → TypeError |

## 執行

流程與 `eval/README.md` 第 6 節相同，只多加 `--bugs-dir eval/historical_bugs`：

```bash
python python_scripts/eval_seeded_bugs.py prepare -o C:/r/hist --bugs-dir eval/historical_bugs
# 擴充套件：開 C:/r/hist，載入 targets.json（bug 版）與 clean/targets.json（乾淨版），v1、v2 各跑一次
# 對照組：eval_baseline_plain_llm.py --targets C:/r/hist/targets.json ...（clean 也跑一次）
python python_scripts/eval_seeded_bugs.py analyze --bugs-dir eval/historical_bugs --clean-dir C:/r/hist/clean ...
```

## 候選挖掘工具與清單說明

本目錄同時保存歷史修復候選挖掘紀錄（`candidates.json`、`candidates.md`）與上游授權文件（`licenses/`）。

### 篩選方法

`python_scripts/mine_bug_fix_commits.py` 只執行唯讀 Git 指令與 Python AST 解析，不 import 或執行上游程式，不 checkout 或修改上游工作區。

1. 掃描指定 revision 可達的非 merge commit，限定檔案／目錄（預設 `bottle.py`、`validators/`、`src/validators/`）。
2. 訊息須含 fix、bug、regression、issue 等字樣；排除明示新功能、效能／記憶體優化、重構與 PEP8／格式整理。
3. 整筆 commit 只能改一個 Python 檔案；即使其他變更只是測試或文件，也保守排除。修復前後都必須能由執行工具的 Python 解析。
4. 去除位置、註解、格式與 docstring 差異後，只能有**一個既有函式本體**的 AST 改變。簽名、裝飾器、模組／類別層級或多函式的語意變更均排除；新增／刪除函式也排除。巢狀函式獨立計數，同名相容性定義依詞法次序配對（後者標 `#2` 等）。
5. 人工檢查差異，排除純優化或新增功能；記錄修復判斷與可區分前後行為的 witness 建議。`candidates.json` 內的候選 witness 為靜態推導紀錄；已轉換為 `hist_01`～`hist_10` 的案例則已完成兩版實跑驗證。

此法偏向小型修復，會漏掉跨檔案修復、伴隨測試的修復、Python 2 語法與無關鍵字的修復；結果不能當成上游 bug 的完整統計。`screenedKeywordCommits` 是訊息篩選後、AST 篩選前的筆數；指定 `--limit` 時只代表掃描到上限為止。

### 重現挖掘（Windows 原生）

上游需放在本專案外的暫存資料夾。以下 `$historyRoot` 請指定一個新的外部位置；clone 只下載資料。

```powershell
$historyRoot = Join-Path $env:TEMP 'historical-bugs-review'
New-Item -ItemType Directory -Path $historyRoot -Force
git clone https://github.com/bottlepy/bottle.git (Join-Path $historyRoot 'bottle')
git clone https://github.com/python-validators/validators.git (Join-Path $historyRoot 'validators')
# 在本專案根目錄執行；固定來源 revision 見 candidates.json 的 sources。
python -B python_scripts/mine_bug_fix_commits.py (Join-Path $historyRoot 'bottle') --rev aba0c1a7ee59ed851db001d100b6a792b54a94a3 --files bottle.py --output log/historical-bottle.json
python -B python_scripts/mine_bug_fix_commits.py (Join-Path $historyRoot 'validators') --rev 22786cc6e7283a0fa452c179797e447f798db9f0 --files validators src/validators --output log/historical-validators.json
python -B -m unittest discover -s python_scripts -p test_mine_bug_fix_commits.py
```

CLI 可用 `--files` 指定其他 Git 路徑、`--limit N` 限制候選數，不指定 `--output` 時 JSON 寫到 stdout。輸出包含 commit、parent、日期、完整訊息、檔案、限定函式名、diff 新增／刪除／總行數、前後 docstring 有無、前後完整函式原始碼。diff 行數是整個檔案的文字差異（可能包含伴隨的註解），AST 契約另行驗證。

`candidates.md` 是人工檢查清單；`candidates.json` 保存所選候選的上述證據、來源 revision、判斷與 witness 建議。來源與授權資料見 `licenses/`；每筆 commit 連結指向上游原始歷史。
