"""Compose generated tests from AST structure without importing or executing them.

The executed baseline remains byte-for-byte in its original order. Only exact
duplicate definitions are omitted; conflicting fixtures fail closed. Execution,
preservation and review of the combined file remain the caller's responsibility.
"""
import ast
import copy
import json
import re
import sys


def dump(node):
    return ast.dump(node, include_attributes=False)


def imported_names(node):
    if isinstance(node, ast.Import):
        return {item.asname or item.name.split('.')[0]: ('import', item.name) for item in node.names}
    if isinstance(node, ast.ImportFrom):
        if any(item.name == '*' for item in node.names):
            raise ValueError('wildcard-import')
        return {item.asname or item.name: ('from', node.level, node.module, item.name) for item in node.names}
    return {}


def case_bases(tree):
    bases = set()
    modules = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for item in node.names:
                if item.name == 'unittest':
                    modules.add(item.asname or 'unittest')
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module == 'unittest':
            for item in node.names:
                if item.name in ('TestCase', 'IsolatedAsyncioTestCase'):
                    bases.add(item.asname or item.name)
    for module in modules:
        bases.update((module + '.TestCase', module + '.IsolatedAsyncioTestCase'))
    return bases, modules


def test_class(node, bases):
    return isinstance(node, ast.ClassDef) and len(node.bases) == 1 and ast.unparse(node.bases[0]) in bases


def main_guard(node, modules):
    if not isinstance(node, ast.If) or node.orelse or len(node.body) != 1:
        return False
    check = node.test
    if not (isinstance(check, ast.Compare) and len(check.ops) == 1 and isinstance(check.ops[0], ast.Eq)
            and isinstance(check.left, ast.Name) and check.left.id == '__name__'
            and len(check.comparators) == 1 and isinstance(check.comparators[0], ast.Constant)
            and check.comparators[0].value == '__main__'):
        return False
    call = node.body[0]
    return (isinstance(call, ast.Expr) and isinstance(call.value, ast.Call)
            and isinstance(call.value.func, ast.Attribute) and call.value.func.attr == 'main'
            and isinstance(call.value.func.value, ast.Name) and call.value.func.value.id in modules)


def segment(source, node):
    # Include decorators (get_source_segment(ClassDef) alone omits them).
    start = min([node.lineno] + [item.lineno for item in getattr(node, 'decorator_list', [])])
    return ''.join(source.splitlines(keepends=True)[start - 1:node.end_lineno]).rstrip('\r\n')


def remove_identical_baseline_methods(node, previous):
    """Prune only exact test copies under the exact same class/fixture context."""
    def is_test(item):
        return isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name.startswith('test')
    def fixture(item):
        result = copy.deepcopy(item)
        result.body = [part for part in result.body if not is_test(part)]
        return dump(result)
    if fixture(node) != fixture(previous):
        return
    methods = {item.name: dump(item) for item in previous.body if is_test(item)}
    removed = {item.name for item in node.body if is_test(item) and methods.get(item.name) == dump(item)}
    if not removed:
        return
    if any((isinstance(item, ast.Attribute) and item.attr in removed)
           or (isinstance(item, ast.Name) and item.id in removed)
           or (isinstance(item, ast.Constant) and isinstance(item.value, str) and item.value in removed)
           for item in ast.walk(node)):
        raise ValueError('duplicate-test-reference')
    node.body = [item for item in node.body if not (is_test(item) and item.name in removed)]


def merge(baseline, snippets, stem='TestMergedSuite'):
    try:
        if not isinstance(baseline, str) or not baseline.strip() or not isinstance(snippets, list) \
                or not snippets or len(snippets) > 32 or not all(isinstance(item, str) for item in snippets):
            raise ValueError('invalid-merge-input')
        if len(baseline) + sum(map(len, snippets)) > 2_000_000:
            raise ValueError('merge-input-too-large')
        base_tree = ast.parse(baseline)
        trees = [ast.parse(item) for item in snippets]
        base_cases, base_modules = case_bases(base_tree)
        baseline_classes = {node.name: node for node in base_tree.body if test_class(node, base_cases)}
        if not any(test_class(node, base_cases) for node in base_tree.body):
            raise ValueError('unsupported-baseline-test-class')
        imports = {}
        definitions = {}
        exact = set()
        # Protect all names referenced by baseline methods/fixtures as well as
        # top-level bindings; adding a new import cannot silently rebind them.
        protected = {node.id for node in ast.walk(base_tree) if isinstance(node, ast.Name)}
        reserved = set(protected)
        for tree in [base_tree] + trees:
            reserved.update(node.name for node in ast.walk(tree)
                            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)))
            reserved.update(node.id for node in ast.walk(tree) if isinstance(node, ast.Name))
            for node in tree.body:
                reserved.update(imported_names(node))
        for node in base_tree.body:
            signature = dump(node)
            exact.add(signature)
            for name, meaning in imported_names(node).items():
                if name in definitions or (name in imports and imports[name] != meaning):
                    raise ValueError('baseline-binding-conflict')
                imports[name] = meaning
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name in definitions or node.name in imports:
                    raise ValueError('baseline-binding-conflict')
                definitions[node.name] = signature
        additions = []
        renamed = 0
        for source, tree in zip(snippets, trees):
            bases, modules = case_bases(tree)
            local_definitions = [node.name for node in tree.body
                                 if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))]
            if len(local_definitions) != len(set(local_definitions)):
                raise ValueError('duplicate-snippet-definition')
            for node in tree.body:
                signature = dump(node)
                if signature in exact or main_guard(node, modules):
                    continue
                names = imported_names(node)
                if names:
                    if isinstance(node, ast.ImportFrom) and node.module == '__future__':
                        raise ValueError('conflicting-future-import')
                    if any((name in imports and imports[name] != meaning)
                           or name in definitions or (name in protected and name not in imports)
                           for name, meaning in names.items()):
                        raise ValueError('import-binding-conflict')
                    if all(imports.get(name) == meaning for name, meaning in names.items()):
                        exact.add(signature)
                        continue
                    imports.update(names)
                elif isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                    name = node.name
                    if name in definitions:
                        if not test_class(node, bases):
                            raise ValueError('fixture-definition-conflict')
                        # A different TestCase is independent. Renaming only its
                        # declaration is safe for ordinary self/cls-based tests;
                        # explicit class references and introspection need Writer.
                        if node.decorator_list or any((isinstance(item, ast.Name) and item.id == name)
                               or (isinstance(item, ast.Attribute) and item.attr in ('__name__', '__qualname__', '__class__'))
                               or (isinstance(item, ast.Constant) and isinstance(item.value, str) and name in item.value)
                               for item in ast.walk(tree)):
                            raise ValueError('class-rename-reference')
                        if name in baseline_classes:
                            remove_identical_baseline_methods(node, baseline_classes[name])
                        renamed += 1
                        safe_stem = re.sub(r'\W', '_', stem, flags=re.ASCII) or 'TestMergedSuite'
                        if safe_stem[0].isdigit():
                            safe_stem = 'Test_' + safe_stem
                        new_name = safe_stem + '_Site' + str(renamed)
                        while new_name in reserved:
                            renamed += 1
                            new_name = safe_stem + '_Site' + str(renamed)
                        reserved.add(new_name)
                        node.name = new_name
                        additions.append(ast.unparse(node))
                        definitions[new_name] = signature
                        exact.add(signature)
                        continue
                    if name in imports or name in protected:
                        raise ValueError('fixture-binding-conflict')
                    definitions[name] = signature
                else:
                    # New module assignments/control flow could alter a retained
                    # fixture. Never omit them while pretending to merge a file.
                    raise ValueError('unsupported-module-context')
                additions.append(segment(source, node))
                exact.add(signature)
            protected.update(item.id for item in ast.walk(tree) if isinstance(item, ast.Name))
        guards = [node for node in base_tree.body if main_guard(node, base_modules)]
        if len(guards) > 1:
            raise ValueError('ambiguous-main-guard')
        offset = sum(map(len, baseline.splitlines(keepends=True)[:guards[0].lineno - 1])) if guards else len(baseline)
        inserted = ('\n\n' + '\n\n'.join(additions) + '\n\n') if additions else ''
        merged = baseline[:offset] + inserted + baseline[offset:]
        merged_tree = ast.parse(merged)
        methods = sum(isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) and method.name.startswith('test')
                      for node in merged_tree.body if isinstance(node, ast.ClassDef) for method in node.body)
        return {'schemaVersion': 'baseline-test-merge-v1', 'ok': True,
                'mergedCode': merged, 'totalMethodsCount': methods}
    except (SyntaxError, ValueError, TypeError, RecursionError) as error:
        reason = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[a-z-]+', str(error)) else 'invalid-python-structure'
        return {'schemaVersion': 'baseline-test-merge-v1', 'ok': False, 'reasonCode': reason}


def main():
    try:
        value = json.load(sys.stdin)
        result = merge(value.get('baseline'), value.get('snippets'), value.get('className', 'TestMergedSuite'))
    except (ValueError, AttributeError, RecursionError):
        result = {'schemaVersion': 'baseline-test-merge-v1', 'ok': False, 'reasonCode': 'invalid-merge-input'}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
