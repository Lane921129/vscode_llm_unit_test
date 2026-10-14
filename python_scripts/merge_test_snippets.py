"""Compose generated tests from AST structure without importing or executing them.

The executed baseline remains byte-for-byte in its original order. Only exact
duplicate definitions are omitted; conflicting fixtures fail closed. Execution,
preservation and review of the combined file remain the caller's responsibility.
"""
import ast
import copy
import hashlib
import json
import re
import sys
import textwrap


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


def merge_addition(baseline, addition):
    """Attach new methods without rewriting the executed baseline.

    Accepted shapes are imports plus TestCase classes, or complete top-level
    test methods for an unambiguous single baseline class. This function only
    parses AST; it never imports, evaluates decorators or executes either file.
    """
    schema = 'writer-test-addition-v1'
    try:
        if not isinstance(baseline, str) or not baseline.strip() or not isinstance(addition, str) or not addition.strip():
            raise ValueError('invalid-addition-input')
        if len(baseline) + len(addition) > 2_000_000:
            raise ValueError('merge-input-too-large')
        base_tree = ast.parse(baseline)
        try:
            tree = ast.parse(addition)
        except IndentationError:
            # Parse the entire indented block beneath a known AST-only wrapper.
            # Dedenting text could change spaces inside a multiline string.
            addition = 'if True:\n' + addition
            wrapped = ast.parse(addition)
            if len(wrapped.body) != 1 or not isinstance(wrapped.body[0], ast.If) or wrapped.body[0].orelse:
                raise ValueError('unsupported-addition-context')
            tree = ast.Module(body=wrapped.body[0].body, type_ignores=[])
        base_bases, base_modules = case_bases(base_tree)
        extra_bases, extra_modules = case_bases(tree)
        bases = base_bases | extra_bases
        modules = base_modules | extra_modules
        base_classes = {node.name: node for node in base_tree.body if test_class(node, base_bases)}
        if not base_classes:
            raise ValueError('unsupported-baseline-test-class')
        is_method = lambda node: isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        is_test = lambda node: is_method(node) and node.name.startswith('test')
        imports, definitions = {}, {}
        exact = {dump(node) for node in base_tree.body}
        protected = {node.id for node in ast.walk(base_tree) if isinstance(node, ast.Name)}
        for node in base_tree.body:
            for name, meaning in imported_names(node).items():
                if name in definitions or name in imports and imports[name] != meaning:
                    raise ValueError('baseline-binding-conflict')
                imports[name] = meaning
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name in definitions or node.name in imports:
                    raise ValueError('baseline-binding-conflict')
                definitions[node.name] = node
        for node in base_classes.values():
            names = [item.name for item in node.body if is_method(item)]
            if len(names) != len(set(names)):
                raise ValueError('baseline-binding-conflict')
        declarations = [node.name for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))]
        if len(declarations) != len(set(declarations)):
            raise ValueError('duplicate-addition-definition')
        lines = baseline.splitlines(keepends=True)
        newline = '\r\n' if '\r\n' in baseline else '\n'
        edits, new_imports, new_classes, added = {}, [], [], []

        def insert(offset, value):
            edits[offset] = edits.get(offset, '') + value

        def method_names(node):
            names = [part.name for part in node.body if is_method(part)]
            if len(names) != len(set(names)):
                raise ValueError('duplicate-test-method')
            assigned = [name.id for part in node.body if isinstance(part, (ast.Assign, ast.AnnAssign))
                        for target in (part.targets if isinstance(part, ast.Assign) else [part.target])
                        for name in ast.walk(target) if isinstance(name, ast.Name)]
            if any(name in assigned for name in names if name.startswith('test')):
                raise ValueError('duplicate-test-method')
            return {part.name: part for part in node.body if is_method(part)}

        def attach(previous, candidates):
            old = method_names(previous)
            bound = {name.id for part in previous.body if isinstance(part, (ast.Assign, ast.AnnAssign))
                     for target in (part.targets if isinstance(part, ast.Assign) else [part.target])
                     for name in ast.walk(target) if isinstance(name, ast.Name)}
            fresh = []
            for method in candidates:
                if method.name in old:
                    if dump(method) != dump(old[method.name]):
                        raise ValueError('existing-test-method-changed')
                    continue
                if method.name in bound:
                    raise ValueError('fixture-binding-conflict')
                if method.name in {item['name'] for item in added if item['className'] == previous.name}:
                    raise ValueError('duplicate-test-method')
                fresh.append(method)
                added.append({'className': previous.name, 'name': method.name})
            if not fresh:
                return
            # Do not guess the indentation of an inline class body.
            if previous.body[0].lineno == previous.lineno:
                raise ValueError('unsupported-baseline-test-class')
            indent = lines[previous.body[0].lineno - 1][:previous.body[0].col_offset]
            blocks = []
            for method in fresh:
                # Reformat only the new AST, preserving string literal values.
                source = ast.unparse(method)
                blocks.append(textwrap.indent(source, indent).replace('\r\n', '\n').replace('\n', newline))
            offset = sum(map(len, lines[:previous.end_lineno]))
            insert(offset, newline + (newline + newline).join(blocks) + newline)

        for node in tree.body:
            signature = dump(node)
            if signature in exact or main_guard(node, modules):
                continue
            names = imported_names(node)
            if names:
                if isinstance(node, ast.ImportFrom) and node.module == '__future__':
                    raise ValueError('conflicting-future-import')
                if any(name in definitions or name in imports and imports[name] != meaning
                       or name in protected and name not in imports for name, meaning in names.items()):
                    raise ValueError('import-binding-conflict')
                if not all(imports.get(name) == meaning for name, meaning in names.items()):
                    new_imports.append(segment(addition, node))
                    imports.update(names)
            elif isinstance(node, ast.ClassDef):
                if not test_class(node, bases):
                    raise ValueError('unsupported-test-class')
                method_names(node)
                if node.name in base_classes:
                    previous = base_classes[node.name]
                    old_header, new_header = copy.deepcopy(previous), copy.deepcopy(node)
                    old_header.body, new_header.body = [], []
                    if dump(old_header) != dump(new_header):
                        raise ValueError('class-header-conflict')
                    previous_context = {dump(part) for part in previous.body if not is_test(part)}
                    for part in node.body:
                        if not is_test(part) and dump(part) not in previous_context:
                            raise ValueError('fixture-definition-conflict')
                    attach(previous, [part for part in node.body if is_test(part)])
                else:
                    if node.name in definitions or node.name in imports or node.name in protected:
                        raise ValueError('fixture-binding-conflict')
                    tests = [part for part in node.body if is_test(part)]
                    if not tests:
                        raise ValueError('unsupported-addition-context')
                    added.extend({'className': node.name, 'name': part.name} for part in tests)
                    definitions[node.name] = node
                    new_classes.append(segment(addition, node))
            elif is_test(node):
                if len(base_classes) != 1:
                    raise ValueError('ambiguous-addition-target')
                attach(next(iter(base_classes.values())), [node])
            else:
                raise ValueError('unsupported-addition-context')
        if len(added) > 32:
            raise ValueError('too-many-additional-methods')
        if new_imports:
            prefix = 0
            for index, node in enumerate(base_tree.body):
                is_docstring = index == 0 and isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
                if is_docstring or isinstance(node, ast.ImportFrom) and node.module == '__future__':
                    prefix = sum(map(len, lines[:node.end_lineno]))
                else:
                    break
            insert(prefix, (newline if prefix and not baseline[:prefix].endswith(('\n', '\r')) else '')
                   + newline.join(new_imports).replace('\r\n', '\n').replace('\n', newline) + newline)
        if new_classes:
            guards = [node for node in base_tree.body if main_guard(node, base_modules)]
            if len(guards) > 1:
                raise ValueError('ambiguous-main-guard')
            offset = sum(map(len, lines[:guards[0].lineno - 1])) if guards else len(baseline)
            insert(offset, newline + newline + (newline + newline).join(new_classes).replace('\r\n', '\n').replace('\n', newline) + newline + newline)
        merged = baseline
        for offset in sorted(edits, reverse=True):
            merged = merged[:offset] + edits[offset] + merged[offset:]
        merged_tree = ast.parse(merged)
        methods = sum(is_test(method) for node in merged_tree.body if isinstance(node, ast.ClassDef) for method in node.body)
        return {'schemaVersion': schema, 'ok': True, 'mergedCode': merged, 'totalMethodsCount': methods,
                'addedMethodsCount': len(added), 'addedMethods': added}
    except (SyntaxError, ValueError, TypeError, RecursionError) as error:
        reason = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[a-z-]+', str(error)) else 'invalid-python-structure'
        return {'schemaVersion': schema, 'ok': False, 'reasonCode': reason}


def project_addition_context(baseline):
    """Project only proven fixture-free unittest setup; never a runnable candidate.

    Removing method bodies is safe for this prompt-only view because the host
    still owns the original bytes and merges additions into that original file.
    Any context that could require fixtures or reflection retains the full view.
    """
    schema = 'writer-addition-context-v1'

    def reject(reason):
        return {'schemaVersion': schema, 'ok': False, 'reasonCode': reason}

    if not isinstance(baseline, str) or not baseline.strip() or len(baseline.encode('utf-8')) > 1024 * 1024:
        return reject('invalid-baseline-input')
    try:
        tree = ast.parse(baseline)
    except (SyntaxError, ValueError, RecursionError):
        return reject('invalid-python-structure')
    if sum(1 for _ in ast.walk(tree)) > 20000:
        return reject('addition-context-unsupported')

    imports = []
    bindings = {}
    test_node = None
    known_modules = set()
    known_cases = set()
    saw_main = False
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if test_node is not None or saw_main:
                return reject('addition-context-unsupported')
            try:
                names = imported_names(node)
            except ValueError:
                return reject('addition-context-unsupported')
            if any(name in bindings and bindings[name] != identity for name, identity in names.items()):
                return reject('addition-context-unsupported')
            # imported_names alone loses duplicate aliases within one statement.
            local_names = [item.asname or (item.name.split('.')[0] if isinstance(node, ast.Import) else item.name)
                           for item in node.names]
            if len(local_names) != len(set(local_names)):
                return reject('addition-context-unsupported')
            bindings.update(names)
            imports.append(node)
            if isinstance(node, ast.Import):
                known_modules.update(item.asname or 'unittest' for item in node.names if item.name == 'unittest')
            elif node.level == 0 and node.module == 'unittest':
                known_cases.update(item.asname or item.name for item in node.names if item.name == 'TestCase')
            continue
        if isinstance(node, ast.ClassDef):
            if test_node is not None:
                return reject('addition-context-unsupported')
            if saw_main or node.name in bindings or node.decorator_list or node.keywords or getattr(node, 'type_params', []):
                return reject('addition-context-unsupported')
            allowed_bases = known_cases | {name + '.TestCase' for name in known_modules}
            if len(node.bases) != 1 or ast.unparse(node.bases[0]) not in allowed_bases:
                return reject('addition-context-unsupported')
            test_node = node
            continue
        if test_node is not None and not saw_main and main_guard(node, known_modules):
            call = node.body[0].value
            if call.args or call.keywords:
                return reject('addition-context-unsupported')
            saw_main = True
            continue
        return reject('addition-context-unsupported')
    if test_node is None or not 1 <= len(test_node.body) <= 256:
        return reject('addition-context-unsupported')

    method_names = []
    for node in test_node.body:
        if not isinstance(node, ast.FunctionDef) or not node.name.startswith('test_') or len(node.name) <= 5:
            return reject('addition-context-unsupported')
        args = node.args
        if (node.decorator_list or node.returns or getattr(node, 'type_params', []) or args.posonlyargs
                or len(args.args) != 1 or args.args[0].arg != 'self' or args.args[0].annotation
                or args.vararg or args.kwarg or args.kwonlyargs or args.defaults or args.kw_defaults):
            return reject('addition-context-unsupported')
        if node.name in method_names:
            return reject('addition-context-unsupported')
        method_names.append(node.name)
    reflective_names = {'getattr', 'setattr', 'delattr', 'globals', 'locals', 'vars', 'eval', 'exec',
                        '__import__', 'compile'}
    fixture_names = {'patch', 'Mock', 'MagicMock', 'AsyncMock', 'PropertyMock', 'create_autospec', 'mock_open'}
    reflective_names.update(name for name, identity in bindings.items()
                            if identity[0] == 'from' and identity[1:3] == (0, 'builtins') and identity[3] in reflective_names)
    fixture_names.update(name for name, identity in bindings.items()
                         if identity[0] == 'from' and identity[1:3] == (0, 'unittest.mock') and identity[3] in fixture_names)
    reflective_attrs = {'__dict__', '__class__', '__getattribute__', '__getattr__', '__setattr__',
                        '__subclasses__', '__bases__', '__mro__', '__code__', '__globals__', '__closure__'}
    blocked_names = reflective_names | fixture_names | set(method_names) | {test_node.name}
    blocked_attrs = reflective_attrs | reflective_names | fixture_names | set(method_names)
    for method in test_node.body:
        for node in ast.walk(method):
            if ((isinstance(node, (ast.Global, ast.Nonlocal, ast.ClassDef, ast.AsyncFunctionDef)))
                    or (isinstance(node, ast.FunctionDef) and node is not method)
                    or (isinstance(node, ast.Name) and node.id in blocked_names)
                    or (isinstance(node, ast.Attribute) and node.attr in blocked_attrs)):
                return reject('addition-context-unsupported')
            if isinstance(node, (ast.Attribute, ast.Subscript)) and isinstance(node.ctx, (ast.Store, ast.Del)):
                owner = node.value
                while isinstance(owner, (ast.Attribute, ast.Subscript)):
                    owner = owner.value
                if isinstance(owner, ast.Name) and owner.id in bindings:
                    return reject('addition-context-unsupported')

    projected_class = copy.deepcopy(test_node)
    projected_class.body = [ast.Pass()]
    projected = ast.Module(body=[*copy.deepcopy(imports), projected_class], type_ignores=[])
    ast.fix_missing_locations(projected)
    return {'schemaVersion': schema, 'ok': True, 'contextCode': ast.unparse(projected) + '\n',
            'methodIds': [test_node.name + '.' + name for name in method_names],
            'baselineHash': hashlib.sha256(baseline.encode('utf-8')).hexdigest()}


def main():
    try:
        value = json.loads(sys.stdin.buffer.read().decode('utf-8'))
        if value.get('mode') == 'writer-addition-context-v1':
            result = project_addition_context(value.get('baseline'))
        elif value.get('mode') == 'writer-addition-v1':
            result = merge_addition(value.get('baseline'), value.get('addition'))
        else:
            result = merge(value.get('baseline'), value.get('snippets'), value.get('className', 'TestMergedSuite'))
    except (ValueError, AttributeError, RecursionError):
        result = {'schemaVersion': 'baseline-test-merge-v1', 'ok': False, 'reasonCode': 'invalid-merge-input'}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
