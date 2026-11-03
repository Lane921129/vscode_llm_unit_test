"""Bounded annotation shapes from source syntax and lexical import bindings.

No target is imported, annotation evaluated, or runtime type hook consulted.
Shapes are input construction hints, never return-value or exception evidence.
"""
import ast
import json

from trace_value_codec import snapshot_value

TYPE_SHAPE_VERSION = 'type-shape-v1'
MAX_DEPTH = 8
MAX_NODES = 128
MAX_MEMBERS = 16
MAX_LITERAL_VALUES = 32
MAX_ANNOTATION_TEXT = 4096

SCALARS = {'int', 'float', 'bool', 'str', 'bytes'}
CONTAINERS = {'list', 'tuple', 'dict', 'set', 'frozenset'}
TYPING_FORMS = {'Literal': 'literal', 'Optional': 'optional', 'Union': 'union',
                'List': 'list', 'Tuple': 'tuple', 'Dict': 'dict', 'Set': 'set', 'FrozenSet': 'frozenset'}
SCOPES = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)


def unknown(reason, name=None):
    result = {'kind': 'unknown', 'reason': reason}
    if name:
        result['name'] = name[:MAX_ANNOTATION_TEXT]
    return result


def _arguments(arguments):
    return (list(arguments.posonlyargs) + list(arguments.args) + list(arguments.kwonlyargs)
            + ([arguments.vararg] if arguments.vararg else [])
            + ([arguments.kwarg] if arguments.kwarg else []))


def _scope_path(tree, target):
    def visit(node, parents):
        if node is target:
            return parents
        next_parents = parents + [node] if isinstance(node, SCOPES) else parents
        for child in ast.iter_child_nodes(node):
            found = visit(child, next_parents)
            if found is not None:
                return found
        return None
    return visit(tree, [])


def _binding_names(node):
    """Names bound in this lexical scope, excluding child callable bodies."""
    names = set()
    class Bindings(ast.NodeVisitor):
        def visit_Name(self, item):
            if isinstance(item.ctx, (ast.Store, ast.Del)):
                names.add(item.id)
        def visit_FunctionDef(self, item):
            names.add(item.name)
        visit_AsyncFunctionDef = visit_FunctionDef
        def visit_ClassDef(self, item):
            names.add(item.name)
        def visit_Lambda(self, item):
            pass
        def visit_Import(self, item):
            names.update(alias.asname or alias.name.split('.')[0] for alias in item.names)
        def visit_ImportFrom(self, item):
            names.update(alias.asname or alias.name for alias in item.names)
        def visit_ExceptHandler(self, item):
            if item.name:
                names.add(item.name)
            self.generic_visit(item)
        def visit_MatchAs(self, item):
            if item.name:
                names.add(item.name)
            self.generic_visit(item)
        def visit_MatchStar(self, item):
            if item.name:
                names.add(item.name)
        def visit_MatchMapping(self, item):
            if item.rest:
                names.add(item.rest)
            self.generic_visit(item)
        def visit_ListComp(self, item):
            # Comprehension targets belong to their implicit scope. Assignment
            # expressions, however, bind in the containing scope.
            for child in ast.walk(item):
                if isinstance(child, ast.NamedExpr):
                    self.visit(child.target)
        visit_SetComp = visit_ListComp
        visit_DictComp = visit_ListComp
        visit_GeneratorExp = visit_ListComp
    Bindings().visit(node)
    return names


def _root_name(node):
    while isinstance(node, (ast.Attribute, ast.Subscript)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def _apply_statement(statement, bindings):
    if isinstance(statement, ast.Import):
        for alias in statement.names:
            name = alias.asname or alias.name.split('.')[0]
            bindings[name] = ('import', alias.name if alias.asname else alias.name.split('.')[0])
        return
    if isinstance(statement, ast.ImportFrom):
        for alias in statement.names:
            name = alias.asname or alias.name
            if alias.name == '*':
                for bound in bindings:
                    bindings[bound] = ('unknown', 'wildcard-binding')
                bindings['*'] = ('unknown', 'wildcard-binding')
            elif statement.module == '__future__':
                continue
            elif not statement.level:
                bindings[name] = ('import', f'{statement.module}.{alias.name}')
            else:
                bindings[name] = ('unknown', 'relative-import')
        return
    if isinstance(statement, ast.ClassDef):
        bindings[statement.name] = ('class', statement.name)
        return
    if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
        bindings[statement.name] = ('unknown', 'shadowed-name')
        return
    if isinstance(statement, ast.AnnAssign) and statement.value is None:
        return  # Module/class annotation-only statements do not bind a value.
    direct = isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.Delete))
    reason = 'shadowed-name' if direct else 'conditional-binding'
    for name in _binding_names(statement):
        bindings[name] = ('unknown', reason)
    if direct:
        targets = statement.targets if isinstance(statement, (ast.Assign, ast.Delete)) else [statement.target]
        for target in targets:
            if isinstance(target, (ast.Attribute, ast.Subscript)):
                name = _root_name(target)
                if name:
                    bindings[name] = ('unknown', 'mutated-type-binding')


def _bindings_at_annotation(tree, target, deferred=False):
    path = _scope_path(tree, target)
    if path is None:
        return {}, 'target-not-in-tree'
    bindings = {name: ('import', 'builtins.' + name) for name in SCALARS | CONTAINERS}
    for index, scope in enumerate(path):
        # A class namespace is visible while its direct method is defined, but
        # is not a closure for nested classes or a method's nested functions.
        if isinstance(scope, ast.ClassDef) and index != len(path) - 1:
            continue
        boundary = path[index + 1] if index + 1 < len(path) else target
        if isinstance(scope, FUNCTIONS):
            for argument in _arguments(scope.args):
                bindings[argument.arg] = ('unknown', 'lexical-shadowing')
            for statement in scope.body:
                for name in _binding_names(statement):
                    bindings[name] = ('unknown', 'lexical-shadowing')
                if isinstance(statement, (ast.Global, ast.Nonlocal)):
                    for name in statement.names:
                        bindings[name] = ('unknown', 'dynamic-closure-binding')
        reached = False
        for statement in scope.body:
            contains = statement is boundary or any(child is boundary for child in ast.walk(statement))
            if contains:
                reached = True
                # Bindings under a conditional scope are not statically certain.
                if statement is not boundary:
                    for name in _binding_names(statement):
                        bindings[name] = ('unknown', 'conditional-binding')
                continue
            if not reached:
                _apply_statement(statement, bindings)
            elif deferred:
                # Quoted/future annotations must not use an import alias whose
                # later rebinding changes its meaning. Do not guess a new type.
                for name in _binding_names(statement):
                    bindings[name] = ('unknown', 'deferred-rebinding')
    # A self-reference denotes a fixture need, even before the class is bound.
    for scope in path:
        if isinstance(scope, ast.ClassDef) and scope.name not in bindings:
            bindings[scope.name] = ('class', scope.name)
    return bindings, None


class _ShapeParser:
    def __init__(self, bindings):
        self.bindings = bindings
        self.remaining = MAX_NODES

    def reference(self, node):
        parts = []
        while isinstance(node, ast.Attribute):
            parts.insert(0, node.attr)
            node = node.value
        if not isinstance(node, ast.Name):
            return unknown('unsupported-expression')
        name = node.id
        binding = self.bindings.get(name)
        if binding is None:
            return unknown('wildcard-binding' if '*' in self.bindings else 'unresolved-name', name)
        kind, value = binding
        if kind == 'unknown':
            return unknown(value, name)
        if kind == 'class':
            return unknown('needs-fixture', '.'.join([name, *parts]))
        canonical = '.'.join([value, *parts])
        if canonical.startswith('builtins.') and canonical.count('.') == 1:
            leaf = canonical.split('.')[1]
            if leaf in SCALARS | CONTAINERS:
                return leaf
        if canonical.startswith(('typing.', 'typing_extensions.')) and canonical.count('.') == 1:
            leaf = canonical.split('.')[1]
            return TYPING_FORMS.get(leaf, unknown('unsupported-typing-form', leaf))
        return unknown('needs-fixture', canonical)

    def union(self, members):
        flattened = []
        seen = set()
        for member in members:
            for shape in member['members'] if member.get('kind') == 'union' else [member]:
                key = json.dumps(shape, sort_keys=True, ensure_ascii=True)
                if key not in seen:
                    seen.add(key)
                    flattened.append(shape)
        if len(flattened) > MAX_MEMBERS:
            return unknown('shape-budget')
        return flattened[0] if len(flattened) == 1 else {'kind': 'union', 'members': flattened}

    def parse(self, node, depth=0):
        self.remaining -= 1
        if depth > MAX_DEPTH or self.remaining < 0:
            return unknown('shape-budget')
        if node is None:
            return unknown('missing-annotation')
        if isinstance(node, ast.Constant):
            if node.value is None:
                return {'kind': 'scalar', 'name': 'none'}
            if type(node.value) is str:
                if len(node.value) > MAX_ANNOTATION_TEXT:
                    return unknown('annotation-text-budget')
                try:
                    return self.parse(ast.parse(node.value, mode='eval').body, depth + 1)
                except (SyntaxError, ValueError, RecursionError):
                    return unknown('invalid-forward-annotation')
            return unknown('unsupported-expression')
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            return self.union([self.parse(node.left, depth + 1), self.parse(node.right, depth + 1)])
        if not isinstance(node, (ast.Name, ast.Attribute, ast.Subscript)):
            return unknown('unsupported-expression')
        subscript = isinstance(node, ast.Subscript)
        form = self.reference(node.value if subscript else node)
        if type(form) is dict:
            return form
        if form in SCALARS:
            return unknown('invalid-type-arguments') if subscript else {'kind': 'scalar', 'name': form}
        if not subscript:
            missing = unknown('missing-type-arguments')
            if form in ('list', 'set', 'frozenset'):
                return {'kind': form, 'element': missing}
            if form == 'dict':
                return {'kind': 'dict', 'key': missing.copy(), 'value': missing.copy()}
            if form == 'tuple':
                return {'kind': 'tuple', 'variadic': True, 'element': missing}
            return missing
        parts = node.slice.elts if isinstance(node.slice, ast.Tuple) else [node.slice]
        if len(parts) > MAX_LITERAL_VALUES:
            return unknown('shape-budget')
        if form == 'literal':
            if not parts:
                return unknown('empty-literal')
            values, seen = [], set()
            for part in parts:
                try:
                    value = ast.literal_eval(part)
                except (ValueError, TypeError, SyntaxError, RecursionError):
                    return unknown('non-literal-value')
                if value is not None and type(value) not in (int, float, bool, str, bytes):
                    return unknown('unsupported-literal-value')
                snapshot = snapshot_value(value)
                if not snapshot['replayable']:
                    return unknown('literal-value-budget')
                key = json.dumps(snapshot, sort_keys=True)
                if key not in seen:
                    seen.add(key)
                    values.append(snapshot)
            return {'kind': 'literal', 'values': values}
        if form in ('optional', 'union'):
            if (form == 'optional' and len(parts) != 1) or (form == 'union' and len(parts) < 2):
                return unknown('invalid-type-arguments')
            members = [self.parse(part, depth + 1) for part in parts]
            if form == 'optional':
                members.append({'kind': 'scalar', 'name': 'none'})
            return self.union(members)
        if form in ('list', 'set', 'frozenset'):
            return {'kind': form, 'element': self.parse(parts[0], depth + 1)} if len(parts) == 1 else unknown('invalid-type-arguments')
        if form == 'dict':
            return {'kind': 'dict', 'key': self.parse(parts[0], depth + 1), 'value': self.parse(parts[1], depth + 1)} \
                if len(parts) == 2 else unknown('invalid-type-arguments')
        if form == 'tuple':
            if len(parts) == 2 and isinstance(parts[1], ast.Constant) and parts[1].value is Ellipsis:
                return {'kind': 'tuple', 'variadic': True, 'element': self.parse(parts[0], depth + 1)}
            if any(isinstance(part, ast.Constant) and part.value is Ellipsis for part in parts):
                return unknown('invalid-type-arguments')
            return {'kind': 'tuple', 'variadic': False, 'elements': [self.parse(part, depth + 1) for part in parts]}
        return unknown('unsupported-expression')


def resolve_annotation_shape(tree, target_node, annotation):
    """Resolve one annotation in its definition scope, never the target body."""
    future = any(isinstance(node, ast.ImportFrom) and node.module == '__future__'
                 and any(alias.name == 'annotations' for alias in node.names) for node in tree.body)
    deferred = future or isinstance(annotation, ast.Constant) and type(annotation.value) is str
    bindings, failure = _bindings_at_annotation(tree, target_node, deferred)
    if failure:
        return unknown(failure)
    return _ShapeParser(bindings).parse(annotation)


def resolve_parameter_shapes(tree, target_node, excluded_names=()):
    """Return name -> shape; the caller decides which bound receiver to omit."""
    excluded = set(excluded_names)
    return {argument.arg: resolve_annotation_shape(tree, target_node, argument.annotation)
            for argument in _arguments(target_node.args) if argument.arg not in excluded}
