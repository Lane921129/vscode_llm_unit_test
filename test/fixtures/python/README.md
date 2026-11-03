# Python 內部回歸 Fixture Corpus

這些檔案是單元測試生成系統的內部、無業務資料回歸輸入，不是本 extension 的功能程式碼。
它們用於避免 AST、測試生成規則、Prompt 與驗證流程改動造成既有行為退步；目前不是公開
模型排行、公開驗收成績，亦不代表 Tier 2–4 已成熟。

- 每個 manifest 項目都標示建議 Tier、最低 coverage／mutation 門檻與不可接受的假測試。
- `expected.rules` 只列出由可觀察 Python 結構與 AST import/call 綁定可證實的測試生成規則。
- 這份 corpus 不含 API Key、網路端點、資料庫檔案或真實使用者資料。HTTP、檔案、時間與資料庫項目只能透過 mock 或隔離資源驗收。
- 這是內部模型／Tier 評估的共同輸入；模型是否合格仍以產出的 unittest、coverage 與 mutation 結果為準。

## 實驗室第一輪五類小批次

先在專案 `.venv` 安裝 `test/fixtures/python/requirements.txt`（Windows：
`.venv/Scripts/python.exe -m pip install -r test/fixtures/python/requirements.txt`）。
HTTP／async fixture 需要 `httpx`、`aiohttp` 才能匯入；實際測試仍必須 mock 外部邊界，不能連網。

`lab_batch_manifest.json` 固定第一輪的五個代表類別：純函式、class method、DB mock、async
相依與外部邊界。最後一項以 HTTP boundary 作為可重現的 mock 代理；若實驗室要驗證原始 UI
相依，保留同一個 category id，將 fixture 替換成對應原始目標並維持相同的報告欄位。
每個 category 必須使用獨立結果目錄，最後以本頁的 `fixture_scorecard.py` 彙整，不能把
缺報告或執行中斷算成通過。

新結果以同一份保留測試的 `coverage.selectedTarget` 實測行集合評分所選目標，並另存
`module_coverage`；未覆蓋分支仍會阻擋通過，100% 的門檻未改。身分、限定目標或行集合不符
一律拒絕。舊報告缺少目標範圍證據時繼續採模組分數，不從文字或其他輪次推算新成績。
實際 Tier 採同一保留候選的 `resolvedTier`，不使用降階前的報告標頭冒充原 Tier 通過。

## 彙整真實執行結果

先用 extension 對這些 fixture 產生測試並保留其 `final_report.md`，再執行：

```text
python python_scripts/fixture_scorecard.py <報告根目錄> --tier1-generation-mode llm-evidence-bound
```

實驗室第一輪只評分五個代表項目時，加上：

```text
python python_scripts/fixture_scorecard.py <報告根目錄> --batch-manifest test/fixtures/python/lab_batch_manifest.json
```

工具會在報告根目錄產生 `fixture_scorecard/fixture_scorecard.json` 與
`fixture_scorecard/fixture_scorecard.md`。加上 `--require-complete` 可讓
內部 CI 或 release 候選 gate 在任何 fixture 未通過門檻時回傳非零結束碼；它不會
呼叫模型、讀取 API Key 或把缺失結果算作通過。

Tier 1 的 LLM 證據導向與 deterministic fallback 必須分開評分。若同一 fixture
根目錄同時含兩種產生模式而沒有指定 `--tier1-generation-mode`，工具會標示
`mixed_generation_modes`，不會把兩種成績混成單一品質結論。可用的值是
`llm-evidence-bound` 與 `deterministic-fallback`。
