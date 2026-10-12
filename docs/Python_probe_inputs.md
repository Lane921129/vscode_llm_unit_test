# 手動 Trace 輸入：來源綁定、只提供輸入

當自動輸入規劃找不到合適的測資，可以提供指定函式的呼叫參數。這份 JSON 只描述輸入；不接受 `expected`、assertion、測試程式或初始化 Python 程式碼。

工具在原有受控 Trace 流程執行目標，才會產生實際回傳值或例外觀測。Writer 仍須撰寫 unit test，候選仍須經過結構、真實執行、Reviewer 及同候選突變門檻。手動輸入不會直接批准測試或提供獨立業務需求的答案。

## 用 literal builder 建立 JSON

`python_scripts/probe_fixture_builder.py` 不匯入應用、不呼叫目標、不讀原始資料庫。它只讀指定 `.py` / `.pyw` 的 UTF-8 來源以計算 SHA-256，並將安全的 Python literal 轉成既有型別化輸入格式。

例如專案 `D:\projects\demo` 中有 `sample.py` 與函式 `advance(value)`，從擴充套件專案根目錄執行：

```powershell
@'
{"cases":[
  {"args_literals":"[3]"},
  {"args_literals":"[0]"},
  {"args_literals":"[-1]"}
]}
'@ | .venv/Scripts/python.exe -B python_scripts/probe_fixture_builder.py `
  --root 'D:\projects\demo' --file 'sample.py' --target 'advance' |
  Set-Content -LiteralPath 'D:\projects\demo\trace_inputs.json' -Encoding utf8
```

先確認工具退出碼為 `0`，JSON 頂層為 `schemaVersion: probe-input-fixtures-v1`。失敗時退出碼為 `2`，只輸出固定原因碼，不輸出原始 literal 或例外內容；不要把錯誤 JSON 當成輸入 fixture。

將 `llmUnitTest.probeInputFile` 設為專案內的 `trace_inputs.json`。設定可使用專案相對路徑或專案內的絕對路徑。未設定或該檔沒有當前目標時沿用自動輸入規劃；當前目標已列入、但來源過期或輸入不合法時會拒絕該 fixture，避免默默改用其他輸入。

## 型別與建構參數

每個案例有四組 literal text，省略值依序為 `[]`、`{}`、`[]`、`{}`：

| 欄位 | 用途 |
| --- | --- |
| `args_literals` | 目標函式或方法的 positional arguments，必須是 list / tuple |
| `kwargs_literals` | 目標的 keyword arguments，必須是字串 key 的 dict |
| `constructor_args_literals` | 實例建構子的 positional arguments |
| `constructor_kwargs_literals` | 實例建構子的 keyword arguments |

建構參數和方法參數分開。例如中性 `Counter.advance(delta)`：

```json
{"cases":[{
  "args_literals":"[2]",
  "kwargs_literals":"{}",
  "constructor_args_literals":"[]",
  "constructor_kwargs_literals":"{'initial': 4}"
}]}
```

使用 `--target Counter.advance`，並指定定義該 class 的來源檔。建構子會在真正的受控 Trace 執行階段才被呼叫。

下例包含一個 tuple 參數、bytes、大整數、float 與負零：

```json
{"cases":[{
  "args_literals":"[(9007199254740993, b'\\x00A', 1.0, -0.0)]",
  "kwargs_literals":"{'second': 2, 'first': 1}"
}]}
```

`1` 保留為 Python `int`，`1.0` 保留為 `float`；大整數不經過 JavaScript number，tuple / bytes 與 keyword 順序也保留。最外層 positional sequence 只是呼叫參數的載體，builder 將其整理成 list；裡面真正傳給函式的參數型別維持原樣。輸入 literal 形式的 `None`、bool、int、有限 float、str、bytes、list、tuple、dict、set 均可支援；自訂物件、datetime、numpy array、Mock 等不會自動建立。

builder 拒絕 Call、Attribute、BinOp、comprehension、lambda、f-string、字典展開及過深或過大的資料。`dict(...)`、`set()`、`datetime(...)` 與 `2 ** 10` 都不會執行；請直接寫 literal，例如 `{}`、`{1, 2}`、`1024`。Python 值的深度、節點、集合、文字和整數上限仍受既有 `trace-value-v1` codec 約束。循環或共享參照、非有限 float，以及無法保真還原的資料會明確拒絕。

## 綁定、限額與失敗診斷

每份 JSON 可有多個 `targets`，每項精確綁定專案相對 `file`、qualified `target` 和完整來源 `sourceHash`。builder 每次產生一個 target；需要多個 target 時，合併它們的 `targets` 陣列，保留各自的 metadata 和完整 `inputs`。不要把不同專案的同名函式當成同一項。

手動 JSON 的 target 格式如下，`cases` 由 builder 填入完整型別化資料：

```json
{
  "schemaVersion": "probe-input-fixtures-v1",
  "targets": [{
    "file": "sample.py",
    "target": "advance",
    "sourceHash": "<目前來源的64字元SHA-256>",
    "inputs": {"schema_version": "probe-inputs-v1", "cases": []}
  }]
}
```

上面的空 `cases` 是形狀說明，不能直接執行。loader 要求每個 case 只有 `input`，並由宿主標記為 `unknown` / `user-fixture`；使用者不能自行聲稱呼叫站證據或審查批准。

- JSON 檔最多 64 KiB；當前 target 必須有 1～32 個案例。
- source 只允許專案內的普通 `.py` / `.pyw`，最多 16 MiB；fixture 只允許專案內普通 `.json`。
- 拒絕符號連結、junction、UNC、裝置路徑、路徑逃逸及重複的同一 target。
- 精確保留 UTF-8 來源位元組，包括 BOM 與 CRLF。來源修改後重新執行 builder，不能把舊 hash 改成新 hash 來假裝舊觀測仍然有效。
- 拒絕高可信憑證及已知秘密；請只提供中性測試值，不放 API key、token、帳號密碼或原始資料。

常見原因碼：`fixture-source-mismatch` 表示來源或 fixture 綁定過期；`fixture-invalid-input` 表示 typed 結構、呼叫欄位或型別無效；`fixture-unsupported-input` 表示不可重播物件；`fixture-case-limit` / `fixture-too-large` 表示超出限額；`fixture-path-rejected` 表示檔案位置或連結不符合要求。這些是輸入準備問題，不能被記成目標函式的預期例外或成功測試。
