# 歷史 bug 候選清單（待使用者挑選）

2026-11-12 以 Windows 原生 Git／Python 掃描。共選 15 項：Bottle 12、validators 3。每筆皆符合「整筆只改一檔、僅一個既有函式本體有語意變化」的保守 AST 篩選。

**以下是靜態審閱與 witness 建議，未執行 witness、未驗證與目前評估集的版本相容，也未加入 seeded_bugs。** 修復／優化判斷是依訊息及程式差異的推論，仍由使用者挑選。完整前後函式、commit 訊息、parent、docstring 狀態與行數證據在 [candidates.json](candidates.json)。

| 上游 | 固定來源 HEAD | 訊息篩選後 | 結構符合 | 本清單 |
| --- | --- | ---: | ---: | ---: |
| [bottle](https://github.com/bottlepy/bottle) | `aba0c1a7ee59ed851db001d100b6a792b54a94a3` | 369 | 52 | 12 |
| [validators](https://github.com/python-validators/validators) | `22786cc6e7283a0fa452c179797e447f798db9f0` | 85 | 6 | 3 |

未列出的結構符合項目不代表都是錯誤修復。本清單優先選擇能提出具體輸入與觀察值的項目；例如 Bottle `8dbae77560a1` 的 view 參數改寫，因同版 template 已接受 positional dict，未找到一般入口的確定差異，未收錄；`971bc5028340` 的 not/is 語法改寫也不收。validators `7f39c42f8d58` 回傳 match 而非 True，公開裝飾器可能仍同為 True，未選；`1231f6a69eef` 擴大 fragment 字元集合，需另行核對規格與新增支援的界線，本輪不收；`8295d99c0e72` 為同一參數 helper 的另一相容修復，本輪以 H15 代表該 helper。純記憶體優化 `9f5871b0251e` 與 PEP8 改寫 `433fab335e6d` 已由訊息篩選排除。

## H01 bottle：bytearray 的文字解碼

- Commit：[8804dd957f544255e71a5a4bade7bd7483ba8073](https://github.com/bottlepy/bottle/commit/8804dd957f544255e71a5a4bade7bd7483ba8073)；日期 `2024-10-12T14:16:41+02:00`。
- 檔案／函式：`bottle.py`／`touni`；文字 diff +3/−3，總計 6 行；docstring 前／後：無／無。
- 上游訊息：fix: touni() should recognize bytearray
- 判斷依據：修復。原本只認 bytes，bytearray 落入一般 str 轉換，回傳容器表示式；修復納入 bytes／bytearray 解碼，改的是既有轉文字行為。
- Witness 建議（未執行）：touni(bytearray(b'abc'))；預期 parent 為 bytearray 的表示字串，修復版為 'abc'。
- 適用條件：Python 3；無函式 docstring，挑選前需另行確認文字轉換規格。

## H02 bottle：autojson=False 寫錯設定鍵

- Commit：[6917b86ea59cdcd1e84841d0d14aba92901ad389](https://github.com/bottlepy/bottle/commit/6917b86ea59cdcd1e84841d0d14aba92901ad389)；日期 `2024-10-22T12:06:15+02:00`。
- 檔案／函式：`bottle.py`／`Bottle.__init__`；文字 diff +1/−1，總計 2 行；docstring 前／後：無／無。
- 上游訊息：fix: Fix deprecated Bottle(autojson=False) behavior
- 判斷依據：修復。既有 autojson=False 參數寫入 json.disable，但實際開關是 json.enable；修復改為 json.enable=False，非新增參數。
- Witness 建議（未執行）：app = Bottle(autojson=False)，觀察 app.config['json.enable']；預期 parent 仍沿用開啟值，修復版為 False。
- 適用條件：需載入該歷史版的 Bottle／ConfigDict；DeprecationWarning 不應當作行為失敗。無函式 docstring。

## H03 bottle：空檔名仍是 multipart 檔案欄位

- Commit：[d1413a81ead7a6f130a06e21a17ca98f4ea30df6](https://github.com/bottlepy/bottle/commit/d1413a81ead7a6f130a06e21a17ca98f4ea30df6)；日期 `2021-07-07T13:02:33+02:00`。
- 檔案／函式：`bottle.py`／`BaseRequest.POST`；文字 diff +3/−3，總計 6 行；docstring 前／後：有／有。
- 上游訊息：Fix: Multipart file uploads with empty filename not detected as binary.
- 判斷依據：修復。原本用 filename 的真假區分表單與檔案，把 filename="" 當一般欄位；修復以 is None 區分，保留空檔名的檔案語意。
- Witness 建議（未執行）：建立 multipart/form-data POST，Content-Disposition: form-data; name="upload"; filename=""，內容為 abc；比較 request.POST["upload"] 的型別：parent 為一般值，修復版為 FileUpload。
- 適用條件：需要完整 multipart boundary、CONTENT_LENGTH 與 BytesIO wsgi.input；該版本依賴 cgi（Python 3.13 已移除），先選相容歷史環境。

## H04 bottle：檔案區間迭代完成後關檔

- Commit：[245386e4cb45320047f2e3f9f1912d3f7e1eef42](https://github.com/bottlepy/bottle/commit/245386e4cb45320047f2e3f9f1912d3f7e1eef42)；日期 `2018-02-05T20:33:25+09:00`。
- 檔案／函式：`bottle.py`／`_file_iter_range`；文字 diff +3/−1，總計 4 行；docstring 前／後：有／有。
- 上游訊息：Fixed ResourceWarning: unclosed file <_io.BufferedReader... in static_file() #1000
- 判斷依據：修復資源生命週期。原本走完迭代仍留下開啟檔案，修復在正常耗盡後 close；可觀察 closed 狀態，非只縮短執行時間。
- Witness 建議（未執行）：fp=BytesIO(b'abc')；list(_file_iter_range(fp, 0, 1)) 後讀 fp.closed；預期 parent=False，修復版=True。
- 適用條件：必須完整耗盡 generator；提前停止迭代不是這筆修復保證的情境。

## H05 bottle：tob(None) 的 Python 3 例外

- Commit：[06cc47b1f5403767ccc792b4ac739c4948982de4](https://github.com/bottlepy/bottle/commit/06cc47b1f5403767ccc792b4ac739c4948982de4)；日期 `2017-12-09T20:20:16+08:00`。
- 檔案／函式：`bottle.py`／`tob`；文字 diff +1/−1，總計 2 行；docstring 前／後：無／無。
- 上游訊息：fix pass None to tob (#1018)
- 判斷依據：修復。既有 None 輸入走 bytes("") 在 Python 3 會拋 TypeError；修復直接回傳空 bytes，沒有擴充輸出類型。
- Witness 建議（未執行）：tob(None)；預期 Python 3 parent 拋 TypeError，修復版回傳 b''。
- 適用條件：Python 3；無函式 docstring，需使用上游文字／bytes 轉換契約。

## H06 bottle：自動 ETag 的字串雜湊

- Commit：[d7a3ca9bec7f937670929702416edb6cf91adc9b](https://github.com/bottlepy/bottle/commit/d7a3ca9bec7f937670929702416edb6cf91adc9b)；日期 `2016-07-05T13:35:48+02:00`。
- 檔案／函式：`bottle.py`／`static_file`；文字 diff +1/−1，總計 2 行；docstring 前／後：有／有。
- 上游訊息：Fix: Hashlib wants bytes, not unicode.
- 判斷依據：修復。既有 etag=None 自動產生路徑把 str 傳入 hashlib.sha1；修復先 tob 轉成 bytes，修正 Python 3 的型別錯誤。
- Witness 建議（未執行）：暫存 root 下建立 a.txt，綁定 GET request 環境，再呼叫 static_file('a.txt', root, etag=None)；預期 parent 在 sha1 拋 TypeError，修復版產生含 ETag 的 HTTPResponse。
- 適用條件：Python 3、可讀暫存檔與歷史 Bottle request 環境；回應 body 完成後關檔。

## H07 bottle：無預設參數的 getargspec 回傳值

- Commit：[2647a364742f06db01d71481cefbd10c339f084a](https://github.com/bottlepy/bottle/commit/2647a364742f06db01d71481cefbd10c339f084a)；日期 `2015-10-11T18:52:13+01:00`。
- 檔案／函式：`bottle.py`／`getargspec`；文字 diff +1/−1，總計 2 行；docstring 前／後：無／無。
- 上游訊息：Fix minor error in getargspec
- 判斷依據：修復相容契約。沒有 defaults 時原本回傳 []，修復回傳 None，對齊既有 getargspec 無預設值的表示；不是效能優化。
- Witness 建議（未執行）：定義 def f(x): pass；getargspec(f)[3]：預期 parent 為 []，修復版為 None。
- 適用條件：需走 inspect.signature 相容實作（Python 3.3+）；無函式 docstring。

## H08 bottle：不合法 JSON 回應為 HTTP 400

- Commit：[606cb957fd1279bd973e8010ca4f5365a8278509](https://github.com/bottlepy/bottle/commit/606cb957fd1279bd973e8010ca4f5365a8278509)；日期 `2015-07-31T13:26:48+10:00`。
- 檔案／函式：`bottle.py`／`BaseRequest.json`；文字 diff +6/−1，總計 7 行；docstring 前／後：有／有。
- 上游訊息：Return 400 with bad json request
- 判斷依據：修復既有請求錯誤分類。原本 JSON 解碼的 ValueError／TypeError 外洩，修復轉成 HTTPError(400)，沒有增加新的 content type。
- Witness 建議（未執行）：以 CONTENT_TYPE='application/json'、body=b'{' 建立 request，存取 request.json；預期 parent 為 JSON 解碼 ValueError，修復版為 status_code=400 的 HTTPError。
- 適用條件：需正確 CONTENT_LENGTH 與 BytesIO wsgi.input；固定同一 JSON decoder。

## H09 bottle：缺少 wsgi.input 的空 body

- Commit：[599abe503337b1929c07db6d4773a9c6a580d426](https://github.com/bottlepy/bottle/commit/599abe503337b1929c07db6d4773a9c6a580d426)；日期 `2015-03-09T19:11:52Z`。
- 檔案／函式：`bottle.py`／`BaseRequest._body`；文字 diff +1/−1，總計 2 行；docstring 前／後：無／無。
- 上游訊息：Fixes #727 use default BytesIO() if wsgi.input not present
- 判斷依據：修復。既有無請求內容情境直接索引 environ["wsgi.input"] 會 KeyError；修復以空 BytesIO 作缺省值，保留空 body 行為。
- Witness 建議（未執行）：BaseRequest 的 environ 設 REQUEST_METHOD='GET'、CONTENT_LENGTH='0' 且不放 wsgi.input；存取 request._body；預期 parent 為 KeyError，修復版可 read() 得 b''。
- 適用條件：需該歷史版 BaseRequest 的非 chunked 路徑；無函式 docstring，需審閱 WSGI 缺省容忍行為是否適合評估。

## H10 bottle：複製回應時遺失 Cookie

- Commit：[8f427001c0fd5a5fa4124dbc0d227292ad5983e7](https://github.com/bottlepy/bottle/commit/8f427001c0fd5a5fa4124dbc0d227292ad5983e7)；日期 `2014-12-28T17:46:24+01:00`。
- 檔案／函式：`bottle.py`／`BaseResponse.copy`；文字 diff +1/−1，總計 2 行；docstring 前／後：有／有。
- 上游訊息：Fixed bug where BaseResponse.copy() would not copy Cookies due to a behaviour change in newest Python 3.x releases.
- 判斷依據：修復。原本把帶 Set-Cookie: 前綴的字串重新交給 SimpleCookie.load，會受 Python 3 行為影響遺失 cookie；修復用 header="" 輸出可再載入的內容。
- Witness 建議（未執行）：r=BaseResponse(); r.set_cookie('sid','abc'); copied=r.copy()；比較 copied._cookies['sid'].value；預期受影響的 Python 3 parent 遺失 sid，修復版為 'abc'。
- 適用條件：需確認所選 Python 的 SimpleCookie 行為；這是相容性候選，不能先假設所有版本都能重現。

## H11 bottle：405 Allow 回傳錯誤方法

- Commit：[f27a9a3be9b3c031eac44b4a99f44d58557175f3](https://github.com/bottlepy/bottle/commit/f27a9a3be9b3c031eac44b4a99f44d58557175f3)；日期 `2014-10-31T17:27:24+01:00`。
- 檔案／函式：`bottle.py`／`Router.match`；文字 diff +1/−1，總計 2 行；docstring 前／後：有／有。
- 上游訊息：Fix the Allow: header value in 405 "Method not allowed." response.
- 判斷依據：修復。找到其他可用 method 後卻把本次不允許的 verb 放入 Allow；修復加入真正匹配的 method，修正既有 HTTP 405 的標頭。
- Witness 建議（未執行）：Router 只登記 GET /hello；match({'REQUEST_METHOD':'POST','PATH_INFO':'/hello'})，捕捉 HTTPError；預期 parent Allow='POST'，修復版 Allow='GET'。
- 適用條件：使用靜態路由；不混入動態路由與 HEAD／ANY 的差異。

## H12 bottle：path wildcard 不應匹配空字串

- Commit：[18afaae86bc4c32726bb03fc80011ead1c840830](https://github.com/bottlepy/bottle/commit/18afaae86bc4c32726bb03fc80011ead1c840830)；日期 `2012-02-29T21:24:18+01:00`。
- 檔案／函式：`bottle.py`／`Router.path_filter`；文字 diff +1/−1，總計 2 行；docstring 前／後：無／無。
- 上游訊息：fix: The 'path' wildcard filter should not match empty strings.
- 判斷依據：修復既有 wildcard 邊界。回傳 regex 由 .*? 改成 .+?，要求至少一字元；未增加 wildcard 類型或參數。
- Witness 建議（未執行）：pattern,_,_=Router().path_filter(None)；re.fullmatch(pattern, '')：預期 parent 匹配、修復版不匹配；'a' 兩版皆匹配。
- 適用條件：檢查回傳正規表示式即可；無函式 docstring，挑選前需核對歷史 wildcard 規格。

## H13 validators：MAC 位址混用分隔符

- Commit：[402b3517eb09be188df13e5c57ea4d1400b7cc20](https://github.com/python-validators/validators/commit/402b3517eb09be188df13e5c57ea4d1400b7cc20)；日期 `2025-07-18T22:55:38+08:00`。
- 檔案／函式：`src/validators/mac_address.py`／`mac_address`；文字 diff +4/−0，總計 4 行；docstring 前／後：有／有。
- 上游訊息：fix: reject MAC addresses with mixed separators
- 判斷依據：修復。原 regex 各段獨立允許 : 或 -，誤收混用位址；修復先排除兩種符號並存的輸入，沒有新增允許的格式。
- Witness 建議（未執行）：mac_address('01:23-45:67:89:ab')；預期 parent=True，修復版為 ValidationError（未裝飾內層為 False）。
- 適用條件：使用該 revision 的 validator 裝飾器與依賴；正式對比應使用公開函式。

## H14 validators：mailto 前綴移除過度

- Commit：[d6241fc31f6b46bf81283c6ab3cae07c370fc1f6](https://github.com/python-validators/validators/commit/d6241fc31f6b46bf81283c6ab3cae07c370fc1f6)；日期 `2025-03-29T06:16:55+01:00`。
- 檔案／函式：`src/validators/uri.py`／`uri`；文字 diff +1/−1，總計 2 行；docstring 前／後：有／有。
- 上游訊息：fix(uri): remove "mailto:" prefix manually (#418)
- 判斷依據：修復。lstrip("mailto:") 會剝掉一組字元而非固定前綴，連合法信箱開頭的 t/o/m 等字元也被刪；切片只去掉 mailto:。
- Witness 建議（未執行）：uri('mailto:tom@example.com')；預期 parent 傳 '@example.com' 給 email 而失敗，修復版傳 'tom@example.com' 而通過。
- 適用條件：使用該歷史版的 email 驗證器；正常信箱規則需保持相同。

## H15 validators：Python 3 kwargs 無 iteritems

- Commit：[ff6e237d31c3b2910a5841900eef02de2f6ccbc2](https://github.com/python-validators/validators/commit/ff6e237d31c3b2910a5841900eef02de2f6ccbc2)；日期 `2013-10-21T13:21:50+03:00`。
- 檔案／函式：`validators/utils.py`／`func_args_as_dict`；文字 diff +1/−1，總計 2 行；docstring 前／後：無／無。
- 上游訊息：Fixed compatibility issue with py3
- 判斷依據：修復既有 Python 3 相容性。dict.iteritems 不存在，改 items 才能組成參數字典；與新增參數功能或效能無關。
- Witness 建議（未執行）：def f(x): pass；func_args_as_dict(f, (1,), {})：預期 Python 3 parent 拋 AttributeError（iteritems），修復版為 OrderedDict([('x',1)])。
- 適用條件：使用仍提供 inspect.getargspec 的 Python 3（如 3.10）與歷史 six 依賴；新 Python 的其他相容錯誤不能當成本候選的證據。

挑選後的反向 patch＋meta.json 流程見 [README](README.md#使用者挑選後才做的轉換)。本輪不改評估程式，也不把推論當成已執行結果。
