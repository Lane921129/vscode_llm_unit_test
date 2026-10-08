# 隔離測試資源

專案選擇區的「隔離測試資源」可準備空白目錄、測試文字與 SQLite schema／初始資料。工具管理資源，AI 只產生測試；不複製正式資料、不修改受測原始碼。

## 操作

1. 選取專案並按「檢查模組載入／初始化設定」。實際阻擋的頂層 `Path.mkdir(exist_ok=True)` 若能確認路徑，清單會提出空白暫存目錄；確認套用後只重新預檢一次。
2. 需要設定文字、SQLite 表格或資料時，按「隔離測試資源」→「新增／編輯隔離資源清單」，選使用資源的 Python 檔案。清單保存於結果根目錄 `resource_setup`。
3. 編輯 `resources` 並保存，再按「隔離測試資源」→「套用已儲存清單並重新預檢」。確認時會列出資源／資料表／資料列數量。
4. 來源修改後若批准過期，選「更新來源版本供重新預覽」保留資源內容並重算草稿版本，再另行確認套用；不會自動刷新初始化入口行號。
5. 預檢可載入後按「開始測試」，才會進入 AI、執行、Reviewer 與突變；可載入不等於通過。

格式範例（必須替換成原專案實際路徑與 schema）：

```json
"resources": [
  { "path": "data", "kind": "directory" },
  { "path": "settings.ini", "kind": "text", "text": "[test]\nmode=demo\n" },
  { "path": "data/test.db", "kind": "sqlite", "tables": [
    { "name": "items", "columns": [
      { "name": "id", "type": "INTEGER", "primaryKey": true },
      { "name": "value", "type": "TEXT", "notNull": true }
    ], "rows": [{ "id": 1, "value": "example" }] }
  ] }
]
```

`tables: []` 建立空 SQLite，供原模組原有的初始化程式建立表格。工具不猜表格、不猜選或額外呼叫 `init_db`。不接受任意 SQL／setup script；複合鍵、外鍵、索引與 trigger 尚不在 seed 格式內。清單只能包含測試資料，勿放密碼、API key、正式資料或 provider 回應。

省略 `scope` 時，`path` 相對於所選專案根目錄。`pkg/config.py` 使用相鄰 `data` 時應宣告 `pkg/data`；程式內相對 I/O 以計畫根目錄匹配，不隨報告 cwd 改變。原始 `__file__`、來源 hash 與 coverage 身分不變。來源改變須重新預覽批准；跨專案或不同 seed 不共用證據。

若資料位於所選專案上一層的同層資料夾，可加上 `"scope": "project-parent"`。例如原程式使用 `APP_DIR.parent / "SampleData"`，宣告為：

```json
{ "path": "SampleData", "kind": "directory", "scope": "project-parent" }
```

預檢會從實際受阻的 `Path.mkdir(exist_ok=True)` 提出支援的父層目錄，確認清單後重新檢查。原 `SampleData` 只作為邏輯路徑；工具在暫存區建立全新內容，不匯入原目錄資料。文字及 SQLite seed 也可使用相同 scope，例如 `SampleData/test.db`。不得把 `path` 寫成 `../SampleData`、絕對路徑，或掛載整個專案／其祖先。此能力限同父層子樹；更遠位置仍須另行處理。

解除目錄障礙後若發現 GUI 啟動或缺少資料表，報告會保留新原因；需依預覽確認相應替身或補齊 schema，不能將「已建立目錄」當成整個專案就緒。

## 生命週期與邊界

- 匯入前建立宣告資源。目錄已存在，所以原程式若要求 `mkdir(exist_ok=False)`，真實 `FileExistsError` 仍保留，不會吞掉。
- 每個預檢、Trace case、測試程序、baseline、mutant 都建立新資源。同一程序的 import／函式呼叫沿用同一份，避免匯入建立的連線失效。
- 同一 unittest suite 的方法共用資源；AI 必須透過公開 API 安排與清理狀態，不能依賴執行順序、直接開檔或直接連接 SQLite。
- 程序退出時先關閉連線、清 worker。外層工具在 owned 子樹完全停止後，核對擁有權再清理 lease；取消／逾時同樣處理。清理失敗不能回報成功。
- `import_fixtures.json` 保存配置；執行證據保留計畫 ID／資源數量／操作摘要；`role_events.jsonl` 留下 `isolated-resources` 清理事件。隨機實體路徑不進邏輯 hash，也不提供為 expected。
- 未宣告路徑、越界、symlink／junction、可執行檔、網路、shell、SQLite URI／共享 DB、ATTACH／VACUUM INTO／extension 仍禁止。未宣告或超出支援父層子樹的專案外路徑，以及未支援操作，會明確受阻。
- 隔離 SQLite 缺表／欄位標示 `resource-schema-required`，不能當 assertion oracle 或 killed。GUI、通知與外部服務仍需明確 mock。

將原生檔案 handle 交給生成測試再讀寫不屬支援契約；不為此替換原生物件型別。

這是 Python 執行防護的受限能力，不是抵禦惡意原生 extension 的 OS sandbox。資源提供可控輸入，本身不能證明需求或預期答案。
