"""Validate generated unittest calls against the selected target signature.

This is intentionally a narrow pre-execution guard. It rejects impossible
calls only when they are not explicitly asserting Python's TypeError contract;
tests are still allowed to verify invalid-call behaviour with assertRaises.
"""
import ast
import json
import sys
from target_bindings import target_references, unresolved_target_aliases


def exception_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def has_type_error_guard(ancestors):
    """Return True when a call is enclosed by assertRaises(TypeError) or assertRaisesRegex(TypeError, ...)."""
    for ancestor in reversed(ancestors):
        if not isinstance(ancestor, (ast.With, ast.AsyncWith)):
            continue
        for item in ancestor.items:
            context = item.context_expr
            if not isinstance(context, ast.Call) or not context.args:
                continue
            if isinstance(context.func, ast.Attribute) and context.func.attr in ('assertRaises', 'assertRaisesRegex'):
                first_arg = context.args[0]
                if isinstance(first_arg, (ast.Tuple, ast.List)):
                    if any(exception_name(elt) == 'TypeError' for elt in first_arg.elts):
                        return True
                elif exception_name(first_arg) == 'TypeError':
                    return True
    return False


def validate_target_calls(code, target_name, signature, context=None):
    try:
        tree = ast.parse(code)
    except SyntaxError as error:
        return {'valid': False, 'reason': f'Python AST 無法解析：{error.msg} (line {error.lineno})'}

    parameters = [param for param in (signature or []) if isinstance(param, dict)]
    if not target_name or not parameters:
        return {'valid': True}

    selected = None
    if context and context.get('module'):
        selected = context['module'] + ('.' + context['className'] if context.get('className') else '') + '.' + target_name
    if selected:
        references = target_references(tree, selected)
        unresolved = unresolved_target_aliases(tree, selected)
        if unresolved:
            return {'valid': False, 'reasonCode': 'target-alias-unresolved',
                    'reason': 'Target alias cannot be resolved at ' + ', '.join(f'{item["name"]}:{item["line"]}' for item in unresolved)
                              + f'. Call {selected}(...) with a canonical import, or assign the alias once before use in the same straight-line scope without rebinding.'}
    else:
        # Legacy signature-only callers lack a canonical module. Use the same
        # flow proof, with explicit syntactic origins rather than name heuristics.
        selected_paths = {target_name}
        for stmt in tree.body:
            if isinstance(stmt, ast.ImportFrom) and not stmt.level:
                for item in stmt.names:
                    origin = (stmt.module or '') + '.' + item.name
                    selected_paths.add(origin if item.name == target_name else origin + '.' + target_name)
            elif isinstance(stmt, ast.Import):
                selected_paths.update(item.name + '.' + target_name for item in stmt.names)
        references = set().union(*(target_references(tree, path, {target_name: target_name}) for path in selected_paths))

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
        if isinstance(node, ast.Call) and id(node.func) in references:
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
    context = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
    print(json.dumps(validate_target_calls(sys.stdin.read(), target, target_signature, context)))
