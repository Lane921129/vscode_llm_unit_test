# 中文變更紀錄

本檔記錄每個已完成、已驗證並提交的專案改動；不記錄 API Key、Token 或其他密鑰。

## 2026-09-02

### 合格非同步實例方法的隔離突變驗證

- 新增內建 AST 突變 runner 的端到端回歸案例：必要建構子、限定 `Class.method` scope、`asyncio.run` 的成功與例外測試會在每個隔離 mutant 上執行。
- 驗證原始 baseline 可通過、選取 scope 存在、所有候選 mutant 都被測試殺死，且沒有 runner error 或 survived mutant；防止類別／非同步情境只在測試生成通過、但突變分數失真的問題。
- 驗證：137 個 TypeScript 單元測試、50 個 Python AST pipeline 測試、TypeScript 型別檢查與完整建置皆通過；Lint 為既有 42 個 warning、0 error。

### Tier 1 一般 Coroutine 的可執行斷言

- 修正一般 `async def` 目標的 Dynamic Trace 已等待並取得真實結果，但 Tier 1 測試直接對 coroutine 物件做 assertion 的問題。
- Tier 1 現在根據 AST 的 `is_async` 事實，以標準 library event loop 執行一般 coroutine 的成功與例外呼叫；同步與 async generator 的既有流程不受影響。
- 新增正常回傳、`assertRaises`、必要建構子實例方法與實際執行 unittest 的 coroutine 整合回歸測試。
- 驗證：137 個 TypeScript 單元測試、49 個 Python AST pipeline 測試、TypeScript 型別檢查與完整建置皆通過；Lint 為既有 42 個 warning、0 error。

### Stub 快速通道的類別綁定安全性

- 修正 Stub 快速通道一律使用 `Class()` 與實例方法呼叫的問題；這會讓必要建構子參數、靜態／類別方法與 property 產生不正確或無法執行的 smoke test。
- 新增通用測試計畫器，依 module、instance、static、class、property 綁定方式產生正確呼叫；實例 Stub 僅能重用已驗證的 constructor literal。
- 必要建構子沒有可驗證設定時，快速通道會在報告標示安全略過，且不會呼叫 LLM 或寫入必定失敗的測試。
- 驗證：134 個 TypeScript 單元測試、49 個 Python AST pipeline 測試、TypeScript 型別檢查與完整建置皆通過；Lint 為既有 42 個 warning、0 error。

### 類別方法的目標綁定結構驗證

- 修正寫入前驗證器只要看到任意 `.method()` 就視為已測到選取類別方法的漏洞；這會讓錯誤物件上的同名方法通過行為驗證。
- 現在選取 `Class.method` 時，驗證器會要求呼叫經由目標類別直接匯入、目標模組 alias 的 `module.Class.method(...)`，或由目標類別直接建立的實例而來。
- 已加入正確實例、錯誤同名實例與模組別名靜態／類別方法的回歸測試；所有一般頂層函式與 property 驗證維持既有相容行為。
- 驗證：129 個 TypeScript 單元測試、49 個 Python AST pipeline 測試、TypeScript 型別檢查與完整建置皆通過；Lint 為既有 42 個 warning、0 error。

### Tier 1 類別實例的可執行建構子設定

- 修正 Tier 1 在 Dynamic Trace 已成功執行實例方法後，仍因 `__init__` 有必要參數而拒絕產生測試的問題。
- AST 呼叫端會把「已 literal 驗證」的建構子原始碼表示與實際值分開保存；Tier 1 只在兩者皆存在時，將相同設定寫入 `setUp`，例如 `self._instance = Service('prefix:')`，再呼叫該實例方法。
- Writer Prompt 同步看到這個已驗證建構子設定，明確禁止把建構子值誤傳給方法本身；沒有此證據時仍維持保守停止／要求 source-supported setup 的行為。
- 新增確定性 setUp、Prompt 與實際執行 unittest 的整合回歸測試。
- 驗證：126 個 TypeScript 單元測試、49 個 Python AST pipeline 測試、TypeScript 型別檢查與完整建置皆通過；Lint 為既有 42 個 warning、0 error。

### 局部實例變數的安全呼叫端追蹤

- 呼叫端掃描現在支援同一函式作用域的直接實例建立模式，例如 `subject = Service("prefix")` 後的 `subject.render("value")`；可用的建構子與方法字面值仍會分開提供給 Dynamic Trace。
- 只採用明確、同 scope 且呼叫前的直接賦值；條件式／巢狀 scope／factory／屬性鏈不會被猜測為目標類別。若同一變數已被重新賦值成未知物件，也會排除，降低將錯誤 caller 參數注入 Trace 的風險。
- 補充同名頂層函式、同名本地類別、模組屬性、匯入別名、局部實例與重新賦值的回歸測試。
- 驗證：123 個 TypeScript 單元測試、49 個 Python AST pipeline 測試、TypeScript 型別檢查與完整建置皆通過；Lint 為既有 42 個 warning、0 error。

### 類別方法的呼叫端與建構子 Trace 語境

- 修正選取合格名稱 `Class.method` 時，呼叫端掃描無法辨識 `from module import Class`、模組別名與 `Class(...).method(...)` 的問題；同名但未匯入目標模組的本地類別不會被誤認。
- 呼叫端現在會獨立保存可靜態驗證的建構子字面值和方法字面值。Dynamic Trace 使用前者安全建立實例、以後者呼叫目標方法，避免把建構子設定誤傳為方法參數。
- 有已知建構子實例時，原始碼導向的其他分支探針會沿用同一組建構子事實，因此必要建構子參數不再使已驗證的實例方法 Trace 整體失敗。
- 新增匯入別名、模組別名、同名碰撞與必要建構子實例方法的回歸測試。
- 驗證：123 個 TypeScript 單元測試、49 個 Python AST pipeline 測試、TypeScript 型別檢查與完整建置皆通過；Lint 為既有 42 個 warning、0 error。

### 精確的 `__init__` 初始化語境

- 修正 AST 擷取器會走進 `__init__` 內部巢狀 helper 的問題；helper 中的 `self.xxx` 不會再被當成建構子完成後可用的實例欄位。
- Class Method 的 Prompt、Mock Scaffold 與 Reviewer 因此只會收到可由真正建構子建立的狀態事實，降低模型憑錯誤欄位猜測 setup 的機率。
- 新增回歸測試，確認 `self.config`、`self.ready` 會保留，而巢狀 helper 中的 `self.transient` 會被排除。
- 驗證：123 個 TypeScript 單元測試、47 個 Python AST pipeline 測試、TypeScript 型別檢查、完整建置皆通過；Lint 為既有 42 個 warning、0 error。

### 可執行目標的函式清單

- 修正函式選單與批次掃描把局部 helper、函式內非同步 helper、巢狀類別方法也列為可分析目標的問題。
- 現在僅列出頂層函式與直接 `Class.method`；這些名稱與 AST、Dynamic Trace、Mock Scaffold、Tier 路由及突變測試支援的目標協定一致，不會再排入必定失敗的任務。
- 新增回歸測試，驗證局部函式與巢狀類別會被排除，而正常的模組函式與直接類別方法仍會保留。
- 驗證：123 個 TypeScript 單元測試、46 個 Python AST pipeline 測試、TypeScript 型別檢查、完整建置皆通過；Lint 為既有 42 個 warning、0 error。

### Class Method 的合格名稱端到端解析

- 修正 UI 傳入 `Class.method` 時，多個 Python 分析工具只比對裸函式名稱的問題；這會讓同名方法被錯誤的類別或頂層函式取代。
- AST Context、Dynamic Trace、Mock Scaffold、複雜度評估與內建 AST 突變引擎現在都接受合格名稱，並維持同一個選定類別範圍；生成／Reviewer 驗證則使用 AST 已確認的實際方法名建立 Python 呼叫。
- 複雜度評估移除依 `db`、`http`、`file` 等關鍵字猜測外部資源的邏輯，改保留可驗證的 AST 匯入與呼叫結構，避免領域污染 Tier 路由。
- 新增同名 `First.label`／`Second.label` 的整合測試，驗證選取 `Second.label` 不會誤追蹤、Mock 或突變另一個類別。
- 驗證：122 個 TypeScript 單元測試、46 個 Python AST pipeline 測試、TypeScript 型別檢查、完整建置皆通過；Lint 為既有 42 個 warning、0 error。

### 模型無關的 Writer 輸出契約

- 測試生成師不再根據模型名稱決定是否要求 `<thinking>` 分析標籤；所有 Cloud、Ollama 與 Custom API 模型統一只需回傳一個 `python` code fence。
- 補齊大型 Prompt、Tier 4 全自主生成與 Self-repair 的固定輸出文字；這些路徑不再要求分析標籤，避免部分 Tier 仍把推理內容混入測試檔。
- 這可避免模型把推理文字混入測試檔，並讓既有程式碼區塊擷取、unittest 結構檢查與 Python AST 驗證以同一套規則處理所有 Tier。
- 新增回歸測試，防止重新引入供應商／模型名稱黑白名單或任何 Writer 的 `<thinking>` 標籤。
- 驗證：122 個 TypeScript 單元測試、45 個 Python AST pipeline 測試、TypeScript 型別檢查、完整建置皆通過；Lint 為既有 42 個 warning、0 error。

### 可攜式 Python 預先驗證

- 生成測試的 unittest／coverage 預先驗證不再執行 Windows 專用的 `chcp`、`set PYTHONPATH`、`cd /d` shell 字串。
- 改由直接啟動 Python，透過明確工作目錄與繼承、去重後的 `PYTHONPATH` 傳入被測模組、父 package 與測試輸出位置。
- 新增跨平台環境與引數組合回歸測試，確認不含 `%PYTHONPATH%`、`$PYTHONPATH` 等 shell placeholder；coverage 失敗仍會保留輸出供 Reviewer 修復。
- 驗證：112 個 TypeScript 單元測試、Python AST pipeline、TypeScript 型別檢查、完整建置皆通過；Lint 仍為既有 44 個 warning、0 error。

### 模型無關的 Prompt 詳細度路由

- 移除依 `gpt-4`、`claude`、`gemini`、`pro`、`opus` 等模型名稱片段判斷 Prompt 大小的舊邏輯。
- 現在只根據探測到的參數量、Context 與已解析 Tier 決定 small／large Prompt；例如本地 31B 與未來新增模型不會因名稱不在清單內而被當作小模型。
- Tier 2 的分治策略也使用相同的能力資料，避免供應商品牌造成策略分歧。
- 驗證：121 個 TypeScript 單元測試、Python AST pipeline、TypeScript 型別檢查、完整建置皆通過；Lint 為既有 43 個 warning、0 error。

### 例外斷言的 AST／Trace 事實閘門

- AST 語境新增 `raised_exceptions`，只擷取被測函式本體中明確 `raise` 的類型，不會把巢狀 helper 的例外混入。
- 生成、Reviewer 與 Tier 4 Self-repair 在寫入前，會將 AST 例外和可 assertion 的 Dynamic Trace 例外合併為可用事實。
- 沒有這些事實的 `assertRaises(ValueError)` 等猜測性斷言會被拒絕；明確的 mock `side_effect` 仍能安全測試相依錯誤傳播。
- 驗證：120 個 TypeScript 單元測試、Python AST pipeline、TypeScript 型別檢查、完整建置皆通過；Lint 為既有 43 個 warning、0 error。

### 模型資格探針的獨立時限

- 所有 provider 的基本連線、模型清單與 Ollama 模型列表請求已統一至少 30 秒，不再使用 2／5／10 秒的短時限。
- Cloud、Local Ollama、Custom API 的結構化 unittest 探針與純 Python 回退各自有獨立 60 秒時限；前一步列模型或結構化輸出較慢，不會消耗回退驗證的時間。
- 此修正避免把延遲較高、首次載入較慢或經 RDP／實驗室網路使用的可用模型，錯誤標示為未通過 Tier 2–4 資格。
- 驗證：116 個 TypeScript 單元測試、Python AST pipeline、TypeScript 型別檢查、完整建置皆通過；Lint 為既有 43 個 warning、0 error。

### 可攜式原生突變引擎執行

- `mutatest` 與 `mutmut` 的啟動流程不再以 Windows／Unix shell 字串組合 `chcp`、`set`、`export` 或 `cd`。
- 兩者現在共用直接執行的命令計畫、明確工作目錄與隔離 Python 環境；目標與報告路徑作為獨立引數傳遞，支援含空白或非 ASCII 的專案位置。
- 原生引擎若回傳非零結束碼，stdout 與 stderr 仍會完整納入報告，讓分數解析、診斷與下一輪修復保有事實依據。
- 驗證：114 個 TypeScript 單元測試、Python AST pipeline、TypeScript 型別檢查、完整建置皆通過；Lint 為既有 43 個 warning、0 error。

### 儀表板結果直達與 Dummy 前置略過

- 覆蓋率儀表板中已完成的函式卡片現在可直接點擊，會在 VS Code 開啟該函式的 `final_report.md`；鍵盤 Enter／Space 也可開啟，勾選框不會誤觸。
- 僅在報告實際寫入後才啟用點擊；找不到報告時會顯示提示，避免開啟錯誤檔案。
- 名稱含明確 `dummy` token 的函式現在於複雜度與 AST 之前就直接略過，同時跳過 Dynamic Trace、LLM、突變測試與不可靠的 `None` Smoke Test；報告會保留略過原因。
- 新增 Dummy 名稱邊界與儀表板報告開啟的回歸測試。

### 可攜且不洩露路徑的執行追溯

- 報告不再寫入本機的擴充功能絕對路徑與工作目錄；改為 extension ID、版本、建置時間識別與 development／production／test 執行模式。
- 開源與跨平台使用者可用版本與建置識別確認實際執行的擴充功能，同時不會暴露磁碟代號、帳號或資料夾結構。

### 資料庫測試隔離技能卡

- 新增以資料庫 driver 靜態證據觸發的技能卡；不依專案、資料表或函式名稱判斷，因此不會污染一般測試 Prompt。
- 技能卡要求使用 module point-of-use patch、每測試獨立的 mock／in-memory／暫存資料庫，避免共用 SQLite 資料造成重複資料、鎖定與跨測試污染。
- 同時禁止裸用未匯入的私有連線 helper，並限制例外斷言只能依明確原始碼或 Verified Dynamic Trace 產生。
- 結構驗證新增硬性保護：拒絕連至檔案型 SQLite 的生成測試與直接操弄被測模組私有 helper；保留 `:memory:` 與 mock 的安全測試做法。
- Mock Scaffold 現在可追蹤同模組內、實際會碰到 imported I/O 的 helper，會自動產生該 helper 的 point-of-use patch；例如目標呼叫連線 helper 時，不再漏掉 SQLite 隔離。
- 跨模型輸出清理現在可辨識 `python`、`Python`、`py` 與未標記 code fence，僅擷取含 unittest 證據的區塊；模型分析文字不會再混入 Python 驗證造成 Markdown／缺 import 類錯誤。

## 2026-09-01

### Stub/Dummy 快速通道的結構式判定

- 修正快速通道過度寬鬆的分類：短小的純計算或「賦值後回傳」函式不再被錯當成 Stub/Dummy 而略過測試與突變分析。
- 判定不看任何業務字詞；除了 `pass`、空函式或移除 docstring 後的單一安全 literal 回傳外，函式名稱含明確 `dummy` token（如 `dummy_noise_function_001`）也視為使用者標記的雜訊／佔位函式，走最小 Smoke Test。
- 新增回歸測試，涵蓋 `dummy_noise_function_*` 命名標記，以及 `add`、容器操作等仍應進入正常測試流程的案例。

### 未探測模型的 Tier 品質閘門

- 尚未透過「測試連線」驗證的 provider／model 現在會先限制為 Dynamic Trace 驅動的 Tier 1，不再因參數量猜測而直接進入 Tier 2–4。
- 「測試連線」仍會讀取供應商可回報的模型參數量與 Context；另外以隔離的最小 unittest fixture 驗證模型是否真的能輸出並執行測試。兩種資料用途不同，會一併顯示於執行日誌與報告。
- 修正 Tier 1 的退回旁路：未驗證模型遇到 Trace 缺失或需要建構子引數時，現在會停止並提示先測試連線，不會暗中改用 LLM 猜測測試。
- 未驗證模型現在也會跳過 LLM 語意分析與存活突變體修補，改用 AST 技能卡並保留 deterministic Tier 1 的真實分數與報告；不再以不可靠模型嘗試灌高突變分數。

### 可執行的模型 unittest 探測

- 探測 fixture 從單一正向案例提升為正值與負值兩個已知行為案例；模型必須同時建立、assert 並在 isolated Python 中執行通過，才能開放 Tier 2–4。
- 「測試連線」不再只檢查模型輸出的 unittest 結構與 assertion；探測碼必須符合嚴格、無外部副作用的最小 fixture，並在 Python isolated mode 中實際執行通過。
- 連線資格結果因此能區分「格式看似正確」與「真的能產生可執行 unittest」，且不會執行模型任意輸出的程式碼。

### 匯入別名的簽名驗證

- 目標函式以 `from module import target as alias` 匯入時，Python AST 簽名閘門現在同樣會檢查別名呼叫的 positional 與 keyword 引數。
- 合法別名不再成為繞過未知 keyword／多餘 positional 引數防護的途徑；`assertRaises(TypeError)` 的明確錯誤簽名測試仍可保留。

### Package 模組一致匯入與 Mock Patch

- 目標檔位於 package／namespace package 時，系統會依 AST imports 推導一致的模組路徑，例如 `src.service_order`，不再強制以檔名 `service_order` 匯入。
- Tier 1、Tier 3、救援、Reviewer 與自動補 import 現在共用此路徑；Mock Scaffold 的 `patch` 也會對準實際載入的模組命名空間，避免 patch 到另一份模組實例。

### 生成測試匯入別名相容性

- 結構驗證現在可辨識 `from module import target as alias` 與 `import module as alias` 的合法目標呼叫，降低不同模型因程式風格不同而被誤拒絕的機率。
- 匯入別名若在測試碼中被重新定義仍會拒絕，防止模型以假的 helper 冒充被測函式。

### Dynamic Trace 副作用隔離

- Dynamic Trace 現在會在載入模組、建構實例與呼叫目標時阻擋檔案寫入、刪除、子程序、shell 與網路 socket 操作。
- 被阻擋的操作只會作為診斷資料，不會被誤寫為 `assertRaises(RuntimeError)` 測試事實；純函式與唯讀匯入維持可追蹤。
- 同時封鎖 `io.open()`、`os.open()` 與常見的 `Path` 寫入／連結／權限修改操作，避免低階檔案 API 繞過追蹤隔離。
- 兩個非字串／非布林數值參數現在會補充少量不同相對尺度的探索組合，避免只測到 `(50, 50)` 這類同位置配對而錯過衍生數值的多分支；斷言仍只使用真實 Trace 結果。

### 直接檔案 I/O 安全閘門

- 生成測試結構驗證現在拒絕直接呼叫 `open()` 與常見 `Path.read_*`／`Path.write_*` 操作，避免模型測試碼讀寫使用者專案或本機檔案。
- `unittest.mock.mock_open` 與 `patch("builtins.open")` 維持可用，檔案相依測試必須透過 mock 模擬。

### 目標行為斷言關聯閘門

- 強化生成測試結構驗證：被測函式的呼叫必須直接出現在 assertion、其回傳值必須被 assertion 使用，或必須位於對應的 `assertRaises` 區塊中。
- 阻擋「先呼叫目標函式、再 `assertTrue(True)`」這類無法驗證目標行為的虛假測試；同時保留變數接收回傳值與例外測試等正常寫法。
- 註解、docstring 與字串中的 `target(...)`／`assert...` 文字現在不會再通過行為閘門，避免模型以說明文字或註解假裝有測試行為。

## 2026-08-31

### 生成測試安全操作閘門

- unittest 結構驗證現在會拒絕模型測試碼中的 shell／子程序啟動、直接網路存取、`eval`／`exec` 等動態程式碼執行，以及破壞性檔案操作。
- 標準 `unittest.mock.patch("os.system")` 等 mock 字串不受影響；測試必須透過 mock 模擬外部與危險行為，而非在使用者環境直接執行。

### 突變分數隔離 Baseline 閘門

- 內建 AST 突變引擎現在會在與 mutant 完全相同的暫存匯入環境中，先執行未修改原始碼的 unittest baseline。
- baseline 失敗、逾時或無法啟動時，不再將每個 mutant 的測試失敗誤算為 killed；流程會拒絕該輪不可信的突變分數並顯示隔離 baseline 原因。

### Dynamic Trace 非決定性 Oracle 隔離

- Dynamic Trace 現在會辨識含記憶體位址的自訂物件、循環／過長容器、非有限浮點數等不可重現結果，將它們標示為不可作為 deterministic assertion 的語境資料。
- Tier 1 只會從可重現的 Python literal I/O 建立機械式斷言；不可穩定的結果不再生成會在下一次程序失敗的 `assertEqual`。
- 未通過模型能力驗證時，只有至少一筆可安全斷言的 Trace（或可安全呼叫的預期例外）才會啟用 Tier 1；其餘情況不會以不穩定資料誤判為可生成。
- 非可序列化物件現在不會呼叫自訂 `__repr__`；Trace 僅保留穩定的型別標記，避免 diagnostic 階段觸發副作用或例外。

### 已驗證的相依函式行為語境

- 深度 AST 相依解析現在會對可載入的專案內相依函式進行獨立 Dynamic Trace，將真實 Python I/O 事實傳給語意分析師與測試生成師。
- 語意分析師輸出的相依回傳值不再被視為未經驗證的事實；缺少 Trace 時改以相依原始碼與 `mock.patch` 為準，避免將 Python dict 誤寫為 `[object Object]`。
- Trace 失敗只記錄原因並保留靜態語境，不會中斷目標函式的測試生成流程。

### 跨 Tier 的 Trace 行為保底

- Tier 2–4 對頂層函式產生的合法 unittest，現在會自動加入所有可安全 assertion 的 Dynamic Trace 測試方法。
- LLM 仍可專注於 Mock、跨模組與存活突變體修補；但不能漏掉已由 Python 實際執行證實的輸入／輸出行為。

### 目標函式簽名相容性閘門

- 產生、Reviewer 與 Tier 4 自癒階段現在會以 AST 檢查測試對目標函式的呼叫；未定義 keyword 或超出 positional 上限的呼叫，若未明確以 `assertRaises(TypeError)` 驗證，會在寫檔前拒絕。
- 此閘門只使用函式簽名，並保留合法的錯誤簽名測試與 `**kwargs` 函式；可避免將相依函式的參數誤加到目標函式上。
- 內建突變引擎的子測試輸出現在以 UTF-8 搭配替代解碼處理，且 CLI JSON 保持 ASCII-safe；被測程式輸出非 UTF-8 位元組時，不再讓 Reader thread 中斷整個突變流程。

### Dynamic Trace JSON 輸出隔離

- Dynamic Tracer 現在會隔離目標模組載入、建構子與函式執行的 stdout/stderr，保證 CLI stdout 僅保留可解析 JSON。
- 新增含 stdout 與 stderr 的被測函式回歸案例，防止 print／日誌再度破壞 Orchestrator 的 Trace 資料。

### 目標分支覆蓋品質閘門

- 預先驗證現在以 `coverage run --branch` 收集分支資料；即使所有目標行都執行過，只要 `if`、loop 或其他控制流仍有未走分支，仍會交由 Reviewer／Tier 4 補測。
- 只會判定來源行位於被測函式本體的缺失 branch arc，避免同一檔案中其他函式的分支影響目前目標；coverage 報告無法安全解析時保持不誤攔。

### 可追溯的模型能力結果

- 每個 provider／model 的測試連線現在會保存非敏感的驗證結果說明與通過模式（結構化 JSON 或純 Python），並在最終報告列出。
- 使用者可直接判斷 Tier 限制是因格式、已知行為 assertion 或探針逾時，不需猜測「未通過」的原因；不保存 API Key、原始 API 錯誤或任何 Authorization 資訊。

### 類別綁定的技能卡精準化

- 「需要實例」技能卡現在只會套用至 instance method 與 property；`staticmethod`、`classmethod` 不再收到相互矛盾的實例化指令。
- property 的卡片明確要求以屬性存取而非加上括號，並新增 static、class 與 instance binding 的回歸測試。

### 相對匯入的動態追蹤

- Dynamic Tracer 現在會沿著 `__init__.py` 找出 package 邊界，並以完整模組名稱載入目標，讓 `from .helper import ...` 的相對匯入能提供真實 I/O Trace。
- 同名暫存 package 在不同追蹤間會被隔離，避免後一次 Trace 靜默使用前一個專案已快取的模組。

### 模型語意能力連線驗證

- 「測試連線」中的最小 unittest 探針現在要求驗證明確事實 `increment(1) == 2`；只產生 unittest 外殼、呼叫函式或 `assertTrue` 的模型不再被誤判為可用於 Tier 2–4。
- 結構化 JSON 與純 Python 相容回退均採用相同的領域無關行為契約，讓本地、Cloud 與 Custom API 的資格判定一致。

### 回傳值 assertion 的突變驗證

- 內建 AST 突變引擎新增通用 `return_value → None` 突變，會檢驗生成測試是否真的驗證函式的回傳結果，而不只覆蓋控制流程。
- 新增結構化字典回傳的回歸測試；此機制不使用任何業務詞彙，適用於字串、數值、tuple、dict 與其他可觀測回傳值。

### 套件匯入的突變真實性

- 內建 AST 突變引擎現在會依 unittest 的 `package.module` 匯入形式鏡像必要套件目錄，並覆寫其目標檔為突變副本；不再只寫入頂層檔案而意外載入原始模組。
- 新增 namespace package 型式 `from src.choose import choose` 的回歸測試，確保突變結果確實由被修改的模組產生。

### 跨模組相依測試有效性

- 結構驗證器現在會拒絕「修改本地相依回傳物件，卻未把它傳入被測函式或注入 mock」的偽相依測試；此類測試無法改變實際呼叫結果。
- 正確以 `patch`、`return_value` 或 `side_effect` 注入相依回傳值的 unittest 維持可接受，避免誤擋標準 mock 寫法。

### 目標函式完整覆蓋品質閘門

- Coverage 現在會區分「被測函式至少曾執行」與「被測函式每個可執行陳述式均已覆蓋」；後者仍有缺行時，不再因 unittest 通過或突變分數偏高而直接接受。
- 預先驗證、Reviewer 與 Tier 4 自癒均會收到具體未覆蓋目標行號，要求補足對應路徑後才視為完成；coverage 資料缺失或無法安全解析時維持保守不誤攔。

### 本機日誌與模型連線資訊釐清

- 新增 `log/` 本機 Agent／執行日誌目錄；除 `log/README.md` 外一律由 Git 忽略，且明訂不得記錄 API Key、Token 或含密鑰網址。
- 「模型資格」改名為「模型 unittest 生成能力（測試連線驗證）」，明確區分模型可連線、參數／Context 資訊與實際生成可執行 unittest 的能力。
- Cloud AI Studio 的測試連線現在採用 ListModels 實際宣告的輸入 token 上限；只有模型名稱明示 `31B` 等資訊時才標為「依模型名稱推定」，API 未公開時採保守預算，不再固定宣稱 1M Context。

### match/case 突變測試

- 內建 AST 突變引擎新增 literal `match/case` 模式的通用突變與回歸測試，讓各 case 分支未被測試時能被突變分數偵測；不加入任何領域專屬規則。

### 專案執行規則與維護規範完善

- 在 `PROJECT_RULES.md` 補充動態追蹤標準輸出（stdout）重定向隔離規範，避免被測函式內的 print 語句污染 Tracer 的 JSON 輸出。
- 在 `PROJECT_RULES.md` 新增 Reviewer 語境對等原則，要求自癒修復階段必須提供完整常數、Class 結構與 Trace 數據；同時明訂禁止透過竄改本地變數進行偽 Mock。
- 在 `AUTO_MAINTENANCE.md` 每次變更驗證流程中加入 `python_scripts/test_ast_pipeline.py` 回歸測試，並新增 `test/result` 歷史測試產物的定期清理與歸檔策略。

### 選定函式的突變範圍隔離

- 當使用者指定單一函式或方法時，內建突變引擎現在會排除其內部宣告的巢狀函式、lambda 與類別；這些 callable 不再被誤算進外層目標的突變分數。
- 候選發現與實際突變套用共用同一走訪規則，避免範圍調整造成候選索引不一致。
- 未指定函式的全檔案模式維持原本完整走訪，確保批次分析不遺漏任何可測 callable。
- 新增巢狀 helper 含分支時，仍只計算外層目標突變的回歸測試。

### Python match/case 分支追蹤

- 動態 Trace 現在可從 Python structural pattern matching 的 MatchValue、MatchSingleton 與 MatchOr 萃取安全純量 case 值，為每個 case 建立真實 I/O 範例。
- 字串、布林與數值 case 會加入不匹配值，以覆蓋 case _ 或未匹配預設路徑；不推測任何領域詞彙或複雜 pattern。
- 技能購物車新增 pattern_matching 卡，只有 AST／原始碼確實出現 match/case 時才提示模型逐一測試 literal 與預設分支。
- 新增 OR case、預設路徑與技能卡證據邊界的回歸測試。

### 純 Python 模型能力探測回退

- 本地 Ollama、Cloud Gemini 與 Custom API 的連線探測現在優先驗證結構化輸出；若模型不支援 JSON mode，會再以純 Python unittest 探測確認實際測試生成能力。
- 只有產出完整、可驗證且包含目標呼叫的 unittest 時才會通過 Tier 2–4 資格；不會因單純可連線或簡短文字回覆而放行。
- 純 Python 回應可安全接受單一 python code fence，讓遵守程式碼格式但不提供 JSON envelope 的模型可被正確辨識。
- 語意 JSON 仍採保守語法技能卡回退，避免非結構化模型污染 Prompt。

### 內建突變引擎控制流程擴充

- 內建 AST 後備引擎新增 while 迴圈條件、三元運算式條件與 augmented assignment（如 +=）的通用突變，不依賴特定業務函式。
- 修正不支援的運算子位於前方時，後續突變候選索引錯位的問題，避免錯誤套用或遺漏可突變語法。
- 單一突變體使原本會結束的測試逾時時，現在視為該突變已被偵測並計為 KILLED，不再誤列為基礎設施 ERROR。
- 新增控制流程、增量賦值、候選索引對齊與逾時行為的 Python 回歸測試。

### 目標覆蓋執行證據

- AST 現在提供被測函式本體的可執行行號，排除只因 import 而執行的定義／decorator 行，以及巢狀 callable 的行號。
- 預先驗證會把這些行號與 coverage report 的缺行資料交叉驗證；若目標本體完全沒有執行，即使 unittest 成功也會交給 Reviewer 或 Tier 4 自我修復，而不會誤判為成功。
- coverage 未安裝、目標列不存在或缺行格式無法安全解析時維持保守模式，不會製造假失敗。
- 新增 coverage 解析、未覆蓋目標偵測與 AST 可執行行號的回歸測試。

### 測試行為關聯品質閘門

- 生成測試的格式驗證現在要求同一個 test_ 方法同時包含被測函式／property 的使用與行為 assertion，避免以無關的 assertTrue(True) 偽裝成有效測試。
- 保留對 async 測試、assertRaises、property 存取與外部相依 mock 的相容性。
- 新增「目標呼叫與 assertion 分散在不同測試」的拒絕測試，以及同一方法正確驗證行為的接受測試。

### 多模型能力紀錄與 Tier 路由

- 連線探測結果現在會依「供應商＋模型」保存最多 50 筆非機密能力資料；切換回先前已驗證的本地、Cloud 或 Custom 模型時，可恢復正確的 Tier 資格與 context 預算。
- 能力紀錄僅包含模型名稱、參數量、context 長度與 unittest 探測結果，明確不保存 API Key、端點或其他密鑰。
- 重新啟動擴充功能後會過濾無效舊資料；尚未探測的模型會明確提示先測試連線，且不會誤用其他模型的資格。
- 新增多模型切換、同模型重新探測、Google 模型名稱正規化與安全還原的回歸測試。

### 產生器 Trace 與 Tier 1 斷言

- 動態追蹤現在會將同步與非同步產生器安全收集為最多 100 項的真實值前綴，不再把含記憶體位址的 generator repr 當作測試預期結果。
- Tier 1 可對有限 generator 使用 list(...) 斷言；對截斷序列只比對已驗證前綴，對 async generator 則在標準 unittest 方法中安全收集後斷言。
- 新增同步與非同步 generator 的 Trace 回歸測試，以及實際執行生成測試的整合驗證。

### Cached Property 動態追蹤

- 動態追蹤新增 functools.cached_property 支援，與一般 property 一樣以 descriptor 存取取得真實回傳值。
- 僅辨識標準庫 cached_property，避免把任意自訂 descriptor 誤判為安全可追蹤目標。

### Stub Smoke Test 斷言

- 純 pass、return None 與安全固定 literal 的 Stub 測試現在會使用精確 assertion，不再只確認未拋出例外。
- 若回傳值是運算式或其他不應在產生器中執行的內容，維持保守的 smoke 行為，不會杜撰預期值。

### 執行環境追溯

- 每份結果報告現在記錄實際執行的 extension.js 路徑、工作目錄、模型、請求與實際 Tier，以及模型 unittest 資格。
- 可直接辨識舊版或不同安裝位置的擴充功能產生的結果，避免將部署問題誤判為測試生成缺陷。

### Python Property Descriptor 語境

- AST 會辨識 @property、getter、setter 與 deleter，並把同一 descriptor 的 accessor 語境提供給測試生成流程。
- 動態 Trace 能安全建立無參數類別實例並讀取 property getter；Tier 1 會生成 self._instance.property 存取，而不是錯誤地呼叫 property()。
- 結構驗證器與測試 Prompt 支援 property 存取語法；有 setter 時會保留其存在與安全測試提醒。

### Trace 回復與突變報告可信度

- 動態 Trace 若 caller 字面值只造成參數數量或關鍵字不符的 TypeError，會自動改用原始碼條件導向測資重試，不再讓錯範圍的呼叫站阻斷 Tier 1。
- 技能卡現在必須有 AST 語法或已解析相依的證據；語意模型回傳的無關卡片不會再污染測試 Prompt。
- 內建突變引擎新增一般 if 條件反轉；沒有可突變點時會標示 N/A 並停止重複迴圈，不再誤報 0% 或重跑相同測試。

### 改進實作報告 PDF

- 新增五頁繁體中文 PDF 報告，整理 AST 語境富化、技能卡、Tier 路由、模型資格、測試品質閘門、突變後備引擎與密鑰安全管理。
- 報告明確列出已通過的 TypeScript 49 項、Python 15 項、編譯與 lint 檢查結果，以及尚待以合格模型完成的 Tier 2-4 端到端驗收。
- PDF 已以系統繁中字型完成文字擷取、頁數與逐頁渲染檢查。

### 相對匯入語境與相依解析

- AST 現在保留 Python 相對匯入的層級資訊，支援 from .helpers、from ..shared 與 from . import sibling。
- 深度相依解析會以被測檔案所在目錄處理相對路徑，不再錯誤以專案根目錄定位。
- 新增絕對／相對路徑解析與 AST 匯入層級的回歸測試。

### 未驗證 Trace 的安全停止

- 未通過模型資格的情況下，Tier 1 現在必須取得至少一筆成功或例外的動態 Trace；否則會停止並提示改用通過探測的模型。
- 不再讓失敗的確定性流程暗中退回未合格模型的 LLM 生成。
- 新增 Tier 1 Trace 可用性回歸測試。

### Tier 資格強制回退

- 未通過 unittest 生成資格探測的模型，即使使用者手動選擇 Tier 2、3 或 4，也會安全改走使用已驗證動態 Trace 的 Tier 1。
- 將 Tier 路由抽成可獨立驗證的規則，新增未合格回退、合格手動策略與 Auto 路由回歸測試。

### 原始模組完整性

- 生成測試不得透過 sys.modules 或動態建立同名模組來替換被測模組，避免測試呼叫到偽造實作而出現假通過。
- 仍允許對外部相依建立替身或使用標準 unittest.mock.patch，不影響正常的依賴隔離。
- 新增目標模組替換拒絕與外部相依替身允許的回歸測試。

### 數值常數突變

- 內建 AST 突變引擎新增數值常數變異，能檢查門檻值、增減量與計算常數被錯改時，生成測試是否能偵測。
- 新增數值常數變異被殺死的回歸測試；既有突變範圍測試同步涵蓋新的候選數量。

### 模型資格隔離

- 模型的 unittest 生成資格現在綁定到「提供者 + 模型名稱」，切換模型後不會錯誤沿用前一個模型的探測結果。
- 未探測或探測失敗的本機模型會安全地進入 Tier 1；完成自身探測後才可由 Auto 路由使用 Tier 2–4。
- 新增跨模型與跨提供者的資格隔離回歸測試。

### 目標範圍突變測試

- 內建 AST 突變引擎現在只針對使用者選定的函式或類別方法產生變異體，不再把同檔案的無關邏輯納入分數。
- 報告會標示實際突變範圍；若找不到選定函式，流程會明確失敗，避免誤報為「沒有突變點」。
- 新增同檔案含無關函式時的範圍隔離回歸測試。

### 目標呼叫品質閘門

- 生成測試現在必須實際呼叫使用者選定的函式或方法，且不得在測試檔內重新定義同名函式來偽造通過結果。
- 本機、雲端與自訂 API 的模型資格探測改為要求最小可自我驗證的 unittest 範例；空洞的常數 assertion 不再被視為可用模型。
- 新增「未呼叫目標」與「覆寫目標函式」的回歸測試。

### Caller Trace 與分支取樣合流

- Dynamic tracer 不再讓 AST 擷取到的字面呼叫站輸入覆蓋自動分支取樣。
- 現在會保留真實 Caller I/O，同時加入條件導向輸入並去重；沒有 Caller 時才補上型別邊界輸入，讓固定呼叫站不會掩蓋其他可達分支。
- 新增「真實 caller 值與另一分支同時存在」的回歸測試。

### 類別 static／class 方法的跨 Tier 呼叫語境

- AST 現在會標示模組函式、實例方法、static method 與 class method 的綁定型態。
- Dynamic tracer 對 static／class 方法不再嘗試建立實例，因此必填建構子不會阻擋真實 I/O Trace。
- Tier 1 與 Tier 3 的測試骨架可直接呼叫 Class.method；Prompt 也會明確禁止為這兩種方法多餘實例化。
- 新增帶必填建構子的 static／class 方法回歸測試。

### 生成測試的行為斷言品質閘門

- 生成測試驗證器現在要求至少一個 unittest assertion、assertRaises 或原生 assert，不再將只有 pass 的空測試方法視為可用產物。
- 此規則套用於模型初次生成、Reviewer 修復與 Tier 4 自癒；Stub 函式的專用 Smoke Test 快速通道維持原設計。
- 新增空測試方法的拒絕回歸測試。

### 動態追蹤的條件導向測資

- Dynamic tracer 新增純 AST 的條件導向取樣：辨識參數比較、數值邊界、長度邊界與集合成員判斷，產生少量可達分支的真實 I/O。
- 這些輸入只取自目標函式已存在的語法，不使用業務詞彙或特定函式規則；既有的型別邊界輸入仍會保留。
- 小型或不穩定模型現在更常能取得可直接生成 Tier 1 斷言的有效 trace，而不是只停在前置條件例外。
- 新增多分支與字串長度界線的 tracer 回歸測試，以及「Trace → Tier 1 → 內建突變器」端到端測試，驗證邊界突變確實被殺死。

### 內建突變器的布林邏輯覆蓋

- Python 3.12+ Windows 無外部突變工具時使用的內建後備引擎，新增 and／or 互換突變。
- 新增回歸測試，驗證測試案例能殺死布林邏輯運算子突變，而不是只覆蓋比較與算術運算子。

### 跨提供者結構化輸出能力驗證

- Cloud Gemini、Ollama 與 OpenAI-compatible Custom API 的「測試連線」改為實際驗證 JSON 內含完整 unittest 的最小生成能力，而非只送出一般文字或只檢查 JSON。
- 若提供者拒絕 JSON 格式，系統會確認純文字請求仍可連線後顯示能力警告；正式生成流程可沿用既有的文字回退，不會把「不支援 JSON」誤報為整個 API 無法使用。
- 新增 Cloud／Custom 回覆安全提取函式與回歸測試，不會假設外部 API 回傳的 JSON 一定具備預期巢狀結構。
- Auto 路由會在模型已明確未通過 unittest 生成資格時改選 Tier 1；使用者手動指定 Tier 則維持原選擇。

### 本地模型結構化輸出能力驗證

- 本地 Ollama 的「測試連線」現在會在模型資訊探針後，使用極小且不涉及業務領域的 JSON 任務驗證結構化輸出能力。
- 若模型輸出不完整 JSON、空內容或不符合預期格式，介面會明確警告：Tier 1 的確定性測試可繼續使用，但 Tier 2–4 建議選用 Instruct 模型。
- 這可提前識別小型 code-completion 模型的能力限制，避免使用者誤以為連線成功就代表能可靠產生進階測試。
- 新增探針請求與回應判定的單元測試。

### Keyword-only 動態追蹤與 Tier 1 生成

- Dynamic tracer 會把 required keyword-only 引數建立為 kwargs 並在結果中保留 Python repr，不再只記錄位置引數。
- Tier 1 確定性生成可將 trace 的 kwargs 還原為 `function(..., name=value)`，例外與成功斷言皆適用。
- 保持無 kwargs 的既有 trace 格式不變，避免不必要的 schema 破壞。
- 新增 keyword-only trace、Tier 1 生成及實際 Python unittest 端到端回歸測試。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、29 個 TypeScript 單元／端到端測試、8 個 Python 回歸測試、完整建置與 Git diff 檢查。

## 2026-08-30

### AST 函式與建構子簽章語境

- AST 提取新增參數 kind、型別註解、必填狀態與預設值，涵蓋位置限定、一般、keyword-only、`*args`、`**kwargs`。
- 測試 Writer 依實際簽章區分必填與可選參數，不再要求所有函式固定傳入所有參數。
- 類別建構子同樣區分 required／optional，Tier 1 只在真正存在必填建構子參數時才避免無參數實例化。
- 新增包含位置限定、預設值、keyword-only 與 variadic 的 AST 回歸測試。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、27 個 TypeScript 單元／端到端測試、7 個 Python 回歸測試、完整建置與 Git diff 檢查。

### 結構化回覆內容驗證與文字回退

- 結構化輸出不再只依 HTTP 400 判斷支援性；HTTP 200 但回傳空白、半截 JSON、缺少 `code` 的程式碼 envelope 也會自動改以文字格式重試。
- 保留純 Python 程式碼作為測試生成的相容格式，避免要求 JSON 的小型本地模型被不必要拒絕。
- 這項修正由本機 `codegemma:2b` 實測的不完整 JSON 回覆觸發，並加入結構化回覆有效性回歸測試。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、27 個 TypeScript 單元／端到端測試、6 個 Python 回歸測試、完整建置與 Git diff 檢查。

### 非同步 unittest 格式閘門

- 生成測試驗證器現在同時接受 `unittest.TestCase` 與 `unittest.IsolatedAsyncioTestCase`，也接受 `async def test_*`。
- 修正 Tier 3／Tier 4 對 coroutine 目標產生正確 async unittest 後，卻被同步格式規則錯誤拒絕的問題。
- 新增非同步 unittest 結構回歸測試。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、26 個 TypeScript 單元／端到端測試、6 個 Python 回歸測試、完整建置與 Git diff 檢查。

### 跨提供者結構化輸出相容性

- Custom OpenAI-compatible API 在需要語意／測試程式碼結構化輸出時，會要求 JSON mode；Cloud、Ollama、Custom 共用同一份通用輸出契約。
- 任一提供者以 HTTP 400 回報不支援結構化輸出時，會自動以文字格式重試，確保不同模型可加入同一個 Tier 流程。
- 新增 Custom API 請求內容與通用 JSON／程式碼 envelope 的回歸測試。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、25 個 TypeScript 單元／端到端測試、6 個 Python 回歸測試、完整建置與 Git diff 檢查。

### 類別動態追蹤可信度

- 動態追蹤無法安全建立類別實例時，不再以 `__new__` 跳過建構子；避免把未初始化屬性造成的 `AttributeError` 誤當成目標方法的真實行為。
- Tier 1 偵測到類別建構子有參數時不再猜測 `ClassName()`，改交由具有完整類別語境的生成／Reviewer 路徑處理。
- 新增回歸測試，確認需要建構子參數的類別不會產生偽造 I/O 與錯誤斷言。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、23 個 TypeScript 單元／端到端測試、6 個 Python 回歸測試、完整建置與 Git diff 檢查。

### Coverage 缺件時的可執行預先驗證

- 預先驗證改為先偵測 `coverage` 是否可用；未安裝時仍會直接執行 `unittest`，只將覆蓋率標為 N/A。
- 避免把環境缺少 coverage 誤判成 LLM 生成測試失敗，導致不必要的 Reviewer／Self-repair 呼叫與所有 Tier 降階。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、23 個 TypeScript 單元／端到端測試、5 個 Python 回歸測試、完整建置與 Git diff 檢查。

### 無外部套件的 AST 突變測試後備引擎

- 新增標準函式庫 AST 基本突變引擎；外部 `mutatest`／`mutmut` 可用時仍優先使用，否則可在 Windows + Python 3.13 等環境繼續執行比較、算術與布林突變。
- 每個突變都在暫存副本中執行生成的 unittest，原始碼不會被覆寫；存活突變會回饋給下一輪生成作為精準修補焦點。
- 當無法安裝外部工具時，系統不再直接中斷，並在 Log 明確說明完整引擎（WSL／Python 3.11）仍可提供更廣覆蓋。
- 新增回歸測試，確認邊界比較突變能被殺死且原始檔案保持不變。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、23 個 TypeScript 單元／端到端測試、5 個 Python AST／Mock Scaffold／async trace／mutation 回歸測試、完整建置與 Git diff 檢查。

### 非同步動態追蹤結果

- 動態追蹤器現在會偵測 awaitable 並以 `asyncio.run` 取得真正回傳值，不再把 coroutine 物件當作函式輸出。
- 新增 async 函式追蹤回歸測試，確認已驗證 I/O 可正確提供給低階與一般測試生成路徑。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、23 個 TypeScript 單元／端到端測試、4 個 Python AST／Mock Scaffold／async trace 回歸測試、完整建置與 Git diff 檢查。

### Cloud 模型可用性預檢

- Cloud 連線測試先呼叫 Google Model List API，僅接受 API 宣告支援 `generateContent` 的模型，再發送生成探針。
- 模型不存在、無權使用或不支援生成時，介面會回報可用模型建議，讓使用者直接替換 Model 名稱，而非只看到 404。
- 支援使用者貼上 API resource 形式的 `models/名稱`，系統會正規化成正確的生成端點，且 API Key 持續只放在 Header。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、23 個 TypeScript 單元／端到端測試、3 個 Python AST／Mock Scaffold 回歸測試、完整建置與 Git diff 檢查。

### Tier 3 Mock 使用點與非同步骨架

- Tier 3 的 mock patch 路徑改為被測模組的實際使用點，可正確處理 `import ... as ...` 與 `from ... import ... as ...`，不再錯 patch 到原始套件。
- 修正多個 `@patch` decorator 對應的 mock 參數順序，避免 mock 回傳值套用到錯誤相依項目。
- Mock 骨架現在辨識 `async def`，使用 `unittest.IsolatedAsyncioTestCase` 與 `await`；類別方法也會產生 instance 呼叫及建構子必填參數提示。
- 清除 Writer、Reviewer 與回歸測試中殘留的舊領域函式／欄位名稱，並加入防回歸檢查。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、21 個 TypeScript 單元／端到端測試、3 個 Python AST／Mock Scaffold 回歸測試、完整建置與 Git diff 檢查。

### 通用技能卡保底與進階測試能力

- 完整移除歷史遺留的業務領域 Few-shot，基礎範例只保留算術、例外與布林分支等通用 Python 行為。
- 擴充三張按需技能卡：非同步協程、檔案 I/O mock、固定時間；只依目標程式碼的語法／標準函式庫使用情況選取。
- Semantic Analyzer 正常運作時會與保守的語法級選卡合併；模型無法回傳語意 JSON 時仍注入保底技能卡，不會替任何特定專案或函式寫規則。
- 移除會把函式引數誤判為 tuple 回傳的保底推論，tuple 判斷繼續交由 AST／語意分析處理。
- 新增技能卡選擇回歸測試，確認 async、檔案與時間能力可被選取，且沒有除法時不會誤加除零規則。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、20 個 TypeScript 單元／端到端測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### Tier 1 端到端回歸測試

- 新增 Python `unittest` 端到端回歸：由 Tier 1 產生測試程式碼、載入相依函式並實際執行。
- 驗證精確字串回傳可正確斷言，避免再出現預期值被額外加引號而全部失敗的結果。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、18 個 TypeScript 單元／端到端測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### 基礎 Prompt 去領域污染

- 共用 Few-shot 僅保留通用的算術、例外與字串處理案例；舊專案領域案例不再注入任何模型 Prompt。
- Reviewer、Semantic Analyzer、技能卡與 Writer 的範例改為從實際函式簽章、原始碼與 AST 資料推導，不再預設特定欄位、模組或閾值。
- 新增回歸測試，禁止實際共用 Prompt 與啟用的基礎案例出現既有專案領域詞。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、17 個 TypeScript 單元測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### Tier 1 確定性測試生成

- Tier 1 不再請小模型補全 assertion；它直接根據已驗證的 dynamic trace 產生 `assertEqual`、`assertIsNone` 與 `assertRaises`。
- 修正模型即使回覆語法正確、但把字串多包一層引號時仍被接受的問題。
- 例外測試不再因 LLM 請求失敗而遺失，讓小模型、離線或不穩定連線仍能產出基本可執行測試。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、16 個 TypeScript 單元測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### Cloud／Local 結構化輸出與相容回退

- Google Cloud 生成測試時可要求受 JSON Schema 限制的 `{ "code": "..." }` 回應；回覆會在寫入前還原成 Python 程式碼並接受既有驗證。
- Semantic Analyzer 與突變分流師使用 JSON 輸出；本地 Ollama 對這類工作啟用 JSON mode。
- Cloud 或 Local 模型若以 HTTP 400 回報不支援結構化輸出，系統會自動回退至一般文字輸出，不會犧牲模型可用性。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、15 個 TypeScript 單元測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### 動態追蹤資料可信度

- 呼叫站中的變數、運算式與不可安全還原的資料不再被當成真實輸入執行；它們只保留在語意提示中。
- 可由 Python `ast.literal_eval` 安全還原的字面值位置／關鍵字參數，才會傳入 dynamic tracer；追蹤器同時支援這種 args／kwargs 格式。
- Tier 4 Self-repair 補上與生成器、Reviewer 相同的 Python／unittest 格式閘門。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、13 個 TypeScript 單元測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### 生成驗證、AST 語境與專案維護規範

- 新增 `PROJECT_RULES.md`、`AUTO_MAINTENANCE.md` 與本中文變更紀錄；規定每個已驗證改動必須更新 Log 並建立中英文 commit。
- 測試生成結果現在必須通過 unittest 結構檢查與 Python AST 解析，Markdown／說明文字不可再寫入測試檔；格式錯誤會以嚴格輸出要求重試。
- Reviewer 使用相同驗證規則，避免說明文字覆寫有效測試；Tier 1 會保留動態追蹤的 Python 字串 repr，修正額外引號造成的錯誤斷言。
- AST 提取新增完整 imports、被引用模組常數、類別基底、類別屬性及 `__init__` 初始化資料；屬性呼叫也會被識別。
- 呼叫站搜尋以目標模組與匯入別名確認，避免不同模組同名函式污染語境；動態追蹤移除業務領域關鍵字，改採型別註解與通用候選值。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、13 個 TypeScript 單元測試、2 個 Python AST 回歸測試、完整建置與 Git diff 檢查。

### Cloud Gemini 憑證欄位分離

- 改為儲存 API Key 名稱、API Model、API Key 三個欄位，名稱不再被用作模型 ID。
- 儲存完成後清空三個輸入欄位，且不將 API Key 回傳至 Webview。
- 舊版 `{ 名稱: Key }` 資料可讀取；建議重新儲存以補上明確模型名稱。
- 驗證：TypeScript 型別檢查、Lint（0 error、既有 54 warnings）、9 個單元測試、完整建置、Git diff 檢查。
- Commit：`a5af175`。

### Google API 與突變工具相容性

- Google API Key 改走 HTTP Header，並可由 SecretStorage 或 CI 環境變數取得。
- 依 Python／平台選擇可用突變引擎，避免 Windows + Python 3.12 以上錯誤執行不相容工具。
- 驗證：型別、Lint、單元測試、建置及 Python 相依性檢查。
- Commit：`7961b8c`。

### 語意策略與技能卡基礎

- 加入語意分析策略、技能卡庫與相關提示詞調整。
- 驗證：型別、Lint、Git diff 檢查。
- Commit：`9a6af74`。
