"""Create and verify the 16 seeded bugs in eval/seeded_bugs/."""
import difflib
import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCREENING_DIR = os.path.join(REPO_ROOT, 'eval', 'eval_screening')
SEEDED_BUGS_DIR = os.path.join(REPO_ROOT, 'eval', 'seeded_bugs')

DOCSTRINGS_TO_ADD = {
    'vehicle_time_utils.py': [
        ('def get_remaining_text(eta_time):\n',
         'def get_remaining_text(eta_time):\n    """回傳剩餘或超時文字說明與是否超時之布林值元組 (text, is_overdue)"""\n'),
        ('def format_eta_time(eta_time):\n',
         'def format_eta_time(eta_time):\n    """將預計到達時間字串轉為月/日 時:分格式字串 (%m/%d %H:%M)"""\n')
    ]
}

def get_base_content(filename):
    path = os.path.join(SCREENING_DIR, filename)
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    if filename in DOCSTRINGS_TO_ADD:
        for old, new in DOCSTRINGS_TO_ADD[filename]:
            content = content.replace(old, new, 1)
    return content

BUGS = [
    # 1. 邊界運算子 (boundary-operator)
    {
        'id': 'bug_01_bmi_upper_boundary',
        'sourceFile': 'bmi.py',
        'target': 'calculate_bmi',
        'type': 'boundary-operator',
        'description': '將健康體位上限 18.5 <= bmi < 24 誤寫為閉區間 18.5 <= bmi <= 24',
        'expectedSpecSentence': '判斷體重狀態（依據台灣衛福部標準）：18.5 <= bmi < 24 健康體位，24 <= bmi < 27 體重過重',
        'docstringAdded': False,
        'old': '    elif 18.5 <= bmi < 24:\n        status = "健康體位"',
        'new': '    elif 18.5 <= bmi <= 24:\n        status = "健康體位"',
        'witness': {
            'call': 'calculate_bmi(76.8, 178.8854376378933)',
            'expectedClean': [24.0, '體重過重'],
            'expectedBug': [24.0, '健康體位']
        }
    },
    {
        'id': 'bug_02_range_non_inclusive',
        'sourceFile': 'bottle_utils.py',
        'target': 'parse_range_header',
        'type': 'boundary-operator',
        'description': '結束索引應為 non-inclusive，誤將包含式 end 轉為非包含式時漏加 1',
        'expectedSpecSentence': 'The end index is non-inclusive.',
        'docstringAdded': False,
        'old': '            else:  # bytes=100-200 -> bytes 100-200 (inclusive)\n                start, end = int(start), min(int(end) + 1, maxlen)',
        'new': '            else:  # bytes=100-200 -> bytes 100-200 (inclusive)\n                start, end = int(start), min(int(end), maxlen)',
        'witness': {
            'call': 'list(parse_range_header("bytes=100-200", 300))',
            'expectedClean': [[100, 201]],
            'expectedBug': [[100, 200]]
        }
    },
    {
        'id': 'bug_03_char_value_digit_boundary',
        'sourceFile': 'validators_basic.py',
        'target': '_char_value',
        'type': 'boundary-operator',
        'description': '字母 A 轉數值應為 10，計算公式誤減 1 導致 A 轉為 9',
        'expectedSpecSentence': 'A=10, B=11, ..., Z=35 (case-insensitive).',
        'docstringAdded': False,
        'old': '    return char if char.isdigit() else str(10 + ord(char.upper()) - ord("A"))',
        'new': '    return char if char.isdigit() else str(9 + ord(char.upper()) - ord("A"))',
        'witness': {
            'call': '_char_value("A")',
            'expectedClean': '10',
            'expectedBug': '9'
        }
    },

    # 2. 單位或換算 (unit-or-conversion)
    {
        'id': 'bug_04_bmi_height_unit_scale',
        'sourceFile': 'bmi.py',
        'target': 'calculate_bmi',
        'type': 'unit-or-conversion',
        'description': '身高公分換算為公尺應除以 100，誤以毫米單位除以 1000',
        'expectedSpecSentence': ':param height_cm: 身高（公分），將身高由公分換算為公尺',
        'docstringAdded': False,
        'old': '    # 將身高由公分換算為公尺\n    height_m = height_cm / 100',
        'new': '    # 將身高由公分換算為公尺\n    height_m = height_cm / 1000',
        'witness': {
            'call': 'calculate_bmi(70, 175)',
            'expectedClean': [22.86, '健康體位'],
            'expectedBug': [22857.14, '肥胖']
        }
    },
    {
        'id': 'bug_05_mod_check_rearrange',
        'sourceFile': 'validators_basic.py',
        'target': '_mod_check',
        'type': 'unit-or-conversion',
        'description': 'IBAN 檢查碼搬移應將前 4 碼移到末尾，誤切為前 2 碼',
        'expectedSpecSentence': 'move country code and check numbers to end',
        'docstringAdded': False,
        'old': '    # move country code and check numbers to end\n    rearranged = value[4:] + value[:4]',
        'new': '    # move country code and check numbers to end\n    rearranged = value[2:] + value[:2]',
        'witness': {
            'call': '_mod_check("DE29100500001061045672")',
            'expectedClean': True,
            'expectedBug': False
        }
    },

    # 3. 漏處理的例外 (unhandled-exception)
    {
        'id': 'bug_06_parse_date_overflow',
        'sourceFile': 'bottle_utils.py',
        'target': 'parse_date',
        'type': 'unhandled-exception',
        'description': '解析時間戳記時漏捕捉 OverflowError，導致超範圍年份直接拋出未捕捉例外',
        'expectedSpecSentence': 'Parse rfc1123, rfc850 and asctime timestamps and return UTC epoch or None.',
        'docstringAdded': False,
        'old': '    except (TypeError, ValueError, IndexError, OverflowError):',
        'new': '    except (TypeError, ValueError, IndexError):',
        'witness': {
            'call': 'parse_date("Sunday, 06-Nov-99999999999 08:49:37 GMT")',
            'expectedClean': None,
            'expectedBugException': 'OverflowError'
        }
    },
    {
        'id': 'bug_07_parse_excel_datetime_unhandled_type',
        'sourceFile': 'vehicle_time_utils.py',
        'target': 'parse_excel_datetime',
        'type': 'unhandled-exception',
        'description': '處理非字串且非 datetime 的型別時未安全檢查直接呼叫 strip，拋出 AttributeError',
        'expectedSpecSentence': '將 Excel A欄的出差時間轉成 datetime。支援 Excel 真正時間，也支援文字時間。',
        'docstringAdded': False,
        'old': '    if isinstance(value, str):\n        value = value.strip()',
        'new': '    if value:\n        value = value.strip()',
        'witness': {
            'call': 'parse_excel_datetime(12345)',
            'expectedClean': None,
            'expectedBugException': 'AttributeError'
        }
    },

    # 4. 錯誤的預設值 (wrong-default)
    {
        'id': 'bug_08_parse_range_default_maxlen',
        'sourceFile': 'bottle_utils.py',
        'target': 'parse_range_header',
        'type': 'wrong-default',
        'description': 'maxlen 預設值應為 0，誤設為 100',
        'expectedSpecSentence': 'parse_range_header(header, maxlen=0)',
        'docstringAdded': False,
        'old': 'def parse_range_header(header, maxlen=0):',
        'new': 'def parse_range_header(header, maxlen=100):',
        'witness': {
            'call': 'list(parse_range_header("bytes=10-20"))',
            'expectedClean': [],
            'expectedBug': [[10, 21]]
        }
    },
    {
        'id': 'bug_09_html_quote_tab_replacement',
        'sourceFile': 'bottle_utils.py',
        'target': 'html_quote',
        'type': 'wrong-default',
        'description': '跳脫 HTTP 屬性中的 tab 字元應替換為 "&#9;"，誤替換為空字串',
        'expectedSpecSentence': 'Escape and quote a string to be used as an HTTP attribute.',
        'docstringAdded': False,
        'old': '    return \'"%s"\' % html_escape(string).replace(\'\\n\', \'&#10;\') \\\n        .replace(\'\\r\', \'&#13;\').replace(\'\\t\', \'&#9;\')',
        'new': '    return \'"%s"\' % html_escape(string).replace(\'\\n\', \'&#10;\') \\\n        .replace(\'\\r\', \'&#13;\').replace(\'\\t\', \'\')',
        'witness': {
            'call': 'html_quote("a\\tb")',
            'expectedClean': '"a&#9;b"',
            'expectedBug': '"ab"'
        }
    },
    {
        'id': 'bug_10_path_shift_default_shift',
        'sourceFile': 'bottle_utils.py',
        'target': 'path_shift',
        'type': 'wrong-default',
        'description': 'shift 參數預設值應為 1，誤設為 0（不移動路徑片段）',
        'expectedSpecSentence': ':param shift: The number of path fragments to shift. (default: 1)',
        'docstringAdded': False,
        'old': 'def path_shift(script_name, path_info, shift=1):',
        'new': 'def path_shift(script_name, path_info, shift=0):',
        'witness': {
            'call': 'path_shift("/a", "/b")',
            'expectedClean': ['/a/b', ''],
            'expectedBug': ['/a', '/b']
        }
    },

    # 5. 回傳錯欄位 (wrong-field)
    {
        'id': 'bug_11_get_remaining_text_return_order',
        'sourceFile': 'vehicle_time_utils.py',
        'target': 'get_remaining_text',
        'type': 'wrong-field',
        'description': '回傳元組欄位順序錯誤，誤將 (is_overdue, text) 順序回傳而非 (text, is_overdue)',
        'expectedSpecSentence': '回傳剩餘或超時文字說明與是否超時之布林值元組 (text, is_overdue)',
        'docstringAdded': True,
        'old': '    if eta_time is None or eta_time == "":\n        return "", False',
        'new': '    if eta_time is None or eta_time == "":\n        return False, ""',
        'witness': {
            'call': 'get_remaining_text("")',
            'expectedClean': ['', False],
            'expectedBug': [False, '']
        }
    },
    {
        'id': 'bug_12_parse_auth_reversed_user_pwd',
        'sourceFile': 'bottle_utils.py',
        'target': 'parse_auth',
        'type': 'wrong-field',
        'description': '解析 Basic Auth 標頭回傳 tuple 時，誤將 (pwd, user) 顛倒回傳',
        'expectedSpecSentence': 'Parse rfc2617 HTTP authentication header string (basic) and return (user,pass) tuple or None',
        'docstringAdded': False,
        'old': '            user, pwd = touni(base64.b64decode(tob(data))).split(\':\', 1)\n            return user, pwd',
        'new': '            user, pwd = touni(base64.b64decode(tob(data))).split(\':\', 1)\n            return pwd, user',
        'witness': {
            'call': 'parse_auth("Basic YWxhZGRpbjpvcGVuc2VzYW1l")',
            'expectedClean': ['aladdin', 'opensesame'],
            'expectedBug': ['opensesame', 'aladdin']
        }
    },
    {
        'id': 'bug_13_format_eta_time_field_order',
        'sourceFile': 'vehicle_time_utils.py',
        'target': 'format_eta_time',
        'type': 'wrong-field',
        'description': '時間格式化回傳欄位順序錯誤，誤回傳時:分 月/日 (%H:%M %m/%d) 而非月/日 時:分 (%m/%d %H:%M)',
        'expectedSpecSentence': '將預計到達時間字串轉為月/日 時:分格式字串 (%m/%d %H:%M)',
        'docstringAdded': True,
        'old': '        eta = datetime.strptime(eta_time, "%Y-%m-%d %H:%M:%S")\n        return eta.strftime("%m/%d %H:%M")',
        'new': '        eta = datetime.strptime(eta_time, "%Y-%m-%d %H:%M:%S")\n        return eta.strftime("%H:%M %m/%d")',
        'witness': {
            'call': 'format_eta_time("2026-11-09 10:30:00")',
            'expectedClean': '11/09 10:30',
            'expectedBug': '10:30 11/09'
        }
    },

    # 6. 條件反向 (condition-inversion)
    {
        'id': 'bug_14_html_escape_quote_inversion',
        'sourceFile': 'bottle_utils.py',
        'target': 'html_escape',
        'type': 'condition-inversion',
        'description': '跳脫 HTML 特殊字元時，單引號與雙引號之跳脫替換對調',
        'expectedSpecSentence': 'Escape HTML special characters ``&<>`` and quotes ``\'"``.',
        'docstringAdded': False,
        'old': '    return string.replace(\'&\', \'&amp;\').replace(\'<\', \'&lt;\').replace(\'>\', \'&gt;\')\\\n                 .replace(\'"\', \'&quot;\').replace("\'", \'&#039;\')',
        'new': '    return string.replace(\'&\', \'&amp;\').replace(\'<\', \'&lt;\').replace(\'>\', \'&gt;\')\\\n                 .replace(\'"\', \'&#039;\').replace("\'", \'&quot;\')',
        'witness': {
            'call': 'html_escape(\'"\')',
            'expectedClean': '&quot;',
            'expectedBug': '&#039;'
        }
    },
    {
        'id': 'bug_15_iban_empty_string_check',
        'sourceFile': 'validators_basic.py',
        'target': 'iban',
        'type': 'condition-inversion',
        'description': '檢查是否為非空字串之條件反向，將 if value else False 誤寫為 if not value else False',
        'expectedSpecSentence': 'Return whether or not given value is a valid IBAN code.',
        'docstringAdded': False,
        'old': '        if value\n        else False',
        'new': '        if not value\n        else False',
        'witness': {
            'call': 'bool(iban("DE29100500001061045672"))',
            'expectedClean': True,
            'expectedBug': False
        }
    },
    {
        'id': 'bug_16_char_value_digit_condition',
        'sourceFile': 'validators_basic.py',
        'target': '_char_value',
        'type': 'condition-inversion',
        'description': '數字判斷條件反向，誤寫為 char if not char.isdigit() else str(...)',
        'expectedSpecSentence': 'A=10, B=11, ..., Z=35 (case-insensitive).',
        'docstringAdded': False,
        'old': '    return char if char.isdigit() else str(10 + ord(char.upper()) - ord("A"))',
        'new': '    return char if not char.isdigit() else str(10 + ord(char.upper()) - ord("A"))',
        'witness': {
            'call': '_char_value("5")',
            'expectedClean': '5',
            'expectedBug': '14'
        }
    }
]

def apply_patch(original_text, patch_text):
    import re
    orig_lines = original_text.splitlines(keepends=True)
    patch_lines = patch_text.splitlines(keepends=True)
    hunks = []
    current_hunk = None
    for line in patch_lines:
        if line.startswith('@@'):
            m = re.match(r'^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@', line)
            if m:
                orig_start = int(m.group(1))
                orig_len = int(m.group(2)) if m.group(2) is not None else 1
                new_start = int(m.group(3))
                new_len = int(m.group(4)) if m.group(4) is not None else 1
                current_hunk = {
                    'orig_start': orig_start,
                    'orig_len': orig_len,
                    'new_start': new_start,
                    'new_len': new_len,
                    'lines': []
                }
                hunks.append(current_hunk)
        elif current_hunk is not None:
            if line.startswith((' ', '-', '+', '\\')):
                current_hunk['lines'].append(line)
    out_lines = list(orig_lines)
    for hunk in reversed(hunks):
        start_idx = hunk['orig_start'] - 1
        del_count = 0
        new_block = []
        for hline in hunk['lines']:
            if hline.startswith(' '):
                del_count += 1
                new_block.append(hline[1:])
            elif hline.startswith('-'):
                del_count += 1
            elif hline.startswith('+'):
                new_block.append(hline[1:])
        out_lines[start_idx : start_idx + del_count] = new_block
    return ''.join(out_lines)

def make_patch(filename, old_str, new_str, original_content):
    if old_str not in original_content:
        raise ValueError(f'old_str not in original_content for {filename}')
    modified_content = original_content.replace(old_str, new_str, 1)
    diff = difflib.unified_diff(
        original_content.splitlines(keepends=True),
        modified_content.splitlines(keepends=True),
        fromfile=f'a/{filename}',
        tofile=f'b/{filename}'
    )
    return ''.join(diff), modified_content

def execute_witness(dir_path, source_file, call_code):
    mod_name = os.path.splitext(source_file)[0]
    py_code = f"""import json, sys
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, r'{dir_path}')
try:
    import {mod_name}
    for attr in dir({mod_name}):
        globals()[attr] = getattr({mod_name}, attr)
except Exception as e:
    print(json.dumps({{'import_error': type(e).__name__ + ': ' + str(e)}}))
    sys.exit(0)

try:
    res = {call_code}
    try:
        json_res = json.loads(json.dumps(res))
    except Exception:
        json_res = repr(res)
    print(json.dumps({{'status': 'ok', 'value': json_res, 'repr': repr(res)}}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({{'status': 'exception', 'type': type(e).__name__, 'msg': str(e)}}, ensure_ascii=False))
"""
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    run = subprocess.run([sys.executable, '-c', py_code], capture_output=True, text=True, encoding='utf-8', env=env)
    if run.returncode != 0 or not run.stdout.strip():
        raise RuntimeError(f"Execution failed:\nSTDOUT: {run.stdout}\nSTDERR: {run.stderr}")
    return json.loads(run.stdout.strip())

def main():
    os.makedirs(SEEDED_BUGS_DIR, exist_ok=True)
    type_counts = {}
    target_counts = {}

    for bug in BUGS:
        bug_id = bug['id']
        bug_dir = os.path.join(SEEDED_BUGS_DIR, bug_id)
        os.makedirs(bug_dir, exist_ok=True)

        source_file = bug['sourceFile']
        original_content = get_base_content(source_file)
        patch_text, modified_content = make_patch(source_file, bug['old'], bug['new'], original_content)

        # 1. Verify patch applies cleanly with apply_patch
        patched_content = apply_patch(original_content, patch_text)
        assert patched_content == modified_content, f"apply_patch did not reproduce modified_content for {bug_id}"

        # 2. Test in clean environment vs bug environment
        with tempfile.TemporaryDirectory() as td_clean, tempfile.TemporaryDirectory() as td_bug:
            for fname in os.listdir(SCREENING_DIR):
                src = os.path.join(SCREENING_DIR, fname)
                if os.path.isfile(src):
                    with open(src, 'r', encoding='utf-8') as sf:
                        c = sf.read()
                    if fname in DOCSTRINGS_TO_ADD:
                        for old_s, new_s in DOCSTRINGS_TO_ADD[fname]:
                            c = c.replace(old_s, new_s, 1)
                    with open(os.path.join(td_clean, fname), 'w', encoding='utf-8') as df:
                        df.write(c)
                    with open(os.path.join(td_bug, fname), 'w', encoding='utf-8') as df:
                        df.write(c)

            # Apply patch to bug directory
            with open(os.path.join(td_bug, source_file), 'w', encoding='utf-8') as f:
                f.write(modified_content)

            call_code = bug['witness']['call']
            clean_eval = execute_witness(td_clean, source_file, call_code)
            bug_eval = execute_witness(td_bug, source_file, call_code)

            assert 'import_error' not in clean_eval, f"Clean import error for {source_file}: {clean_eval['import_error']}"
            assert 'import_error' not in bug_eval, f"Bug import error for {source_file}: {bug_eval['import_error']}"
            assert clean_eval != bug_eval, f"Witness did not produce differing outputs for {bug_id}!\nClean: {clean_eval}\nBug: {bug_eval}"

        patch_path = os.path.join(bug_dir, 'patch')
        with open(patch_path, 'w', encoding='utf-8') as f:
            f.write(patch_text)

        meta = {
            'id': bug['id'],
            'sourceFile': bug['sourceFile'],
            'target': bug['target'],
            'type': bug['type'],
            'description': bug['description'],
            'expectedSpecSentence': bug['expectedSpecSentence'],
            'witness': {
                'call': bug['witness']['call'],
                'clean': clean_eval,
                'bug': bug_eval
            },
            'docstringAdded': bug['docstringAdded']
        }
        meta_path = os.path.join(bug_dir, 'meta.json')
        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        type_counts[bug['type']] = type_counts.get(bug['type'], 0) + 1
        target_counts[bug['target']] = target_counts.get(bug['target'], 0) + 1

    print(f"Successfully generated and verified {len(BUGS)} seeded bugs.")
    print("Type distribution:", json.dumps(type_counts, ensure_ascii=False, indent=2))
    print("Target distribution:", json.dumps(target_counts, ensure_ascii=False, indent=2))
    print("Type distribution:", json.dumps(type_counts, ensure_ascii=False, indent=2))
    print("Target distribution:", json.dumps(target_counts, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
