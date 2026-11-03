# 既有 data 候選的 Reviewer 診斷（2026-11-03）

本輪沒有新增或執行本專案的回歸測試。資料均為先前針對 `test_data/data` 由模型生成並實際執行過的候選，包括保存的失敗候選。直接重審屬診斷，不會替原候選補發完整品質通過資格，也不代替同候選的 native、覆蓋率及突變量測。

每批保留確切 prompt、候選／來源雜湊、原 native 證據路徑、模型 digest、Reviewer bundle 雜湊、原始模型回覆與解析結果。表中的「無 findings」只是模型回覆，不能獨立證明審查正確。不同 prompt／bundle 的批次分開保存。

| 結果目錄（`test_data/result/` 下） | 條件及觀察 |
| --- | --- |
| `data_review_transport_20261102T170233Z` | esbuild 受沙箱祖先目錄讀取限制，未發送模型請求。工具錯誤保留；其後以已授權建置完成 bundle。 |
| `data_review_transport_20261102T170301Z` | codellama:13b；add、safe_divide 同候選各兩次，比較 Schema 與一般 JSON。一般 JSON 四次均有行號格式錯誤；Schema 仍誤稱 add 的直接相等斷言未檢查具體回傳。沒有證據支持直接切換一般 JSON。 |
| `data_review_transport_20261102T170546Z` | codellama:13b；加入逐斷言觀測說明並將 TEST_FILE 放在最後，四次重審。仍有缺失匯入誤報，或要求「所有可能輸入」的泛泛建議，尚未解決模型能力問題。 |
| `data_review_transport_20261102T170806Z` | codeqwen:7b；正常 add、safe_divide 各兩次，四次皆無 findings。 |
| `data_review_transport_20261102T171019Z` | codeqwen:7b；重審已失敗的 safe_divide、calculate_discount，各兩次，四次也皆無 findings。因此上一批的空陣列不能證明角色可用。 |
| `data_review_transport_20261102T171129Z` | 同兩個失敗候選改用一般 JSON，各兩次；依然皆無 findings。 |
| `data_review_transport_20261102T171219Z` | 移除提示開頭的完整空結果範例，再用 codeqwen 審同兩個失敗候選，各兩次；依然皆無 findings。 |
| `data_review_transport_20261102T171308Z` | gemma4:12b、`think=false`；四次均提出具體問題，包括字串參數造成 TypeError，以及正常回傳案例被錯誤包成 assertRaises。不表示模型已找出所有問題或具備全面能力。 |
| `data_review_transport_20261102T171433Z` | 同一 Gemma digest、`think=false`；正常 add、safe_divide 各兩次，四次皆無 findings，未再出現缺失匯入誤報。 |
| `data_review_transport_20261102T171549Z` | 同一 Gemma digest、供應商預設思考模式；四次皆耗盡 2,048 個輸出 tokens，只有 thinking、最終 response 為空，`done_reason=length`。這是輸出預算問題，不是 timeout。 |

## 本機思考模式

新增 VS Code 設定，預設保持 `provider-default`：

```json
{
  "llmUnitTest.localThinkingMode": "disabled"
}
```

`disabled` 傳送 Ollama `think=false`，模型／伺服器須支援此選項。該值在啟動 run 時固定，傳入所有角色、輸出恢復及容量重認證請求，並記入角色事件與知識紀錄。角色資格、批次快取與容量偏好同時區分思考模式；歷史未記模式的資格只對應 `provider-default`。更改後須重新測試連線；本輪依使用者限制，沒有執行用於專案自身的角色探針案例。

此選項不變更 Context、輸出 cap、時間預算、停止政策或品質門檻。不能把只有 thinking 的截斷回覆當成有效程式碼／審查 JSON，也不能以額外等待時間推定它會補出最終答案。

## 完整資料流程

`data_gemma_live_20261102T172353Z` 使用正式 production bundle、gemma4:12b 固定 digest、`localThinkingMode=disabled`，對原有 add、BMI、store 兩個函式及 complex_test token 各跑兩次。事先資格要求維持前批的關閉設定，以避免執行額外合成探針；原有同候選 Reviewer、native、覆蓋率與突變門檻仍在。當次設定、來源及 build hash 以 manifest 為準。十份測試匯出後全部 native 通過；五份完整達標（add、BMI 各兩份，token 一份），其餘保留未達標結果。結束時來源／bundle／模型均相符。

第一輪 add 已完整通過（行覆蓋 1/1、突變 6/6、失敗數 0）；BMI 經三輪改善後完整通過（行覆蓋 10/10、突變 39/39、累計失敗數 4）。其他結果仍須核對，不能由兩個成功宣稱整批或全部 data 通過。

safe_divide 的失敗另揭露恢復資訊缺口：候選 native 通過，Reviewer 提出具體除零補測，但 `basis.kind=requirement` 引用的是 `probe-...` 觀測案例 ID，不是提供的 R 需求 ID，連續修正仍收到 `requirement-evidence-missing`。這個 finding 不能被偷偷改寫或直接採納。目前 `correctionPrompt()` 沒有帶回 `projectRejectedReviewFindings()` 的原 finding，只提供診斷代碼，且欄位提示只覆蓋 host-fact／evidence-gap；stateless 重送無從對照實際被拒絕欄位。後續應提供有界、去密、明確標為未接受的前次 finding 與實際可用需求 ID，讓模型重新評估並自行回覆正確契約；原基線、修改範圍及解析門檻維持不變。為保留當批版本識別，尚未在該批執行中修改 production source。

該批結束後已實作上述修正。`data_review_repair_live_20261102T175532Z` 對 store 兩個目標各跑兩次，4/4 完整通過並匯出後重新執行成功。safe_divide 的突變結果為 11/13、12/13；calculate_discount 均為 22/26；行覆蓋皆完整，仍依原政策判定。safe_divide 實際紀錄顯示一次 `requirement-evidence-missing` 後，模型自行回覆以 L7、test-code、judgment=unverified 為依據的具體除零補測，隨後完成改善。兩次 safe_divide 均在失敗數 4 時成功，沒有隱藏兩次限制。來源／bundle／模型核對均相符。

以正式 `BatchJournal` 重新讀取 checkpoint、raw tool 證據與政策計算後，上述 core 批次仍為 5/10 完整通過、store 修正批次為 4/4。核對不發送模型請求、不執行測試。核對腳本初次的目錄層級錯誤另存為 `audit_wrong_root_*`，並未覆寫原執行紀錄。

`data_web_gemma_live_20261102T180729Z` 保持同一修正版本，Web_Spider 的兩個目標各兩次。四份匯出測試均 native 通過；_listing_to_dict 第一次完整通過（行覆蓋 1/1、突變 9/10），第二次為品質停滯（1/1、0/10）。地址解析兩次分別為 19/28、27/28 行覆蓋及 13/28、20/28 突變，未完整通過，保留實際測試與五次失敗停止原因。沒有再出現 config 缺失使突變未執行的問題。正式報告驗證器重算為 1/4 完整通過；核對腳本曾使用不同的 Windows 根目錄拼寫，原核對結果保留為 `audit_root_case_*`，改用原 manifest 的根目錄後核對一致，未改寫原執行證據。

地址解析後續只使用同一個現有 data 目標，沒有新增或執行專案回歸案例。`data_regex_address_live_20261102T221710Z` 的正則／split 提案已觸發缺少的城市分支，但兩次仍只有 24/28 行及 17/28 突變。平衡長模式、同源分支輸入與每次最多兩筆已驗證觀測後，`data_balanced_address_live_20261102T223543Z` 為 1/2 完整通過；第二次 seed native 通過後，Reviewer 要求新增情境，模型卻改寫既有 test_seed，正確停止 repair-scope。這個失敗仍保留，不以多給重試放寬範圍。

查明該 Reviewer 新增路徑未綁定一般新增流程的唯一方法名稱，已讓它以當時執行候選作基線，沿用共同新增提示與命名；方法替換則另外明確傳入 text 與局部替換標記。`data_review_scope_address_live_20261102T224912Z` 同模型／fixture／政策各兩次為 2/2 完整通過：各四方法、七筆輸入，行覆蓋 28/28、分支完整、突變 23/28，failureCount=3。第二次實際走到 Reviewer 補案例，原 seed 雜湊與前批失敗相同，writer-review-addition 成功合併一個新方法，原 seed 保留，再經執行與 Reviewer 批准。正式 BatchJournal 與匯出重跑均確認通過，來源／bundle／模型及相依結束核對均相符。三批版本分開，細節與摘要見 GENERATION_STATUS.md 及各批原始報告。
