"""Validate generated unittest calls against the selected target signature.

This is intentionally a narrow pre-execution guard. It rejects impossible
calls only when they are not explicitly asserting Python's TypeError contract;
tests are still allowed to verify invalid-call behaviour with assertRaises.
"""
import ast
import json
import sys


def exception_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def has_type_error_guard(ancestors):
    """Return True when a call is enclosed by assertRaises(TypeError)."""
    for ancestor in reversed(ancestors):
        if not isinstance(ancestor, (ast.With, ast.AsyncWith)):
            continue
        for item in ancestor.items:
            context = item.context_expr
            if not isinstance(context, ast.Call) or not context.args:
                continue
            if isinstance(context.func, ast.Attribute) and context.func.attr == 'assertRaises':
                if exception_name(context.args[0]) == 'TypeError':
                    return True
    return False


def imported_target_names(tree, target_name):
    """Return direct names that are proven aliases of the selected target."""
    names = {target_name}
    for node in tree.body:
        if not isinstance(node, ast.ImportFrom):
            continue
        for alias in node.names:
            if alias.name == target_name:
                names.add(alias.asname or alias.name)
    return names


def target_call(node, target_names, target_name):
    return (
        isinstance(node.func, ast.Name) and node.func.id in target_names
    ) or (
        isinstance(node.func, ast.Attribute) and node.func.attr == target_name
    )


def validate_target_calls(code, target_name, signature):
    try:
        tree = ast.parse(code)
    except SyntaxError as error:
        return {'valid': False, 'reason': f'Python AST 無法解析：{error.msg} (line {error.lineno})'}

    parameters = [param for param in (signature or []) if isinstance(param, dict)]
    if not target_name or not parameters:
        return {'valid': True}

    target_names = imported_target_names(tree, target_name)

    positional = [
        param for param in parameters
        if param.get('kind') in ('positional_only', 'positional_or_keyword')
    ]
    accepted_keywords = {
        param.get('name') for param in parameters
        if param.get('kind') in ('positional_or_keyword', 'keyword_only')
    }
    accepts_varargs = any(param.get('kind') == 'var_positional' for param in parameters)
    accepts_kwargs = any(param.get('kind') == 'var_keyword' for param in parameters)
    failures = []

    def visit(node, ancestors):
        if isinstance(node, ast.Call) and target_call(node, target_names, target_name):
            invalid = None
            fixed_positional_count = sum(not isinstance(argument, ast.Starred) for argument in node.args)
            if not accepts_varargs and fixed_positional_count > len(positional):
                invalid = f'傳入 {fixed_positional_count} 個 positional 引數，但簽名最多接受 {len(positional)} 個'
            if invalid is None and not accepts_kwargs:
                for keyword in node.keywords:
                    if keyword.arg is not None and keyword.arg not in accepted_keywords:
                        invalid = f'使用未定義的 keyword 引數 {keyword.arg}'
                        break
            if invalid and not has_type_error_guard(ancestors):
                failures.append(invalid)
        for child in ast.iter_child_nodes(node):
            visit(child, ancestors + [node])

    visit(tree, [])
    if failures:
        return {
            'valid': False,
            'reason': (
                f'呼叫被測函式 {target_name} {failures[0]}；'
                '此呼叫不可能測到目標行為。若刻意測試錯誤簽名，必須使用 with self.assertRaises(TypeError):。'
            )
        }
    return {'valid': True}


if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else ''
    try:
        target_signature = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
    except json.JSONDecodeError:
        target_signature = []
    # Keep this process protocol-safe even when Windows' active code page is
    # not UTF-8. json.loads restores escaped text for the TypeScript caller.
    print(json.dumps(validate_target_calls(sys.stdin.read(), target, target_signature)))
