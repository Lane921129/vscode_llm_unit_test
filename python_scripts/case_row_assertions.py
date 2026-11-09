"""Check that a single-row fix only touches setup, never what the test asserts.

stdin:  {"before": "<method>", "after": "<method>", "method": "test_c1",
         "callees": ["target_module.find", "instance.size"], "module": "store", "target": "find"}
stdout: {"parsed": bool, "sameName": bool, "accepted": bool, "violations": [...]}

A fix is accepted only when, compared with the host-written method:
  post-call-changed     every statement from the first top-level statement that
                        contains a target call to the end of the method is
                        AST-identical (nothing may be added, removed or edited
                        after the call starts, e.g. re-assigning the result);
  target-rebound        setup before that statement never assigns, deletes or
                        augments an attribute of target_module (or of a name
                        imported from the module under test), never calls
                        setattr/delattr on them, never rebinds target_module,
                        the target's own name or `instance.<method>`, never
                        patches the target itself with mock.patch/patch.object,
                        and never binds any of those protected objects to
                        another name (assignment, tuple unpacking, walrus, for
                        target, comprehension, with-as, default argument, or the
                        result of getattr/vars/__dict__ on them);
  target-call-changed   every call to the function under test (callee and all
                        arguments) is AST-identical, in the same order;
  assertion-changed     every self.assert* call (all arguments, including the
                        first) is AST-identical, with the same count;
  mock-changed          every mock.patch* context and every mock_N configuration
                        statement is AST-identical;
  control-flow-added    no try/except, if, loop or conditional expression newly
                        encloses a target call or assertion, and no return is added.
Only surrounding code (setup lines, imports, helper values) may change.
"""
import ast
import json
import sys
import textwrap

GUARDS = (ast.Try, ast.If, ast.IfExp, ast.While, ast.For, ast.AsyncFor, ast.With, ast.AsyncWith, ast.Lambda)
try:
    GUARDS = GUARDS + (ast.TryStar,)
except AttributeError:  # Python < 3.11
    pass


def _method(source, name):
    tree = ast.parse(textwrap.dedent(source))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return node if node.name == name else None
    return None


def _parents(root):
    parents = {}
    for node in ast.walk(root):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    return parents


def _guard_path(node, parents, root):
    """Kinds of enclosing control structures; mock.patch with-blocks are part of the mock fingerprint instead."""
    kinds = []
    current = parents.get(node)
    while current is not None and current is not root:
        if isinstance(current, (ast.With, ast.AsyncWith)) and all(_is_patch(item.context_expr) for item in current.items):
            pass
        elif isinstance(current, (ast.With, ast.AsyncWith)) and all(_is_assert_call(item.context_expr) for item in current.items):
            kinds.append('assert-context')
        elif isinstance(current, GUARDS):
            kinds.append(type(current).__name__)
        current = parents.get(current)
    return kinds


def _dotted(node):
    try:
        return ast.unparse(node)
    except Exception:  # unparse of exotic nodes
        return ''


def _is_patch(node):
    name = _dotted(node.func) if isinstance(node, ast.Call) else ''
    return any(part.startswith('patch') for part in name.split('.')) and name.startswith(('mock.', 'patch', 'unittest.mock.'))


def _is_assert_call(node):
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr.startswith('assert') \
        and isinstance(node.func.value, ast.Name) and node.func.value.id == 'self'


def fingerprint(method, callees):
    parents = _parents(method)
    calls, asserts, mocks = [], [], []
    for node in ast.walk(method):
        if isinstance(node, ast.Call) and _dotted(node.func) in callees:
            calls.append((node.lineno, node.col_offset, ast.dump(node), tuple(_guard_path(node, parents, method))))
        elif _is_assert_call(node):
            asserts.append((node.lineno, node.col_offset, ast.dump(node), tuple(_guard_path(node, parents, method))))
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if _is_patch(item.context_expr):
                    mocks.append((node.lineno, ast.dump(item)))
        if isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(_dotted(target).startswith('mock_') for target in targets):
                mocks.append((node.lineno, ast.dump(node)))
    order = lambda items: [item[2:] if len(item) == 4 else item[1:] for item in sorted(items)]
    returns = sum(isinstance(node, ast.Return) for node in ast.walk(method))
    return {'calls': order(calls), 'asserts': order(asserts), 'mocks': order(mocks), 'returns': returns}


def _root(node):
    while isinstance(node, (ast.Attribute, ast.Subscript, ast.Call)):
        node = node.func if isinstance(node, ast.Call) else node.value
    return node.id if isinstance(node, ast.Name) else None


def _first_call_index(method, callees):
    for index, statement in enumerate(method.body):
        if any(isinstance(node, ast.Call) and _dotted(node.func) in callees for node in ast.walk(statement)):
            return index
    return None


def _rebinds_target(statements, module, target):
    """True when setup touches the module under test or the target itself."""
    parts = target.split('.')
    protected_names = {'target_module', parts[0], parts[-1]}
    roots = {'target_module'}
    for statement in statements:
        for node in ast.walk(statement):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == module or alias.name.endswith('.' + module):
                        roots.add(alias.asname or alias.name.split('.')[0])
            elif isinstance(node, ast.ImportFrom) and node.module and (node.module == module or node.module.endswith('.' + module)):
                for alias in node.names:
                    roots.add(alias.asname or alias.name)
    instance_attribute = parts[-1]
    target_attributes = {parts[0], parts[-1], '__dict__'}

    def aliases(expression):
        """True when the expression evaluates to a protected object itself (not merely uses it)."""
        if expression is None:
            return False
        if isinstance(expression, ast.Name):
            return expression.id in roots or expression.id in protected_names
        if isinstance(expression, ast.Attribute):
            return expression.attr in target_attributes and (_root(expression) in roots or _root(expression) == 'instance')
        if isinstance(expression, ast.Call):
            name = _dotted(expression.func)
            if name in ('getattr', 'builtins.getattr', 'vars', 'builtins.vars') and expression.args:
                return aliases(expression.args[0]) or _root(expression.args[0]) in roots | {'instance'}
            return False
        if isinstance(expression, ast.Subscript):
            return aliases(expression.value)
        if isinstance(expression, (ast.Tuple, ast.List, ast.Set)):
            return any(aliases(item) for item in expression.elts)
        if isinstance(expression, ast.Dict):
            return any(aliases(item) for item in list(expression.keys) + list(expression.values) if item is not None)
        if isinstance(expression, ast.Starred):
            return aliases(expression.value)
        if isinstance(expression, ast.IfExp):
            return aliases(expression.body) or aliases(expression.orelse)
        if isinstance(expression, ast.BoolOp):
            return any(aliases(item) for item in expression.values)
        if isinstance(expression, ast.NamedExpr):
            return aliases(expression.value)
        return False

    for statement in statements:
        for node in ast.walk(statement):
            sources = []
            if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
                sources = [node.value]
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                sources = [node.iter]
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                sources = [item.context_expr for item in node.items if item.optional_vars is not None]
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                sources = list(node.args.defaults) + [item for item in node.args.kw_defaults if item is not None]
            if any(aliases(source) for source in sources):
                return True

    for statement in statements:
        for node in ast.walk(statement):
            targets = []
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
                targets = [node.target]
            elif isinstance(node, ast.Delete):
                targets = node.targets
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.With, ast.AsyncWith, ast.NamedExpr)):
                targets = [node.target] if isinstance(node, (ast.For, ast.AsyncFor, ast.NamedExpr)) else \
                    [item.optional_vars for item in node.items if item.optional_vars is not None]
            for target_node in targets:
                for element in ast.walk(target_node):
                    if isinstance(element, ast.Name) and isinstance(element.ctx, (ast.Store, ast.Del)) and element.id in protected_names:
                        return True
                    if isinstance(element, (ast.Attribute, ast.Subscript)) and isinstance(element.ctx, (ast.Store, ast.Del)):
                        # Any protected name inside the stored expression counts, e.g. vars(target_module)['f'] = ...
                        if _root(element) in roots or any(isinstance(inner, ast.Name) and inner.id in roots for inner in ast.walk(element)):
                            return True
                        if isinstance(element, ast.Attribute) and _root(element) == 'instance' and element.attr == instance_attribute:
                            return True
            if isinstance(node, ast.Call):
                name = _dotted(node.func)
                first = node.args[0] if node.args else None
                if name in ('setattr', 'delattr', 'builtins.setattr', 'builtins.delattr') and first is not None \
                        and (_root(first) in roots or _root(first) == 'instance'):
                    return True
                if _is_patch(node) and first is not None:
                    if isinstance(first, ast.Constant) and isinstance(first.value, str):
                        if first.value.split('.')[-1] in (parts[0], parts[-1]) and module in first.value.split('.'):
                            return True
                    elif _root(first) in roots | {'instance'}:
                        attribute = node.args[1] if len(node.args) > 1 else None
                        if isinstance(attribute, ast.Constant) and attribute.value in (parts[0], parts[-1]):
                            return True
                        if _dotted(first).split('.')[-1] in (parts[0], parts[-1]):
                            return True
    return False


def compare(request):
    callees = set(request.get('callees') or [])
    module = request.get('module') or ''
    target = request.get('target') or ''
    try:
        before = _method(request['before'], request['method'])
        after = _method(request['after'], request['method'])
    except (SyntaxError, ValueError):
        return {'parsed': False, 'sameName': False, 'accepted': False, 'violations': ['unparseable']}
    if before is None or after is None:
        return {'parsed': True, 'sameName': False, 'accepted': False, 'violations': ['method-renamed']}
    old, new = fingerprint(before, callees), fingerprint(after, callees)
    violations = []
    first_old, first_new = _first_call_index(before, callees), _first_call_index(after, callees)
    if first_old is None or first_new is None \
            or [ast.dump(item) for item in before.body[first_old:]] != [ast.dump(item) for item in after.body[first_new:]]:
        violations.append('post-call-changed')
    if target and _rebinds_target(after.body[:first_new] if first_new is not None else after.body, module, target):
        violations.append('target-rebound')
    if [item[0] for item in old['calls']] != [item[0] for item in new['calls']] or not old['calls']:
        violations.append('target-call-changed')
    if [item[0] for item in old['asserts']] != [item[0] for item in new['asserts']] or not old['asserts']:
        violations.append('assertion-changed')
    if old['mocks'] != new['mocks']:
        violations.append('mock-changed')
    if new['returns'] > old['returns'] or [item[1] for item in old['calls'] + old['asserts']] != [item[1] for item in new['calls'] + new['asserts']]:
        violations.append('control-flow-added')
    return {'parsed': True, 'sameName': True, 'accepted': not violations, 'violations': violations}


def main(stdin=None, stdout=None):
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    try:
        report = compare(json.loads(stdin.read()))
    except (ValueError, KeyError, TypeError):
        report = {'parsed': False, 'sameName': False, 'accepted': False, 'violations': ['invalid-request']}
    stdout.write(json.dumps(report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
