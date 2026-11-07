"""Conservative, shared target binding proof. Never executes submitted code.

Callable aliases require one straight-line assignment before use. Parameters,
deletions, rebinding and unsupported control-flow writes revoke that proof.
"""
import ast
from collections import Counter
from ast_extractor import function_scope_bindings


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return base + '.' + node.attr if base else ''
    return ''


def target_references(tree, selected, initial_aliases=None):
    """Return AST expression identities proven to reference selected callable."""
    aliases = dict(initial_aliases or {})
    nodes = tree.body if isinstance(tree, ast.Module) else []
    if any(isinstance(stmt, ast.ImportFrom) and any(item.name == '*' for item in stmt.names) for stmt in nodes):
        return set()
    writes = Counter()
    for stmt in nodes:
        if isinstance(stmt, (ast.Import, ast.ImportFrom)):
            if isinstance(stmt, ast.ImportFrom) and stmt.level:
                continue
            for item in stmt.names:
                name = item.asname or (item.name.split('.')[0] if isinstance(stmt, ast.Import) else item.name)
                writes[name] += 1
                aliases[name] = ((item.name if item.asname else name) if isinstance(stmt, ast.Import)
                                 else (stmt.module or '') + '.' + item.name)
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            writes[stmt.name] += 1
        else:
            for child in ast.walk(stmt):
                if isinstance(child, (ast.Name, ast.Attribute)) and isinstance(child.ctx, (ast.Store, ast.Del)):
                    writes[dotted(child).split('.')[0]] += 1
    aliases = {name: origin for name, origin in aliases.items() if writes[name] <= 1}
    references = set()

    def method(fn, inherited=None):
        local = function_scope_bindings(fn)
        env = {name: origin for name, origin in aliases.items() if name not in local}
        env.update(inherited or {})
        stores = Counter(dotted(n) for n in ast.walk(fn)
                         if isinstance(n, (ast.Name, ast.Attribute)) and isinstance(n.ctx, (ast.Store, ast.Del)))
        unsafe = any(isinstance(n, (ast.Global, ast.Nonlocal)) or isinstance(n, ast.Call) and dotted(n.func).split('.')[-1] in
                     {'exec', 'eval', 'globals', 'locals', 'setattr', 'delattr'} for n in ast.walk(fn))
        if unsafe:
            return {}

        def origin(node):
            name = dotted(node)
            if name in env:
                return env[name]
            if isinstance(node, ast.Attribute):
                base = origin(node.value)
                return base + '.' + node.attr if base else ''
            if isinstance(node, ast.Call):
                # A constructed real class retains its canonical owner path.
                value = origin(node.func)
                return value if selected.startswith(value + '.') else ''
            return ''

        def expression(node):
            if node is None or isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                return
            if origin(node) == selected:
                references.add(id(node))
            for child in ast.iter_child_nodes(node):
                expression(child)

        def invalidate(node):
            name = dotted(node)
            for key in list(env):
                if key == name or key.startswith(name + '.'):
                    env.pop(key)
            if name:
                env[name] = ''

        def statements(body, allow_alias_binding=True):
            for stmt in body:
                if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                    expression(stmt.value)
                    value = origin(stmt.value)
                    targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                    for dest in targets:
                        invalidate(dest)
                        name = dotted(dest)
                        if allow_alias_binding and name and stores[name] == 1 and value:
                            env[name] = value
                elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
                    if isinstance(stmt, ast.ImportFrom) and stmt.level:
                        continue
                    for item in stmt.names:
                        name = item.asname or (item.name.split('.')[0] if isinstance(stmt, ast.Import) else item.name)
                        env[name] = (((item.name if item.asname else name) if isinstance(stmt, ast.Import)
                                      else (stmt.module or '') + '.' + item.name) if allow_alias_binding else '')
                elif isinstance(stmt, (ast.With, ast.AsyncWith)):
                    for item in stmt.items:
                        expression(item.context_expr)
                        if item.optional_vars:
                            invalidate(item.optional_vars)
                    statements(stmt.body, allow_alias_binding)
                elif isinstance(stmt, ast.If):
                    expression(stmt.test)
                    before = env.copy()
                    statements(stmt.body, allow_alias_binding)
                    env.clear(); env.update(before)
                    statements(stmt.orelse, allow_alias_binding)
                    env.clear(); env.update(before)
                    for child in ast.walk(stmt):
                        if isinstance(child, (ast.Name, ast.Attribute)) and isinstance(child.ctx, (ast.Store, ast.Del)):
                            invalidate(child)
                elif isinstance(stmt, (ast.For, ast.AsyncFor)):
                    expression(stmt.iter)
                    before = env.copy()
                    changed = [child for child in ast.walk(stmt)
                               if isinstance(child, (ast.Name, ast.Attribute))
                               and isinstance(child.ctx, (ast.Store, ast.Del))]
                    for child in changed:
                        invalidate(child)
                    stable = env.copy()
                    # Stable canonical imports and pre-loop bindings are still
                    # calls to the target. Never infer a new alias in a loop.
                    statements(stmt.body, False)
                    env.clear(); env.update(stable)
                    statements(stmt.orelse, False)
                    env.clear(); env.update(before)
                    for child in changed:
                        invalidate(child)
                elif isinstance(stmt, (ast.Expr, ast.Assert)):
                    expression(stmt)
                else:
                    # Do not infer a binding through loops, exception flow or nested scopes.
                    for child in ast.walk(stmt):
                        if isinstance(child, (ast.Name, ast.Attribute)) and isinstance(child.ctx, (ast.Store, ast.Del)):
                            invalidate(child)
                    if isinstance(stmt, (ast.Return, ast.Raise)):
                        break
        statements(fn.body)
        return {name: value for name, value in env.items() if name.startswith('self.')}

    if isinstance(tree, (ast.FunctionDef, ast.AsyncFunctionDef)):
        method(tree)
    else:
        for cls in nodes:
            if not isinstance(cls, ast.ClassDef) or cls.decorator_list:
                continue
            inherited = {}
            for fn in cls.body:
                if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and fn.name in ('setUp', 'asyncSetUp'):
                    inherited.update(method(fn))
            for fn in cls.body:
                if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and fn.name.startswith('test_'):
                    method(fn, inherited)
    return references


def unresolved_target_aliases(tree, selected):
    """Bounded repair hints for aliases whose target identity could not be proved."""
    imports = {}
    for stmt in tree.body:
        if isinstance(stmt, ast.Import):
            for item in stmt.names:
                name = item.asname or item.name.split('.')[0]
                imports[name] = item.name if item.asname else name
        elif isinstance(stmt, ast.ImportFrom) and not stmt.level:
            for item in stmt.names:
                imports[item.asname or item.name] = (stmt.module or '') + '.' + item.name
    proven = target_references(tree, selected)
    result = []
    module_candidates = set()
    for stmt in tree.body:
        if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            head, _, tail = dotted(stmt.value).partition('.')
            origin = imports.get(head, '') + ('.' + tail if tail else '')
            if origin == selected or head in module_candidates and not tail:
                module_candidates.update(dest.id for dest in (stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target])
                                         if isinstance(dest, ast.Name))
    for method in ast.walk(tree):
        if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) or not method.name.startswith('test_'):
            continue
        candidates = module_candidates.copy()
        for stmt in ast.walk(method):
            if not isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                continue
            head, _, tail = dotted(stmt.value).partition('.')
            origin = imports.get(head, '') + ('.' + tail if tail else '')
            if origin == selected or head in candidates and not tail:
                for dest in stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]:
                    if isinstance(dest, ast.Name):
                        candidates.add(dest.id)
        for node in ast.walk(method):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in candidates and id(node.func) not in proven:
                result.append({'name': node.func.id, 'line': node.lineno})
    return result[:8]
