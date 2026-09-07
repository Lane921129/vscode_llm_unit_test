# Python 公開驗收 Fixture Corpus

這些檔案是單元測試生成系統的公開、無業務資料驗收輸入，不是本 extension 的功能程式碼。

- 每個 manifest 項目都標示建議 Tier、最低 coverage／mutation 門檻與不可接受的假測試。
- `expected_skills` 只列出由可觀察 Python 結構與 AST import/call 綁定可證實的技能卡。
- 這份 corpus 不含 API Key、網路端點、資料庫檔案或真實使用者資料。HTTP、檔案、時間與資料庫項目只能透過 mock 或隔離資源驗收。
- 這是模型／Tier 評分的共同輸入；模型是否合格仍以產出的 unittest、coverage 與 mutation 結果為準。
