# Windows 平台探測與補測格式恢復

## 後續確認的 Housefun 讀取阻擋

2026-11-03 對原有 `Web_Spider/scraper/housefun_scraper.py` 使用正式預檢，確認仍有 file read 阻擋。資源 ID 指向該 .py 本身；原始診斷在 warnings／linecache／tokenize，靜態 compile 僅取得 L59 的 SyntaxWarning（invalid escape sequence），未執行應用。這是 compiler warning 顯示來源時的讀取，不是需要使用者填入的文字資源。

共享 runtime 現在只對真正 source-loader 編譯堆疊中的標準 SyntaxWarning formatter、同一個 warning.filename 提供來源讀取。警告仍存在，data 不變；一般 app getline／warn_explicit 不因此取得任意讀取。正式預檢兩個新程序均成功載入 Housefun 與車輛管理本體，來源／runtime 雜湊前後一致，保存於 `data_environment_inspection_20261102T232820Z`、`data_environment_inspection_20261102T232903Z`。這是模組載入證據，尚不是 Housefun 測試或 JavaScript 邏輯量測通過；未新增或執行專案回歸測試。

## 修正範圍

Python 3.13 的 `platform.machine()` 可經 `uname()`、`win32_ver()` 呼叫
`platform._syscmd_ver()`，執行固定的 Windows `ver` 命令。SQLAlchemy 匯入會觸發
此路徑；原先在開啟 `NUL` 時被資源保護攔截，並非應用程式需要文字 fixture。

共享 `guarded_runtime()` 現在於應用程式匯入路徑和 fixture 啟用之前，取得標準庫
固定 `ver` 探測的真實主機結果。在保護區內，只替換該標準庫 helper，重播同一
結果；離開時還原。保留原有 defaults／supported_platforms 語意，不填入猜測的
Windows 版本。非 Windows 不啟用。沒有開放 subprocess、shell、NUL 或任意讀寫；
應用程式啟動子程序，即使捕捉例外仍是受阻。

此策略由 import preflight、Trace、native 與突變子程序共用。它解決相依套件的
主機資訊探測，不能用來證明跨作業系統分支正確；需要測試不同平台分支時，仍須
由測試在實際使用處明確控制 `platform`／`sys.platform` 相依，不能修改目標本身。

補測合併失敗現在優先使用 merger 的原始 reasonCode，不再被缺少 AST inventory
的通用格式錯誤蓋過，也不進入完整測試檔的自動包裝。修復提示保留原始證據、
執行基線、焦點與選定方法簽名，提供語法、頂層語句、class header、fixture 或
既有方法變更的具體指引。仍共用目標失敗額度，並保留原品質閘門。

## 驗證

- `test_runtime_policy.py` 新增 Windows 真實 host 版本重播、結束還原與 subprocess
  仍受阻的驗證；另以安裝的 SQLAlchemy 驗證 preflight、Trace、native 和真正的
  builtin 突變執行，不以模擬的工具結果代替。
- `writerAdditionNamingIntegration.test.ts` 新增先回覆說明文字、再回覆不支援的
  頂層語句、最後產生合法補測的整合情境。模型回覆為測試替身，Python 工具實跑；
  驗證精確修復原因、兩次格式失敗只增加兩次計數、原基線保留，以及僅合法候選
  到達審查與突變。種子有效量測未達品質門檻另計一次；上限 4、累計失敗 3 時，
  最後一個允許的候選仍可成功。
- `writerPhases.test.ts` 驗證提示保留原證據與修改範圍。
- 舊整合測試改為明確指定失敗上限；scope 測試依現行方法修訂協定回覆，驗證
  額外方法立即停止。AST inventory 的測試替身保留目前含 codeHash 的診斷協定。

修正前模型實測保留於 `test_data/result/sp_live_20261101T151514Z`。
`test_data/result/sp_live_20261101T154012Z` 為中間版本：整合測試發現修訂角色
缺少原完整基線後，由代理停止並標為 `invalidated-by-integration-fix`，保留原始
部分結果，不冒充使用者取消，也不計入完成比較。修訂角色現已明確補回原基線。
上述都是局部驗證，不能視為完成跨專案泛化實驗。

最終版本模型實測另存於 `test_data/result/sp_live_20261101T155356Z`，政策為
失敗上限 5、品質無改善 3、批次失敗目標上限 10；每個目標 5 輪，原時間預算
6,000,000 ms，使用 `codellama:13b` 與 mutatest 3.1.0。起始 context 8192，
既有角色容量恢復可在模型上限 16384 內增加，實際各次設定記於 role events，
不宣稱整批固定為 8192。manifest 保存精確模型、bundle、來源及 fixture 雜湊；
Python 相依清單與結束時的來源／bundle／模型一致性另存。

Python 驗證：runtime policy、AST merge 與資源診斷 57 項通過。較廣命令中誤寫
不存在的 `test_mutation_baseline`，原錯誤紀錄保留於
`log/platform-addition-python.log`；其餘 114 個實際測試通過。正確模組
`test_mutation_baseline_repair` 補跑 4 項通過，保留於
`log/platform-addition-python-baseline-corrected.log`。57 項與較廣集合重疊，
不能直接加總，也不能宣稱整個倉庫所有測試通過。

Node 相關集合 65 項：`log/platform-addition-node-final.log` 中其餘 58 項通過；
scope 情境的錯誤字串原先比對人類報告文字，修為比對結構化 failureStage 後，
獨立重跑該檔 7 項全部通過（`log/platform-addition-node-scope-final.log`）。
保留前面失敗紀錄，不將它們覆蓋成成功。production bundle、型別檢查、lint 與
測試編譯也已通過。

## 原保存候選的環境重播

先前 `_listing_to_dict` 的 `loop1_test.py` 保持原位、原 bytes，以副本交給目前
guarded runner 與 mutatest 3.1.0，不重新要求模型產生測試，也不補上新的審查批准。
第一次獨立重播 host 未傳必要資源 lease，runner-error 的原結果保留在
`saved_listing_replay/`。改用 production `createResourceLease()` 後的重播另存
`saved_listing_replay_with_lease/`，native exit 0；兩次 mutatest 都是 baseline
通過、10/10 executed、0 error、0 timeout、0 notRun。來源和候選雜湊未變，
資源 lease 的 created／cleaned 均為 true。

兩次重播都是 killed 0/10；這證明原 config 相依副本阻擋已排除，不證明候選
品質達標。原候選大量使用空字串／假值，可能無法區分 or／and 等突變。
這份環境重播與新模型的四次實驗分開記錄，不能混為四次模型實驗的通過項目。

## 最終模型實測結果

四次全部完成；完整通過 1/4、環境／工具受阻 0/4、未達標 3/4、未完成 0/4。
兩次 DataCleaner 均保留 12/28 目標行與 4/28 killed 的基線，在 failureCount=5
停止。第一次 reporter 保留 0/10 killed 的基線，在第 5 次失敗停止；第二次
reporter 在種子階段完整通過（failureCount=0），目標行覆蓋 1/1、killed 10/10。

通過候選的實際檔案、Reviewer approval、native invocation、coverage 與 mutation
均綁定 `d41d0d31a62e063811c970521e55c5f7304d98186ed17352c659049231c8a7ec`；
`passing_candidate_identity_check.json` 的六項檢查皆為 true。其 line coverage
是所選函式範圍，不能說整份 reporter 模組／專案達 100%。品質政策仍要求目標行
100%、完整分支及突變至少 80%，沒有降低門檻。

合計 27 個邏輯請求、27 次 HTTP、7060 個量測輸出 tokens、214800.942 ms
有效成對生成時間（約 32.868 tokens/s）、857727 ms 目標執行時間。這些不是
貨幣成本或 GPU 時間。原始目標未變、設定寫入 0、憑證讀取 0。
`postrun_identity_check.json` 確認實驗前後來源、bundle 與精確模型版本均未變。

production bundle SHA-256：
`982be188906ae259b6d6b386c3d1295bb5cd0c6eead6525bdd33d258bed764e6`。
來源指紋：`215def32d9a2eb42facf6fe72a0edcbb0557a89a41ef171653239c020eae557b`。
所有失敗、環境重播和成功結果均保留。這是這兩個目標的局部驗證，跨專案泛化
驗收仍未完成；兩次 reporter 結果不同也不能被隱藏或以單次成功宣稱穩定通過。

## 命名中的雜湊

結果資料夾的短雜湊以來源路徑／目標身分去除同名或截斷後的路徑碰撞，並不是
來源內容版本。新增方法的 `test_add_<baseline>_<focus>` 則避免覆寫同名方法，
讓同一基線／焦點取得穩定的新名稱；AST inventory 若已存在該名稱，仍加後綴。
兩者都不是 unittest 的命名要求。真正的同候選證據另以完整 sourceHash／testHash
綁定，不以短名稱雜湊取代。
