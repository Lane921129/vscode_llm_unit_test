# 專案測試 skills

這個目錄集中管理本擴充套件給測試生成模型的能力指引，與 Codex 自己的 `SKILL.md` 安裝機制分開。

| 檔案 | 用途 |
| --- | --- |
| `catalog.json` | 穩定 ID、版本、用途及對應文字檔 |
| `dependency_protocol.txt` | 呼叫結果、成員、cursor、context manager 與模組物件 |
| `database.txt` | 隔離資料庫、schema、狀態及副作用驗證 |
| `http_client.txt` | HTTP response、同步／非同步呼叫及網路替身 |

完整 26 項指引都已移入此目錄，每個 skill 一個 `.txt`；上表列出本次補強的三項，其餘包含數值、邊界、時間、async、context manager 等。`src/prompts/testRuleLibrary.ts` 保留選取邏輯，不再維護另一份文字。目錄登錄不代表所有目標都載入全部指引。修改文字後重新啟動擴充宿主，使該次執行採固定版本。此目錄須隨 VSIX 一起交付。

## txt 與 Python 如何分工

每個 `.txt` 非空行是一項指引。它應說明適用範圍、依賴安排、可觀察行為及未知狀態，不包含特定專案測試答案。修改行為時同步提升 `catalog.json` 的版本，並新增對應回歸。

Python 適合 AST 分析與受控執行工具；目前正式工具集中在 `python_scripts/`，由 `src/pipeline/pythonTools.ts` 登錄及既有受控程序呼叫。**放入一個 `.py` 不會自動執行或取得工具權限。** 若未來移動 Python 工具，須同時維護其輸入／輸出契約、隔離與封裝，不能直接掃描任意工作區資料夾並 import。

## 選取與交接

1. AST 抽取唯一目標，追蹤該目標實際讀取的穩定模組 import／alias／factory initializer。只保留來源與目標 hash，不執行模組、不讀資料庫／網路、不提供 runtime 型別或 expected。
2. Dispatcher 使用這些事實及既有來源特徵選取規則。資料庫物件作為呼叫參數時亦可觸發；未使用的 import、參數／區域遮蔽、重綁、動態 namespace、循環及過深鏈維持未知。一般 helper factory、跨檔 re-export 與任意 ORM 型別推導尚未支援。
3. Writer 先收到 `DEPENDENCY_FIXTURE_PLAN_V1` 的來源 lookup／呼叫參數導航，再依原輸出 scope 撰寫 Python。這是主機整理的安排任務，**不是新增一個模型角色或一次額外模型請求，也不會替模型產生 fixture／斷言**。完整來源及原始契約繼續保留；未知仍未知。
4. 生成候選照常通過範圍、名稱、有效斷言、隔離 native、同候選 Reviewer 及品質量測。Mock 成功只驗證受控單元行為。

來源呼叫站不是 runtime 次數，factory 名稱不是物件型別，schema／seed 不是測試答案。長篇指引及較多檔案本身不保證小模型改善。

## 小模型對照驗收

先驗 `init_db` 原目標，再驗未見過的下列型態：同步 HTTP response、`await client.get()`、`async with client.get()`、資料庫 cursor／row、交易 commit／rollback，以及無回傳值的副作用目標。每個情境至少做三次，固定來源、模型版本、實際 prompt envelope、容量、採樣參數、時間與請求額度。

比較組 A 使用父提交 `45ed8e7` 的擴充；組 B 使用本次提交，分開宿主並確認報告 build。這是整組 skill 改善的版本對照，不能把它解讀成單獨一張卡的因果效應。不要在產品裡停用驗證來建立比較組，也不要以固定回覆冒充真模型實驗。

批次完成後執行：`python test/skill_ab_summary.py --a <A批次目錄> --b <B批次目錄>`。多次實驗可重複提供 `--a`／`--b`。輸出只彙整 manifest 宣告的結果及可比欄位，不重新認證測資、Reviewer 或品質證據。

逐次記錄：規則 ID／版本、輸出是否為 Python、生成測試是否 native 通過、斷言是否驗到真正依賴、Reviewer、同候選 coverage／mutation、耗時與失敗階段。未執行、受阻、未量測與完整通過分列。可用 `test/skill_ab_summary.py` 彙整兩組原始批次，報表不補造缺失品質證據。
