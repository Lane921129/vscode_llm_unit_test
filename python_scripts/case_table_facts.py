"""Static facts for the v2 case-table pipeline (case-table-facts-v1).

Usage: case_table_facts.py <file> <target>   (target: `func` or `Class.method`)

Parses the module (never imports or runs it) and prints one JSON object with the
target signature, docstring, branch conditions, raised exceptions, and the
patchable dependencies a case row may mock. A dependency is either a dotted
name resolvable in the target module (`_connect`, `sqlite3.connect`, `db.fetchone`)
or a call on a local bound from such a call (`cur.fetchone` after
`conn = _connect(); cur = conn.cursor()`), recorded as a patch root plus chain.
"""
import ast
import builtins
import json
import sys

VERSION = 'case-table-facts-v1'
MAX_BRANCHES = 20
MAX_CONDITION_CHARS = 120
# Builtins worth patching for isolation; other builtins are ordinary computation.
PATCHABLE_BUILTINS = frozenset({'open', 'input'})
_BUILTINS = frozenset(dir(builtins))


class FactsError(Exception):
    pass


def _find(tree, target):
    parts = target.split('.')
    body, owner = tree.body, None
    for index, name in enumerate(parts):
        last = index == len(parts) - 1
        kinds = (ast.FunctionDef, ast.AsyncFunctionDef) if last else (ast.ClassDef,)
        matches = [node for node in body if isinstance(node, kinds) and node.name == name]
        if not matches:
            raise FactsError('target-not-found')
        node = matches[-1]
        if last:
            return node, owner
        owner, body = node, node.body
    raise FactsError('target-not-found')


def _dotted(node):
    """Return ['a', 'b', 'c'] for a.b.c, or None for anything else."""
    names = []
    while isinstance(node, ast.Attribute):
        names.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        names.append(node.id)
        return list(reversed(names))
    return None


def _module_names(tree):
    names = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname or alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != '*':
                    names.add(alias.asname or alias.name)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    names.add(target.id)
    return names


def _method_kind(node, owner):
    if owner is None:
        return 'module'
    decorators = {d.id for d in node.decorator_list if isinstance(d, ast.Name)}
    if 'staticmethod' in decorators:
        return 'static'
    if 'classmethod' in decorators:
        return 'class'
    return 'instance'


def _parameters(node):
    args = node.args
    params = []
    positional = args.posonlyargs + args.args
    defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
    for index, (arg, default) in enumerate(zip(positional, defaults)):
        kind = 'positional_only' if index < len(args.posonlyargs) else 'positional_or_keyword'
        params.append((arg, kind, default))
    if args.vararg:
        params.append((args.vararg, 'var_positional', None))
    for arg, default in zip(args.kwonlyargs, args.kw_defaults):
        params.append((arg, 'keyword_only', default))
    if args.kwarg:
        params.append((args.kwarg, 'var_keyword', None))
    return [{'name': arg.arg, 'kind': kind,
             'annotation': ast.unparse(arg.annotation) if arg.annotation else None,
             'default': ast.unparse(default) if default is not None else None} for arg, kind, default in params]


def _own_nodes(node):
    """Walk the target body without descending into nested functions or classes."""
    nested = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
    stack = [child for child in reversed(node.body) if not isinstance(child, nested)]
    while stack:
        current = stack.pop()
        yield current
        for child in reversed(list(ast.iter_child_nodes(current))):
            if not isinstance(child, nested):
                stack.append(child)


def _branches(node):
    elifs = set()
    for current in _own_nodes(node):
        if isinstance(current, ast.If) and len(current.orelse) == 1 and isinstance(current.orelse[0], ast.If):
            elifs.add(id(current.orelse[0]))
    found = []
    for current in _own_nodes(node):
        if isinstance(current, ast.If):
            kind, test = ('elif' if id(current) in elifs else 'if'), current.test
        elif isinstance(current, ast.While):
            kind, test = 'while', current.test
        elif isinstance(current, ast.IfExp):
            kind, test = 'conditional-expression', current.test
        elif isinstance(current, ast.Assert):
            kind, test = 'assert', current.test
        elif hasattr(ast, 'Match') and isinstance(current, ast.Match):
            kind, test = 'match', current.subject
        else:
            continue
        text = ast.unparse(test)
        if len(text) > MAX_CONDITION_CHARS:
            text = text[:MAX_CONDITION_CHARS - 3] + '...'
        found.append({'line': current.lineno, 'kind': kind, 'condition': text})
    found.sort(key=lambda item: item['line'])
    return found[:MAX_BRANCHES]


def _raises(node):
    names = []
    for current in _own_nodes(node):
        if isinstance(current, ast.Raise) and current.exc is not None:
            exc = current.exc.func if isinstance(current.exc, ast.Call) else current.exc
            dotted = _dotted(exc)
            if dotted and '.'.join(dotted) not in names:
                names.append('.'.join(dotted))
    return names


def _dependencies(node, module_names, parameter_names):
    """Collect patchable dependencies in source order."""
    locals_chain = {}   # local name -> (patch root, chain)
    found = {}

    def resolve_call(call):
        """Return (name, patch, chain) for a call's callee, or None."""
        dotted = _dotted(call.func)
        if not dotted:
            return None
        root = dotted[0]
        if root in locals_chain:
            patch, chain = locals_chain[root]
            return '.'.join(dotted), patch, chain + dotted[1:]
        if root in parameter_names or root in ('self', 'cls'):
            return None
        if root in module_names or (root in PATCHABLE_BUILTINS and len(dotted) == 1):
            return '.'.join(dotted), '.'.join(dotted), []
        if root in _BUILTINS:
            return None
        return None

    def bind(name, call, suffix=()):
        resolved = resolve_call(call)
        if resolved and name not in locals_chain:
            _, patch, chain = resolved
            if chain:
                locals_chain[name] = (patch, chain + ['()'] + list(suffix))
            else:
                locals_chain[name] = (patch, ['()'] + list(suffix))

    for current in _own_nodes(node):
        if isinstance(current, ast.Assign) and len(current.targets) == 1 and isinstance(current.targets[0], ast.Name) \
                and isinstance(current.value, ast.Call):
            bind(current.targets[0].id, current.value)
        elif isinstance(current, (ast.With, ast.AsyncWith)):
            for item in current.items:
                if isinstance(item.context_expr, ast.Call) and isinstance(item.optional_vars, ast.Name):
                    bind(item.optional_vars.id, item.context_expr, ('__enter__', '()'))
        if isinstance(current, ast.Call):
            resolved = resolve_call(current)
            if resolved and resolved[0] not in found:
                name, patch, chain = resolved
                entry = {'name': name, 'patch': patch, 'chain': chain}
                if name in PATCHABLE_BUILTINS:
                    entry['create'] = True
                found[name] = entry
    return list(found.values())


def collect_facts(source, target):
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        raise FactsError('source-syntax-error')
    node, owner = _find(tree, target)
    method_kind = _method_kind(node, owner)
    parameters = _parameters(node)
    if method_kind in ('instance', 'class') and parameters:
        parameters = parameters[1:]
    names = {param['name'] for param in parameters}
    segment = ast.get_source_segment(source, node) or ''
    return {
        'version': VERSION,
        'target': target,
        'className': owner.name if owner is not None else None,
        'methodKind': method_kind,
        'isAsync': isinstance(node, ast.AsyncFunctionDef),
        'signature': f"{node.name}({', '.join(_signature_parts(parameters))})"
                     + (f" -> {ast.unparse(node.returns)}" if node.returns else ''),
        'parameters': parameters,
        'returns': ast.unparse(node.returns) if node.returns else None,
        'docstring': ast.get_docstring(node),
        'branches': _branches(node),
        'raises': _raises(node),
        'dependencies': _dependencies(node, _module_names(tree), names),
        'source': segment,
    }


def _signature_parts(parameters):
    parts = []
    for param in parameters:
        prefix = {'var_positional': '*', 'var_keyword': '**'}.get(param['kind'], '')
        text = prefix + param['name']
        if param['annotation']:
            text += f": {param['annotation']}"
        if param['default'] is not None:
            text += f" = {param['default']}" if param['annotation'] else f"={param['default']}"
        parts.append(text)
    return parts


def main(argv=None, stdout=None):
    argv = sys.argv[1:] if argv is None else argv
    stdout = stdout or sys.stdout
    if len(argv) != 2:
        stdout.write(json.dumps({'version': VERSION, 'error': 'usage'}))
        return 2
    try:
        with open(argv[0], encoding='utf-8') as handle:
            source = handle.read()
        facts = collect_facts(source, argv[1])
    except OSError:
        facts = {'version': VERSION, 'error': 'source-unreadable'}
    except FactsError as failure:
        facts = {'version': VERSION, 'error': str(failure)}
    stdout.write(json.dumps(facts, ensure_ascii=False))
    return 1 if 'error' in facts else 0


if __name__ == '__main__':
    sys.exit(main())
