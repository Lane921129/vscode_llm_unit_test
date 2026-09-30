"""Read-only AST data flow for unittest assertions, including unpacked results.

No submitted code is executed. Unsupported flows do not manufacture evidence.
"""
import ast


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        root = dotted(node.value)
        return root + '.' + node.attr if root else ''
    return ''


def has_target_result_assertion(tree, context):
    aliases = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for item in node.names:
                aliases[item.asname or item.name.split('.')[0]] = item.name if item.asname else item.name.split('.')[0]
        elif isinstance(node, ast.ImportFrom) and not node.level:
            for item in node.names:
                aliases[item.asname or item.name] = f'{node.module}.{item.name}'
    owner = context.get('className')
    target = context.get('target', '')
    root = context.get('module', '') + ('.' + owner if owner else '')
    selected = root + '.' + target

    def resolve(node, hidden):
        name = dotted(node)
        head, _, tail = name.partition('.')
        return '' if head in hidden else aliases.get(head, head) + ('.' + tail if tail else '')

    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef) or cls.decorator_list:
            continue
        if not any(resolve(base, set()) in ('unittest.TestCase', 'unittest.IsolatedAsyncioTestCase') for base in cls.bases):
            continue
        fixtures = [node for node in cls.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in ('setUp', 'asyncSetUp')]
        for method in cls.body:
            if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) or not method.name.startswith('test_'):
                continue
            values, instances, hidden = set(), set(), set()

            def is_target(node):
                return resolve(node, hidden) == selected or bool(owner and isinstance(node, ast.Attribute)
                    and node.attr == target and (dotted(node.value) in instances or (
                        isinstance(node.value, ast.Call) and resolve(node.value.func, hidden) == root)))

            def derived(node):
                if isinstance(node, ast.Await):
                    return derived(node.value)
                if isinstance(node, ast.Call):
                    return is_target(node.func) or (resolve(node.func, hidden) in (
                        'len', 'bool', 'str', 'int', 'float', 'abs', 'round', 'sorted', 'list', 'tuple', 'type', 'isinstance')
                        and any(derived(arg) for arg in node.args))
                if isinstance(node, (ast.Name, ast.Attribute)):
                    return dotted(node) in values or (context.get('targetUsage') == 'property' and is_target(node)) or (
                        isinstance(node, ast.Attribute) and derived(node.value))
                if isinstance(node, ast.Subscript):
                    return derived(node.value)
                if isinstance(node, (ast.Tuple, ast.List)):
                    return any(derived(item) for item in node.elts)
                if isinstance(node, (ast.UnaryOp, ast.BinOp, ast.Compare)):
                    return any(derived(child) for child in ast.iter_child_nodes(node))
                return False

            def assign(node, evidence, instance=False):
                if isinstance(node, (ast.Tuple, ast.List)):
                    for item in node.elts:
                        assign(item, evidence)
                elif isinstance(node, ast.Starred):
                    assign(node.value, evidence)
                else:
                    name = dotted(node)
                    if not name:
                        # Mutation of an element invalidates the containing result.
                        if isinstance(node, ast.Subscript):
                            values.discard(dotted(node.value))
                        return
                    if isinstance(node, ast.Attribute):
                        values.discard(dotted(node.value))
                    values.discard(name)
                    instances.discard(name)
                    if evidence:
                        values.add(name)
                    if instance:
                        instances.add(name)
                    if isinstance(node, ast.Name):
                        hidden.add(name)

            def statements(nodes, assertions=True):
                for node in nodes:
                    if isinstance(node, (ast.Assign, ast.AnnAssign)):
                        value = node.value
                        evidence = derived(value)
                        instance = bool(owner and isinstance(value, ast.Call) and resolve(value.func, hidden) == root)
                        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                        for dest in targets:
                            # Respect each element's origin for tuple literals.
                            if isinstance(dest, (ast.Tuple, ast.List)) and isinstance(value, (ast.Tuple, ast.List)) and len(dest.elts) == len(value.elts):
                                flags = [derived(item) for item in value.elts]
                                for item, flag in zip(dest.elts, flags):
                                    assign(item, flag)
                            else:
                                assign(dest, evidence, instance)
                    elif isinstance(node, (ast.AugAssign, ast.Delete)):
                        for dest in node.targets if isinstance(node, ast.Delete) else [node.target]:
                            assign(dest, False)
                    elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                        call = node.value
                        if assertions and isinstance(call.func, ast.Attribute) and dotted(call.func.value) == 'self' and call.func.attr.startswith('assert'):
                            # Messages are not tested values; target-vs-target is not an oracle.
                            count = 2 if call.func.attr in ('assertEqual', 'assertNotEqual', 'assertAlmostEqual', 'assertNotAlmostEqual', 'assertIs', 'assertIsNot', 'assertIn', 'assertNotIn', 'assertGreater', 'assertGreaterEqual', 'assertLess', 'assertLessEqual', 'assertSequenceEqual', 'assertListEqual', 'assertTupleEqual', 'assertDictEqual', 'assertCountEqual') else 1
                            flags = [derived(arg) for arg in call.args[:count]]
                            if any(flags) and (count == 1 or not all(flags)):
                                return True
                    elif isinstance(node, ast.Assert) and assertions:
                        if derived(node.test) and not (isinstance(node.test, ast.Compare)
                                and all(derived(item) for item in [node.test.left, *node.test.comparators])):
                            return True
                    elif isinstance(node, (ast.With, ast.AsyncWith)):
                        raises = any(isinstance(item.context_expr, ast.Call) and isinstance(item.context_expr.func, ast.Attribute)
                            and dotted(item.context_expr.func.value) == 'self' and item.context_expr.func.attr in ('assertRaises', 'assertRaisesRegex') for item in node.items)
                        if assertions and raises and any(isinstance(child, ast.Call) and is_target(child.func) for child in ast.walk(node)):
                            return True
                        if statements(node.body, assertions):
                            return True
                    elif isinstance(node, ast.If):
                        # Check assertions within branches, but do not carry uncertain writes out.
                        old = values.copy(), instances.copy(), hidden.copy()
                        for branch in (node.body, node.orelse):
                            values.clear(); values.update(old[0])
                            instances.clear(); instances.update(old[1])
                            hidden.clear(); hidden.update(old[2])
                            if statements(branch, assertions):
                                return True
                        values.clear(); instances.clear()
                    elif isinstance(node, (ast.For, ast.AsyncFor)):
                        assign(node.target, False)
                        if statements(node.body, assertions):
                            return True
                        values.clear(); instances.clear()
                    elif isinstance(node, (ast.Return, ast.Raise, ast.Try, ast.While)):
                        return False
                return False

            for fixture in fixtures:
                statements(fixture.body, False)
            # Fixture instances are useful; assertions must inspect a call made in the test.
            values.clear()
            if statements(method.body):
                return True
    return False
