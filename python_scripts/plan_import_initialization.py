"""Bounded, source-only proposals for import initialization.

No selected module, dependency, annotation, or expression is executed. ``complete``
means the static source closure was scanned, not that arbitrary Python startup
behavior has been discovered. External callable identity still needs validation
by ImportFixtures after approval. Resource names are lexical: never stat them.
"""
import ast
from collections import deque
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import PurePath
import re
import stat
import sys

from isolated_resources import (
    _external_path, _relative_path, _unsafe_raw_components,
    absolute, external_resource_identity, inside, is_unc_or_device,
    unc_resource_identity,
)

MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_FILES = 64
MAX_CANDIDATES = 256
MAX_AST_NODES = 100000
MAX_IMPORTS = 1024
MAX_REQUEST_BYTES = 128 * 1024
MAX_DIAGNOSTICS = 256
DIAGNOSTIC_REASONS = frozenset({
    'invalid-request', 'invalid-root', 'invalid-source', 'source-outside-root',
    'source-link', 'source-unreadable', 'source-too-large', 'source-syntax-error',
    'source-ast-limit', 'file-limit', 'candidate-limit', 'import-limit',
    'unresolved-local-import', 'diagnostic-limit', 'dynamic-directory',
})
_OPERATION = re.compile(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+')
_MATCH_CAPTURE = tuple(getattr(ast, name) for name in ('MatchAs', 'MatchStar') if hasattr(ast, name))
_MATCH_MAPPING = getattr(ast, 'MatchMapping', ())


@dataclass(frozen=True)
class _Value:
    kind: str
    value: object


def _parts(node):
    result = []
    while isinstance(node, ast.Attribute):
        result.append(node.attr)
        node = node.value
    return [node.id] + result[::-1] if isinstance(node, ast.Name) else None


def _definition_nodes(node):
    """Ignore deferred function bodies, but include defaults and annotations."""
    pending = [node]
    while pending:
        current = pending.pop()
        yield current
        for field, value in ast.iter_fields(current):
            if field == 'body' and isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                continue
            pending.extend(child for child in (value if isinstance(value, list) else [value])
                           if isinstance(child, ast.AST))


def _resource(root, raw):
    """Mirror logical_resource_path's scope checks without its resource lstat.

    Only the pure validators/identities are shared. In particular, calling
    logical_resource_path here would inspect the original resource's ancestors.
    """
    try:
        spelling = raw.replace('\\', '/') if os.name == 'nt' else raw
        if is_unc_or_device(raw):
            path = unc_resource_identity(spelling)
            if inside(path, root) or inside(root, path):
                return None
            return {'resourcePath': path, 'resourceScope': 'unc-virtual'}
        if (_unsafe_raw_components(raw) or any(part == '..' for part in spelling.split('/'))
                or os.name == 'nt' and (os.path.splitdrive(raw)[0] and not os.path.isabs(raw)
                    or spelling.startswith('/') or os.path.isabs(raw) and not re.match(r'^[A-Za-z]:/', spelling))):
            return None
        lexical = absolute(raw if os.path.isabs(raw) else os.path.join(root, raw))
        parent = os.path.dirname(root)
        if inside(lexical, root):
            path = _relative_path(os.path.relpath(lexical, root).replace('\\', '/'))
            result = {'resourcePath': path}
        elif inside(lexical, parent):
            if inside(root, lexical):
                return None
            path = _relative_path(os.path.relpath(lexical, parent).replace('\\', '/'))
            result = {'resourcePath': path, 'resourceScope': 'project-parent'}
        else:
            path = _external_path(external_resource_identity(lexical))
            if inside(root, lexical):
                return None
            result = {'resourcePath': path, 'resourceScope': 'external-exact'}
        if any(part.lower().endswith(('.py', '.pyc', '.pyo', '.pyd', '.dll', '.so'))
               for part in path.split('/')):
            return None
        return result
    except (ValueError, TypeError, OSError):
        return None


class _Planner:
    def __init__(self, root):
        self.root = root
        self.result = {'schemaVersion': 'import-initialization-plan-v1',
                       'sources': [], 'candidates': [], 'diagnostics': [], 'complete': True}
        self.queue = deque()
        self.enqueued = set()
        self.metadata = {}
        self.import_count = 0

    def fail(self, reason, file='.', line=None, fatal=True):
        assert reason in DIAGNOSTIC_REASONS
        if fatal:
            self.result['complete'] = False
        if len(self.result['diagnostics']) >= MAX_DIAGNOSTICS - 1:
            self.result['complete'] = False
            if len(self.result['diagnostics']) < MAX_DIAGNOSTICS:
                self.result['diagnostics'].append({'file': '.', 'reason': 'diagnostic-limit'})
            return
        item = {'file': file or '.', 'reason': reason}
        if line is not None:
            item['line'] = line
        if item not in self.result['diagnostics']:
            self.result['diagnostics'].append(item)

    def relative(self, path):
        return os.path.relpath(path, self.root).replace('\\', '/')

    def kind(self, path, owner=''):
        """Inspect source paths from the anchor down, never crossing a link."""
        path = absolute(path)
        if is_unc_or_device(path):
            self.fail('source-link', owner)
            return 'blocked'
        if path in self.metadata:
            return self.metadata[path]
        chain = []
        current = path
        while current not in self.metadata:
            chain.append(current)
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
        if current in self.metadata and self.metadata[current] != 'directory':
            return self.metadata[current]
        for item in reversed(chain):
            try:
                info = os.lstat(item)
            except (FileNotFoundError, NotADirectoryError):
                self.metadata[item] = 'missing'
                return 'missing'
            except OSError:
                self.fail('source-unreadable', owner)
                self.metadata[item] = 'blocked'
                return 'blocked'
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 1024:
                self.fail('source-link', owner)
                self.metadata[item] = 'blocked'
                return 'blocked'
            kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'blocked'
            self.metadata[item] = kind
            if item != path and kind != 'directory':
                return 'missing'
        return self.metadata[path]

    def enqueue(self, path, owner=''):
        path = absolute(path)
        if path in self.enqueued:
            return
        if len(self.enqueued) >= MAX_FILES:
            self.fail('file-limit', owner)
            return
        self.enqueued.add(path)
        self.queue.append(path)

    def local_module(self, base, parts, owner):
        """Find .py modules and package initializers without import machinery."""
        current, found, local = base, [], False
        for index, part in enumerate(parts):
            current = os.path.join(current, part)
            directory = self.kind(current, owner)
            module = self.kind(current + '.py', owner)
            if 'blocked' in (directory, module):
                return 'blocked', found
            if directory == 'directory':
                initializer = os.path.join(current, '__init__.py')
                initial_kind = self.kind(initializer, owner)
                if initial_kind == 'blocked':
                    return 'blocked', found
                if initial_kind == 'file':
                    found.append(initializer)
                # A regular package precedes a same-named module. A namespace
                # directory does not: Python chooses the concrete module.
                if initial_kind != 'file' and module == 'file':
                    found.append(current + '.py')
                    return ('local' if index == len(parts) - 1 else 'unresolved'), found
                local = True
            elif module == 'file':
                found.append(current + '.py')
                return ('local' if index == len(parts) - 1 else 'unresolved'), found
            else:
                return ('unresolved' if local else 'external'), found
        return ('local' if local else 'external'), found

    def resolve_import(self, node, file):
        owner = self.relative(file)
        self.import_count += 1
        if self.import_count > MAX_IMPORTS:
            self.fail('import-limit', owner, node.lineno)
            return {}
        relative = isinstance(node, ast.ImportFrom) and node.level
        base = os.path.dirname(file)
        if relative:
            for _ in range(node.level - 1):
                base = os.path.dirname(base)
            if not inside(base, self.root):
                self.fail('unresolved-local-import', owner, node.lineno)
                return {}
        if relative:
            bases = [base]
        else:
            # Match the guarded preflight's parent, grandparent, great-
            # grandparent, root order, without following that search outside
            # the approved source root or into its runtime report directory.
            bases = []
            anchor = os.path.dirname(file)
            for _ in range(3):
                if inside(anchor, self.root):
                    bases.append(anchor)
                anchor = os.path.dirname(anchor)
            bases = list(dict.fromkeys([*bases, self.root]))
        names = [item.name for item in node.names] if isinstance(node, ast.Import) else [node.module or '']
        bindings = {}
        for name in names:
            resolutions = [self.local_module(anchor, name.split('.') if name else [], owner) for anchor in bases]
            if relative and not name:
                resolutions = [('local', [])]
            # Workers put the selected file's directory first. Retain both
            # known local source closures when that directory and root contain
            # the same name; neither binding is an external startup entry.
            if (not any(status == 'local' for status, _ in resolutions)
                    and (any(status == 'unresolved' for status, _ in resolutions)
                         or relative and name and all(status == 'external' for status, _ in resolutions))):
                self.fail('unresolved-local-import', owner, node.lineno)
            status = 'external' if all(status == 'external' for status, _ in resolutions) and not relative else 'local'
            bindings[name] = status
            for _, paths in resolutions:
                for path in paths:
                    self.enqueue(path, owner)
            if isinstance(node, ast.ImportFrom) and status == 'local':
                for item in node.names:
                    if item.name == '*':
                        continue
                    child = (name.split('.') if name else []) + [item.name]
                    for anchor in bases:
                        _, paths = self.local_module(anchor, child, owner)
                        for path in paths:
                            self.enqueue(path, owner)
        return bindings

    def value(self, node, env, file, depth=0):
        if depth > 40:
            return None
        def read(child):
            return self.value(child, env, file, depth + 1)
        if isinstance(node, ast.Name):
            return env.get(node.id)
        if isinstance(node, ast.Constant) and type(node.value) in (str, int, bool, float, type(None)):
            if type(node.value) is str and len(node.value) > 4096:
                return None
            return _Value('literal', node.value)
        if isinstance(node, ast.BinOp):
            left, right = read(node.left), read(node.right)
            if not left or not right:
                return None
            if isinstance(node.op, ast.Add) and left.kind == right.kind == 'literal' and type(left.value) is type(right.value) is str:
                joined = left.value + right.value
                return _Value('literal', joined) if len(joined) <= 4096 else None
            if isinstance(node.op, ast.Div) and left.kind == 'path' and right.kind == 'literal' and type(right.value) is str:
                if _unsafe_raw_components(right.value) or '..' in right.value.replace('\\', '/').split('/'):
                    return None
                return _Value('path', os.fspath(PurePath(left.value) / right.value))
        if isinstance(node, ast.Attribute):
            base = read(node.value)
            if base and base.kind == 'path-module' and node.attr == 'Path':
                return _Value('path-constructor', None)
            if base and base.kind == 'path' and node.attr == 'parent':
                return _Value('path', os.fspath(PurePath(base.value).parent))
        if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute)
                and node.value.attr == 'parents' and isinstance(node.slice, ast.Constant)
                and type(node.slice.value) is int and 0 <= node.slice.value <= 64):
            base = read(node.value.value)
            if base and base.kind == 'path':
                try:
                    return _Value('path', os.fspath(PurePath(base.value).parents[node.slice.value]))
                except IndexError:
                    return None
        if isinstance(node, ast.Call):
            function = read(node.func)
            if function and function.kind == 'path-constructor' and 1 <= len(node.args) <= 16 and not node.keywords:
                values = [read(arg) for arg in node.args]
                if any(value is None or value.kind not in ('literal', 'path', 'file')
                       or type(value.value) is not str or _unsafe_raw_components(value.value)
                       or '..' in value.value.replace('\\', '/').split('/') for value in values):
                    return None
                return _Value('path', os.fspath(PurePath(*(value.value for value in values))))
            if isinstance(node.func, ast.Attribute) and node.func.attr == 'resolve' and not node.args and not node.keywords:
                base = read(node.func.value)
                # Only __file__ and its verified source ancestors have known
                # link-free semantics. Never resolve/stat a resource name.
                if base and base.kind == 'path' and os.path.isabs(base.value) and inside(file, absolute(base.value)):
                    return _Value('path', absolute(base.value))
        return None

    def invalidate_aliases(self, name, env):
        binding = env.get(name)
        if binding and binding.kind in ('path-module', 'path-constructor'):
            for alias in list(env):
                if env[alias].kind in ('path-module', 'path-constructor', 'path'):
                    env.pop(alias)
        elif binding and binding.kind == 'external':
            module = binding.value.split('.')[0]
            for alias in list(env):
                if env[alias].kind == 'external' and env[alias].value.split('.')[0] == module:
                    env.pop(alias)
        env.pop(name, None)

    def invalidate(self, node, env):
        for child in _definition_nodes(node):
            if isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del)):
                env.pop(child.id, None)
            elif isinstance(child, (ast.Attribute, ast.Subscript)) and isinstance(child.ctx, (ast.Store, ast.Del)):
                target = child
                while isinstance(target, (ast.Attribute, ast.Subscript)):
                    target = target.value
                if isinstance(target, ast.Name):
                    self.invalidate_aliases(target.id, env)
            elif isinstance(child, _MATCH_CAPTURE) and child.name:
                env.pop(child.name, None)
            elif isinstance(child, _MATCH_MAPPING) and child.rest:
                env.pop(child.rest, None)
            elif isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
                if child.func.id in ('exec', 'eval', 'globals', 'locals'):
                    env.clear()
                elif child.func.id in ('setattr', 'delattr', 'vars') and child.args and isinstance(child.args[0], ast.Name):
                    self.invalidate_aliases(child.args[0].id, env)
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                env.pop(child.name, None)
            elif isinstance(child, (ast.Import, ast.ImportFrom)):
                for item in child.names:
                    if item.name == '*':
                        env.clear()
                    else:
                        env.pop(item.asname or item.name.split('.')[0], None)
            elif isinstance(child, ast.ExceptHandler) and child.name:
                env.pop(child.name, None)

    def arguments_safe(self, node, env):
        if isinstance(node, ast.Name):
            return env.get(node.id, _Value('', None)).kind in ('literal', 'callback')
        if isinstance(node, ast.Constant):
            return type(node.value) in (str, int, float, bool, type(None))
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return all(self.arguments_safe(item, env) for item in node.elts)
        if isinstance(node, ast.Dict):
            return all(key is not None and self.arguments_safe(key, env) and self.arguments_safe(value, env)
                       for key, value in zip(node.keys, node.values))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            return isinstance(node.operand, ast.Constant) and type(node.operand.value) in (int, float)
        return False

    def candidate(self, call, env, file, digest):
        result = None
        if isinstance(call.func, ast.Attribute) and call.func.attr == 'mkdir':
            receiver = self.value(call.func.value, env, file)
            kwargs = {item.arg: item.value for item in call.keywords}
            supported_arguments = (not call.args and len(kwargs) == len(call.keywords)
                    and set(kwargs) <= {'mode', 'parents', 'exist_ok'}
                    and isinstance(kwargs.get('exist_ok'), ast.Constant) and kwargs['exist_ok'].value is True
                    and all(isinstance(value, ast.Constant) and (type(value.value) is bool if key != 'mode'
                        else type(value.value) is int and 0 <= value.value <= 0o7777) for key, value in kwargs.items()))
            if supported_arguments and receiver is None:
                # This is an unknown receiver, not evidence that it is pathlib.
                # The host may use its existing guarded runtime observation;
                # the static planner itself never executes a fallback import.
                self.fail('dynamic-directory', self.relative(file), call.lineno, fatal=False)
            if supported_arguments and receiver and receiver.kind == 'path':
                resource = _resource(self.root, receiver.value)
                if resource:
                    result = {'kind': 'mkdir', 'operation': 'pathlib.Path.mkdir', **resource}
        else:
            parts = _parts(call.func)
            binding = env.get(parts[0]) if parts else None
            if binding and binding.kind == 'external':
                operation = '.'.join([binding.value, *parts[1:]])
                arguments = list(call.args) + [keyword.value for keyword in call.keywords]
                callback = any(isinstance(arg, ast.Name) and env.get(arg.id, _Value('', None)).kind == 'callback'
                               for arg in arguments)
                # Capitalized imported symbols are potential constructors.
                # Lowercase symbols remain provisional until runtime validation.
                if (_OPERATION.fullmatch(operation) and operation.rsplit('.', 1)[1][:1].islower()
                        and callback and all(keyword.arg is not None for keyword in call.keywords)
                        and all(self.arguments_safe(arg, env) for arg in arguments)):
                    result = {'kind': 'entry-point', 'operation': operation}
        if result:
            if len(self.result['candidates']) >= MAX_CANDIDATES:
                self.fail('candidate-limit', self.relative(file), call.lineno)
                return True
            self.result['candidates'].append({
                'schemaVersion': 'import-initialization-candidate-v1', **result,
                'file': self.relative(file), 'line': call.lineno, 'sourceHash': digest,
                'evidence': 'static-direct-module-call', 'returnValue': 'discarded',
            })
            return True
        return False

    def scan(self, tree, file, digest, imports):
        env = {'__file__': _Value('file', file)}
        line_counts = {}
        for statement in tree.body:
            line_counts[statement.lineno] = line_counts.get(statement.lineno, 0) + 1
        for statement in tree.body:
            if isinstance(statement, (ast.Import, ast.ImportFrom)):
                statuses = imports.get(id(statement), {})
                for item in statement.names:
                    if item.name == '*':
                        env.clear()
                        continue
                    name = item.asname or (item.name.split('.')[0] if isinstance(statement, ast.Import) else item.name)
                    env.pop(name, None)
                    module = item.name if isinstance(statement, ast.Import) else statement.module
                    if statuses.get(module or '') != 'external':
                        continue
                    if isinstance(statement, ast.Import):
                        imported = module if item.asname else module.split('.')[0]
                        env[name] = _Value('path-module' if imported == 'pathlib' else 'external', imported)
                    else:
                        env[name] = _Value('path-constructor', None) if module == 'pathlib' and item.name == 'Path' else _Value('external', module + '.' + item.name)
            elif isinstance(statement, (ast.Assign, ast.AnnAssign)):
                value = self.value(statement.value, env, file) if statement.value else None
                self.invalidate(statement, env)
                targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                if value and value.kind in ('path', 'literal', 'file', 'path-constructor', 'path-module', 'external'):
                    for target in targets:
                        if isinstance(target, ast.Name):
                            env[target.id] = value
            elif isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                nodes = list(_definition_nodes(statement))
                self.invalidate(statement, env)
                if (isinstance(statement, ast.FunctionDef) and not statement.decorator_list
                        and not any(isinstance(node, (ast.Call, ast.NamedExpr, ast.Await, ast.Yield, ast.YieldFrom)) for node in nodes)):
                    env[statement.name] = _Value('callback', None)
            else:
                if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call) and line_counts[statement.lineno] == 1:
                    self.candidate(statement.value, env, file, digest)
                self.invalidate(statement, env)

    def run(self):
        while self.queue:
            file = self.queue.popleft()
            owner = self.relative(file)
            if self.kind(file, owner) != 'file':
                self.fail('source-unreadable', owner)
                continue
            try:
                with open(file, 'rb') as stream:
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                        self.fail('invalid-source', owner)
                        continue
                    data = stream.read(MAX_SOURCE_BYTES + 1)
            except OSError:
                self.fail('source-unreadable', owner)
                continue
            if len(data) > MAX_SOURCE_BYTES:
                self.fail('source-too-large', owner)
                continue
            digest = hashlib.sha256(data).hexdigest()
            self.result['sources'].append({'file': owner, 'sourceHash': digest})
            try:
                tree = ast.parse(data, filename=owner)
                nodes = []
                for node in ast.walk(tree):
                    nodes.append(node)
                    if len(nodes) > MAX_AST_NODES:
                        raise OverflowError
            except (SyntaxError, ValueError, UnicodeError, RecursionError):
                self.fail('source-syntax-error', owner)
                continue
            except OverflowError:
                self.fail('source-ast-limit', owner)
                continue
            imports = {}
            for node in nodes:
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    imports[id(node)] = self.resolve_import(node, file)
            self.scan(tree, file, digest, imports)
        self.result['sources'].sort(key=lambda item: item['file'])
        self.result['candidates'].sort(key=lambda item: (item['file'], item['line'], item['operation']))
        return self.result


def plan_initialization(request):
    """Return a JSON-compatible plan using only bounded local source reads."""
    root = request.get('root') if type(request) is dict else None
    planner = _Planner(absolute(root) if type(root) is str and root else os.getcwd())
    if (type(request) is not dict or set(request) != {'root', 'files'}
            or type(request.get('files')) is not list):
        planner.fail('invalid-request')
        return planner.result
    if (type(root) is not str or not root or not os.path.isabs(root)
            or is_unc_or_device(root) or '\x00' in root
            or os.name == 'nt' and not re.match(r'^[A-Za-z]:[/\\]', root)):
        planner.fail('invalid-root')
        return planner.result
    if planner.kind(planner.root) != 'directory':
        planner.fail('invalid-root')
        return planner.result
    if len(request['files']) > MAX_FILES:
        planner.fail('file-limit')
        return planner.result
    for file in request['files']:
        if (type(file) is not str or not os.path.isabs(file) or is_unc_or_device(file)
                or '\x00' in file or not file.lower().endswith('.py')):
            planner.fail('invalid-source')
            continue
        file = absolute(file)
        if not inside(file, planner.root):
            planner.fail('source-outside-root')
            continue
        planner.enqueue(file, planner.relative(file))
        parent = os.path.dirname(file)
        while inside(parent, planner.root):
            initializer = os.path.join(parent, '__init__.py')
            if planner.kind(initializer, planner.relative(file)) == 'file':
                planner.enqueue(initializer, planner.relative(file))
            if parent == planner.root:
                break
            parent = os.path.dirname(parent)
    return planner.run()


plan = plan_initialization


def main():
    try:
        data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        request = json.loads(data) if len(data) <= MAX_REQUEST_BYTES else None
    except (ValueError, UnicodeError):
        request = None
    print(json.dumps(plan_initialization(request), ensure_ascii=True, allow_nan=False))


if __name__ == '__main__':
    main()
