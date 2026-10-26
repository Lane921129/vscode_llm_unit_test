"""Read-only, bounded unittest facts. Never import or execute submitted code.

Unknown scopes remain unknown. Observations are supplied by the host after its
source/run identity and isolation checks; source expressions are not oracles.
"""
import ast
import hashlib
import json
import sys
import unittest
from trace_value_codec import snapshot_value, restore_value


class Unknown(Exception):
    pass


def standard_assertion_syntax(cls, method, aliases, overrides):
    """Method validity only: never claims a branch ran or its expected value is correct."""
    params = method.args.posonlyargs + method.args.args
    if not params or method.decorator_list or overrides.intersection({'run', '__getattribute__', '__getattr__'}):
        return []
    receiver = params[0].arg
    if any(isinstance(node, ast.Name) and node.id == receiver and isinstance(node.ctx, (ast.Store, ast.Del))
           for node in ast.walk(method)):
        return []
    standard = {name for name in dir(unittest.TestCase) if name.startswith('assert')
                and callable(getattr(unittest.TestCase, name))}
    if any(isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del))
           and aliases.get(dotted(node).split('.')[0], '').startswith('unittest') for node in ast.walk(cls)):
        return []
    # A fixture may replace an inherited assertion; syntax alone cannot then bind it.
    for member in cls.body:
        if not isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        arguments = member.args.posonlyargs + member.args.args
        if not arguments:
            continue
        owner = arguments[0].arg
        for node in ast.walk(member):
            if isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del)):
                path = dotted(node)
                root, _, tail = path.partition('.')
                if root == owner and (tail in standard or tail.startswith('__')):
                    return []
                if aliases.get(root, '').startswith('unittest'):
                    return []
            if isinstance(node, ast.Call) and any(isinstance(value, ast.Name) and value.id == owner
                                                for value in [*node.args, *(item.value for item in node.keywords)]):
                return []
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                    and dotted(node.func.value) == owner and node.func.attr not in standard \
                    and node.func.attr not in ('addCleanup', 'skipTest', 'subTest'):
                return []
            if isinstance(node, ast.Call):
                root, _, tail = dotted(node.func).partition('.')
                origin = aliases.get(root, '') + ('.' + tail if tail else '')
                if origin == 'unittest.mock.patch' and node.args and isinstance(node.args[0], ast.Constant) \
                        and type(node.args[0].value) is str and node.args[0].value.startswith('unittest.'):
                    return []
                if origin == 'unittest.mock.patch.object' and node.args:
                    base, _, attribute = dotted(node.args[0]).partition('.')
                    if (aliases.get(base, '') + ('.' + attribute if attribute else '')).startswith('unittest.'):
                        return []
    result = []
    def visit(node):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            return
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and dotted(node.func.value) == receiver and node.func.attr in standard \
                and node.func.attr not in overrides:
            result.append({'line': node.lineno, 'kind': node.func.attr})
        for child in ast.iter_child_nodes(node):
            visit(child)
    for statement in method.body:
        visit(statement)
    return result


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = dotted(node.value)
        return prefix + '.' + node.attr if prefix else ''
    return ''


def same_call(left, right):
    """The outer args transport may be list/tuple; nested input types/order stay exact."""
    if not left or not right:
        return False
    try:
        def normalize(snapshot):
            fields = restore_value(snapshot)
            if type(fields) is dict and set(fields) == {'args', 'kwargs', 'constructor_args', 'constructor_kwargs'}:
                if type(fields['constructor_args']) not in (tuple, list) or fields['constructor_args'] or fields['constructor_kwargs'] != {}:
                    raise ValueError('constructor unsupported')
                fields = {'args': fields['args'], 'kwargs': fields['kwargs']}
            if type(fields) is not dict or set(fields) != {'args', 'kwargs'} or type(fields['args']) not in (list, tuple) or type(fields['kwargs']) is not dict:
                raise ValueError('unsupported call')
            return snapshot_value({'args': tuple(fields['args']), 'kwargs': fields['kwargs']})
        return normalize(left) == normalize(right)
    except (ValueError, TypeError, KeyError):
        return False


def mock_call_assertions(method, aliases, target):
    """Recognize only default patch-created mocks on a straight-line target path.

    These are assertion-presence facts, not proof of requirements or coverage.
    Never derive a return-value oracle from a mock or enter unknown control flow.
    """
    params = method.args.posonlyargs + method.args.args
    if not params or method.args.vararg or method.args.kwarg or method.args.kwonlyargs:
        return []
    local_names = {node.id for node in ast.walk(method) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)}
    local_names.update(item.arg for item in params)
    if any(isinstance(node, (ast.Global, ast.Nonlocal, ast.Import, ast.ImportFrom)) for node in ast.walk(method)):
        return []

    def resolved(node):
        root, _, tail = dotted(node).partition('.')
        if root in local_names or root not in aliases:
            return ''
        return aliases[root] + ('.' + tail if tail else '')

    def patch_target(node):
        if not isinstance(node, ast.Call) or resolved(node.func) != 'unittest.mock.patch' or len(node.args) != 1:
            return None
        if not isinstance(node.args[0], ast.Constant) or type(node.args[0].value) is not str:
            return None
        # new/new_callable/spec/custom configuration may replace assertion methods.
        if node.keywords:
            return None
        path = node.args[0].value
        if not path or any(not part.isidentifier() for part in path.split('.')):
            return None
        if path == target or target.startswith(path + '.'):
            return None
        return path

    mocks = {}
    if len(params) != 1 + len(method.decorator_list):
        return []
    for parameter, decorator in zip(params[1:], reversed(method.decorator_list)):
        path = patch_target(decorator)
        if not path:
            return []
        mocks[parameter.arg] = (path, '')

    def mock_path(node, bindings):
        if isinstance(node, ast.Name):
            return bindings.get(node.id)
        if isinstance(node, ast.Attribute):
            base = mock_path(node.value, bindings)
            if not base or node.attr.startswith('_') or node.attr.startswith('assert') or node.attr in (
                    'called', 'call_count', 'call_args', 'call_args_list', 'mock_calls', 'method_calls',
                    'side_effect', 'reset_mock', 'configure_mock', 'attach_mock'):
                return None
            return (base[0], base[1] + '.' + node.attr)
        return None

    facts = []

    def walk(statements, bindings, target_line=None):
        for stmt in statements:
            if isinstance(stmt, ast.Assign) and all(isinstance(item, ast.Name) for item in stmt.targets):
                value = mock_path(stmt.value, bindings)
                if value:
                    for item in stmt.targets:
                        bindings[item.id] = value
                    continue
                try:
                    ast.literal_eval(stmt.value)
                except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
                    return
                for item in stmt.targets:
                    bindings.pop(item.id, None)
                continue
            if isinstance(stmt, ast.With):
                nested = dict(bindings)
                for item in stmt.items:
                    path = patch_target(item.context_expr)
                    if not path or not isinstance(item.optional_vars, ast.Name):
                        return
                    nested[item.optional_vars.id] = (path, '')
                walk(stmt.body, nested)
                # Context exit can mutate state; do not carry facts across it.
                return
            if not isinstance(stmt, ast.Expr):
                return
            call = stmt.value
            if isinstance(call, ast.Constant):
                continue
            if isinstance(call, ast.Call) and resolved(call.func) == target:
                # Inputs may be local scalar literals, but never arbitrary calls.
                if target_line is not None or any(isinstance(item, (ast.Call, ast.Await, ast.Yield, ast.NamedExpr))
                                                  for arg in [*call.args, *(item.value for item in call.keywords)] for item in ast.walk(arg)):
                    return
                target_line = stmt.lineno
                continue
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute):
                base = mock_path(call.func.value, bindings)
                kind = call.func.attr
                if base and target_line and kind in ('assert_called', 'assert_called_once', 'assert_called_with', 'assert_called_once_with', 'assert_any_call', 'assert_not_called'):
                    if any(isinstance(item, (ast.Call, ast.Await, ast.Yield, ast.NamedExpr))
                           for arg in [*call.args, *(item.value for item in call.keywords)] for item in ast.walk(arg)):
                        return
                    facts.append({'line': call.lineno, 'kind': kind, 'patchTarget': base[0],
                                  'mockPath': base[1], 'targetCallLine': target_line})
                    continue
            # Custom calls, mock reconfiguration and unknown assertions stop proof.
            return

    walk(method.body, mocks)
    return facts


def review_syntax_details(code, method, aliases, standard_assertions):
    """Complete spellings for no-op review proposals; never an execution/oracle proof."""
    standard_calls = {(item['line'], item['kind']) for item in standard_assertions}
    parameters = method.args.posonlyargs + method.args.args
    receiver = parameters[0].arg if parameters else ''
    assertions, patches = [], []
    local_names = {node.id for node in ast.walk(method) if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del))}
    local_names.update(arg.arg for arg in method.args.posonlyargs + method.args.args)

    def spelling(node):
        return list(dict.fromkeys(filter(None, [ast.get_source_segment(code, node), ast.unparse(node)])))

    def visit(node):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            return
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and dotted(node.func.value) == receiver \
                and (node.lineno, node.func.attr) in standard_calls:
            assertions.append({'line': node.lineno, 'kind': node.func.attr, 'spellings': spelling(node)})
        # Only explicit, directly bound stdlib context managers have patch syntax facts.
        # Conditional presence does not prove execution; these fields are used solely
        # to recognize a proposal that repeats an existing complete spelling.
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                call = item.context_expr
                if not isinstance(call, ast.Call) or not isinstance(item.optional_vars, ast.Name):
                    continue
                root, _, tail = dotted(call.func).partition('.')
                if root in local_names or root not in aliases:
                    continue
                origin = aliases[root] + ('.' + tail if tail else '')
                if origin != 'unittest.mock.patch' or not call.args or not isinstance(call.args[0], ast.Constant) \
                        or type(call.args[0].value) is not str:
                    continue
                patches.append({'line': call.lineno, 'origin': origin, 'target': call.args[0].value,
                                'binding': item.optional_vars.id,
                                'spellings': [text + ' as ' + item.optional_vars.id for text in spelling(call)]})
        for child in ast.iter_child_nodes(node):
            visit(child)

    for statement in method.body:
        visit(statement)
    return assertions, patches


def target_call_syntax(method, aliases, target):
    """Conservative call-site lower bound, independent of literal input decoding.
    Never descends into nested bodies or claims execution/expected-value evidence.
    """
    shadowed = {arg.arg for arg in [*method.args.posonlyargs, *method.args.args, *method.args.kwonlyargs]}
    for node in ast.walk(method):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            shadowed.add(node.id)
        elif isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del)):
            shadowed.add(dotted(node).split('.')[0])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node is not method:
            shadowed.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for item in node.names:
                if item.name == '*':
                    shadowed.update(aliases)
                else:
                    shadowed.add(item.asname or (item.name.split('.')[0] if isinstance(node, ast.Import) else item.name))
    result = []

    def visit(node):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            return
        if isinstance(node, ast.Call):
            root, _, tail = dotted(node.func).partition('.')
            if root and root not in shadowed and root in aliases \
                    and aliases[root] + ('.' + tail if tail else '') == target:
                result.append({'line': node.lineno, 'column': node.col_offset})
        for child in ast.iter_child_nodes(node):
            visit(child)

    for statement in method.body:
        visit(statement)
    return result


def build_review_facts(payload):
    code = payload['code']
    if len(code) > 120000:
        raise ValueError('test-facts-budget')
    tree = ast.parse(code)
    if sum(1 for _ in ast.walk(tree)) > 12000:
        raise ValueError('test-facts-budget')
    aliases = {}
    imports = []
    import_statements = []
    rebound = set()
    wildcard_import = False
    for node in tree.body:
        if isinstance(node, ast.Import):
            for item in node.names:
                import_statements.append({'line': node.lineno, 'module': item.name, 'wildcard': False})
                binding = item.asname or item.name.split('.')[0]
                aliases[binding] = item.name if item.asname else binding
                imports.append({'line': node.lineno, 'binding': binding, 'origin': item.name})
        elif isinstance(node, ast.ImportFrom) and not node.level:
            import_statements.append({'line': node.lineno, 'module': node.module or '',
                                      'wildcard': any(item.name == '*' for item in node.names)})
            for item in node.names:
                if item.name == '*':
                    wildcard_import = True
                else:
                    binding = item.asname or item.name
                    aliases[binding] = (node.module or '') + '.' + item.name
                    imports.append({'line': node.lineno, 'binding': binding, 'origin': aliases[binding]})
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            rebound.add(node.name)
        else:
            rebound.update(item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, (ast.Store, ast.Del)))
            # Imported module attributes can be overwritten without rebinding
            # the Name itself; no inherited-method proof survives that mutation.
            rebound.update(dotted(item).split('.')[0] for item in ast.walk(node)
                           if isinstance(item, ast.Attribute) and isinstance(item.ctx, (ast.Store, ast.Del)))
            for item in ast.walk(node):
                if isinstance(item, (ast.Import, ast.ImportFrom)):
                    for entry in item.names:
                        if entry.name == '*':
                            wildcard_import = True
                        else:
                            rebound.add(entry.asname or (entry.name.split('.')[0] if isinstance(item, ast.Import) else entry.name))
    if wildcard_import:
        rebound.update(aliases)
    for binding in rebound:
        aliases.pop(binding, None)
    latest_import = {item['binding']: item for item in imports}
    imports = [item for item in imports if item['binding'] not in rebound and latest_import[item['binding']] is item]

    def resolve(node, local):
        text = dotted(node)
        root, _, tail = text.partition('.')
        if not root or root in local or root not in aliases:
            return ''
        return aliases[root] + ('.' + tail if tail else '')

    target = payload['module'] + '.' + payload['target']
    observations = payload.get('observations', [])
    classes, methods = [], []
    # A custom loader means static test discovery cannot establish execution.
    custom_loader = any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == 'load_tests' for node in tree.body)
    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef) or cls.decorator_list or cls.keywords:
            continue
        if len(cls.bases) != 1 or resolve(cls.bases[0], {}) not in ('unittest.TestCase', 'unittest.IsolatedAsyncioTestCase'):
            continue
        classes.append({'line': cls.lineno, 'name': cls.name, 'kind': 'unittest-harness'})
        base_binding = dotted(cls.bases[0]).split('.')[0]
        for imported in imports:
            if imported['binding'] == base_binding:
                imported['harnessUseLines'] = [*imported.get('harnessUseLines', []), cls.lineno]
        overrides = {node.name for node in cls.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith('test_')}
        for node in cls.body:
            if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                overrides.update(item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Store))
        # Exact source/input observations cannot establish what an unknown
        # fixture or dispatch override changed before this test's target call.
        # Calls and their assertions must share the same existing setup gate.
        observation_setup_known = not overrides.intersection({'setUp', 'setUpClass', 'run', '__getattribute__', '__getattr__'})
        for method in cls.body:
            if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) or not method.name.startswith('test_'):
                continue
            params = method.args.posonlyargs + method.args.args
            if not params or method.args.vararg or method.args.kwarg or method.args.kwonlyargs:
                continue
            receiver = params[0].arg
            facts = {'line': method.lineno, 'endLine': method.end_lineno, 'name': cls.name + '.' + method.name,
                     'assertions': [], 'calls': [], 'exceptionGuards': [], 'scalarBindings': [], 'mockAssertions': [],
                     'standardAssertions': []}
            if not custom_loader:
                facts['targetCallSyntax'] = target_call_syntax(method, aliases, target)
                facts['standardAssertions'] = standard_assertion_syntax(cls, method, aliases, overrides)
                assertion_syntax, patch_syntax = review_syntax_details(code, method, aliases, facts['standardAssertions'])
                facts['standardAssertionCalls'] = assertion_syntax
                facts['dependencyPatchSyntax'] = patch_syntax
            if not custom_loader and observation_setup_known:
                facts['mockAssertions'] = mock_call_assertions(method, aliases, target)
            # All assigned local names shadow module aliases, including assignments later in the method.
            local = {node.id: None for node in ast.walk(method) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)}
            local[receiver] = None
            standard_calls = {(item['line'], item['kind']) for item in facts['standardAssertions']}
            observation_flow_known = True

            def literal(node):
                remaining = [512]

                def read(item, depth=0):
                    remaining[0] -= 1
                    if remaining[0] < 0 or depth > 8:
                        raise Unknown()
                    if isinstance(item, ast.Name):
                        value = local.get(item.id)
                        if not isinstance(value, tuple) or value[0] != 'literal':
                            raise Unknown()
                        return value[1]
                    if isinstance(item, ast.Constant):
                        return item.value
                    if isinstance(item, (ast.Tuple, ast.List, ast.Set)):
                        values = [read(child, depth + 1) for child in item.elts]
                        return {ast.Tuple: tuple, ast.List: list, ast.Set: set}[type(item)](values)
                    if isinstance(item, ast.Dict) and all(key is not None for key in item.keys):
                        return {read(key, depth + 1): read(value, depth + 1)
                                for key, value in zip(item.keys, item.values)}
                    # Signed numeric literals are syntax, not general arithmetic.
                    if isinstance(item, ast.UnaryOp) and isinstance(item.op, (ast.UAdd, ast.USub)) \
                            and isinstance(item.operand, ast.Constant) and type(item.operand.value) in (int, float):
                        return ast.literal_eval(item)
                    # Calls, attributes, unpacking, comprehensions and operators
                    # are deliberately not evaluated, including inside containers.
                    raise Unknown()

                try:
                    result = read(node)
                    snap = snapshot_value(result)
                except (Unknown, ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
                    raise Unknown() from None
                if not snap['replayable']:
                    raise Unknown()
                return result

            def mutable_literal(value):
                if type(value) in (list, dict, set):
                    return True
                return type(value) is tuple and any(mutable_literal(child) for child in value)

            def forget_mutable_inputs(call):
                nonlocal observation_flow_known
                # A target may mutate a caller-owned container. Preserve its
                # captured typed input, but do not reuse pre-call aliases as an
                # expected value after that call. Clearing all mutable literals
                # is conservative and also covers aliases nested in tuples.
                names = {item.id for arg in [*call.args, *(entry.value for entry in call.keywords)]
                         for item in ast.walk(arg) if isinstance(item, ast.Name)}
                if any(isinstance(local.get(name), tuple) and local[name][0] == 'literal'
                       and mutable_literal(local[name][1]) for name in names):
                    observation_flow_known = False
                    for name, value in local.items():
                        if isinstance(value, tuple) and value[0] == 'literal' and mutable_literal(value[1]):
                            local[name] = None

            def observed_result(call):
                matches = [item for item in observations if same_call(item.get('call'), call)]
                if not matches or any('result_snapshot' not in item for item in matches) \
                        or any(item['result_snapshot'] != matches[0]['result_snapshot'] for item in matches):
                    raise Unknown()
                return restore_value(matches[0]['result_snapshot'])

            def expression(node):
                nonlocal observation_flow_known
                if isinstance(node, ast.Await):
                    return expression(node.value)
                if isinstance(node, ast.Name) and isinstance(local.get(node.id), tuple):
                    return local[node.id]
                if isinstance(node, ast.Subscript):
                    base = expression(node.value)
                    index = literal(node.slice)
                    if base[0] == 'result' and type(index) is int:
                        return ('result', base[1], base[2] + [index], base[3])
                if isinstance(node, ast.Call) and resolve(node.func, local) == target:
                    binding = dotted(node.func).split('.')[0]
                    for imported in imports:
                        if imported['binding'] == binding:
                            imported['targetUseLines'] = sorted({*imported.get('targetUseLines', []), node.lineno})
                    if any(isinstance(arg, ast.Starred) for arg in node.args) or any(item.arg is None for item in node.keywords):
                        observation_flow_known = False
                        return ('result', None, [], node.lineno)
                    try:
                        args = [literal(arg) for arg in node.args]
                        kwargs = {item.arg: literal(item.value) for item in node.keywords}
                    except Unknown:
                        observation_flow_known = False
                        return ('result', None, [], node.lineno)
                    call = snapshot_value({'args': args, 'kwargs': kwargs})
                    if len(kwargs) != len(node.keywords) or not call['replayable']:
                        observation_flow_known = False
                        return ('result', None, [], node.lineno)
                    literal_call = ast.Call(func=node.func,
                                            args=[ast.parse(repr(arg), mode='eval').body for arg in args],
                                            keywords=[ast.keyword(arg=name, value=ast.parse(repr(value), mode='eval').body)
                                                      for name, value in kwargs.items()])
                    fact = {'line': node.lineno, 'call': call,
                            'spellings': list(dict.fromkeys(filter(None, [ast.get_source_segment(code, node), ast.unparse(literal_call)])))}
                    # This is a source-bound exact-input return observation, not proof
                    # that a fixture/unknown setup produces the same behavior.
                    try:
                        observed_result(call)
                        if observation_setup_known and observation_flow_known:
                            fact['observationReturned'] = True
                    except (Unknown, ValueError, TypeError):
                        pass
                    facts['calls'].append(fact)
                    forget_mutable_inputs(node)
                    return ('result', call, [], node.lineno)
                return ('literal', literal(node))

            def assign(binding, value, line):
                if isinstance(binding, ast.Name):
                    local[binding.id] = value
                    if value and value[0] == 'literal' and type(value[1]) in (int, float, bool, str, type(None)):
                        facts['scalarBindings'].append({'line': line, 'name': binding.id, 'type': type(value[1]).__name__})
                elif isinstance(binding, (ast.Tuple, ast.List)):
                    for index, child in enumerate(binding.elts):
                        part = ('result', value[1], value[2] + [index], value[3]) if value and value[0] == 'result' else None
                        assign(child, part, line)

            def assertion(node):
                if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute) or dotted(node.func.value) != receiver:
                    return
                kind = node.func.attr
                if not kind.startswith('assert') or kind in overrides:
                    return
                fact = {'line': node.lineno, 'kind': kind, 'observationStatus': 'unknown'}
                facts['assertions'].append(fact)
                if kind not in ('assertEqual', 'assertAlmostEqual', 'assertTupleEqual', 'assertListEqual', 'assertDictEqual', 'assertSequenceEqual') or len(node.args) < 2:
                    return
                try:
                    sides = []
                    for arg in node.args[:2]:
                        try:
                            sides.append(expression(arg))
                        except Unknown:
                            sides.append(None)
                    actual_index = next((index for index, side in enumerate(sides) if side and side[0] == 'result'), None)
                    if actual_index is None:
                        return
                    actual, expected = sides[actual_index], sides[1 - actual_index]
                    # Binding the assertion to the target is independent from
                    # understanding its expected expression or having Trace data.
                    fact['targetResult'] = True
                    # Syntax provenance is independent of whether the value has
                    # an oracle. Only the bounded literal reader can establish
                    # a fixed expected value; unknown is never "computed".
                    fact['expectedOrigin'] = 'unknown'
                    if actual[1] is not None and any(item['line'] == actual[3] and item['call'] == actual[1]
                                                     for item in facts['calls']):
                        fact['targetCallLine'] = actual[3]
                    if not expected or expected[0] != 'literal':
                        return
                    fact.update({'expectedType': type(expected[1]).__name__, 'expected': snapshot_value(expected[1]),
                                 'expectedOrigin': 'static-literal'})
                    if not observation_setup_known or not observation_flow_known \
                            or (node.lineno, kind) not in standard_calls:
                        return
                    value = observed_result(actual[1])
                    for index in actual[2]:
                        if type(value) not in (tuple, list):
                            raise Unknown()
                        value = value[index]
                    if kind == 'assertAlmostEqual':
                        if len(node.args) > 5:
                            raise Unknown()
                        positional = {name: literal(arg) for name, arg in zip(('places', 'msg', 'delta'), node.args[2:])}
                        keywords = {item.arg: literal(item.value) for item in node.keywords}
                        if set(keywords) - {'places', 'delta', 'msg'} or set(keywords).intersection(positional) \
                                or len(keywords) != len(node.keywords):
                            raise Unknown()
                        options = {**positional, **keywords}
                        places, delta = options.get('places'), options.get('delta')
                        if places is not None and delta is not None:
                            raise Unknown()
                        places = 7 if places is None else places
                        if type(value) not in (float, int) or type(expected[1]) not in (float, int) or type(places) is not int or abs(places) > 12:
                            raise Unknown()
                        if delta is not None and (type(delta) not in (float, int) or delta < 0):
                            raise Unknown()
                        equal = value == expected[1] or (abs(value - expected[1]) <= delta if delta is not None
                                                        else round(abs(value - expected[1]), places) == 0)
                    else:
                        if len(node.args) > 3 or any(item.arg != 'msg' for item in node.keywords) \
                                or len(node.keywords) > 1 or len(node.args) == 3 and node.keywords:
                            raise Unknown()
                        for arg in [*node.args[2:], *(item.value for item in node.keywords)]:
                            literal(arg)
                        required_type = {'assertTupleEqual': tuple, 'assertListEqual': list, 'assertDictEqual': dict}.get(kind)
                        if required_type and (type(value) is not required_type or type(expected[1]) is not required_type):
                            raise Unknown()
                        if kind == 'assertSequenceEqual':
                            if type(value) not in (tuple, list) or type(expected[1]) not in (tuple, list):
                                raise Unknown()
                            equal = list(value) == list(expected[1])
                        else:
                            equal = value == expected[1]
                    fact['observationStatus'] = 'verified' if equal else 'contradicted'
                    if equal:
                        fact['observationVerified'] = True
                except (Unknown, ValueError, TypeError, IndexError, OverflowError):
                    return

            def walk(statements, patch_mocks=()):
                nonlocal observation_flow_known
                patch_mocks = set(patch_mocks)
                for stmt in statements:
                    try:
                        if isinstance(stmt, ast.Assign):
                            if any(not isinstance(binding, (ast.Name, ast.Tuple, ast.List))
                                   or any(isinstance(item, (ast.Attribute, ast.Subscript, ast.Starred)) for item in ast.walk(binding))
                                   for binding in stmt.targets):
                                paths = [dotted(binding).split('.') for binding in stmt.targets]
                                if not all(isinstance(binding, ast.Attribute) and 2 <= len(parts) <= 8
                                           and parts[0] in patch_mocks and parts[-1] in ('return_value', 'side_effect')
                                           and all(part and not part.startswith('_') for part in parts[1:])
                                           and not any(part in ('return_value', 'side_effect') for part in parts[1:-1])
                                           for binding, parts in zip(stmt.targets, paths)):
                                    break
                                if any(isinstance(item, (ast.NamedExpr, ast.Await, ast.Yield, ast.YieldFrom)) for item in ast.walk(stmt.value)):
                                    break
                                observation_flow_known = False
                                for name, value in local.items():
                                    if value and value[0] == 'result':
                                        local[name] = None
                                continue
                            patch_mocks.difference_update(item.id for item in ast.walk(stmt)
                                                          if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Store))
                            try:
                                value = expression(stmt.value)
                            except Unknown:
                                observation_flow_known = False
                                value = None
                            for binding in stmt.targets:
                                assign(binding, value, stmt.lineno)
                        elif isinstance(stmt, ast.AnnAssign):
                            if not isinstance(stmt.target, ast.Name):
                                break
                            patch_mocks.discard(stmt.target.id)
                            try:
                                value = expression(stmt.value) if stmt.value else None
                            except Unknown:
                                observation_flow_known = False
                                value = None
                            assign(stmt.target, value, stmt.lineno)
                        elif isinstance(stmt, ast.Expr):
                            if isinstance(stmt.value, ast.Constant):
                                continue
                            assertion(stmt.value)
                            # Unknown arbitrary calls may mutate prior results; do not propagate them.
                            if not (isinstance(stmt.value, ast.Call) and isinstance(stmt.value.func, ast.Attribute) and dotted(stmt.value.func.value) == receiver and stmt.value.func.attr.startswith('assert')):
                                break
                            if not facts['assertions'] or facts['assertions'][-1].get('observationStatus') != 'verified':
                                observation_flow_known = False
                            # Unsupported assertion arguments may invoke hooks or
                            # mutate earlier results before a later assertion.
                            for arg in [*stmt.value.args, *(item.value for item in stmt.value.keywords)]:
                                target_functions = {id(part) for item in ast.walk(arg)
                                                    if isinstance(item, ast.Call) and resolve(item.func, local) == target
                                                    for part in ast.walk(item.func)}
                                if any(isinstance(item, (ast.Call, ast.Await, ast.Yield, ast.NamedExpr, ast.Attribute))
                                       and not (isinstance(item, ast.Call) and resolve(item.func, local) == target)
                                       and id(item) not in target_functions
                                       for item in ast.walk(arg)):
                                    observation_flow_known = False
                        elif isinstance(stmt, ast.With) and len(stmt.items) == 1:
                            guard = stmt.items[0].context_expr
                            item = stmt.items[0]
                            path = guard.args[0].value if isinstance(guard, ast.Call) and len(guard.args) == 1 \
                                and isinstance(guard.args[0], ast.Constant) and type(guard.args[0].value) is str else ''
                            if isinstance(guard, ast.Call) and resolve(guard.func, local) == 'unittest.mock.patch' \
                                    and not guard.keywords and isinstance(item.optional_vars, ast.Name) \
                                    and path.startswith(payload['module'] + '.') \
                                    and path != target and not path.startswith(target + '.') and not target.startswith(path + '.'):
                                # Default stdlib patch setup can preserve syntax binding,
                                # never the unpatched Trace's returned value or oracle.
                                observation_flow_known = False
                                for name, value in local.items():
                                    if value and value[0] == 'result':
                                        local[name] = None
                                walk(stmt.body, patch_mocks | {item.optional_vars.id})
                                break
                            if not isinstance(guard, ast.Call) or not isinstance(guard.func, ast.Attribute) or dotted(guard.func.value) != receiver or guard.func.attr not in ('assertRaises', 'assertRaisesRegex') or guard.func.attr in overrides or not guard.args:
                                break
                            exception = dotted(guard.args[0])
                            resolved_exception = resolve(guard.args[0], local)
                            if resolved_exception.startswith('builtins.'):
                                exception = resolved_exception
                            elif not (isinstance(guard.args[0], ast.Name) and exception in ('TypeError', 'ZeroDivisionError')
                                      and exception not in local and exception not in aliases and exception not in rebound):
                                exception = 'unknown'
                            calls = []
                            for body in stmt.body:
                                if not isinstance(body, ast.Expr):
                                    raise Unknown()
                                result = expression(body.value)
                                if result[0] != 'result':
                                    raise Unknown()
                                calls.append(body.lineno)
                            facts['exceptionGuards'].append({'line': stmt.lineno, 'exception': exception, 'callLines': calls})
                        else:
                            # Do not promote conditional, loop, try, nested or transformed results.
                            break
                    except Unknown:
                        break
            if not custom_loader and not method.decorator_list and len(params) == 1:
                walk(method.body)
            present = {(item['line'], item['kind']) for item in facts['assertions']}
            for item in facts['standardAssertions']:
                if (item['line'], item['kind']) not in present:
                    facts['assertions'].append({**item, 'observationStatus': 'unknown'})
            facts['assertions'].sort(key=lambda item: item['line'])
            methods.append(facts)
    return {'schemaVersion': 'review-test-facts-v1', 'runId': payload['runId'], 'sourceHash': payload['sourceHash'],
            'target': payload['target'], 'module': payload['module'], 'testHash': hashlib.sha256(code.encode()).hexdigest(),
            'executionVerified': payload.get('executionVerified') is True, 'imports': imports,
            'importStatements': import_statements, 'classes': classes, 'methods': methods,
            'limitations': 'Import statements prove syntax/presence only; wildcard exports and rebound bindings remain unknown. Standard assertions prove inherited unittest method syntax only, never execution or expected-value validity. Static facts cover directly resolved unittest constructs, straight-line literal target calls and default patch-created mock call assertions. Mock assertions prove presence only, not return requirements or coverage. Unknown or unexecuted paths are not observations.'}


if __name__ == '__main__':
    try:
        # The host writes UTF-8 JSON regardless of the user's Windows console code page.
        result = build_review_facts(json.loads(sys.stdin.buffer.read().decode('utf-8')))
        print(json.dumps(result, ensure_ascii=True))
    except (ValueError, KeyError, TypeError, SyntaxError, RecursionError):
        print(json.dumps({'error': 'review-test-facts-unavailable'}))
        sys.exit(1)
