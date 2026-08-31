# 中文變更紀錄

本檔記錄每個已完成、已驗證並提交的專案改動；不記錄 API Key、Token 或其他密鑰。

## 2026-08-31

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
