# 生成能力修正核對（2026-11-03）

目前已完成多批既有 data 的真實模型生成與突變量測，但尚未證明「完成 Python 泛化單元生成與突變專案」的完整目標。各批版本與候選分開核對；最新進度見文末，較早的版本摘要與檢查結果保留為歷史紀錄。

## 原始問題對照

| 要求 | 目前程式狀態 | 證據與限制 |
| --- | --- | --- |
| AST 目標別名 | `target_bindings.py` 供目標呼叫、Reviewer／seed facts 與回傳斷言共用；無法解析時提供位置與修復提示 | 原保存候選已以相同內容重新作唯讀分析：別名呼叫在 L11，seed／review facts 均辨識一個呼叫，L13 回傳斷言可辨識；見 `data_alias_analysis_20261102T173922Z/analysis.json`。這不代表已取得回傳觀測或完整品質資格 |
| native／突變環境 | 基線與突變使用共同的相依副本、匯入配置與 fixture；基線失敗具有結構化分類 | 舊版 `_listing_to_dict` 已有一次完整通過；此結果不代表目前版本或所有專案通過 |
| 局部格式恢復 | 語法錯誤、空回覆、缺少／重複計畫方法與未修改共用目標失敗額度；重送保留基線與計畫 | 現有 Node 與 Python 檢查通過；fixture／新增方法／簽名／來源漂移與工具失效仍停止 |
| 環境診斷 | 提供經去密資源識別、來源行號、fixture 類型與設定形狀；schema 缺失另外說明 | 不會代填未知 schema 或把載入錯誤當成目標預期結果；具體專案仍須補齊資源並重新預檢 |
| 速率彙總 | 接受有限的小數毫秒；只累計有效 tokens／正耗時成對紀錄 | 已核對目前聚合與合併程式；舊紀錄的未知用量不會補成有效速率 |
| 獨立停止政策 | 側欄與設定分開提供單目標失敗、品質無改善、批次失敗及目標預算 | 現有 N=1／3／5、最後一次成功、跨角色去重計數與預算優先檢查通過；詳見 `STOP_POLICY.md` |

## 生成流程補強

- 本機模型完整回覆只有說明文字時，seed／addition 可在剩餘額度內切換程式碼續寫。
- 補測選擇排除基線已包含的型別化呼叫；合格回傳案例用完後可選擇確定的例外案例。
- 字串輸入規劃可追溯單次綁定別名與常用無參數正規化，並從包含、前後綴及分隔符提出輸入；預期結果仍須觀測。
- Reviewer 修正提供當次診斷及同候選可用證據欄位；宿主證據失效歸工具受阻，不扣模型失敗次數。
- 局部修訂先解開單一程式區塊，再由 AST 判斷範圍，避免把 fixture 修改誤判成可恢復語法錯誤。

## 較早階段的版本與驗證範圍（歷史紀錄）

- 基準 commit：`8fb075f7dd940938f07a021d40f121cee99529b0`；工作樹尚未提交，commit 本身不能識別修改後版本。
- 來源 SHA-256：`e259b94a6c3822def1ba6fbb063706e1f12a3bb6bf3edaff9576db4dee8cebb8`。
- 來源識別算法：`sorted-path-nul-bytes-nul-v1`；對 Git 已追蹤與非忽略新增檔案取唯一、排序的路徑，範圍為 `src/`、`python_scripts/`、`contracts/`、`package*.json`、`esbuild.js`、`tsconfig.json`，共 602 個檔案；每項依序雜湊路徑、NUL、原始位元組、NUL。文件與執行產物不在此摘要中。
- `dist/extension.js` SHA-256：`acbc3a9ecc3df534743da54ed86c0ab3ef49f1b8eaf91398b480c87d83b52bc6`。
- `out/orchestrator.js` SHA-256：`bd5a6b8b06f1107b17cf2f4c8ca9c0dc449c1e406eada62d315d4c96279237a9`。
- 本機 Node `24.18.0`、Python `3.13.14`。
- 最後一組 Node 檢查：`writerMethodEdits`、`stopPolicy`、`generatedTestValidator`，59 項通過；AST 方法編輯 Python 檢查 17 項通過。其他已完成的 21／41／49 項子集合彼此可能重疊，不加總成獨立案例數，也不代表全庫完整驗收。
- 最後正式建置的型別、lint 與 production bundle 通過。自使用者要求不再新增測試後，未再新增回歸案例；只調整既有驗收的必要斷言或案例選擇。此限制之前建立的測試檔仍保留於工作樹。

## 真實模型證據尚未覆蓋目前版本

`test_data/result/gen_live_20261102T070945Z` 保存兩次 `DataCleaner.parse_address_line` 執行。兩次都生成兩個方法並通過 native，品質狀態都是 `round-limit`，突變分數都是 `4/28`，不能稱為完整品質通過。該次 compiled entrypoint 摘要為 `af566b075c9be7368ae18434fe9bb7f67125414779202e6ffd1024dcd47b87f5`，與目前版本不同。

`test_data/result/sp_live_20261101T155356Z` 的四個目標執行中，`_listing_to_dict` 第二次為完整通過，其餘三次保留未達標成果。它使用另一個舊 bundle，不能與目前版本合併成通過率。

使用者已釐清：只針對目前 data 的程式生成測試；不再新增或執行用來檢驗本專案的回歸或其他測試。接下來固定當次來源／build、模型 digest、Python 相依、fixture、停止政策、預算與引擎；各專案及備份／測試程式分開確認範圍，每個實驗格至少兩次，保留失敗、受阻與未執行結果，同時報告通過率、受阻率、未完成率與成本。

## 範圍釐清後的 data 實跑

- `test_data/result/sp_live_20261102T091616Z`：兩個既有目標各兩次，四份模型測試均已匯出並重新執行成功，共七個測試方法。只有 `_listing_to_dict` 第一次完整通過，行覆蓋 1/1、突變 10/10；其他三份未完整通過。匯出候選與舊量測不相同者未繼承舊候選分數。詳見該資料夾的 `data_generation_report.md`、`generated/generation_summary.json` 及同候選證據。
- 此批 postrun 核對：工具來源、bundle 與模型 digest 均未在批次中改變；未再出現 `config` 缺失導致突變基線受阻。
- 實跑確認地址解析的八個規劃輸入已執行完成；仍有 Reviewer 把宿主 fixture 標籤當成缺少匯入的格式失敗。已補上最終 Reviewer 回覆指令，品質解析與門檻不變。
- `test_data/result/data_live_20261102T155438Z` 原規劃七個既有目標各兩次。執行發現同名 `loop1_test.py` 從錯誤目錄載入，由代理停止修復，標為 `stopped-for-tool-fix`；保留八個已完成結果、一個中斷及五個未啟動結果，並非使用者取消或 timeout。當次來源與 bundle 在停止時仍相符。原 BMI 與 token 候選後來在 `native_replay_20261102T161544Z` 以完全相同內容重跑成功，確實進入目標函式。
- 原始資料盤點另外保存於第一批的 `data_scope_inventory.json`／`data_scope_summary.json`；環境套件不當成應用目標，`all_test` 複本與原件分開。此盤點不代表其中所有函式已完成生成。

本次工作階段未提供 AOCI MCP 工具；未自行重建或修改正式 AOCI 索引。

## 既有 data 的生成能力修正與實跑（2026-11-03）

依使用者最新釐清，只生成及執行既有 data 的測試；不再新增或執行本專案自身的回歸／其他驗證測試。正常型別檢查、lint 與 production build 仍執行。

- 修正 native runner 的匯入順序：生成測試所在目錄先於來源目錄，避免其他既有 `loop1_test.py` 被載入。原檔的執行身分與目標呼叫證據照常核對。
- 來源匯入路徑納入未遮蔽標準庫的模組所在目錄，使 store 的歷史同層匯入可運作。
- 未執行的語意輸入提案採來源簽名允許的位置參數；keyword-only 與省略參數後的呼叫維持 keyword。實際呼叫形式仍須經探測，既有觀測不改寫。
- runner 證據無效、互相矛盾等故障歸工具受阻，避免錯扣模型失敗額度。

`test_data/result/data_core_live_20261102T161837Z`：add、BMI、store 兩個函式與 complex_test token，共五個目標各兩次。10 份模型候選均已保存、匯出並 native 重新執行通過，各一個方法。完整通過 0/10，均仍受 Reviewer／修訂阻礙。批次達第十個失敗目標後為 `policy-stopped`，全部十個工作均已啟動，沒有假報使用者取消。批次後核對來源、bundle、模型與目標來源均相符。

同候選診斷突變已全部完成；每次基線通過，所有選取突變均已執行，沒有 timeout／error。兩次結果依序為 add 6/6、4/6；BMI 24/39、26/39；safe_divide 7/13、7/13；calculate_discount 19/26、19/26；token 12/32、12/32。引擎 mutatest 3.1.0，operator `mutatest-ast-3.1.0-v2`。這些是診斷量測，不補發 Reviewer 資格。行覆蓋與診斷突變的明細、用量及測試連結見該批 `data_generation_report.md`；未沿用不同候選分數。

另找到 store 的輸入規劃缺口：不可還原的 caller 變數被排成 `not_started`，使已成功執行的其他案例也因整批未完成而無法被選作 seed。現將這類自動發現提案記為 `input_rejections`，保留來源檔案／呼叫者／行號／原因，不當作已執行案例，也不改寫 timeout 或真正未完成狀態。顯式 fixture／skill 輸入維持原驗證。Reviewer 提示另外說明宿主觀測旗標為唯讀證據，修正必須落在 Python 測試。

此修正已正常建置，既有 store 兩目標各兩次的 `test_data/result/data_seed_live_20261102T164430Z` 已完成。四次觀測均恢復為完整案例；1/4 保存並匯出 native 通過的候選，完整通過 0/4，該候選診斷突變 7/13。其餘三次未生成可執行基線：模型誤將回傳案例寫成例外預期，或把記錄中的 Python 字面值拼寫當成 runtime 字串；失敗與重複候選均保留。當次來源摘要 `f05a9e461b06abfce9313c80e5ac64da955676b2968145e4d4cc454dc4412b6e`，bundle `033db488c7f053819eb9f28b774cfefa4629963391c12edbb0178900d905c169`；批次後來源／bundle／模型均相符。

因此將選定案例追加為清楚的 Python 呼叫及結果字面值說明，明確區分正常回傳與已觀測例外，並指出宿主 JSON 不能抄成 fixture、字串不能透過 eval／解析變成測試輸入。原始資料、輸入身分及品質門檻保持一致。修正已正常建置；僅對既有 safe_divide 再跑兩次，另存 `test_data/result/data_literal_live_20261102T165322Z`。

最新兩次均在第一次生成得到 grounded 的單一觀測案例，native 通過並保存；匯出後以原模型測試內容重新執行亦為 2/2 通過。每份目標行覆蓋 2/3，診斷突變 7/13，所有突變執行完成且沒有 timeout／error。兩次仍在 Reviewer 回覆修復達失敗上限，完整通過 0/2；沒有將 native 或診斷突變冒充完整資格。當次來源摘要 `440cecf0046ed6b4bda518ec8b3a083a8babeeb607de2a03472114334dd4d673`，bundle `e403ebdf11177a0eed4c41e58414d7c0e65af183c442348b0f20c3e54405e49f`；批次結束核對來源／bundle／原 codellama:13b 模型 digest 均未改變。結果、可讀測試檔名及用量見該批 `data_generation_report.md`。

## Reviewer 實際資料診斷及本機 thinking

已用原有正常及失敗的 data 候選比較 Reviewer，不新增任何回歸案例。codellama 的一般 JSON 輸出沒有解決誤報；逐斷言可讀說明亦未解決其語意問題。codeqwen 對失敗候選也全部回空陣列，因此未把可解析空 JSON 當作模型資格證明。Gemma 在已保存失敗候選上指出具體例外／參數型別錯誤，對正常候選未報虛假匯入問題；詳見 `REVIEWER_DATA_DIAGNOSTICS.md` 及各批原始回覆，不能由少量診斷宣稱全面能力。

實跑另確認 Gemma 預設 thinking 會耗盡 2,048 個輸出 tokens，四次皆只有 thinking、沒有最終 response，為輸出截斷而非 timeout。新增 `llmUnitTest.localThinkingMode`，預設維持 `provider-default`，可明確選 `disabled` 傳送 `think=false`；run 啟動時固定選項，角色資格、快取及容量偏好區分不同思考模式，角色事件與知識紀錄保存有效模式。沒有增加預算或降低品質門檻。建置通過，沒有執行本專案的回歸測試或事先角色合成探針。

`test_data/result/data_gemma_live_20261102T172353Z` 固定 gemma4:12b digest `4eb23ef187e2c5462566d6a1d3bbbc2f1346d0b4327cbb66d58fffbcc9b2b05c`、thinking disabled，原五個 core data 目標各兩次，使用相同 maxLoops／失敗政策／預算／mutatest 引擎。當次來源摘要 `ff221a261f1683d309749db35c140bc073b87fcddd5e780b8dc5da27500fc29b`，bundle `4c578412a5c920e54bd1ab809ba0b90b73ad4bf016c5b25926e3afa6a5ba9b24`。第一個 add 已完整通過，同候選行覆蓋 1/1、突變 6/6、Reviewer completed，失敗數 0；匯出後重新執行亦通過。批次尚未結束，其他結果不得預先計入通過。

後續完成核對：上述 core 批次為 10/10 匯出後 native 通過、5/10 完整品質通過；Reviewer 重送補回未接受 finding 後，`data_review_repair_live_20261102T175532Z` 的 store 兩目標各兩次為 4/4 完整通過。`data_web_gemma_live_20261102T180729Z` 四份均可執行、1/4 完整通過，其餘保留品質未達標／停滯成果。每批來源、bundle 與模型結束核對均相符，未混合不同版本的通過率。詳見各批 `data_generation_report.md` 與 `REVIEWER_DATA_DIAGNOSTICS.md`。

## 極早耗盡目標預算的修正

只用既有 add 做實際資料流程：`data_time_budget_live_20261102T181648Z` 設定 1 ms 時間上限，各跑兩次，重現一次缺少報告、一次被 AST helper 吞掉預算例外而誤報 static-analysis。失敗原紀錄完整保留。

已讓 complexity／AST／caller helper 傳遞控制例外，並補上尚未建立 journal 時的預算停止記錄路徑。該路徑只寫停止資訊，不啟動新分析、不增加模型失敗次數；已由正常 finally 保存的候選與報告不重寫。當次預算、停止政策、來源及 run 識別照常保存。

`data_time_budget_live_20261102T220214Z` 同樣的既有 add、1 ms、兩次重跑，皆有完整目標報告，failureStage=target-budget、stopReason=budget-exhausted、failureCount=0、failureLimit=5，模型請求／HTTP／候選執行用量皆為 0。當次來源 `e39834f8921b53464ebf2964505ca08994a78df22737d0a2f341dcc526c0145d`，bundle `3df3123a101d5448734cbe738428f31594ad5d7a9fdf231f6659149f2c16c208`；來源／bundle／模型結束核對均相符。正常預算的同一 add 兩次完整生成流程另在 `data_normal_after_budget_live_20261102T220304Z` 執行中。這些均為原有 data 的流程，沒有新增或執行專案回歸測試。

正常預算兩次已完成：皆 native、Reviewer、行覆蓋 1/1、突變 6/6 完整通過，匯出後重新執行亦通過；一次在失敗數 2 後成功，另一次失敗數 0。正式批次驗證器重算為 2/2，兩次極短預算報告亦可完整讀取，均保持 target-budget 分類。沒有以截斷／缺失報告補成通過。

最新正常與極短預算兩批另外保存 `tool_snapshot/`：與各批 bundle／來源摘要核對一致的 extension bundle、Python runtime、contracts、套件鎖及 runner，共 72 個檔案；未新增回歸案例。較早批次只有當時的來源／bundle 摘要及原始結果，不能用較新的 runtime 冒充舊版本。各主要批次另有 `postrun_environment_check.json`，對照 Node、Python 與 pip freeze 版本清單。

尚未完成整體泛化驗收。地址解析第二次仍缺 L164（163→164）分支，存活突變集中在分隔後的城市／行政區正則與切片；需改善可追溯的輸入提案後，再用同一現有 data 目標重跑。另須擴大車輛管理本體的資料／fixture 診斷證據，與 Web_Spider、備份及測試程式分開記錄。所有後續工作仍限於原有 data，整體目標保持進行中。

## 正則與分隔段的輸入提案

已在原有 AST 輸入規劃器補上有限正則代表與相鄰模式拼接，沿單次寫入、清理、切片及明確 split 首尾段提出輸入。這條寬鬆來源線索只用於待執行輸入；不替代目標別名綁定、Reviewer、執行觀測或品質證據。沒有新增本專案的回歸測試、增加輸入額度或更動原有 data。`npm run package` 的型別、lint 與打包通過。

`data_regex_address_live_20261102T221710Z` 使用原有地址目標、相同 gemma4:12b digest／thinking disabled／停止政策／fixture／mutatest，各兩次；來源摘要 `430e2cdda61c66134fb551ae28cfb88c9ef009548fe11ef235378f524b4cad20`，bundle 摘要 `3df3123a101d5448734cbe738428f31594ad5d7a9fdf231f6659149f2c16c208`（本次改動為外載 Python，bundle 相同）。已保存核對一致的 runtime snapshot。初始 context 8192，原有自動容量調整仍會生效，不能宣稱固定使用 8K。

受控 Trace 已觀測 `一一市一一一一區-x` 回傳 `('一一市', '一一一一區', 'x')`，來源記錄為 `regex-composition:155,160`。先前輸入無法取得的城市結果現在可作 Writer 觀測依據。完整候選生成與量測仍在進行，尚不計入通過率。

上述批次後續完成：兩次皆五個模型撰寫方法、匯出 native 通過、Reviewer completed，但同候選覆蓋 24/28、突變 17/28，均 failureCount=5 後 retained-after-failure；正式 BatchJournal 重算一致，完整通過 0/2。三項結束身分核對均 true。結果證明新分隔段觀測可被生成器採用，也暴露了另外兩個規劃限制：長城市正則錯用輸入文字長度額度、同源分支別名未追蹤，以及一筆觀測一次品質量測導致額度先用完。

後續修正把模式來源與輸入文字額度分開，僅對最多四個較早賦值均回推至相同輸入位置的別名提出輸入；以錨點安排一個優先組合及一個單段代表，保持總共八筆輸入。初始 seed 嚴格維持一個呼叫；普通新增方法一次可綁定最多兩筆完整、一致、可重播且基線未測過的觀測，沿用原有多呼叫新增方法契約。未改共同失敗政策、修改範圍或同候選 Reviewer／native／覆蓋／突變資格。

`data_balanced_address_live_20261102T223543Z` 以同一地址目標各兩次啟動，所有模型、fixture、停止政策及引擎設定相同；新來源 `d6953cd54a01690c072ae576816d60cdfe332b6ec1c522d2e89a0f048cad77cd`、bundle `b5ea014ad5d781430e3a4b473d757cf27b4e6b6405cf5009b5c7e8dc08f0935e`，已保存 runtime snapshot。建置通過；未新增或執行專案回歸測試。此批執行中，結果另計，不能與前版混合。

此批已結束，正式 BatchJournal 重算為 1/2 完整通過、2/2 匯出 native 通過。第一次四個方法涵蓋七筆指定觀測，行覆蓋 28/28、分支完整、突變 23/28（82.14%），failureCount=3 後第 4 輪成功。第二次 Reviewer 提出 missing-scenario；模型將新增內容寫回既有 `test_seed`，範圍檢查正確停止於 repair-scope，保留原 native seed，沒有授予 Reviewer 或品質資格。三項結束身分核對均 true，失敗原始回覆完整保留。

追查發現 Reviewer 補案例路徑沒有綁定一般新增流程的唯一新方法名稱；現已讓它以當時確實執行的 candidate 作新增基線，沿用相同新增提示／方法名稱契約。真正的方法替換另外明確傳入局部替換標記與 text 格式，防止被一般新增包裝覆蓋。修改範圍違反仍維持停止，不將第二次失敗改寫為可重試或通過。

此範圍契約修正建置通過後，`data_review_scope_address_live_20261102T224912Z` 以同目標與同設定各兩次啟動；來源 `e0f393799b184f72e7251dcde4f573b5e2ca5e6a1ab66b8ccf36154d9a8abfcc`、bundle `f52ea073b64b749916663241d47b721b44f27a421f98ea5bb40880e6230f5278`。已保存 runtime snapshot，執行中，結果待正式核對；沒有新增或執行專案回歸測試。

此批已完成，正式 BatchJournal 重算為 **2/2 完整通過**，兩份原樣匯出後 native 也通過，各四個方法、七筆指定輸入，皆行覆蓋 28/28、分支完整、突變 23/28（82.14%），failureCount=3、stopReason=passed。第一次第 4 輪成功；第二次初始 Reviewer 要求補案例，採用修正後新增路徑，第 3 輪成功。第二次的初始 seed 雜湊 `88c2fa214f9486666966028003c8883e3a5413fe987233fbec889dc2a346d434` 與前批範圍停止的 seed 相同；本次 writer-review-addition=merged、addedMethodsCount=1，原 seed 保留，模型以唯一新方法寫入兩筆受控觀測，之後重新執行與 Reviewer 批准，不是忽略原範圍錯誤。

來源／bundle／模型三項結束核對均 true；Node、Python、平台、架構與 pip freeze 均與批次起始相符。實際模型請求 12／11 次；有效成對輸出用量 1151 tokens／27013.4 ms、1219 tokens／28638.5 ms，沒有把小數耗時略為零。所有正式突變已有同候選量測，未另外重複診斷量測，也未執行任何本專案回歸測試。各批原始失敗、未達標與通過結果分開保存，不能合併不同版本計算通過率。

本輪地址生成缺口已有兩次真實模型通過證據，整體泛化目標仍未完成。後續需對車輛管理本體的檔案／資料庫 fixture 診斷擴大既有 data 實跑，並與 Web_Spider、中文測試副本和 old backup 分開確認範圍。已唯讀確認本體 `database.py` 有 init_db 建表來源（L29 起），尚未將盤點視為執行或品質證據。

## 車輛管理本體的突變資源映射

`data_vehicle_core_live_20261102T230354Z` 僅選本體 database.py 的 get_destination_minutes 與 is_car_allowed_for_destination，各兩次，沿用原已設定的空 schema／空 INI／目錄 fixture，未加入測試資料列、未選中文測試副本與備份。四份模型候選皆 native 與 Reviewer 通過，但正式突變基線因 os.mkdir 阻擋，15／7 個突變均未執行；failureCount 均 0，保留工具受阻，正式 BatchJournal 重算一致。來源／bundle／模型結束核對均 true。

原因是扁平模組副本讓 config.py 的 `APP_DIR.parent / VMS_Data` 落在 baseline／mutant_N 的同層；原資源別名只承認 trial 內的位置。已擴至 driver 自有暫存父目錄中的精確來源推導位置，仍導向每 worker 自己的隔離資源，不讀原資料或修改 config.py。另外保留零測試 isolation-blocked 結構化報告，作環境受阻，不再誤報 runner 報告缺失；受阻不授予 target activation、passed 或 killed。

修正後將四份原候選原樣診斷重測：基線均 passed、完整執行 15／7 個突變，無 timeout／ERROR；時間換算兩份皆 9/15、白名單兩份皆 4/7。這些是診斷證據，另存當時 Python 工具與 bundle 雜湊，不把原批工具受阻或 Reviewer 資格改寫為完整通過。未新增或執行專案回歸測試。

`data_vehicle_resource_live_20261102T231237Z` 使用修正版本重新生成同兩目標各兩次，來源 `393061308027f3ddab5e3040f2982e94cb982f32b386bdbb333f6f77805ef184`、bundle `f52ea073b64b749916663241d47b721b44f27a421f98ea5bb40880e6230f5278`（Python 外載修正），已封存 runtime。第一組兩目標完整通過：時間換算 8/8 行與 14/15 突變、白名單 6/6 行與 6/7 突變；第二組仍在執行。這些是來源使用點的受控單元案例，不宣稱真實 SQLite 業務整合已通過。

白名單第一份模型候選另用 mock fetchone=[-1] 驗證比較邊界；這不是實際 COUNT(*) 會產生的資料。模型 Reviewer 與原品質政策均接受此受控單元候選，6/7 分數只能按這個 fixture 範圍解讀，不可作真實 SQLite 行為或獨立業務需求證明。工具沒有自動生成負計數測試或移除等價突變。

同時以正式模組預檢檢查既有 Housefun／本體，`data_environment_inspection_20261102T231441Z` 本體可載入，Housefun 仍 file read 受阻且缺來源位置。完整診斷與資源 ID 核對表明，被讀取的是 Housefun 原 .py；靜態 compile（未執行應用）取得 L59 的 `SyntaxWarning: invalid escape sequence`。阻擋發生於 warnings 格式化經 linecache/tokenize 讀來源，並被警告格式器吞掉後於 guard 結束重拋；不應要求使用者提供 Python 來源文字 fixture。尚待工具端修正與原模組重檢，原失敗報告完整保留。

本體修正批次後續已完成：**4/4 正式完整通過、4/4 原樣匯出後 native 通過**，正式 BatchJournal 重算一致。時間換算兩次均 8/8 行、14/15 突變、failureCount=1；白名單兩次均 6/6 行、6/7 突變，failureCount 分別 2／4，後者第 5 輪成功。共十二個模型撰寫方法，仍只代表兩個原有目標各兩次，不能當十二個目標。來源／bundle／模型結束核對與 Node／Python／平台／相依核對均相符；完整量測已存在，未再重複診斷突變。原失敗批次維持 0/4 完整通過、4/4 工具受阻，不與修正版本合併計算。

Housefun 警告讀取修正也已完成：共享 runtime 僅在真實 source-loader 編譯仍位於堆疊、標準 warnings formatter 正處理同一個 SyntaxWarning.filename 時，允許 linecache 讀該來源。沒有忽略警告、修改原 .py、要求 Python 文字 fixture 或開放一般 app getline／檔案讀取。原模組預檢以兩個新程序重跑於 `data_environment_inspection_20261102T232820Z`、`data_environment_inspection_20261102T232903Z`，兩次 Housefun 與本體皆 loaded，runtimeFiles／來源前後摘要一致。兩批均保存 Python runtime 檔案雜湊；最新 runtime_policy.py 為 `5c4b1869e577971b1f60f2d470d7be3f911867ff739a15789baed6667a91f95a`。較早預檢沒有單獨 runtimeFiles 摘要，僅保留原診斷，不冒稱同等版本封存證據。修正後 npm run package 通過，未新增或執行本專案回歸測試。

最新警告處理與上述本體模型批次為不同 Python runtime 版本，不能把預檢載入成功算成 Housefun 測試／覆蓋／突變通過。整體泛化目標仍在進行；下一階段應用已解除載入障礙的原有 Housefun 目標驗證 async／Page 相依案例生成，保留 Python 突變引擎對外部 JavaScript 內容的實際量測範圍。

## Housefun 現有資料的生成失敗與修復（2026-11-03）

`data_housefun_live_20261102T233211Z`：兩個原目標各兩次，完整通過 0/4、匯出 native 3/4。兩份 `_extract_items` 均 native／Reviewer 通過，但只有 await page.evaluate 的一行 Python，突變候選為零，不能證明其中 JavaScript DOM 邏輯已驗證。`scrape_region` 第一次耗盡五次候選失敗；第二次保留 native／Reviewer 候選，但最後突變只執行 14/16，剩餘 stage 額度不足，不能借用前一候選分數。該保留候選正式突變分數不成立。已有各批原始紀錄、原樣匯出與正式 BatchJournal 重算。

`data_housefun_shape_live_20261102T235038Z`：加入 mapping 鍵型別與 async 控制提示後，完整通過仍為 0/4、匯出 native 2/4、受阻率 0%、未完成率 100%。`scrape_region` 一份用錯 logger 匯入使用點等問題後耗盡五次失敗；另一份 page.query_selector 永遠回傳 truthy 按鈕、抽取每頁固定非空資料，且保留真實 asyncio.sleep，native 30 秒超時，failureCount=0，原流程未回到修復。提示文字本身尚未展現改善，不能宣稱問題解決。這批與前批來源版本不同，不合併通過率。

後續修正：完整且來源雜湊一致的 source call contract 可提供模組查找根與呼叫路徑，避免把 `from loguru import logger` 誤寫為目標模組的 `loguru.logger`；屬性呼叫根也可進入既有依賴綁定資訊。native 超時增加 runner 進度紀錄，必須驗證同一來源、候選、run、實際 unittest 方法進入及執行邊界，才能回到單一方法修復。setup／teardown／載入或無法確認方法者繼續停止；時間／請求總預算耗盡不轉成模型候選失敗。超時沒有完整 native／coverage 證據，不授予通過。

原樣重播 `shape` 批次第二次保存的兩份候選，診斷目錄 `native_replay_20261103T104739Z`：extract 正常結束；scrape 仍真實超時 30 秒，但可確認為單一方法可修復。來源／候選雜湊均未變。第一次使用 coroutine profile return 的實作在 Python 3.13 把 RESUME 當成結束，該失敗診斷保留；已改以實際標準 unittest 同步執行邊界辨識 async 方法的完整生命週期。這是原資料候選重播，不是新增回歸案例，也不代表模型修復成功。

兩個未有效啟動的生成目錄完整保留：`data_housefun_binding_live_20261103T104526Z` 因 Windows 結果路徑過長、無候選；`data_hf_bind_20261103T104836Z` 因 host 在打包完成前誤啟動而版本不一致，已停止 owned runner 並標為 tool／BuildIdentityChanged，不偽裝成使用者取消或模型失敗。打包完成後的固定版本另以 `data_hf_bind_20261103T104952Z` 執行，runtime snapshot 72 檔；仍須以正式結果判斷。

`data_hf_bind_20261103T104952Z` 已結束：兩次 scrape 皆五次可恢復失敗後停止，0/2 native、0/2 完整通過、0/2 環境／工具受阻，原始重複候選沒有重新執行。正式 BatchJournal 與匯出彙總一致，來源／bundle／模型及 Node／Python／相依前後均相符。檢查本批真實 sourceContext 發現另外一個契約錯位：AST signature／args 已排除 self，但 TS 提示驗證又把第一個 callable 參數 page 當 receiver，因此拒絕完整 source call contract，importContract.dependencies 仍為空。已取消重複排除；來源端原本即排除 receiver members，依舊只接受 declared callable parameters。這個修正需用後續新版本原目標兩次生成驗證，不能回填本批通過。

`data_hf_args_20261103T105922Z`：修正參數契約後，同一 scrape 兩次的真實 importContract.dependencies 均包含 logger 與 CITY_CN_MAP，page 成員也能通過來源提示驗證。兩份模型 seed 開始控制 asyncio.sleep 與 MAX_PAGES_PER_REGION，但仍以字串鍵 "1" 搭配整數參數 1；後續修復未穩定改正。兩次皆 failureCount=5、stopReason=failure-limit，0/2 native、0/2 完整通過，未進入突變。不能只因提示資訊正確便宣稱生成已成功。正式 BatchJournal／匯出彙總一致，來源／bundle／模型與 Node／Python／相依前後均相符。來源摘要 `5118ce27137d611022259c16d675c967754bcac978bdd3d1db7e688077070a4c`，bundle `4054b1ab44d84325914e19a1761ef5c2d233cde5a3fffe16c9ee07cc8394a526`，已封存 72 個 runtime 檔。此版 npm run package 型別／lint／打包與 diff whitespace 檢查通過，沒有新增或執行專案回歸測試。

同版另以 `data_hf_think_20261103T110821Z` 比較 provider-default（不傳 think=false），仍為原有 scrape 兩次，模型 digest、fixture、停止政策、品質門檻不變。模式與 disabled 分開記錄，不能宣稱設定名即證明 thinking 已啟用。已觀測 analyst-planning 輸出耗盡且沒有最終文字，工具按已完成 transport 的 token／耗時規劃輸出增額；這不是 native timeout。保留完整結果後再判斷，不能以增加輸出容量推定模型一定會寫出有效測試。

此 provider-default 批次亦已完成：兩次都在 analyst-planning 的第 5 次輸出失敗停止，failureCount=5／failureLimit=5／stopReason=failure-limit；輸出 cap 依序 1024、2048、2048、3072、3072，沒有完整最終文字，未啟動 Writer／native／突變。每次消耗 11,264 輸出 tokens，生成耗時分別 264,497.4／265,222.0 ms。這些耗時已使用有效 tokens／毫秒配對彙總，沒有被略成 0 ms。多層捕捉沒有把同一次輸出失敗重複扣次，HTTP 傳輸與模型失敗分開記錄。正式 BatchJournal 與匯出彙總均 0/2 native、0/2 完整通過、0/2 受阻、2/2 未完成；來源／bundle／模型及 Node／Python／相依前後核對均相符，所有原始失敗保留。

目前結論：來源屬性呼叫依賴漏接、第一個 callable 參數誤排除，以及可證明測試方法內 native 超時無法修復的工具缺口已修；僅以原候選重播確認超時可辨識與路由，未宣稱模型成功修復超時案例。最新兩種模式各兩次都尚無 scrape 可執行成功候選。剩餘生成問題是模型未穩定修復具體 fixture 鍵型別衝突，以及 provider-default 前置分析的最終回覆容量；單純增加等待時間沒有解決上述問題。完整 Python 泛化／突變目標仍未達成，沒有降低通過門檻、修改原 data 或新增本專案回歸案例。
