"""Compare passed test scenarios without executing either candidate.

This is deliberately a preservation check, not a proof that arbitrary Python
rewrites are equivalent. An AI may append tests/assertions and tighten a numeric
tolerance. Changes that cannot be shown to preserve an executed scenario are
reported explicitly; this helper never manufactures or merges test code.
"""

import ast
import copy
import json
import math
import sys


VERSION = 'passing-test-preservation-v1'
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
FIXTURES = {'setUp', 'tearDown', 'asyncSetUp', 'asyncTearDown',
            'setUpClass', 'tearDownClass', 'setUpModule', 'tearDownModule'}


def result(valid, code=None, method=None, methods=None):
    reasons = {
        'baseline-syntax': 'The retained baseline could not be parsed.',
        'candidate-syntax': 'The candidate could not be parsed.',
        'invalid-protected-methods': 'Passed method identities are absent or ambiguous in the retained baseline.',
        'duplicate-binding': 'A duplicate class, test method or import binding makes preservation ambiguous.',
        'removed-passing-method': 'A passed test was removed or renamed. Keep its original class and method name.',
        'passing-signature-changed': 'A passed test signature, decorator or async form changed.',
        'assertion-weakened': 'A passed assertion was removed, replaced or weakened. Keep its verified expected value and comparison.',
        'passing-scenario-changed': 'A passed scenario changed its inputs, setup or execution steps; equivalence is not established.',
        'fixture-context-changed': 'Shared setup or a helper of a passed scenario changed; preservation is not established.',
        'import-binding-changed': 'An existing import binding changed or a new import shadows a name used by passed tests.',
        'unsupported-preservation': 'The proposed rewrite cannot be established to preserve passed scenarios.',
        'preservation-tool-error': 'The passed-scenario preservation check could not complete.'
    }
    reason = reasons.get(code, '')
    if method:
        reason += ' Method: ' + method + '.'
    if not valid:
        reason += ' Retain the complete passed methods and their shared setup; append a new method for a different scenario. Failing methods remain editable.'
    return {'schemaVersion': VERSION, 'valid': valid, 'reasonCode': code,
            'reason': reason, 'protectedMethods': sorted(methods or [])}


def dump(node):
    return ast.dump(node, include_attributes=False)


def body_without_docstring(body):
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
            and isinstance(body[0].value.value, str):
        return body[1:]
    return body


def normalized(node):
    """Comments, formatting and docstrings do not establish test semantics."""
    node = copy.deepcopy(node)
    for item in ast.walk(node):
        if isinstance(item, (*FUNCTIONS, ast.ClassDef, ast.Module)):
            item.body = body_without_docstring(item.body)
    return node


def names_bound(node):
    if isinstance(node, (ast.ClassDef, *FUNCTIONS)):
        return {node.name}
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return {alias.asname or (alias.name.split('.')[0] if isinstance(node, ast.Import) else alias.name)
                for alias in node.names}
    if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        return {item.id for target in targets for item in ast.walk(target) if isinstance(item, ast.Name)}
    return set()


def loaded_names(node):
    return {item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)}


def attribute_names(node):
    return {item.attr for item in ast.walk(node) if isinstance(item, ast.Attribute)}


def import_bindings(tree):
    found = {}
    for node in tree.body:
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        for alias in node.names:
            binding = alias.asname or (alias.name.split('.')[0] if isinstance(node, ast.Import) else alias.name)
            meaning = ('import', alias.name, alias.asname) if isinstance(node, ast.Import) \
                else ('from', node.level, node.module, alias.name)
            existing = found.get(binding, set())
            package_imports = meaning[0] == 'import' and meaning[2] is None \
                and all(item[0] == 'import' and item[2] is None for item in existing)
            if binding == '*' or existing and meaning not in existing and not package_imports:
                raise ValueError('duplicate-binding')
            found.setdefault(binding, set()).add(meaning)
    return found


def class_methods(tree):
    classes, methods = {}, {}
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        if node.name in classes:
            raise ValueError('duplicate-binding')
        classes[node.name] = node
        seen = set()
        for member in node.body:
            if not isinstance(member, FUNCTIONS):
                continue
            if member.name in seen:
                raise ValueError('duplicate-binding')
            seen.add(member.name)
            if member.name.startswith('test'):
                methods[node.name + '.' + member.name] = member
    return classes, methods


def function_header(node):
    clone = copy.deepcopy(node)
    clone.body = []
    return dump(clone)


def assertion_call(node):
    if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
        call = node.value
        if isinstance(call.func, ast.Attribute) and call.func.attr.startswith('assert'):
            return call
    return None


def finite_literal(node):
    try:
        value = ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return None
    return value if type(value) in (float, int) and math.isfinite(value) else None


def almost_equal_parts(call):
    """Normalize only documented assertAlmostEqual arguments, without eval."""
    if not isinstance(call.func, ast.Attribute) or call.func.attr != 'assertAlmostEqual' \
            or not 2 <= len(call.args) <= 4 or any(keyword.arg is None for keyword in call.keywords):
        return None
    fields = dict(zip(['first', 'second', 'places', 'msg'], call.args))
    for keyword in call.keywords:
        if keyword.arg in fields or keyword.arg not in {'first', 'second', 'places', 'msg', 'delta'}:
            return None
        fields[keyword.arg] = keyword.value
    if not {'first', 'second'} <= fields.keys():
        return None
    if 'delta' in fields:
        if 'places' in fields:
            return None
        value = finite_literal(fields['delta'])
        if value is None or value < 0:
            return None
        tolerance = ('delta', value)
    else:
        value = finite_literal(fields.get('places', ast.Constant(value=7)))
        if value is None or type(value) is not int:
            return None
        tolerance = ('places', value)
    # Even a diagnostic message can be an effectful Python expression. Permit
    # the tolerance change only when every other argument remains unchanged.
    message = dump(fields['msg']) if 'msg' in fields else None
    return dump(call.func.value), dump(fields['first']), dump(fields['second']), message, tolerance


def standard_assertions(tree, class_name):
    """Strengthening rules apply only to a resolvable stdlib unittest harness."""
    modules, direct = set(), set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            modules.update(alias.asname or alias.name for alias in node.names if alias.name == 'unittest')
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module == 'unittest':
            direct.update(alias.asname or alias.name for alias in node.names
                          if alias.name in {'TestCase', 'IsolatedAsyncioTestCase'})
    if any(names_bound(node) & (modules | direct) for node in tree.body
           if not isinstance(node, (ast.Import, ast.ImportFrom))):
        return False
    classes, _ = class_methods(tree)

    def supported(name, seen):
        if name in seen or name not in classes:
            return False
        cls = classes[name]
        if cls.decorator_list or cls.keywords or len(cls.bases) != 1:
            return False
        for member in cls.body:
            if names_bound(member) & {'__getattribute__', '__getattr__', '_type_equality_funcs'} \
                    or any(bound.startswith('assert') for bound in names_bound(member)):
                return False
        base = cls.bases[0]
        if isinstance(base, ast.Name):
            return base.id in direct or supported(base.id, seen | {name})
        return isinstance(base, ast.Attribute) and base.attr in {'TestCase', 'IsolatedAsyncioTestCase'} \
            and isinstance(base.value, ast.Name) and base.value.id in modules

    if not supported(class_name, set()):
        return False
    # Changing dispatch dynamically defeats any local assertion-name proof.
    # Retaining an unchanged call is still allowed; only rewrite rules stop.
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del)) \
                and (node.attr.startswith('assert') or node.attr == '_type_equality_funcs'):
            return False
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in {'setattr', 'delattr'}:
                return False
            if isinstance(node.func, ast.Attribute) and node.func.attr == 'addTypeEqualityFunc':
                return False
            if any(isinstance(argument, ast.Constant) and isinstance(argument.value, str)
                   and argument.value.startswith('assert') for argument in node.args):
                return False
    return True


def assertion_strengthened(left, right):
    if not isinstance(left.func, ast.Attribute) or not isinstance(right.func, ast.Attribute) \
            or dump(left.func.value) != dump(right.func.value):
        return False
    before, after = left.func.attr, right.func.attr
    if before == 'assertEqual':
        expected = left.args[1] if len(left.args) >= 2 else next(
            (keyword.value for keyword in left.keywords if keyword.arg == 'second'), None)
        supported = isinstance(expected, ast.Tuple) and after == 'assertTupleEqual' \
            or isinstance(expected, ast.List) and after == 'assertListEqual' \
            or isinstance(expected, ast.Dict) and after == 'assertDictEqual' \
            or isinstance(expected, ast.Set) and after == 'assertSetEqual' \
            or isinstance(expected, ast.Constant) and isinstance(expected.value, str) and after == 'assertMultiLineEqual'
        if not supported:
            return False
        old_call, new_call = copy.deepcopy(left), copy.deepcopy(right)
        old_call.func.attr = new_call.func.attr = '_same_assertion'
        return dump(old_call) == dump(new_call)
    if before in {'assertTrue', 'assertFalse'} and after == 'assertIs' \
            and len(left.args) in {1, 2} and len(right.args) == len(left.args) + 1:
        return isinstance(right.args[1], ast.Constant) and right.args[1].value is (before == 'assertTrue') \
            and dump(left.args[0]) == dump(right.args[0]) \
            and [dump(node) for node in left.args[1:]] == [dump(node) for node in right.args[2:]] \
            and all(keyword.arg == 'msg' for keyword in left.keywords) \
            and [dump(node) for node in left.keywords] == [dump(node) for node in right.keywords]
    return False


def assertion_preserved(before, after, receiver):
    if dump(before) == dump(after):
        return True
    left, right = assertion_call(before), assertion_call(after)
    if left is None or right is None or receiver is None \
            or not isinstance(left.func.value, ast.Name) or left.func.value.id != receiver:
        return False
    if assertion_strengthened(left, right):
        return True
    old, new = almost_equal_parts(left), almost_equal_parts(right)
    if not old or not new or old[:4] != new[:4] or old[4][0] != new[4][0]:
        return False
    return new[4][1] <= old[4][1] if old[4][0] == 'delta' else new[4][1] >= old[4][1]


def statements_preserved(before, after, receiver=None):
    """Original statements stay in order; new work is appended, not injected."""
    if len(after) < len(before):
        return False, 'assertion-weakened' if any(assertion_call(node) for node in before[len(after):]) \
            else 'passing-scenario-changed'
    for old, new in zip(before, after):
        if dump(old) == dump(new) or assertion_preserved(old, new, receiver):
            continue
        if assertion_call(old) or isinstance(old, ast.Assert):
            return False, 'assertion-weakened'
        # With/loop/branch context must be identical. Appending an assertion
        # inside that same existing scope is safe; moving a scenario is not.
        if type(old) is type(new) and isinstance(old, (ast.With, ast.AsyncWith, ast.If, ast.For, ast.AsyncFor, ast.While)):
            old_shell, new_shell = copy.deepcopy(old), copy.deepcopy(new)
            fields = [field for field in ('body', 'orelse') if hasattr(old, field)]
            for field in fields:
                setattr(old_shell, field, [])
                setattr(new_shell, field, [])
            if dump(old_shell) != dump(new_shell):
                return False, 'assertion-weakened' if isinstance(old, (ast.With, ast.AsyncWith)) \
                    and any(isinstance(node, ast.Attribute) and node.attr.startswith('assertRaises') for node in ast.walk(old)) \
                    else 'passing-scenario-changed'
            for field in fields:
                valid, reason = statements_preserved(getattr(old, field), getattr(new, field), receiver)
                if not valid:
                    return valid, reason
            continue
        return False, 'passing-scenario-changed'
    return True, None


def additional_context(before, after):
    """New independent helpers may be placed anywhere; retained order stays."""
    position, added = 0, []
    for node in after:
        if position < len(before) and dump(node) == dump(before[position]):
            position += 1
        else:
            added.append(node)
    return added if position == len(before) else None


def validate(previous, candidate, protected_methods='all'):
    try:
        old_tree = normalized(ast.parse(previous))
    except (SyntaxError, ValueError, RecursionError):
        return result(False, 'baseline-syntax')
    try:
        new_tree = normalized(ast.parse(candidate))
    except (SyntaxError, ValueError, RecursionError):
        return result(False, 'candidate-syntax')
    try:
        old_classes, old_methods = class_methods(old_tree)
        new_classes, new_methods = class_methods(new_tree)
        if protected_methods == 'all':
            protected = set(old_methods)
            if not protected:
                return result(False, 'invalid-protected-methods')
        elif isinstance(protected_methods, list) and all(isinstance(name, str) for name in protected_methods):
            protected = set(protected_methods)
            if not protected <= old_methods.keys():
                return result(False, 'invalid-protected-methods')
        else:
            return result(False, 'invalid-protected-methods')
        if not protected:
            return result(True)
        for identity in sorted(protected):
            if identity not in new_methods:
                return result(False, 'removed-passing-method', identity, protected)
            before, after = old_methods[identity], new_methods[identity]
            if function_header(before) != function_header(after):
                return result(False, 'passing-signature-changed', identity, protected)
            standard = standard_assertions(old_tree, identity.split('.')[0]) \
                and standard_assertions(new_tree, identity.split('.')[0])
            positional = before.args.posonlyargs + before.args.args
            receiver = positional[0].arg if standard and positional else None
            if receiver and any(isinstance(node, ast.Name) and node.id == receiver and isinstance(node.ctx, (ast.Store, ast.Del))
                                for body in (before, after) for node in ast.walk(body)):
                receiver = None
            valid, reason = statements_preserved(before.body, after.body, receiver)
            if not valid:
                return result(False, reason, identity, protected)

        protected_classes = {name.split('.')[0] for name in protected}
        required_classes = set(protected_classes)
        pending_classes = list(protected_classes)
        while pending_classes:
            parent = pending_classes.pop()
            for dependency in (loaded_names(old_classes[parent]) & old_classes.keys()) - required_classes:
                required_classes.add(dependency)
                pending_classes.append(dependency)
        for name in protected_classes:
            old_class, new_class = old_classes[name], new_classes[name]
            old_header, new_header = copy.deepcopy(old_class), copy.deepcopy(new_class)
            old_header.body, new_header.body = [], []
            if dump(old_header) != dump(new_header):
                return result(False, 'fixture-context-changed', methods=protected)
            old_context = [node for node in old_class.body if not isinstance(node, FUNCTIONS) or not node.name.startswith('test')]
            new_context = [node for node in new_class.body if not isinstance(node, FUNCTIONS) or not node.name.startswith('test')]
            # Existing fixtures/helpers are atomic. New independent helpers are
            # allowed, but cannot override names referenced by retained methods.
            added_context = additional_context(old_context, new_context)
            if added_context is None:
                return result(False, 'fixture-context-changed', methods=protected)
            used = attribute_names(old_class) | FIXTURES | {bound for node in old_class.body for bound in names_bound(node)}
            for node in added_context:
                if not isinstance(node, FUNCTIONS) or node.name in used or node.name.startswith('__'):
                    return result(False, 'fixture-context-changed', methods=protected)

        old_imports, new_imports = import_bindings(old_tree), import_bindings(new_tree)
        if any(not meanings <= new_imports.get(name, set()) for name, meanings in old_imports.items()):
            return result(False, 'import-binding-changed', methods=protected)
        old_names = loaded_names(old_tree) | {name for node in old_tree.body for name in names_bound(node)}
        if (new_imports.keys() - old_imports.keys()) & old_names:
            return result(False, 'import-binding-changed', methods=protected)

        def module_context(tree):
            return [node for node in tree.body if not isinstance(node, (ast.Import, ast.ImportFrom, ast.ClassDef))]
        old_context, new_context = module_context(old_tree), module_context(new_tree)
        added_context = additional_context(old_context, new_context)
        if added_context is None:
            return result(False, 'fixture-context-changed', methods=protected)
        for node in added_context:
            if not isinstance(node, FUNCTIONS) or node.name in old_names or node.name in FIXTURES or node.name.startswith('__'):
                return result(False, 'fixture-context-changed', methods=protected)
        # Non-test classes and referenced TestCase bases can provide fixtures.
        # Only independent unprotected TestCase classes may change their setup.
        for name, old_class in old_classes.items():
            if name not in protected_classes and (name in required_classes
                    or not any(identity.startswith(name + '.') for identity in old_methods)):
                if name not in new_classes or dump(old_class) != dump(new_classes[name]):
                    return result(False, 'fixture-context-changed', methods=protected)
        for name in new_classes.keys() - old_classes.keys():
            if name in old_names:
                return result(False, 'fixture-context-changed', methods=protected)
        return result(True, methods=protected)
    except (ValueError, RecursionError) as error:
        return result(False, str(error) if str(error) == 'duplicate-binding' else 'unsupported-preservation')


def main():
    try:
        value = json.load(sys.stdin)
        if not isinstance(value, dict) or not isinstance(value.get('previous'), str) or not isinstance(value.get('candidate'), str):
            raise ValueError('invalid-input')
        print(json.dumps(validate(value['previous'], value['candidate'], value.get('protectedMethods', 'all')), ensure_ascii=True))
    except Exception:
        print(json.dumps(result(False, 'preservation-tool-error')))


if __name__ == '__main__':
    main()
