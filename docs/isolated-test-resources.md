# 隔離測試資源

專案選擇區的「隔離測試資源」可準備空白目錄、測試文字與 SQLite schema／初始資料。工具管理資源，AI 只產生測試；不複製正式資料、不修改受測原始碼。

## 操作

初始化規劃會檢查來源中的明確 SQLite 建表語句。已有資源可補 schema；若來源能證明精確資料庫地址，也可直接提出新 DB 資源，不必先手動宣告空 DB。支援的 literal `CREATE TABLE IF NOT EXISTS`、可保真的新增欄位遷移與目錄／啟動入口一起預覽一次。`schema_plan.json` 保存候選與原因碼。未知動態路徑、不支援 SQL、一般 `CREATE TABLE` 或同表定義衝突不自動套用；需提供明確 schema，不能把找到的第一個 DB 當成目標。

若原始碼透過 `ConfigParser` 的明確 fallback 決定地址，清單會同時列出所需的空白 INI 測試設定。確認後只讓測試程序使用該空白設定，不讀取或改寫原 INI；既有非空測試設定有衝突時不覆蓋。跨檔依據保存為 `sourceDependencies`，每個 worker 核對摘要；`pythonSourceMode` 要求一般 Python 原始碼程序。設定來源改變、未知 package 初始化或無法保真解析時保持診斷。若突變改動這些設定依據而無法核對，記為 ERROR／未評分，不能算 killed。

欄位可使用 `default`（JSON scalar literal）、`unique: true`、`autoIncrement: true`（僅 `INTEGER` 且 `primaryKey: true`）；表可用 `unique: [["column_a", "column_b"]]` 宣告複合唯一限制。保留原有 rows，提案不新增或複製正式資料。每個 worker 都重建 seed；測試方法間仍須透過受測公開 API 安排個別狀態。來源修改使既有批准失效，必須重新預覽。

1. 選取專案並按「檢查模組載入／初始化設定」。實際阻擋的頂層 `Path.mkdir(exist_ok=True)` 若能確認路徑，清單會提出空白暫存目錄；確認套用後只重新預檢一次。
2. 需要設定文字、SQLite 表格或資料時，按「隔離測試資源」→「新增／編輯隔離資源清單」，選使用資源的 Python 檔案。清單保存於結果根目錄 `resource_setup`。
3. 編輯 `resources` 並保存，再按「隔離測試資源」→「套用已儲存清單並重新預檢」。確認時會列出資源／資料表／資料列數量。
4. 來源修改後若批准過期，選「更新來源版本供重新預覽」保留資源內容並重算草稿版本，再另行確認套用；不會自動刷新初始化入口行號。
5. 預檢可載入後按「開始測試」，才會進入 AI、執行、Reviewer 與突變；可載入不等於通過。

若已按「開始測試」執行批次，遇到受阻時選「處理初始化設定」，再確認實際資源清單。確認後只重新預檢一次；就緒時會接續同一批次、同一份來源勾選，不需要再次開始。仍受阻則停止並保存新的原因，不會反覆要求初始化；拒絕、取消或來源／Python／設定改變也不接續。「繼續測試並記錄失敗」只用於明確需要完整失敗診斷的情況。

`batch_workflow.md`／`failure_report.md` 的「初始化處理紀錄」可對照初始與套用後的設定 ID、資源數、處理結果和報告連結；JSON 原始紀錄在 `batch_manifest.json` 的 `preflightEvents`。這能分辨資源僅被提出、已套用但有下一個障礙，以及就緒後已接續；就緒仍不等於測試品質通過。

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

預檢會從實際受阻的 `Path.mkdir(exist_ok=True)` 提出支援的父層目錄，確認清單後重新檢查。原 `SampleData` 只作為邏輯路徑；工具在暫存區建立全新內容，不匯入原目錄資料。文字及 SQLite seed 也可使用相同 scope，例如 `SampleData/test.db`。此 scope 不得把 `path` 寫成 `../SampleData`、絕對路徑，或掛載整個專案／其祖先。

## 程式寫死的外部路徑

位於其他磁碟或更遠位置的固定本機絕對路徑，使用 `"scope": "external-exact"`。預檢從實際受阻的建立目錄呼叫提出精確路徑；確認視窗會逐項顯示映射，取消不套用。也可在清單手動加入，例如：

```json
{ "path": "C:/ExampleAppData", "kind": "directory", "scope": "external-exact" }
```

範例必須換成程式實際使用的路徑，不能自行猜位置。此路徑只用來辨識應用程式的讀寫；工具在自己的暫存區建立空白資源，不會建立原目錄或讀取原資料。需要內容時仍須明確宣告測試文字、SQLite schema／seed；不會自動搬入既有資料庫。

此 scope 限專案父層範圍之外、與來源樹不相交的本機路徑；專案內及相鄰目錄繼續使用原本兩種 scope。拒絕磁碟根目錄、UNC／裝置路徑、`..`、symlink／junction 與程式檔案。Windows 路徑正規化為 `/` 並統一大小寫身分；清單、來源或 seed 改變都必須重新核對。

突變仍比對同一個精確外部路徑。若程式以 `__file__` 動態推算較遠位置，複製至突變目錄後可能得到另一個地址；工具不會猜測或擴張授權，該基線會保留受阻原因及無有效分數。資源摘要中的別名也不能拿來當 expected。

解除目錄障礙後若發現 GUI 啟動或缺少資料表，報告會保留新原因；需依預覽確認相應替身或補齊 schema，不能將「已建立目錄」當成整個專案就緒。

## Windows 網路樣式路徑

如果程式使用 UNC 樣式名稱，Windows 可另外宣告 `"scope": "unc-virtual"`。這會保留程式原本的路徑，只在本機暫存區建立對應測試資源；不會測試網路共享是否存在、是否可用或是否有權限，也不會連線、查詢原路徑 metadata、讀取或寫入共享內容。`external-exact` 仍不接受 UNC。

以下是純示例名稱，不需要也不會連線：

```json
{ "path": "//unit-test.invalid/share", "kind": "directory", "scope": "unc-virtual" }
```

實際清單必須填入程式使用的精確名稱，不以此範例替換受測原始碼。Windows 分隔符與大小寫會正規化；可宣告共享根目錄或其子路徑，明確文字或 SQLite schema／seed 亦使用同一 scope。拒絕裝置路徑、`IPC$`、`..` 及與來源相交的映射。此功能不適用其他作業系統。

預檢只能根據實際受阻的 `Path.mkdir(exist_ok=True)` 提出候選；也可在「隔離測試資源」手動編輯。確認視窗會逐項顯示精確網路樣式名稱，明示「只在本機暫存區建立測試資源，不連線、不讀寫原共享位置；此確認不授予網路存取權限」。預覽本身不查詢原共享的 metadata。取消不儲存、不重新預檢；來源或設定在預覽後變動，必須重新核對。確認後只重檢一次，若發現下一個障礙，先保存原因，再由使用者另行處理。

每個程序在工具擁有的本機 lease 建立並清理資源，突變仍匹配相同原字面地址，不猜測其他共享名稱。模型只收到設定 alias／hash；不能把 alias 當路徑使用、當函式預期回傳值，或把 seed 當成已驗證答案。目錄可用也不代表實際網路服務或完整專案已通過測試。

## 生命週期與邊界

`Path.absolute()`／`abspath()` 的 UNC 路徑正規化只作字串計算，保留 Windows 分享根語義；它本身不需要資源批准。真正的 `resolve()`、目錄資訊及檔案操作仍須符合已確認的資源清單。突變複製來源時先排除 symlink／junction，不解析其目標位置。

- 匯入前建立宣告資源。目錄已存在，所以原程式若要求 `mkdir(exist_ok=False)`，真實 `FileExistsError` 仍保留，不會吞掉。
- 每個預檢、Trace case、測試程序、baseline、mutant 都建立新資源。同一程序的 import／函式呼叫沿用同一份，避免匯入建立的連線失效。
- 套件匯入的突變使用對應套件副本，不額外產生未使用的平面模組與目錄別名。若測試確實同時使用多種匯入方式且資源映射矛盾，基線仍會受阻，不能把這種設定錯誤算成 killed 或有效分數。
- 同一 unittest suite 的方法共用資源；AI 必須透過公開 API 安排與清理狀態，不能依賴執行順序、直接開檔或直接連接 SQLite。
- 程序退出時先關閉連線、清 worker。外層工具在 owned 子樹完全停止後，核對擁有權再清理 lease；取消／逾時同樣處理。清理失敗不能回報成功。
- `import_fixtures.json` 保存配置；執行證據保留計畫 ID／資源數量／操作摘要；`role_events.jsonl` 留下 `isolated-resources` 清理事件。隨機實體路徑不進邏輯 hash，也不提供為 expected。
- 未宣告路徑、越界、symlink／junction、可執行檔、網路、shell、SQLite URI／共享 DB、ATTACH／VACUUM INTO／extension 仍禁止。沒有精確外部宣告的專案外路徑，以及未支援操作，會明確受阻。
- 隔離 SQLite 缺表／欄位標示 `resource-schema-required`，不能當 assertion oracle 或 killed。GUI、通知與外部服務仍需明確 mock。

將原生檔案 handle 交給生成測試再讀寫不屬支援契約；不為此替換原生物件型別。

runtime 前置防護涵蓋支援的標準 Python 檔案／路徑 API 與已知 `ntpath` 別名，在底層操作前套用映射或阻擋；未宣告及不支援的 UNC 操作保持受阻。這是 Python 程序內防護的受限能力，不是抵禦惡意原生 extension 或任意私有 API 的 OS sandbox。資源提供可控輸入，本身不能證明需求或預期答案。
