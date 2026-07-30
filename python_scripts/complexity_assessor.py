"""
complexity_assessor.py
計算函式的複雜度分數（0–100），供 Tier Router 使用。
用法: python complexity_assessor.py <file_path> <func_name>
輸出: JSON { "score": int, "level": str, "reasons": [str] }
"""
import sys
import ast
import json
import os

EXTERNAL_RESOURCE_KEYWORDS = [
    'db', 'database', 'sql', 'query', 'session',
    'http', 'request', 'response', 'url', 'fetch', 'get', 'post',
    'redis', 'cache', 'queue', 'kafka', 'rabbitmq',
    'file', 'open', 'write', 'read', 'path',
    'email', 'smtp', 'send', 'socket',
]


def assess_complexity(file_path: str, func_name: str) -> dict:
    reasons = []
    score = 0

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            source = f.read()
    except Exception as e:
        return {"score": 0, "level": "Unknown", "reasons": [f"Cannot read file: {e}"]}

    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"score": 0, "level": "Unknown", "reasons": [f"Syntax error: {e}"]}

    target_func = None
    class_name = None

    # 優先找頂層函式，再找 class method
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            target_func = node
            break
    if target_func is None:
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == func_name:
                        target_func = item
                        class_name = node.name
                        break
            if target_func:
                break
    if target_func is None:
        return {"score": 0, "level": "Unknown", "reasons": [f"Function '{func_name}' not found"]}

    # --- 1. 參數數量（去除 self/cls）---
    all_args = [arg.arg for arg in target_func.args.args]
    effective_args = [a for a in all_args if a not in ('self', 'cls')] if class_name else all_args
    n_args = len(effective_args)
    if n_args > 0:
        pts = n_args * 5
        score += pts
        reasons.append(f"+{pts} 參數數量: {n_args} 個 (每個 +5)")

    # --- 2. 程式碼行數 ---
    func_lines = target_func.end_lineno - target_func.lineno + 1 if hasattr(target_func, 'end_lineno') else 0
    line_pts = (func_lines // 10) * 2
    if line_pts > 0:
        score += line_pts
        reasons.append(f"+{line_pts} 程式碼行數: {func_lines} 行 (每10行 +2)")

    # --- 3. 分支數量（if / elif / for / while）---
    branch_count = 0
    for node in ast.walk(target_func):
        if isinstance(node, (ast.If, ast.For, ast.While)):
            branch_count += 1
        elif isinstance(node, ast.IfExp):
            branch_count += 1
    if branch_count > 0:
        pts = branch_count * 3
        score += pts
        reasons.append(f"+{pts} 分支數量: {branch_count} 個 (每個 +3)")

    # --- 4. raise / except 點 ---
    exception_count = 0
    for node in ast.walk(target_func):
        if isinstance(node, (ast.Raise, ast.ExceptHandler)):
            exception_count += 1
    if exception_count > 0:
        pts = exception_count * 8
        score += pts
        reasons.append(f"+{pts} 例外處理點: {exception_count} 個 (每個 +8)")

    # --- 5. 外部模組 import 依賴 ---
    imports_in_file = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            # 相對 import 或同專案 import
            if node.module and not node.module.startswith('__'):
                for alias in node.names:
                    imports_in_file.add(alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                imports_in_file.add(alias.name)

    # 收集函式內實際呼叫的名稱
    calls_in_func = set()
    for node in ast.walk(target_func):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                calls_in_func.add(node.func.id)
            elif isinstance(node.func, ast.Attribute):
                calls_in_func.add(node.func.attr)

    external_deps = calls_in_func & imports_in_file
    if external_deps:
        pts = len(external_deps) * 10
        score += pts
        reasons.append(f"+{pts} 外部依賴呼叫: {', '.join(sorted(external_deps))} (每個 +10)")

    # --- 6. 外部資源關鍵字（高危）---
    func_source_lower = ast.get_source_segment(source, target_func) or ''
    func_source_lower = func_source_lower.lower()
    found_resources = []
    for kw in EXTERNAL_RESOURCE_KEYWORDS:
        if kw in func_source_lower and kw not in found_resources:
            # 避免重複計算相似關鍵字
            found_resources.append(kw)
    if found_resources:
        # 最多計 3 個關鍵字，避免分數爆炸
        unique_res = found_resources[:3]
        pts = len(unique_res) * 20
        score += pts
        reasons.append(f"+{pts} 外部資源關鍵字: {', '.join(unique_res)} (每個 +20)")

    # --- 上限 100 ---
    score = min(score, 100)

    # --- 等級判定 ---
    if score <= 25:
        level = "Simple"
    elif score <= 50:
        level = "Moderate"
    elif score <= 75:
        level = "Complex"
    else:
        level = "Very Complex"

    return {
        "score": score,
        "level": level,
        "reasons": reasons
    }


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({"score": 0, "level": "Unknown", "reasons": ["Usage: complexity_assessor.py <file_path> <func_name>"]}))
        sys.exit(1)

    result = assess_complexity(sys.argv[1], sys.argv[2])
    print(json.dumps(result, ensure_ascii=False))
