"""Evidence-only import setup proposals. Never import dependencies or execute AST."""
import ast
import hashlib
import os
from pathlib import Path
import re
import sys
import types

from import_fixtures import ImportFixtures

_PATH_MKDIR_CODE = Path.mkdir.__code__
_FIXTURE_MKDIR_CODE = next(code for code in ImportFixtures.__enter__.__code__.co_consts
                          if type(code) is types.CodeType and code.co_name == 'mkdir')
_ENTRY_FACTORY_CODE = next(code for code in ImportFixtures.install_entries.__code__.co_consts
                          if type(code) is types.CodeType and code.co_name == 'wrapper')
_FIXTURE_ENTRY_CODE = next(code for code in _ENTRY_FACTORY_CODE.co_consts
                          if type(code) is types.CodeType and code.co_name == 'entry_mock')
_IDENTIFIER_PATH = re.compile(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+')


def _absolute(file):
    return os.path.normcase(os.path.realpath(file))


def _inside(file, root):
    if file.startswith('<frozen '):
        return False
    try:
        return os.path.commonpath([_absolute(file), root]) == root
    except ValueError:
        return False


def _parts(node):
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Attribute):
        prefix = _parts(node.value)
        return prefix + [node.attr] if prefix else None
    return None


def _observed_directory(following, root):
    """Read the actual pathlib receiver, never evaluate its source expression."""
    for entry in following:
        if entry.tb_frame.f_code is not _PATH_MKDIR_CODE:
            continue
        receiver = entry.tb_frame.f_locals.get('self')
        if type(receiver) is not type(Path()) or entry.tb_frame.f_locals.get('exist_ok') is not True:
            return None
        raw = os.fspath(receiver)
        if not os.path.isabs(raw) and any(part == '..' for part in raw.replace('\\', '/').split('/')):
            return None
        # Relative declarations are explicitly bound to the project logical
        # root, independent of the report/worker current directory.
        lexical = os.path.abspath(raw if os.path.isabs(raw) else os.path.join(root, raw))
        # Reject existing symlink components and out-of-project destinations.
        if os.path.normcase(lexical) != _absolute(lexical) or not _inside(lexical, root):
            return None
        relative = os.path.relpath(lexical, root).replace('\\', '/')
        if relative == '.' or any(part in ('', '.', '..') for part in relative.split('/')):
            return None
        if any(part.lower().endswith(('.py', '.pyc', '.pyo', '.pyd', '.dll', '.so')) for part in relative.split('/')):
            return None
        return relative
    return None


def _definition_time_nodes(node):
    """Walk expressions executed when defining a function, never its local body."""
    yield node
    for field, value in ast.iter_fields(node):
        if field == 'body' and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        children = value if isinstance(value, list) else [value]
        for child in children:
            if isinstance(child, ast.AST):
                yield from _definition_time_nodes(child)


def _import_binding(statements, name):
    """Conservative lexical binding, including aliases; ambiguous stores invalidate it."""
    binding = None
    for statement in statements:
        if isinstance(statement, ast.Import):
            for item in statement.names:
                if (item.asname or item.name.split('.')[0]) == name:
                    binding = (item.name if item.asname else item.name.split('.')[0], [])
        elif isinstance(statement, ast.ImportFrom) and statement.level == 0 and statement.module:
            for item in statement.names:
                if item.name == '*':
                    binding = None
                elif (item.asname or item.name) == name:
                    binding = (statement.module, [item.name])
        else:
            for node in _definition_time_nodes(statement):
                if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name
                        or isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)) and node.id == name
                        or isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del))
                        and (_parts(node) or [None])[0] == name
                        or isinstance(node, (ast.Import, ast.ImportFrom))):
                    binding = None
    return binding


def _fixture_original(value):
    # The guard has restored module attributes before diagnostics run, but a
    # from-import alias may still retain our own wrapper. Never unwrap user code.
    if type(value) is types.FunctionType and value.__code__ is _FIXTURE_ENTRY_CODE:
        cells = dict(zip(value.__code__.co_freevars, value.__closure__ or ()))
        return cells['function'].cell_contents
    return value


def _external_callable(statements, call, frame, root):
    parts = _parts(call.func)
    if not parts:
        return None
    binding = _import_binding(statements, parts[0])
    if not binding:
        return None
    module_name, attributes = binding
    current = sys.modules.get(module_name)
    if type(current) is not types.ModuleType:
        return None
    bound = current
    for attribute in attributes:
        if type(bound) is not types.ModuleType:
            return None
        bound = vars(bound).get(attribute)
    if _fixture_original(frame.f_globals.get(parts[0])) is not bound:
        return None
    path = attributes + parts[1:]
    if not path:
        return None
    for attribute in path[:-1]:
        if type(current) is not types.ModuleType:
            return None
        current = vars(current).get(attribute)
    if type(current) is not types.ModuleType:
        return None
    namespace = vars(current)
    origin, name = namespace.get('__file__'), namespace.get('__name__')
    function = namespace.get(path[-1])
    if (type(origin) is not str or type(name) is not str or _inside(origin, root)
            or sys.modules.get(name) is not current or type(function) is not types.FunctionType
            or _inside(function.__code__.co_filename, root)):
        return None
    operation = name + '.' + path[-1]
    return (operation, function) if _IDENTIFIER_PATH.fullmatch(operation) else None


def advise_blocked_initialization(error, source_root):
    """Called only for a real runtime-policy violation; return one reviewed candidate.

    Only direct module-body expression calls with unused results qualify.
    Traceback identity proves the called function actually ran. Application
    callbacks, local helpers, constructors and arbitrary failures cannot qualify.
    """
    try:
        root = _absolute(source_root)
        trace = BaseException.__dict__['__traceback__'].__get__(error)
        frames = []
        while trace and len(frames) < 256:
            frames.append(trace)
            trace = trace.tb_next
        if trace:
            return None
        for index, item in enumerate(frames):
            frame = item.tb_frame
            file = frame.f_code.co_filename
            if frame.f_code.co_name != '<module>' or not _inside(file, root):
                continue
            if type(frame.f_globals.get('__file__')) is not str or _absolute(frame.f_globals['__file__']) != _absolute(file):
                continue
            following = frames[index + 1:]
            if not following or any(_inside(next_item.tb_frame.f_code.co_filename, root)
                                    or not os.path.isabs(next_item.tb_frame.f_code.co_filename)
                                    and not next_item.tb_frame.f_code.co_filename.startswith('<frozen ')
                                    for next_item in following):
                continue
            with open(file, 'rb') as stream:
                source = stream.read(2 * 1024 * 1024 + 1)
            if len(source) > 2 * 1024 * 1024:
                continue
            # The preview must describe the source that produced this frame,
            # not a file edited while its import was in progress.
            if compile(source, file, 'exec', dont_inherit=True) != frame.f_code:
                continue
            tree = ast.parse(source, filename=file)
            statements = [node for node in tree.body if node.lineno <= item.tb_lineno <= node.end_lineno]
            if len(statements) != 1 or not isinstance(statements[0], ast.Expr) or not isinstance(statements[0].value, ast.Call):
                continue
            statement, call = statements[0], statements[0].value
            prefix = tree.body[:tree.body.index(statement)]
            next_codes = [entry.tb_frame.f_code for entry in following]
            direct_mkdir = (isinstance(call.func, ast.Attribute) and call.func.attr == 'mkdir'
                            and (next_codes[0] is _PATH_MKDIR_CODE
                                 or len(next_codes) > 1 and next_codes[0] is _FIXTURE_MKDIR_CODE
                                 and next_codes[1] is _PATH_MKDIR_CODE))
            if direct_mkdir:
                kind, operation = 'mkdir', 'pathlib.Path.mkdir'
            else:
                external = _external_callable(prefix, call, frame, root)
                if not external:
                    continue
                direct = next_codes[0] is external[1].__code__
                through_fixture = (len(next_codes) > 1 and next_codes[0] is _FIXTURE_ENTRY_CODE
                                   and next_codes[1] is external[1].__code__
                                   and following[0].tb_frame.f_locals.get('function') is external[1])
                if not direct and not through_fixture:
                    continue
                kind, operation = 'entry-point', external[0]
            candidate = {'schemaVersion': 'import-initialization-candidate-v1', 'kind': kind,
                    'file': os.path.relpath(_absolute(file), root).replace('\\', '/'),
                    'line': item.tb_lineno, 'sourceHash': hashlib.sha256(source).hexdigest(),
                    'operation': operation, 'evidence': 'blocked-direct-module-call', 'returnValue': 'discarded'}
            if direct_mkdir:
                resource_path = _observed_directory(following, root)
                if resource_path:
                    candidate['resourcePath'] = resource_path
            return candidate
    except (OSError, ValueError, TypeError, SyntaxError, RecursionError):
        # Advice is optional and must never replace the actual import failure.
        return None
    return None
