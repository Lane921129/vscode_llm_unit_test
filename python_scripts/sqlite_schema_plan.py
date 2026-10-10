"""Read Python syntax and literal SQLite DDL; never import an application or open a DB.

Only the structured resource schema's exact subset is representable. Unknown
receivers, paths, constraints and conflicting definitions are diagnostics, not
invitations to infer a database or weaken its schema.
"""
import ast
import hashlib
import json
import math
import os
import re
import sys

from plan_import_initialization import _Planner, _Value, _resource, absolute, inside, is_unc_or_device

MAX_FILES = 64
MAX_BYTES = 2 * 1024 * 1024
MAX_CANDIDATES = 256
IDENTIFIER = re.compile(r'[A-Za-z_][A-Za-z_0-9]{0,63}\Z')
# Conservative unquoted-name subset from https://www.sqlite.org/lang_keywords.html.
# Never turn invalid source DDL into valid SQL merely by quoting its names later.
KEYWORDS = set('''ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT
BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS
CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC
DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST
FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED
INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED
NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA
PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT
RETURNING RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION
TRIGGER UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT'''.split())
TOKEN = re.compile(r"\s+|--[^\n]*(?:\n|$)|/\*.*?\*/|'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|[A-Za-z_][A-Za-z_0-9]*|[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?|[(),;]", re.S)


class UnsupportedSchema(ValueError):
    pass


def parse_ddl(text, require_idempotent=False):
    """An allowlist grammar, not an SQL engine; unsupported semantics fail closed."""
    if type(text) is not str or len(text.encode('utf-8')) > 65536:
        raise UnsupportedSchema()
    tokens, end = [], 0
    for match in TOKEN.finditer(text):
        if match.start() != end:
            raise UnsupportedSchema()
        end = match.end()
        token = match.group()
        if not token.isspace() and not token.startswith(('--', '/*')):
            tokens.append(token)
    if end != len(text):
        raise UnsupportedSchema()
    index = 0

    def peek(word):
        return index < len(tokens) and tokens[index].upper() == word

    def take(word=None):
        nonlocal index
        if index >= len(tokens) or word is not None and not peek(word):
            raise UnsupportedSchema()
        value = tokens[index]
        index += 1
        return value

    def identifier():
        value = take()
        if value.startswith('"'):
            value = value[1:-1].replace('""', '"')
        elif value.upper() in KEYWORDS:
            raise UnsupportedSchema()
        if not IDENTIFIER.fullmatch(value):
            raise UnsupportedSchema()
        return value

    def default():
        grouped = peek('(')
        if grouped:
            take('(')
        value = take()
        if value.startswith("'"):
            value = value[1:-1].replace("''", "'")
            if '\x00' in value or len(value.encode('utf-8')) > 4096:
                raise UnsupportedSchema()
        elif value.upper() == 'NULL':
            value = None
        elif value.upper() in ('TRUE', 'FALSE'):
            value = value.upper() == 'TRUE'
        elif re.fullmatch(r'[+-]?\d+', value):
            value = int(value)
            if abs(value) > 9007199254740991:
                raise UnsupportedSchema()
        else:
            try:
                value = float(value)
            except ValueError:
                raise UnsupportedSchema() from None
            if not math.isfinite(value) or value.is_integer() and abs(value) > 9007199254740991:
                raise UnsupportedSchema()
        if grouped:
            take(')')
        return value

    tables = []
    while index < len(tokens):
        take('CREATE'); take('TABLE')
        if peek('IF'):
            take('IF'); take('NOT'); take('EXISTS')
        elif require_idempotent:
            raise UnsupportedSchema('non-idempotent-schema')
        name = identifier()
        if name.lower().startswith('sqlite_'):
            raise UnsupportedSchema()
        take('(')
        columns, unique = [], []
        while True:
            if peek('UNIQUE'):
                take('UNIQUE'); take('(')
                names = [identifier()]
                while peek(','):
                    take(','); names.append(identifier())
                take(')')
                if len(set(item.lower() for item in names)) != len(names):
                    raise UnsupportedSchema()
                unique.append(names)
            else:
                column = {'name': identifier(), 'type': take().upper()}
                if column['type'] not in ('INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC'):
                    raise UnsupportedSchema()
                while not peek(',') and not peek(')'):
                    constraint = take().upper()
                    if constraint == 'PRIMARY':
                        take('KEY'); key = 'primaryKey'; value = True
                    elif constraint == 'NOT':
                        take('NULL'); key = 'notNull'; value = True
                    elif constraint == 'UNIQUE':
                        key = 'unique'; value = True
                    elif constraint == 'AUTOINCREMENT':
                        if not column.get('primaryKey') or previous_constraint != 'PRIMARY':
                            raise UnsupportedSchema()
                        key = 'autoIncrement'; value = True
                    elif constraint == 'DEFAULT':
                        key = 'default'; value = default()
                    else:
                        raise UnsupportedSchema()
                    if key in column:
                        raise UnsupportedSchema()
                    column[key] = value
                    previous_constraint = constraint
                # JSON/JavaScript cannot preserve 1.0 versus 1. Reject where
                # SQLite's affinity could expose that distinction.
                if (type(column.get('default')) is float and column['default'].is_integer()
                        and column['type'] in ('TEXT', 'BLOB')):
                    raise UnsupportedSchema()
                if column.get('autoIncrement') and (column['type'] != 'INTEGER' or not column.get('primaryKey')):
                    raise UnsupportedSchema()
                columns.append(column)
            if not peek(','):
                break
            take(',')
        take(')')
        names = {item['name'].lower() for item in columns}
        if (not columns or len(columns) > 32 or len(names) != len(columns)
                or sum(bool(item.get('primaryKey')) for item in columns) > 1
                or len(unique) > 16 or len({tuple(sorted(item.lower() for item in group)) for group in unique}) != len(unique)
                or any(item.lower() not in names for constraint in unique for item in constraint)):
            raise UnsupportedSchema()
        spellings = {item['name'].lower(): item['name'] for item in columns}
        unique = [[spellings[item.lower()] for item in group] for group in unique]
        table = {'name': name, 'columns': columns}
        if unique:
            table['unique'] = unique
        tables.append(table)
        if len(tables) > 16:
            raise UnsupportedSchema()
        if index < len(tokens):
            take(';')
    if not tables:
        raise UnsupportedSchema()
    return tables


def _name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        left = _name(node.value)
        return left + '.' + node.attr if left else ''
    return ''


def local_bindings(function):
    """Python bindings apply to the whole function, even after a return.

    Nested scopes contribute their binding names but not their own locals.
    Global/nonlocal statements are treated conservatively by the caller.
    """
    result = set()

    class Bindings(ast.NodeVisitor):
        def visit_Name(self, node):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                result.add(node.id)

        def visit_Import(self, node):
            result.update(alias.asname or alias.name.split('.')[0] for alias in node.names)

        def visit_ImportFrom(self, node):
            result.update(alias.asname or alias.name for alias in node.names)

        def visit_FunctionDef(self, node):
            result.add(node.name)

        visit_AsyncFunctionDef = visit_FunctionDef
        visit_ClassDef = visit_FunctionDef

        def visit_ExceptHandler(self, node):
            if node.name:
                result.add(node.name)
            self.generic_visit(node)

        def visit_MatchAs(self, node):
            if node.name:
                result.add(node.name)
            self.generic_visit(node)

        visit_MatchStar = visit_MatchAs

        def visit_MatchMapping(self, node):
            if node.rest:
                result.add(node.rest)
            self.generic_visit(node)

    visitor = Bindings()
    for statement in function.body:
        visitor.visit(statement)
    result.update(argument.arg for argument in [*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs])
    if function.args.vararg:
        result.add(function.args.vararg.arg)
    if function.args.kwarg:
        result.add(function.args.kwarg.arg)
    return result


class SchemaPlanner:
    def __init__(self, root, files):
        self.root = root
        self.files = files
        self.paths = _Planner(root)
        self.candidates = []
        self.diagnostics = []
        self.sources = []

    def diagnostic(self, file, node, reason):
        item = {'file': file, 'reason': reason}
        if getattr(node, 'lineno', None):
            item['line'] = node.lineno
        if item not in self.diagnostics:
            self.diagnostics.append(item)

    def inspect(self, file):
        relative = os.path.relpath(file, self.root).replace('\\', '/')
        if self.paths.kind(file, relative) != 'file' or not inside(file, self.root):
            self.diagnostic(relative, None, 'invalid-source'); return
        with open(file, 'rb') as stream:
            data = stream.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            self.diagnostic(relative, None, 'source-too-large'); return
        digest = hashlib.sha256(data).hexdigest()
        self.sources.append({'file': relative, 'sourceHash': digest})
        try:
            tree = ast.parse(data, filename=file)
        except (SyntaxError, ValueError):
            self.diagnostic(relative, None, 'source-syntax-error'); return
        if sum(1 for _ in ast.walk(tree)) > 100000:
            self.diagnostic(relative, None, 'source-ast-limit'); return
        def shadow(module):
            if any(os.path.basename(item).lower() == module + '.py' or item.lower().endswith(os.path.join(module, '__init__.py')) for item in self.files):
                return True
            bases, anchor = {self.root}, os.path.dirname(file)
            for _ in range(3):
                if inside(anchor, self.root):
                    bases.add(anchor)
                anchor = os.path.dirname(anchor)
            return any(self.paths.local_module(base, [module], relative)[0] != 'external' for base in bases)
        sqlite_shadow, pathlib_shadow = shadow('sqlite3'), shadow('pathlib')
        env, helpers = {'__file__': _Value('file', file)}, {}
        sqlite_aliases = set()
        for statement in tree.body:
            if isinstance(statement, ast.Import):
                for alias in statement.names:
                    if alias.name == 'sqlite3' and not sqlite_shadow:
                        sqlite_aliases.add(alias.asname or alias.name)
            elif isinstance(statement, ast.ImportFrom) and statement.level == 0:
                for alias in statement.names:
                    if statement.module == 'sqlite3' and alias.name == 'connect' and not sqlite_shadow:
                        sqlite_aliases.add(alias.asname or alias.name)
            elif isinstance(statement, ast.FunctionDef) and not statement.decorator_list:
                helpers[statement.name] = statement
        for name in list(helpers):
            if sum(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name for node in tree.body) != 1:
                helpers.pop(name)
        # Track simple re-exports before checking attribute mutation; an alias
        # does not make monkey-patching the imported sqlite module trustworthy.
        for _ in range(len(sqlite_aliases) + 64):
            before = len(sqlite_aliases)
            for node in ast.walk(tree):
                if isinstance(node, ast.Assign) and isinstance(node.value, ast.Name) and node.value.id in sqlite_aliases:
                    sqlite_aliases.update(target.id for target in node.targets if isinstance(target, ast.Name))
            if len(sqlite_aliases) == before:
                break
        # Explicit rebinding/introspection cannot prove a stdlib receiver.
        tainted = any(isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.Delete)) and any(
            isinstance(child, ast.Attribute) and isinstance(child.ctx, (ast.Store, ast.Del))
            and _name(child).split('.')[0] in sqlite_aliases for child in ast.walk(node))
            or isinstance(node, ast.Call) and _name(node.func) in ('setattr', 'delattr', 'exec', 'eval', 'globals', 'locals')
            or isinstance(node, ast.Subscript) and isinstance(node.ctx, (ast.Store, ast.Del))
                and (_name(node.value).split('.')[0] in sqlite_aliases
                    or isinstance(node.value, ast.Attribute) and node.value.attr == 'modules')
            or isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name) and node.target.id in sqlite_aliases
            or isinstance(node, ast.Call) and any(isinstance(arg, ast.Name) and arg.id in sqlite_aliases
                for arg in [*node.args, *(item.value for item in node.keywords)]) for node in ast.walk(tree))
        path_tainted = any(isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del))
                           for node in ast.walk(tree)) or tainted
        mutable_globals = {name for node in ast.walk(tree) if isinstance(node, (ast.Global, ast.Nonlocal)) for name in node.names}

        def value(node, local, stack=()):
            if isinstance(node, ast.Name):
                return local.get(node.id) if node.id not in mutable_globals else None
            if isinstance(node, ast.Attribute):
                receiver = value(node.value, local, stack)
                if receiver == ('sqlite-module', None) and node.attr == 'connect':
                    return ('sqlite-connect', None)
            if isinstance(node, ast.Call):
                callable_value = value(node.func, local, stack)
                if callable_value == ('sqlite-connect', None):
                    if len(node.args) != 1 or node.keywords:
                        return None
                    target = value(node.args[0], local, stack)
                    raw = target.value if isinstance(target, _Value) and target.kind in ('path', 'literal') else None
                    resource = _resource(self.root, raw) if isinstance(raw, str) and raw not in (':memory:', '') and not raw.startswith('file:') else None
                    return ('connection', resource, node.lineno)
                if isinstance(node.func, ast.Attribute) and node.func.attr == 'cursor' and not node.args and not node.keywords:
                    receiver = value(node.func.value, local, stack)
                    if isinstance(receiver, tuple) and receiver[0] == 'connection':
                        return ('cursor', receiver[1], receiver[2])
                if isinstance(node.func, ast.Name) and callable_value == ('helper', node.func.id) and not node.args and not node.keywords and node.func.id not in stack:
                    helper = helpers[node.func.id]
                    if helper.args.args or helper.args.posonlyargs or helper.args.kwonlyargs or helper.args.vararg or helper.args.kwarg:
                        return None
                    scope = dict(env)
                    for name in local_bindings(helper):
                        scope.pop(name, None)
                    for part in helper.body:
                        if isinstance(part, ast.Assign) and len(part.targets) == 1 and isinstance(part.targets[0], ast.Name):
                            scope[part.targets[0].id] = value(part.value, scope, stack + (node.func.id,))
                        elif isinstance(part, ast.Return):
                            return value(part.value, scope, stack + (node.func.id,))
                        elif isinstance(part, ast.Expr) and isinstance(part.value, ast.Constant) and type(part.value.value) is str:
                            continue
                        else:
                            return None
            path_env = {key: item for key, item in local.items() if isinstance(item, _Value)}
            return self.paths.value(node, path_env, file)

        def walk(statements, local):
            for node in statements:
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        name = alias.asname or alias.name.split('.')[0]
                        local[name] = (('sqlite-module', None) if alias.name == 'sqlite3' and not sqlite_shadow and not tainted
                            else _Value('path-module', None) if alias.name == 'pathlib' and not pathlib_shadow and not path_tainted else None)
                elif isinstance(node, ast.ImportFrom):
                    if any(alias.name == '*' for alias in node.names):
                        local.clear()
                        continue
                    for alias in node.names:
                        local[alias.asname or alias.name] = (('sqlite-connect', None)
                            if not node.level and node.module == 'sqlite3' and alias.name == 'connect' and not sqlite_shadow and not tainted
                            else _Value('path-constructor', None)
                            if not node.level and node.module == 'pathlib' and alias.name == 'Path' and not pathlib_shadow and not path_tainted else None)
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    local[node.name] = ('helper', node.name) if node in helpers.values() else None
                elif isinstance(node, (ast.AugAssign, ast.Delete)):
                    for child in ast.walk(node):
                        if isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del)):
                            local.pop(child.id, None)
                elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                    for target in targets:
                        if isinstance(target, ast.Name):
                            local[target.id] = value(node.value, local) if node.value is not None else None
                        else:
                            for child in ast.walk(target):
                                if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                                    local.pop(child.id, None)
                elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                    call = node.value
                    if not isinstance(call.func, ast.Attribute) or call.func.attr not in ('execute', 'executescript'):
                        continue
                    sql = call.args[0].value if call.args and isinstance(call.args[0], ast.Constant) and type(call.args[0].value) is str else None
                    if sql is None:
                        self.diagnostic(relative, call, 'nonliteral-sql'); continue
                    if not re.search(r'\bCREATE\s+TABLE\b', sql, re.I):
                        continue
                    receiver = value(call.func.value, local)
                    if not isinstance(receiver, tuple) or receiver[0] not in ('connection', 'cursor'):
                        self.diagnostic(relative, call, 'unproven-sqlite-receiver'); continue
                    if receiver[1] is None:
                        self.diagnostic(relative, call, 'dynamic-database-path'); continue
                    if len(call.args) != 1 or call.keywords:
                        self.diagnostic(relative, call, 'unsupported-execute-arguments'); continue
                    try:
                        tables = parse_ddl(sql, require_idempotent=True)
                        if call.func.attr == 'execute' and len(tables) != 1:
                            raise UnsupportedSchema()
                    except UnsupportedSchema as error:
                        self.diagnostic(relative, call, 'non-idempotent-schema' if str(error) == 'non-idempotent-schema' else 'unsupported-schema'); continue
                    for table in tables:
                        if len(self.candidates) >= MAX_CANDIDATES:
                            self.diagnostic(relative, call, 'candidate-limit'); return
                        resource = {'kind': 'sqlite', 'path': receiver[1]['resourcePath']}
                        if 'resourceScope' in receiver[1]:
                            resource['scope'] = receiver[1]['resourceScope']
                        self.candidates.append({'file': relative, 'sourceHash': digest, 'line': call.lineno,
                            'connectionLine': receiver[2], 'resource': resource, 'table': table})
                elif isinstance(node, (ast.If, ast.For, ast.While, ast.Try, ast.With, ast.AsyncWith)):
                    # Branch-dependent aliases are not facts; do not merge guesses.
                    if any(isinstance(child, ast.Constant) and type(child.value) is str and re.search(r'\bCREATE\s+TABLE\b', child.value, re.I) for child in ast.walk(node)):
                        self.diagnostic(relative, node, 'conditional-schema')
                    for child in ast.walk(node):
                        if isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del)):
                            local.pop(child.id, None)

        walk(tree.body, env)
        for helper in helpers.values():
            local = dict(env)
            for name in local_bindings(helper):
                local.pop(name, None)
            walk(helper.body, local)


def plan_schema(request):
    if (type(request) is not dict or set(request) != {'root', 'files'} or type(request['root']) is not str
            or type(request['files']) is not list or len(request['files']) > MAX_FILES):
        raise ValueError('Invalid schema plan request')
    root = absolute(request['root'])
    if (not os.path.isabs(request['root']) or is_unc_or_device(request['root']) or '\x00' in request['root']
            or os.name == 'nt' and not re.match(r'^[A-Za-z]:[/\\]', request['root'])):
        raise ValueError('Invalid schema root')
    if any(type(file) is not str or not os.path.isabs(file) or is_unc_or_device(file) or '\x00' in file for file in request['files']):
        raise ValueError('Invalid schema source scope')
    files = list(dict.fromkeys(absolute(file) for file in request['files'] if type(file) is str))
    if len(files) != len(request['files']) or any(not file.endswith('.py') or not inside(file, root) for file in files):
        raise ValueError('Invalid schema source scope')
    planner = SchemaPlanner(root, files)
    if planner.paths.kind(root) != 'directory':
        raise ValueError('Invalid schema root')
    for file in files:
        planner.inspect(file)
    return {'schemaVersion': 'sqlite-schema-plan-v1', 'sources': planner.sources,
        'candidates': planner.candidates, 'diagnostics': planner.diagnostics}


if __name__ == '__main__':
    try:
        request = sys.stdin.read(128 * 1024 + 1)
        if len(request.encode('utf-8')) > 128 * 1024:
            raise ValueError('Request too large')
        print(json.dumps(plan_schema(json.loads(request))))
    except (ValueError, OSError, RecursionError):
        print(json.dumps({'schemaVersion': 'sqlite-schema-plan-v1', 'sources': [], 'candidates': [],
                          'diagnostics': [{'file': '.', 'reason': 'schema-plan-incomplete'}]}))
        sys.exit(1)
