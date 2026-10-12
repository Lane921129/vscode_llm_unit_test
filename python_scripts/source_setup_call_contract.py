"""Bound source spellings for fixture setup; no execution or output oracle."""
import ast
import copy
import hashlib
import json

VERSION = 'source-setup-call-contract-v1'
MAX_FACTS = 64
MAX_BYTES = 16384
NESTED = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
DYNAMIC_NAMES = {'globals', 'locals', 'vars', 'eval', 'exec', '__import__', 'setattr', 'delattr'}


def _scope_nodes(node):
    """Exclude independent callable/comprehension scopes, including their writes."""
    yield node
    if isinstance(node, NESTED + COMPREHENSIONS):
        return
    for child in ast.iter_child_nodes(node):
        yield from _scope_nodes(child)


def _bound_names(node):
    names = set()
    for item in _scope_nodes(node):
        if isinstance(item, ast.Name) and isinstance(item.ctx, (ast.Store, ast.Del)):
            names.add(item.id)
        elif isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(item.name)
        elif isinstance(item, ast.Import):
            names.update(alias.asname or alias.name.split('.')[0] for alias in item.names)
        elif isinstance(item, ast.ImportFrom):
            names.update(alias.asname or alias.name for alias in item.names)
        elif isinstance(item, ast.ExceptHandler) and item.name:
            names.add(item.name)
        elif isinstance(item, (ast.MatchAs, ast.MatchStar)) and item.name:
            names.add(item.name)
        elif isinstance(item, ast.MatchMapping) and item.rest:
            names.add(item.rest)
    return names


def _root_name(node):
    while isinstance(node, ast.Attribute):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def _stable_module_names(tree):
    """Prove lexical bindings only, never their runtime values or object types."""
    counts, direct, changed_members = {}, set(), set()
    dynamic = False
    for statement in tree.body:
        names = _bound_names(statement)
        occurrences = []
        for item in _scope_nodes(statement):
            if isinstance(item, ast.Name) and isinstance(item.ctx, (ast.Store, ast.Del)):
                occurrences.append(item.id)
            elif isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                occurrences.append(item.name)
            elif isinstance(item, ast.Import):
                occurrences.extend(alias.asname or alias.name.split('.')[0] for alias in item.names)
            elif isinstance(item, ast.ImportFrom):
                occurrences.extend(alias.asname or alias.name for alias in item.names)
        for name in names:
            counts[name] = counts.get(name, 0) + max(1, occurrences.count(name))
        if isinstance(statement, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            direct.update(names)
        elif isinstance(statement, (ast.Assign, ast.AnnAssign)):
            targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
            direct.update(target.id for target in targets if isinstance(target, ast.Name))
    # Function global writes or namespace mutation can invalidate an earlier
    # module binding. Do not execute code to guess whether those branches run.
    for item in ast.walk(tree):
        if isinstance(item, ast.ImportFrom) and any(alias.name == '*' for alias in item.names):
            dynamic = True
        if isinstance(item, ast.Call) and isinstance(item.func, ast.Name) and item.func.id in DYNAMIC_NAMES:
            dynamic = True
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            declared = set().union(*(set(part.names) for statement in item.body for part in _scope_nodes(statement)
                                     if isinstance(part, ast.Global)))
            written = set().union(*(_bound_names(statement) for statement in item.body))
            for name in declared & written:
                counts[name] = counts.get(name, 0) + 1
        if isinstance(item, (ast.Attribute, ast.Subscript)) and isinstance(item.ctx, (ast.Store, ast.Del)):
            base = item.value
            while isinstance(base, (ast.Attribute, ast.Subscript)):
                base = base.value
            if isinstance(base, ast.Name):
                changed_members.add(base.id)
    return (set() if dynamic else {name for name in direct if counts.get(name) == 1}), changed_members


def build_source_setup_call_contract(func_node, target_source, target_name, module_tree):
    """Describe only this target's lexical lookup/call spellings, even in branches.

    An optional lookup may need create=True; a module argument must be read
    from that module. Neither statement computes or approves an expected value.
    Unknown/rebound names retain unknown scope and never acquire patch rights.
    """
    normalized = target_source.replace('\r\n', '\n').replace('\r', '\n')
    contract = {'schemaVersion': VERSION, 'target': target_name,
                'targetSourceHash': hashlib.sha256(normalized.encode('utf-8')).hexdigest(),
                'sourceHashKind': 'normalized-target-source', 'authority': 'source-spelling-only',
                'spellingKind': 'ast-normalized',
                'assertionOracle': False, 'patchAuthorization': False, 'status': 'complete',
                'optionalLookups': [], 'calls': [], 'sourceLocations': []}

    def unsupported(reason):
        contract.update(status='unsupported', optionalLookups=[], calls=[], sourceLocations=[], reason=reason)
        return contract

    if not isinstance(module_tree, ast.Module):
        return unsupported('target-identity-unresolved')
    if '.' in target_name:
        owner, leaf = target_name.rsplit('.', 1)
        owners = [node for node in module_tree.body if isinstance(node, ast.ClassDef) and node.name == owner]
        selected = [node for node in owners[0].body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and node.name == leaf] if len(owners) == 1 else []
    else:
        selected = [node for node in module_tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and node.name == target_name]
    if len(selected) != 1 or selected[0] is not func_node:
        return unsupported('target-identity-unresolved')
    try:
        try:
            fragment = ast.parse(normalized)
            body = fragment.body
        except IndentationError:
            # Class fragments retain their actual indentation. Wrapping them
            # leaves multiline literal contents intact; dedent would not.
            fragment = ast.parse('if True:\n' + normalized)
            body = fragment.body[0].body
        supplied = body[0] if len(body) == 1 else None
        original = copy.deepcopy(func_node)
        original.decorator_list = []  # extractor's target fragment starts at def
        if not isinstance(supplied, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return unsupported('target-identity-unresolved')
        supplied.decorator_list = []
        if ast.dump(original) != ast.dump(supplied):
            return unsupported('target-source-mismatch')
    except (SyntaxError, ValueError):
        return unsupported('target-source-mismatch')
    parameters = {arg.arg for arg in [*func_node.args.posonlyargs, *func_node.args.args, *func_node.args.kwonlyargs,
                                     *(arg for arg in (func_node.args.vararg, func_node.args.kwarg) if arg)]}
    nodes = [node for statement in func_node.body for node in _scope_nodes(statement)]
    locals_ = parameters | set().union(*(_bound_names(statement) for statement in func_node.body))
    declarations = {name for node in nodes if isinstance(node, (ast.Global, ast.Nonlocal)) for name in node.names}
    module_names, changed_members = _stable_module_names(module_tree)
    module_names.difference_update(locals_ | declarations | {func_node.name, target_name.split('.')[0]})
    reflective = any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                     and node.func.id in DYNAMIC_NAMES for node in nodes)
    if reflective:
        module_names.clear()

    def argument(node):
        scope = ('module-global' if isinstance(node, (ast.Name, ast.Attribute)) and _root_name(node) in module_names
                 or isinstance(node, ast.Name) and node.id == '__file__' and node.id not in locals_ | declarations
                 else 'parameter' if isinstance(node, ast.Name) and node.id in parameters
                 else 'literal' if isinstance(node, ast.Constant) else 'unknown')
        return {'source': ast.unparse(node), 'scope': scope}

    for node in nodes:
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id == '__file__' and node.id not in locals_ | declarations:
            if '__file__' not in contract['sourceLocations']:
                contract['sourceLocations'].append('__file__')
        if not isinstance(node, ast.Call):
            continue
        root = _root_name(node.func)
        if (isinstance(node.func, ast.Name) and node.func.id == 'getattr' and 'getattr' not in locals_ | declarations
                and not any('getattr' in _bound_names(statement) for statement in module_tree.body)
                and len(node.args) == 3 and not node.keywords and isinstance(node.args[0], ast.Name)
                and node.args[0].id in module_names and node.args[0].id not in changed_members
                and isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str)
                and node.args[1].value.isidentifier() and node.args[1].value != func_node.name):
            contract['optionalLookups'].append({'owner': node.args[0].id, 'ownerScope': 'module-global',
                                                'attribute': node.args[1].value, 'defaultSource': ast.unparse(node.args[2]),
                                                'source': ast.unparse(node), 'line': node.lineno})
        if root in module_names and isinstance(node.func, (ast.Name, ast.Attribute)):
            contract['calls'].append({'callee': ast.unparse(node.func), 'args': [argument(arg) for arg in node.args],
                                      'keywords': [{'name': keyword.arg, **argument(keyword.value)} for keyword in node.keywords],
                                      'line': node.lineno})
        if len(contract['calls']) + len(contract['optionalLookups']) > MAX_FACTS:
            return unsupported('contract-limit-exceeded')
    if len(json.dumps(contract, ensure_ascii=False).encode('utf-8')) > MAX_BYTES:
        return unsupported('contract-limit-exceeded')
    return contract
