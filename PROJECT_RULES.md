# 專案執行規則

本文件是本專案自動化測試系統的長期約束；程式、提示詞、測試與維護工作都必須遵守。

## 通用性與語境

- `python_scripts/dynamic_tracer.py`、`python_scripts/ast_extractor.py` 與基礎提示詞不得硬編碼任何業務領域關鍵字、固定閾值或特定回傳結構。
- 技能必須由 Skill Dispatcher 根據目標原始碼與 AST 選取 Skill Cards；不得把某個專案的規則帶進其他專案。
- Semantic Analyzer 的 JSON 回覆必須先經 schema／佔位值清洗，才可傳入 Writer、Reviewer 或報告；模型不再負責選取技能 ID，舊 required_skills 僅保留讀取相容性；空白、`<...>` 佔位符、未知 assertion style 與不完整的分析結果項目不得污染測資策略或技能購物車。分析師提出的突變「候選」只是待驗證假設，不得視為事實。
- 語意分析的回覆至少要含有一個正式 top-level schema 欄位才可視為分析結果；任意 JSON、provider metadata 或錯誤 envelope 都必須拒絕並保留 AST 推導的技能卡基線。
- 供應商支援 JSON Schema 時，Semantic Analyzer 與 mutant triage 必須帶最小任務 schema；供應商 schema 只提供傳輸層結構保證，所有回覆仍需通過本地語意／分流 parser 和 execution quality gates。不得因 schema 成功就把模型候選升格為事實。
- 已驗證僅支援純 Python unittest 的模型，正式 Writer、Semantic Analyzer 與 mutation triage 都不得再強制供應商 JSON mode／schema；分析與分流仍須以 prompt 的 JSON 契約及本地 schema parser 驗證，不得放寬資料品質 gate。
- Semantic Analyzer 必須收到受預算限制的目標模組 imports、引用 globals、class bases 與 `__init__` 簽名／賦值；這些只可用於 import、constructor、dependency injection 與 Mock 策略，不能作為回傳值、例外或外部 side effect 的 assertion 事實。
- AST 提供的 imports、相依與引用 globals 必須遵守所選函式的 Python lexical scope；參數、區域重綁定、巢狀 callable、`nonlocal` 與 comprehension target 不得誤認為模組常數或模組 import 相依。只有可靜態證明未遭 shadow 的模組 binding 才可進入 Prompt。
- 來源碼中的 `return` 表達式只可提示可能的結果形狀與路徑；除非測試輸入可明確到達 literal return，否則不得把 `return helper(value)`、attribute 或運算式直接轉化為 expected value。精確 assertion 仍須來自可 assertion Dynamic Trace 或同測試控制的 mock side effect。
- Prompt 詳細程度與 Tier 2 分治策略必須依已探測的參數量、Context 與已解析 Tier 決定；不得以供應商、模型品牌或名稱片段建立白名單／黑名單。
- Writer 的輸出契約必須對所有 provider、模型與 Tier 使用相同的純 Python code fence；包括 Tier 3 Scaffold、Tier 4 與 Self-repair。不得依模型名稱插入或移除 `<thinking>` 等分析標籤，以免分析文字混入可執行測試。
- 產生測試前必須保留必要的語境：目標函式、imports、引用的模組常數、類別與 `__init__`、相依函式、呼叫站與動態追蹤結果。
- AST 已取得的目標與建構子參數型別註記必須以「輸入形狀提示」完整傳給 Writer、Semantic Analyzer 與 Reviewer；型別註記不得單獨推導回傳值、例外或 assertion oracle。
- `__init__` 語境只可包含建構子本體實際執行路徑中的 `self` 賦值；不得把巢狀 helper、lambda、內部類別的 `self` 賦值誤列為初始化狀態。
- 當 selected class 沒有自己的 `__init__` 時，AST 只可從同一模組、無 decorator／class keyword 且以簡單名稱可解析的繼承鏈提供有效建構子語境；匯入 base、動態 base、metaclass、cycle 或無法證明的 MRO 不得猜測。繼承簽名與父類別 `self` 賦值僅是 setup 指引，仍須依真實 caller literal 或隔離執行驗證，不能直接建構測試 oracle。
- 多重繼承只要含有任何無法解析的 base，就不得跳過它採用後方本地 base 的 `__init__` 當作有效簽名；Python MRO 可能先解析未知 base，系統必須保守視為未知。
- 生成、Mock Scaffold、Reviewer 與救援程式必須使用同一個可匯入的目標模組路徑；不得以檔名匯入而建立與 package 模組不同的第二個模組實例。
- 一般函式在任何模型角色請求前必須以相同 Python／匯入環境預檢正規目標模組與 coverage；核對來源實體，載入副作用仍受阻擋。環境不成立時保存具體原因並停止，不以 Tier 降階或模型修復處理。
- 模組預檢位於所選目標 AST 之後、相依／呼叫點探索與深度 Trace 之前。失敗快取限定同一分析／批次；新分析必須重新檢查已修復的相依，暫時工具失敗與取消不得當作可重用環境診斷。
- 呼叫站搜尋必須以目標模組／匯入關係確認，不得只依同名函式全域比對。
- 直接匯入的函式別名也必須在該呼叫行仍解析到目標 binding；函式參數、local／closure／`nonlocal` binding、同 scope import 與模組層後續重綁定都必須排除，不得把同名 callable 的參數注入 Trace。
- 對 `import package.module` 的呼叫站，只有與該 import 完整 binding path 相同的 `package.module.target(...)` 或 `package.module.Class(...).method(...)` 可補充 Trace 事實；相同 root 下的其他 attribute chain、動態 import 與不明 re-export 一律不可視為目標。
- 使用者選取 `Class.method` 時，AST、Dynamic Trace、Mock Scaffold、複雜度與突變測試必須全程解析為同一個明確類別成員；不得退回同名頂層函式或其他類別方法。
- 生成測試的結構驗證在目標為 `Class.method` 時，必須確認呼叫透過已匯入的目標類別、目標模組別名，或由其直接建立的實例；不得把其他物件的同名方法當作測試證據。
- `Class.method` 的呼叫站語境必須解析直接匯入、模組別名與明確 `Class(...).method(...)` 結構；建構子字面值與方法字面值必須分開傳遞，且不得把未能靜態驗證的實例呼叫當作目標證據。
- 呼叫端可將同一 lexical scope 中直接以目標類別建構的局部變數辨識為實例；條件式、外層 scope、屬性鏈、factory 或重新賦值後無法證明型別的變數一律不可當成 Trace 事實。
- 對已選取 `Base.method`，呼叫站僅可把未覆寫該 member、單一可解析基類且無 class decorator 的直接繼承子類別視為同一目標；複數繼承、覆寫、metaclass／decorator 或無法證明的 MRO 一律不得產生 Trace 事實。
- 函式選單、全檔案與批次掃描只能列出可獨立執行的頂層函式與直接 `Class.method`；不得把函式內局部 helper、巢狀類別或巢狀類別方法建立為分析任務。
- Tier 路由的複雜度評估只能根據 Python AST 結構與可解析的匯入／呼叫關係；不得以業務、資料庫、網路或檔案等名稱關鍵字推測風險。
- 動態追蹤執行目標函式時，必須對目標函式的 stdout 與 stderr 進行重定向隔離，確保追蹤輸出永遠為純淨 JSON，不受目標程式碼中的 print 或日誌干擾。
- Dynamic Trace 不得執行被測模組的檔案寫入、刪除、子程序、shell 或網路副作用；被阻擋的操作只能列為診斷，不得轉化為 LLM 的例外 assertion 事實。
- 例外事實以 AST／Trace 的確切 identifier path 或已驗證 `exception_qualname` 解析，不得要求類型名稱以 `Error`／`Exception` 結尾；診斷句子及 `call_assertable=false` 仍不得成為 assertion oracle。
- 含記憶體位址、循環結構、非有限數值或遭截斷 repr 的 Trace 結果僅能作為診斷語境，不得轉換為 Tier 1 或 LLM 的精確 assertion oracle。
- Trace 若實際讀取未控制的時鐘、隨機／熵或程序身分，該呼叫的回傳及例外均只能作為診斷，標記 `call_assertable=false` 與 `uncontrolled-ambient-read`。涵蓋目標、setup、helper、async／generator 及應用模組初始化；不能因連續數次值相同就升格為固定 oracle。需要精確斷言時使用同測試明確控制的 mock／輸入，仍走所有執行與品質 gate。

## 測試生成安全

- LLM 回應必須先通過 unittest 結構檢查與 Python AST 解析，才可寫入 `loop*_test.py`。
- 結構驗證必須接受可追溯的合法匯入別名，但不得允許測試碼重新定義被測函式或其匯入別名。
- `unittest.TestCase`／`IsolatedAsyncioTestCase` 類別可使用明確由標準庫 `unittest` 匯入的直接名稱或別名；驗證器必須追溯該 import，不可因模型選擇慣用拼寫而誤拒，也不可接受未證實來源的同名類別。
- 結構驗證必須確認 assertion 直接驗證目標呼叫、目標的回傳值，或 `assertRaises` 區塊中的目標例外；不得將無關 assertion 視為行為測試。
- 行為驗證只能採用可執行的 Python 語句；註解、docstring、字串或 Markdown 中出現的目標函式與 assertion 文字不得視為測試證據。
- 標準 mock 呼叫／await 斷言可作為行為測試，但 AST 必須證明 Mock 的標準庫來源、目標使用點 patch 或參數傳入，以及同測試內 target 執行與斷言順序。僅有同名 assert 方法、未使用 mock、重綁定或未 await 的目標不得通過。
- Trace 的 SQLite 僅可使用受保護的獨立 `:memory:` 連線；檔案、共享 URI、ATTACH／VACUUM INTO 與 extension loading 均不得提供 oracle，安全例外被目標吞掉也不例外。
- Reviewer 的相同測試／完整證據可在同一目標分析內重用；連續兩次契約失敗後停止額外審查，必須保留未完成狀態。完整工具通過與 Reviewer 完成分開保存，rollback 必須同步保留候選的審查狀態。scorecard 不得拼接跨輪次的最高分。
- 生成測試不得直接啟動 shell／子程序、直接連網、直接檔案 I/O、動態執行程式碼或做破壞性檔案操作；外部行為必須使用 `unittest.mock.patch`／`mock_open` 模擬。
- 生成、Reviewer 與 Self-repair 的目標函式呼叫必須符合 AST 擷取的簽名；未知 keyword 或過多 positional 引數只允許用於明確的 `assertRaises(TypeError)` 行為測試。
- 上述簽名規則同樣適用於被測函式的合法匯入別名，不得因 alias 而略過驗證。
- Markdown、分析文字、空內容、原始碼複製或沒有 `test_` 方法的內容均不可當作測試檔。
- Reviewer 與 Self-repair 必須使用相同驗證規則；失敗回應只能寫入報告，不可覆寫有效測試。
- Reviewer 與 Self-repair 階段必須提供與生成端同等完整度的語境（目標原始碼、imports、引用常數、Class 定義、相依、真實 Trace 數據與證據觸發的技能卡），禁止在缺乏常數與依賴定義的狀態下進行盲目修復。來源碼與技能策略只可選擇路徑／setup，不可取代精確 Trace assertion 事實。
- 涉及外部模組副作用或跨模組返回值測試時，必須使用標準的 `unittest.mock.patch`；嚴禁透過竄改本地變數進行無效的偽 Mock。
- 生成測試的標準 `patch` 字串或可解析 `patch.object` 不得替換所選目標或其類別，即使同檔另有真實 Trace 基線亦不例外。已知直接 unittest 類別中、沒有 decorator 的測試方法若要求額外必填參數，須於結構階段交 Writer 修正；無法證明的 decorator 注入仍由隔離執行判斷。
- 動態追蹤只提供可呼叫性的基礎 I/O 事實；複雜邊界與多分支策略由 Semantic Analyzer 產生。
- Tier 1 在模型已通過資格探測，或使用者明確選擇 Tier 時，必須由 LLM 根據目標來源碼、完整 AST 語境、可 assertion Dynamic Trace 與證據觸發的技能卡選擇測試組織；LLM 產物仍須通過結構、隔離執行、coverage 與 mutation gate。Auto 未驗證模型的 deterministic Trace 產物只能作為明確標示的 fallback，不得稱為 LLM 生成成果。
- LLM 證據導向 Tier 1 與 Tier 2–4 都必須保留所有可安全 assertion 的 Dynamic Trace I/O；模型可增加情境與測試組織，但不可因遺漏而移除已驗證基線。deterministic Tier 1 本身已由 Trace 建構，不得再重複附加。
- 模型 context 預算不足時，Prompt 必須以完整段落優先保留目標函式、可 assertion Dynamic Trace、類別建構語境、已驗證相依事實與證據觸發的技能卡；低信心的語意候選、補充策略與 few-shot 範例可先縮減。不得截斷規則、code fence 或將候選建議升格為 execution fact。
- Tier 1 fixture scorecard 必須以機讀 `llm-evidence-bound` 或 `deterministic-fallback` provenance 分開評分；同一份彙整含有兩種模式而未選擇模式時，必須拒絕形成單一品質結論。舊報告缺少 provenance 時不可計入 LLM 成績。
- 若要宣稱 Tier 1 LLM 已通過發行品質驗收，必須使用 scorecard 的 `--model-identity <provider/model>` 與 `--require-tier1-llm-release`；每個 Tier 1 corpus fixture 都必須是同一個模型識別、實際 Tier 1、`llm-evidence-bound`、無執行中斷且 coverage／mutation 均達各自門檻。deterministic fallback、混合模式、不同 provider／模型、缺報告、未計分或 Tier 不符一律不可替代。
- Tier 2 分治合流的每一份模型子回覆都必須先通過 Python/unittest 結構與 Trace assertion evidence gate，兩者缺一不可；不合格子回覆只能對該子任務帶著原因重試，不得合併污染其他已通過子測試。
- Tier 2 合併器必須以每個已驗證子回覆的標準庫 `unittest` import 解析其 `TestCase`／`IsolatedAsyncioTestCase` base 與 alias；不得只認固定 `unittest.TestCase` 字串而靜默遺失合法子測試，也不得接受未追溯到標準庫 import 的任意 base class。
- Tier 2 依 caller 分治時，每個子 prompt 與其 Trace assertion gate 只能接收 source literal 可精確匹配該 caller 的 Trace I/O；repr、動態值、近似值或未解析 caller 一律不可借用其他 caller 的 oracle。分治完成後才由全域 Trace augmentation 保留所有已驗證目標行為。
- 若目標為 instance method／property 且 caller 具有已驗證 constructor literal，Tier 2 caller partition 必須同時精確比對方法 args／kwargs 與 constructor args／kwargs；相同方法引數但不同實例 state 的 Trace 結果不得混用。Trace 若缺少可驗證的建構語境，該 caller 子任務必須保守不取得該 oracle。
- Tier 2 合流不得把不同 caller context 的 `setUp`／`tearDown`／Mock 狀態塞進同一個 TestCase；每個已驗證子回覆必須保留為獨立且名稱唯一的 TestCase，只可去重共用 imports。
- 每份中斷報告必須寫入 provider-neutral 的機讀失敗分類；分類只用於後續 Tier／模型品質分析，不能改變驗證 gate、重試或把失敗轉成通過。至少區分 API、格式、AST／Trace、執行驗證、coverage、mutation、環境與 timeout。
- Mutant triage 回覆必須包含 `verdicts` 陣列及每筆可辨識的 mutant、verdict、reason；`KILLABLE` 只有附帶完整 `kill_test` 才能成為下一輪提示。等效／可殺計數必須由已驗證 verdicts 重算，不得信任模型宣告的 summary 欄位。
- 已通過資格的 Tier 2–4 測試，對頂層函式必須保留所有可安全 assertion 的 Dynamic Trace I/O 方法；LLM 可以增加情境、Mock 與突變修補，但不得移除或覆寫已驗證的行為 oracle。
- 已通過資格的 Tier 2–4 測試，對可安全建立的 class method 或 property 也必須保留所有可 assertion 的 Dynamic Trace I/O；這些 Trace 測試必須使用獨立 `TestCase` 及已驗證的 constructor literal，禁止合併覆寫模型的 `setUp`，也不得猜測 constructor dependency。
- Dynamic Trace 可使用受限、語法／型別中立的數值尺度組合作為探索輸入，但任何測試 oracle 都必須來自實際執行結果；不得將探索值或結果解讀為特定領域規則。
- Dynamic Trace 對直接 AST `and` 條件可合成同時滿足多個不同參數之 literal／長度／集合子條件的單一探索輸入；只能在每個子條件皆可靜態證明且不衝突時使用，必須優先受限於 probe 預算，且仍不得將該輸入推定為任何輸出 oracle。巢狀 callable 的條件不得進入 selected target 的探索。
- Dynamic Trace 可從明確 `typing.Literal[...]` annotation 擷取有限 scalar 值作為探索輸入；只接受字串、數字、布林與 `None`，不得評估 annotation 中的 call、attribute 或任意表達式。這些值僅用於實際執行 Trace，不是 output oracle。
- 每一項新增 Trace 輸入推導能力，都必須新增中性 corpus fixture，並至少驗證 AST／Trace 取得預期輸入、deterministic Tier 1 unittest 可執行，以及符合該 fixture 的 mutation 門檻；不得只以單一 helper unit test 宣稱品質提升。
- 每一項新增類別建構語境（包括可安全解析的繼承 `__init__`）都必須有中性 corpus fixture，端到端驗證有效 constructor signature、caller literal、Dynamic Trace、deterministic Tier 1 unittest 與 scoped mutation；corpus 不得回讀舊的子類別空 `__init__` 而略過有效建構子。
- corpus 的 Python 整合驗收必須使用與 extension 相同的工作區 `.venv` 解析邏輯；不得在測試程式硬寫系統 `python`，避免本機套件遮蔽乾淨環境的依賴問題。
- 語意分析師提出的 input hints 只是候選；在傳給 Writer 前必須以 AST 目標函式 signature 過濾，絕不得讓 dependency 的參數、回傳 key 或 caller 局部變數成為 target kwargs。目標呼叫站僅能提供候選輸入，不是相依行為或輸出 oracle。
- Semantic Analyzer 的 scalar input hints 可在 AST signature 完整、每個 required 非 variadic 參數都有安全 literal／source default 時，轉為有上限的 Dynamic Trace 候選；只接受 `None`、布林、有限數字與無 expression 的短字串，禁止 eval、collection、call、attribute 或變數名。再次 Trace 必須與既有 I/O 合併保留，且新增結果仍須由真實執行決定 assertion／例外；候選本身永遠不是 oracle。
- 相對 import 的 caller 解析必須先依 caller 所在 package 與 `ImportFrom.level` 正規化為絕對模組路徑，再與 target module 比對；不可只以短模組名相符就收集 caller。跨模組 caller literals 必須透過 corpus 實測傳到 Dynamic Trace。
- `from . import module` 後的 `module.target(...)` 只能在該 relative alias 完整解析後精確匹配 selected target module 時視為 caller；不得把 package 的未知 attribute 或同名成員當作 module fact。
- 已解析的 module alias 仍須在呼叫行通過 lexical scope／module binding 歷史檢查；函式參數、區域 assignment、`nonlocal`、或較晚的 module rebind 都使該 alias 失去 caller 證據資格。
- 模型資格探測的 provider 請求與隔離 Python unittest 執行均不得低於 30 秒；同一 selected `.venv` 必須用於探測與正式執行，避免將慢速但可用模型誤判為不合格。
- Writer、Reviewer 與 Bug Fixer 的模型資格必須分別探測與保存；Writer Python 可執行不代表 Reviewer JSON 或單方法替換合格。Auto 只能呼叫各自狀態為 verified 的角色，手動 Tier 仍保留既有 gate。
- AST／Dynamic Trace 的分支探索可正規化純 literal 的反向比較（如 `3 < value`）與 parameter-first literal membership（如 `mode in ('a', 'b')`）；反向 membership、非 literal collection、helper call、複合 predicate 與巢狀 callable 一律不可產生輸入事實。
- `match/case` 只可擷取直接目標參數、無 guard 的 scalar literal／literal-or pattern 作為輸入探索事實；guarded case、capture／mapping／class pattern 與可變匹配一律不可當作可保證到達的分支。
- 模型若對完全相同、可 assertion 的 Dynamic Trace 呼叫直接寫出 `assertEqual` 或 `assertIsNone`，其 assertion value 必須與該 Trace 相同；`assertEqual` 的 actual／expected 兩種參數順序與可選訊息都必須檢查。`assertTrue`／`assertFalse` 只在 Trace 精確回傳 `True`／`False` 時判定矛盾，因為其他 Python 值的 truthiness 必須由隔離執行判定。初次 Writer、Tier 2 分治合流、Reviewer 與 Tier 4 Self-repair 的每個模型產物都必須套用此 gate；矛盾候選必須在寫檔／執行前拒絕並以事實原因重試。此 gate 不得拒絕未 Trace 的候選輸入或經額外轉換後的 assertion。
- Tier 1 若 AST 指出目標為一般 coroutine，必須用標準 library event loop 執行已驗證的呼叫後再 assertion／`assertRaises`；async generator 仍須以受限收集邏輯處理，不得把 coroutine 或 generator 物件本身當作結果 oracle。
- 相依函式的具體回傳值與例外類型，只有在 Python Dynamic Trace 驗證後才可作為測試事實；模型的語意推論只能當作策略建議，缺乏事實時應依原始碼或 `mock.patch` 處理。
- Tier 1／Tier 2 的模型生成測試不得先直接呼叫相依函式來計算 expected value、或建立未被目標呼叫使用的 setup；若相依行為決定目標路徑，必須在目標模組使用點以 `mock.patch` 明確控制，並以目標函式呼叫作為測試主體。
- 若模型在同一個測試方法中將非 target callable 的結果存入變數，該變數至少必須實際傳入 target、參與 assertion 或注入 mock；完全未使用的結果是無效相依 setup，必須在寫檔前拒絕。這個 gate 不得拒絕 target result、有效 target input 或 mock 設定。
- 突變分數必須以相同隔離匯入環境下可通過的原始 unittest baseline 為前提；baseline 失敗不得計算 killed mutant 或宣稱高品質分數。
- 內建突變 fallback 對選取的 `Class.method` 必須同時驗證限定 scope、隔離 baseline 與所有 mutant 執行；非同步實例方法的 mutation score 不得因 event loop、建構子或原模組匯入而失真。
- 內建突變 fallback 新增常見 Python operator 時，必須以可區分原始與突變行為的中性輸入驗證 mutant 確實被殺死；不得只增加候選數量便將未執行、等效或無法觀察的 mutation 計入品質分數。

## 憑證與外部服務

- Python 的專案依賴必須安裝於工作區 `.venv`；未明確設定 `llmUnitTest.pythonPath` 時，AST、Trace、資格 probe 的隔離執行、驗證、coverage、mutation 與本機 Python 回歸測試必須優先使用該 `.venv`（Windows 為 `Scripts/python.exe`，其他系統為 `bin/python`）。明確的使用者／實驗室直譯器設定可覆寫自動選擇；不得保存固定磁碟、帳號或工作區絕對路徑。
- API Key 只能放在 VS Code SecretStorage、CI Secret 或執行環境變數；禁止寫入原始碼、設定檔、報告與 Git。
- 公開 CI 必須在不取得雲端模型 Key 的條件下掃描 tracked files 與可達 Git 歷史的高可信密鑰格式；掃描失敗只可輸出 pattern 類型與檔案／commit 位置，不得輸出疑似憑證內容。此掃描不可取代已揭露憑證的撤銷與重建。
- Google API Key 必須走 HTTP Header，不可放入 URL。
- Cloud 設定需分開保存「名稱、模型、Key」；名稱不可被當成模型 ID。
- 模型 unittest 生成資格必須以無副作用的最小 fixture 在 isolated Python 中實際執行為準；不可僅根據 HTTP 成功或文字結構標記為可用。
- 最小資格 probe 的被測 fixture 必須由隔離執行器提供；模型只需生成 `unittest` 類別與指定的 target call／assertion。可相容地接受舊式自含同值 fixture，但不得因要求模型重寫 fixture 而誤判其測試生成能力。
- 最小資格 probe 可接受安全的 fixture 結果暫存、固定 expected scalar、`assertEqual` 訊息與 `-> None` 註記；允許集合必須為可靜態驗證的 unittest 語句，不能為了相容性執行任意模型 Python。
- 正式 Writer、Tier 2 分治、Tier 3 Scaffold、Reviewer 與 Self-repair 的完整 unittest code request 必須一律要求純 Python code fence，不得把整份測試檔包進 provider JSON／schema；本地 extractor、結構、隔離執行、coverage 與 mutation gate 是唯一驗證依據。Semantic Analyzer 與 mutant triage 的 JSON 契約可獨立失敗並退回 deterministic AST 技能基線，不得阻擋已驗證的純 Python code path。
- 尚未完成「測試連線」的 provider／model 視為尚未驗證；**Auto** 必須先使用有真實 Dynamic Trace 的 Tier 1 deterministic fallback，且只有同一 provider／model 通過可執行 unittest 探測後，Auto 才可使用 LLM 證據導向 Tier 1 與 Tier 2–4。使用者明確選擇 Tier 1–4 時必須保留其選擇，不得因探測缺失強制降階；其模型輸出仍必須通過結構、隔離執行、覆蓋率與突變閘門。測試連線應一併讀取供應商可提供的參數量與 Context，但兩者不可取代可執行性驗證。
- 模型資格的儲存、查詢與套用必須使用同一個 provider／模型身分正規化規則；Google 的 `models/<name>` 與 `<name>` 是同一模型，不得因 resource prefix 讓已通過的 Cloud 探測在 Auto 路由中失效；不同 provider 仍必須嚴格隔離。
- 測試連線的供應商發現與基本探針時限不得低於 30 秒；每一次結構化或純 Python unittest 資格生成必須有獨立、至少 60 秒的時限，禁止共用已消耗的 AbortController 而誤判慢速模型無法生成測試。
- 正式 Semantic Analyzer、Writer、Reviewer 與 mutation triage 的模型生成請求必須對暫態傳輸錯誤及 `408`、`429`、`5xx` 採有限次數、帶 jitter 的指數退避；`400`、認證與權限錯誤不得重試。重試不得重設使用者選擇的總 timeout，取消後不得繼續發送請求，且不得依 provider 或模型名稱決定規則。
- 結構化輸出拒絕或不完整回覆改走一般文字相容模式時，必須沿用原始 API 請求的 absolute deadline；不得以遞迴或新 controller 重給一次完整 timeout。若退避期間已到期，不得再送出下一次 provider 請求。
- 未驗證模型在 **Auto** 的 Tier 1 僅可產生完全由 assertable Dynamic Trace 推導的測試；Trace 不足或無法安全建構類別實例時必須停止並說明原因，禁止暗中退回 LLM 生成。使用者明確選擇任一 Tier 時，可走 LLM fallback／高階流程，但不得略過既有的輸出結構、Python 執行、覆蓋率與突變驗證。
- 若 `Class.method` 的成功 Dynamic Trace 使用了呼叫端已驗證的建構子字面值，Tier 1 必須以相同字面值建立實例後才可寫入 assertion；不得因建構子有必要參數而丟棄已驗證 Trace，也不得猜測建構子依賴。
- Tier 3 Mock Scaffold 若有已驗證的 caller constructor literal，必須將其作為明確 setup 事實提供給模型，並禁止將該設定誤傳給被測方法；沒有事實時不得憑空補出 constructor dependency。
- 未驗證模型在 **Auto** 不得呼叫 LLM 語意分析師、Reviewer、Tier 4 修補或突變體分流師；若 deterministic Tier 1 仍有存活變異體，必須保留測試與報告後停止，不得以猜測性修補灌水分數。手動 Tier 可使用這些流程，但每一輪的產物必須接受相同的可執行驗證，不得以模型宣稱取代證據。
- 未驗證模型在 **Auto** 的 deterministic Tier 1 若未通過 unittest 執行或 coverage gate，也必須在保留現有測試與報告後停止；不得因失敗而繞過上述限制啟動 Reviewer 或 Self-repair。
- Stub/Dummy 快速通道只能依函式本體的結構（`pass` 或單一安全 literal 回傳）或函式名稱中明確的 `dummy` token 判定；不得依短小行數或複雜度分數略過具有可觀察行為的程式碼。`dummy` 是使用者標記的雜訊／佔位約定，不是業務領域關鍵字。
- Stub 快速通道必須依目標的 module／instance／static／class／property 綁定方式建立可執行 smoke test；有必要建構子參數時僅可重用已驗證 caller literal，沒有事實則記錄原因並略過，不得寫入必定失敗的 `Class()` 測試。
- 名稱含明確 `dummy` token 的使用者標記函式，必須在複雜度、AST、Dynamic Trace、LLM 與突變測試之前直接略過；報告須清楚標示略過原因，且不得生成未驗證的 Smoke Test。
- 覆蓋率儀表板的完成項目必須可直接開啟同一項的 `final_report.md`；開啟前需確認檔案存在且名稱正確，執行中項目不可假裝有可用報告。
- 報告的擴充功能追溯資料必須使用可攜的 extension ID、版本、建置識別與執行模式；不得寫入使用者帳號、絕對檔案路徑或工作目錄。
- 生成測試的預先驗證必須透過引數陣列、明確 `cwd` 與 `PYTHONPATH` 環境變數直接啟動 Python；不得依賴 `chcp`、`set`、`cd /d`、磁碟代號或 shell 字串串接。
- 原生突變引擎（`mutatest`／`mutmut`）同樣必須使用引數陣列、明確 `cwd` 與隔離 Python 環境；路徑不得內插至 shell 命令。突變工具的非零結束碼必須保留 stdout／stderr 供報告與後續修復判讀。
- 偵測到資料庫 driver 的函式必須以資料庫隔離技能卡生成測試：每個測試使用 mock、in-memory 或暫存資料庫；禁止碰觸預設／共享資料庫、猜測驗證例外，或裸用未匯入的私有連線 helper。
- 生成測試結構驗證必須拒絕非隔離的 SQLite 連線與未匯入／直接呼叫被測模組私有 helper；`sqlite3.connect(':memory:')` 與標準 `mock.patch` 得以保留。
- LLM 的 `assertRaises` 必須有目標函式 AST 明確 `raise`、可 assertion 的 Dynamic Trace 例外，或同一測試明確設定的 mock `side_effect` 作為事實依據；不得憑空猜測業務例外。簽名不符的 `TypeError` 測試依既有簽名閘門處理。
- Mock Scaffold 必須追蹤被測函式呼叫的同模組 side-effect helper；helper 若到達 imported I/O boundary，必須 patch helper 的 module use point，避免因只看目標函式本體而遺漏資料庫連線。
- 模型輸出可使用標準 Python／Py／未標記 code fence，或被 `code` 字串 JSON envelope 包裝的上述區塊；系統只能擷取含 unittest 證據的單一程式碼區塊後進行結構與 AST 驗證，不得把 Markdown 說明、無 `code` 字串的 JSON 或多段產物當作測試程式。
- 供應商拒絕 JSON／schema 格式時，僅可針對明確的格式拒絕狀態（400、415、422、501）回退為純文字生成；401、403、404、429 與 5xx 等帳號、模型、配額或服務錯誤必須保留並清楚回報，不得偽裝成格式回退。
- Provider 回覆文字必須依官方／相容協定完整讀取所有可執行 text segments，再交給結構化輸出與 Python 驗證；不得只取第一段而截斷 JSON 或測試碼，也不得把 tool、image、reasoning 或未知 segment 偽裝成程式輸出。

## 角色分工與證據交接

- Reviewer 是審查者，只輸出附有原文證據的問題清單；不產生完整測試檔。先前提及 Reviewer 輸出 Python／修復的規則，改適用於 Writer 修訂與 Bug Fixer。
- 結構或審查問題交 Writer 修訂；只有唯一定位的一個實際 unittest 方法失敗交 Bug Fixer，多方法／fixture／import 失敗交 Writer。候選先通過結構、證據與隔離執行，再交 Reviewer；每次修改重新走相同 gate。測試通過但品質不足時交分析師與 Writer 補測，不啟動另一層 Self-repair。
- Bug Fixer 必須可唯一定位失敗方法；模組匯入、fixture 或歧義方法名稱交 Writer，不得回退猜選第一個 test 方法。Reviewer 問題必須有測試原文、具體原因與可操作的測試修訂，不接受空泛佔位動作。
- 分析師的品質分析包含存活變異體；只提出有測量依據的情境假設，不直接注入模型生成的 kill_test，也不能宣告等效或排除分母。
- 完整歷史存於 role_events.jsonl；當次 Prompt 僅提供必要來源、測試與證據。證據超過預算時不可截斷成不完整程式；審查失敗或格式無效必須記錄為未完成，不能假裝通過。
- 已知環境預檢失敗可依 interpreter、來源雜湊、模組與穩定匯入根快取；session output 目錄等暫時路徑不得使同一環境障礙重新啟動子程序。來源或匯入環境變更後必須產生新 cache key。
- 合併已驗證 Trace 與模型測試前，Trace 產物必須先通過相同的結構／安全 gate，再在獨立 Python unittest 程序通過；失敗時停止合併並保留診斷，不交模型反覆修訂，不能讓同一份候選測試掩蓋 Trace 基線問題。async／generator 使用明確標準庫 import，不使用動態 `__import__`。
- 每輪基線綁定同一版測試、案例識別、執行輸出、覆蓋與存活變異體；回滾時全部同步還原。原候選必須保留。
- 跨輪案例識別不可依 loop 檔名；純更名只能在測試 AST 與設定指紋一致時對應，不得猜測任意重寫的語意等價。
- 來源或已解析相依的版本變更後停止沿用舊證據。函式紀錄區分來源結構、已驗證執行與待驗證假設，禁止自動把舊執行資料當成新版本的事實。
- 連續三輪沒有改善已測量的缺口時停止相同策略重試並明示品質未達標；最後一輪結束後不再呼叫無後續用途的品質分析。結果目錄維持時分命名，同分鐘既有紀錄不可默默覆寫。
- 一般函式開始 AST 前建立執行與進度紀錄，每個事件即時落盤；保存第一個與最近失敗，區分完成、取消與仍在執行。批次結果以專案相對來源路徑與限定函式名區分，同分鐘重跑建立新 attempt，不能因失敗報告存在而略過。
- 批次在模型請求前保存已發現的目標清單，逐項保存進度；整批輸出根目錄不可與先前執行共用。`batch_manifest.json` 區分執行完成與全部通過，掃描失敗、缺報告或終態證據不完整不可當成完成；Dummy／Stub／Reviewer 未完成仍不可算通過。環境摘要只彙整結構化分類、缺模組與專案相對阻擋位置，不複製 provider 回覆或原始碼。

## 閱讀入口、探針與斷言證據

- 五個正式角色只能實作於 `src/roles/`；`src/prompts/` 放共用素材，不增加角色轉發檔。流程与 TypeScript／Python 對照維護在 `ARCHITECTURE.md` 與 `src/pipeline/pythonTools.ts`。
- 角色提示詞與 provider schema 不得要求模型重新選取已由程式決定的技能；技能分配需記錄為確定性階段。
- 探針資格必須匹配探針契約版本及不含憑證的端點識別；舊結果只可標記過期，不能未實測就升格為當前格式通過。版本僅在探針契約改變時更新，不因一般 UI 改動失效。
- 精確 Trace 斷言以 Python AST 與可安全解析的 literal 驗證；不可移除字串內容空白或把註解視為程式。Mock、fixture、未知實例及不確定的流程必須保留未知，交執行驗證處理，不能套用不同設定的真實 Trace。
- 正式 Python 工具不得以 `test_` 命名，以免被套件測試檔排除規則移除。

## 品質、Git 與紀錄

- 跨檔相依來源須由預檢實際載入的模組 origin 與函式定義身分解析，且實體位於所選來源樹；不得以批次根目錄拼接猜測。未知、re-export／重綁定、動態來源與範圍外相依只保留診斷，不另行匯入或假造來源。
- Reviewer 使用 `review-v6` 單一 `findings` 陣列，最多五項；以 `test_line` 引用本次完整 TEST_FILE 的行號，程式還原原文並依 category 決定嚴重程度。缺少情境、弱 assertion 與型別／風格不是執行阻擋；blocking 必須指出現有測試的具體錯誤。資格探針亦使用相同契約，舊資格不得直接升級。
- Reviewer 明確違反所選 static／instance 契約、要求修改目標實作或 mock 目標本身時，整份審查保持未完成，不得刪掉錯誤 finding 後偽裝為空問題通過，也不得交 Writer 執行矛盾動作。有限語句檢查不是任意自然語言正確性證明，所有工具 gate 仍須保留。
- 品質回滾及停滯判斷使用實測未覆蓋行／分支的個別身份與存活突變體；不能因缺口清單縮短而改變顯示文字，就將改善誤判退步。已知覆蓋變未知、新增未覆蓋行／分支、舊突變體重新存活及分數降低仍受保護。
- 品質分析師 `quality-task-v2` 每輪最多一項任務，引用程式選定的量測證據 ID；模型不可自行發明證據或預期值。格式補正最多一次，與初次請求共用絕對 deadline；取消／傳輸失敗不再啟動格式重試。空任務只代表無建議，不能將剩餘缺口算通過。
- Tier 3 scaffold 與其他 Writer 使用相同完整 unittest 檔案契約，scaffold 僅提供 setup 指引；不得再把完整模型回覆縮排塞入另一個 TestCase。修訂重複候選時必須保留最新診斷，不得以空白或過期輸出覆蓋。
- Cloud 可使用 `llmUnitTest.cloudThinkingMode` 的 `minimal`（預設）或 `provider-default`；低思考量不改變品質 gate。只依實際、明確的不支援選項回應回退，與格式回退及傳輸重試共用原 deadline；不依模型名稱決定。HTTP 5xx／認證／配額錯誤不得冒充選項不支援，有限傳輸重試耗盡後不得透過 Tier 降階另開請求。
- provider 明示截斷或非正常完成的輸出不可當成完整產物；錯誤 envelope／HTTP body 不寫入日誌或報告。只保存安全的角色、耗時、階段與分類。
- 選取目標與模組整體的覆蓋範圍分開保存。scorecard 只在 run/source/test 身分與限定目標一致、實測行集合完整時採目標行覆蓋；未覆蓋分支仍阻擋通過，fixture 門檻不降低。舊報告無目標證據時保留原模組分數。實際 Tier 綁定保留候選，不取降階前的標頭。

- 每個可交付改動都必須通過相應測試、型別檢查、靜態檢查與建置檢查。
- 每次完成並驗證後都必須建立一次本機 Git commit，接著 push 至目前分支已設定的 upstream，供實驗室 pull 測試；commit subject 必須同時包含英文與繁體中文。此推送流程已由使用者明確授權。
- 每個 commit 必須同步更新 `CHANGELOG.zh-TW.md`，以中文寫明改動、驗證方式與已知限制。
- 推送不得擅自使用 force 或變更 Git remote；不得使用／揭露使用者提供的密鑰，除非使用者明確授權。推送失敗時保留本機 commit 並回報原因，不得宣稱已同步。
