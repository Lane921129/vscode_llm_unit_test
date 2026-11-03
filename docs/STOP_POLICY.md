# 停止政策與重現驗收

`maxLoops` 只控制有效品質改善輪數。側欄新增的停止設定對應 VS Code 的 `llmUnitTest.stopPolicy`：

```json
{
  "llmUnitTest.stopPolicy": {
    "failureLimit": 5,
    "qualityNoImprovementLimit": 3,
    "batchFailureLimit": 10
  },
  "llmUnitTest.targetBudget": {
    "timeoutMs": 600000,
    "logicalRequests": 40,
    "transportAttempts": 80,
    "estimatedInputTokens": 400000,
    "candidateAttempts": 40
  }
}
```

- `failureLimit`：同一目標累計第 N 次可恢復失敗後停止，第一次失敗是 1；至少為 1。Writer、局部修訂、候選結構／執行驗證、Reviewer／分析師格式修復及未達標的有效品質量測共用額度。第 N 個候選若成功，且先前只有 N−1 次失敗，仍可通過。
- `qualityNoImprovementLimit`：連續 N 輪有效量測沒有減少覆蓋率／存活突變缺口時停止；0 關閉。第一輪建立基準，不算無改善。無效量測不進入此計數。
- `batchFailureLimit`：第 N 個目標最終失敗後停止派送；0 不中止整批。環境與工具受阻另外分類。其餘目標標為 `policy-not-run`，整批為 `policy-stopped`，不冒充使用者取消。
- `targetBudget`：時間、邏輯請求、HTTP 傳輸、估計輸入 tokens、候選執行的獨立預算；先耗盡即停止，重試不重設預算。未指定的計數由原有 `maxLoops` 規劃補齊，側欄顯示實際規劃數字。HTTP 重試不扣模型失敗額度。

每次候選／回覆嘗試有獨立識別；同一失敗跨層捕捉只扣一次。重複候選不再次執行，改交修復要求並依剩餘額度決定是否繼續。局部修訂的 Python 語法錯誤沿用原基線、原計畫雜湊與原方法範圍；修改越界、來源漂移、驗證工具失效仍停止。增加額度不改 Reviewer、native、覆蓋率或突變品質閘門。

局部回覆為空、只交出部分已規劃方法（`edit-method-missing`）、重複提交同一已規劃方法或未產生變更，也歸為可恢復的回覆格式失敗。Name binding 與 Reviewer 的局部修訂共用同一分類；這不允許提交新方法、改簽名／fixture 或擴大修改範圍。

「空回覆」限於實際空白或單一空程式區塊；擷取器因內容不符合範圍而沒有產生片段，不會被當成空回覆重送。重送帶上對應的缺漏／重複／未修改指引，原基線與方法清單不變。

本機模型完整回覆若沒有任何測試方法或 unittest 斷言，seed 的後續重送改用程式碼續寫；沿用既有目標失敗額度、請求／時間預算與來源證據。續寫只提供外層包裝，方法內容仍由模型生成。新增案例續寫另外綁定當前基線與方法名稱，避免重送既有案例。

逐案例補測在模型回覆格式錯誤時，沿用同一案例、累積基線、方法範圍與原有預算重送；之前已組合的方法不會重做。每次請求前清除上次回覆的暫存識別，避免把本次傳輸／格式失敗歸到上一個成功案例。組合工具或基線 AST 語境失效另外記為工具受阻。

Reviewer 的契約修正只附上當次診斷對應的指引；被拒絕的 host-fact／evidence-gap 參照最多列出五項實際可用欄位與行號關聯，與驗證器共用事實索引。這些提示不會補造 finding、變更預期值或授予通過。原始候選與完整證據仍保留；宿主證據身分／形狀失效在請求前記為工具受阻，不扣模型失敗次數。修正事件保存實際下一次 attempt，不再固定寫成 1。

突變基線以 `mutation-baseline-failure-v1` 保存 `category` 與 `reasonCode`，區分環境設定／模組載入、工具回報、基線測試、逾時及預算耗盡。若同一候選 native 已通過而突變基線測試失敗，記為 `mutation-baseline-native-mismatch` 環境受阻；保留兩份證據，不扣模型失敗額度。無效工具回報另記工具受阻。只有舊格式缺少此欄位時，才沿用有限的錯誤文字相容辨識。

`function_knowledge.json` 與報告保存 `failureCount`、`failureLimit`、`stopReason`、`effectiveSettings` 和獨立 `targetBudget` 用量。`run_manifest.json` 固定當次停止設定。批次清單保留全部目標，彙總通過／受阻／未完成比例及請求、HTTP、量測輸出 tokens；未取得用量者另列未知數，這些數字不是貨幣費用。

## 缺陷回歸

- `test_target_alias_bindings.py`：地址解析別名、別名鏈、重綁／刪除／條件分支、斷言／seed／簽名共用目標身分。
- `test_mutation_import_layout.py`：平面模組與套件的同根相依閉包、移除原始相依後副本仍可執行、fixture 綁定與既有資料隔離。
- `stopPolicy.test.ts`：N＝1／3／5、最後一次成功、跨角色計數、環境／工具不扣次、時間預算優先、重複候選與可停用停滯限制。
- `nameBindingRepairIntegration.test.ts`：完整／僅執行模式的局部修訂格式恢復，以及基線和修改範圍不擴大。
- `batchJournal.test.ts`、`modelCapabilitySummary.test.ts`：批次停止及未派送狀態、小數毫秒、只用有效 token／時間成對資料計算速率。

## 後續實驗規格

每格至少保留兩次獨立執行，不能覆蓋失敗結果。固定並記錄 Git/build hash、精確模型版本與推論設定、Python 與 lockfile／相依版本、fixture 內容雜湊、停止政策、所有預算、目標清單／範圍雜湊、品質政策與突變引擎版本。這份實作驗收不等於真實模型泛化實驗。

`Web_Spider`、車輛管理本體、備份與測試程式分別確認範圍並建立各自批次；不要以共同父資料夾名稱認定同一專案。統一以確認後的目標總數為分母，分別報告通過率、環境／工具受阻率、未完成率與請求／tokens／耗時。未派送目標必須留在清單。native 與突變基線未能載入相同相依或 fixture 時，先回報環境受阻，不推斷模型測試品質。
