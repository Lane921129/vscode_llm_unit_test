"""Source-only receiver shapes for fixture planning, never assertion evidence.

No application imports, evaluation, execution, or inferred dependency types.
Only straight-line call results and explicit context-manager entry are linked.
"""
import ast
import builtins
import copy
import hashlib


VERSION = 'dependency-fixture-contract-v1'
MAX_FLOWS = 128
MAX_DIAGNOSTICS = 64
NESTED = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
CONTROL = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try)
if hasattr(ast, 'Match'):
    CONTROL += (ast.Match,)
if hasattr(ast, 'TryStar'):
    CONTROL += (ast.TryStar,)


def _names(node):
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, (ast.Tuple, ast.List)):
        return set().union(*(_names(item) for item in node.elts)) if node.elts else set()
    if isinstance(node, ast.Starred):
        return _names(node.value)
    return set()


def _writes(node):
    """Local names affected by a skipped statement, without nested bodies."""
    if isinstance(node, NESTED):
        return {node.name} if hasattr(node, 'name') else set()
    result = set()
    if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
        result.add(node.id)
    if isinstance(node, (ast.Attribute, ast.Subscript)) and isinstance(node.ctx, (ast.Store, ast.Del)):
        base = node
        while isinstance(base, (ast.Attribute, ast.Subscript)):
            base = base.value
        if isinstance(base, ast.Name):
            result.add(base.id)
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        result.update(alias.asname or alias.name.split('.')[0] for alias in node.names)
    if isinstance(node, ast.ExceptHandler) and node.name:
        result.add(node.name)
    for child in ast.iter_child_nodes(node):
        result.update(_writes(child))
    return result


def build_dependency_fixture_contract(func_node, target_source, target_name, module_bindings=()):
    """Describe lexical receiver paths; these facts do not authorize patches.

    ``targetSourceHash`` hashes the supplied LF-normalized target fragment,
    explicitly not the complete file's raw bytes. Lines retain file positions.
    A parameter's methods describe required shape, not a demand to mock it.
    """
    normalized = target_source.replace('\r\n', '\n').replace('\r', '\n')
    contract = {
        'schemaVersion': VERSION, 'target': target_name,
        'targetSourceHash': hashlib.sha256(normalized.encode('utf-8')).hexdigest(),
        'sourceHashKind': 'normalized-target-source',
        'startLine': func_node.lineno, 'endLine': func_node.end_lineno,
        'authority': 'fixture-shape-only', 'assertionOracle': False, 'patchAuthorization': False,
        'status': 'complete', 'flows': [], 'diagnostics': [],
    }
    arguments = [*func_node.args.posonlyargs, *func_node.args.args, *func_node.args.kwonlyargs]
    arguments += [arg for arg in (func_node.args.vararg, func_node.args.kwarg) if arg]
    parameters = {arg.arg for arg in arguments}
    target_receiver = (arguments[0].arg if arguments and '.' in target_name
                       and not any(isinstance(item, ast.Name) and item.id == 'staticmethod'
                                   for item in func_node.decorator_list) else None)
    local_names = parameters | set().union(*(_writes(stmt) for stmt in func_node.body))
    module_names = set(module_bindings)
    bindings = {name: {'root': {'kind': 'parameter', 'name': name}, 'steps': []} for name in parameters}
    assigned = set(parameters)
    diagnostics = set()
    overflow = False

    def diagnostic(code, node, name=None):
        nonlocal overflow
        key = (code, getattr(node, 'lineno', func_node.lineno), name)
        if key in diagnostics:
            return
        diagnostics.add(key)
        if len(contract['diagnostics']) >= MAX_DIAGNOSTICS:
            overflow = True
            return
        contract['diagnostics'].append({'code': code, 'line': key[1], **({'name': name} if name else {})})

    def unknown_binding(name, node, code=None):
        bindings.pop(name, None)
        assigned.add(name)
        if code:
            diagnostic(code, node, name)

    def expression(node):
        nonlocal overflow
        if isinstance(node, NESTED):
            diagnostic('nested-callable-skipped', node)
            return None
        if isinstance(node, ast.Name):
            if node.id == target_receiver:
                diagnostic('target-instance-not-fixture', node, node.id)
                return None
            if node.id in bindings:
                return copy.deepcopy(bindings[node.id])
            if node.id == func_node.name:
                diagnostic('target-call-not-fixture', node, node.id)
            elif node.id not in local_names and node.id in module_names:
                return {'root': {'kind': 'use-point', 'name': node.id}, 'steps': []}
            elif node.id not in vars(builtins) or node.id in local_names:
                diagnostic('receiver-unresolved', node, node.id)
            return None
        if isinstance(node, ast.Attribute):
            base = expression(node.value)
            if base:
                base['steps'].append({'kind': 'member', 'name': node.attr})
            return base
        if isinstance(node, ast.Call):
            callee = expression(node.func)
            for arg in [*node.args, *(keyword.value for keyword in node.keywords)]:
                observe_expression(arg)
            if callee is None:
                if not isinstance(node.func, ast.Name):
                    diagnostic('callable-unresolved', node)
                return None
            steps = callee['steps']
            method = steps[-1]['name'] if steps and steps[-1]['kind'] == 'member' else None
            receiver_steps = steps[:-1] if method is not None else steps
            if len(contract['flows']) >= MAX_FLOWS:
                overflow = True
                return None
            contract['flows'].append({'root': copy.deepcopy(callee['root']), 'steps': copy.deepcopy(receiver_steps),
                                      'method': method, 'line': node.lineno, 'receiverSource': ast.unparse(node.func)})
            callee['steps'].append({'kind': 'return_value'})
            return callee
        if isinstance(node, (ast.Await, ast.IfExp, ast.BoolOp, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp,
                             ast.NamedExpr, ast.Subscript)):
            diagnostic('expression-flow-unsupported', node)
            for name in _writes(node):
                unknown_binding(name, node)
            return None
        return None

    def observe_expression(node):
        if isinstance(node, (ast.Call, ast.Await, ast.IfExp, ast.BoolOp, ast.ListComp, ast.SetComp, ast.DictComp,
                             ast.GeneratorExp, ast.NamedExpr) + NESTED):
            return expression(node)
        for child in ast.iter_child_nodes(node):
            observe_expression(child)
        return None

    def bind(name, value, node):
        if name in assigned:
            unknown_binding(name, node, 'rebound-receiver-unsupported')
        elif value is not None:
            bindings[name] = value
            assigned.add(name)
            if contract['flows']:
                contract['flows'][-1]['resultBinding'] = name
        else:
            unknown_binding(name, node)

    def statements(body):
        nonlocal overflow
        for stmt in body:
            if isinstance(stmt, NESTED):
                for name in _writes(stmt):
                    unknown_binding(name, stmt)
                diagnostic('nested-callable-skipped', stmt)
            elif isinstance(stmt, CONTROL):
                for name in _writes(stmt):
                    unknown_binding(name, stmt)
                diagnostic('control-flow-skipped', stmt)
            elif isinstance(stmt, (ast.Global, ast.Nonlocal)):
                for name in stmt.names:
                    local_names.add(name)
                    unknown_binding(name, stmt, 'scope-declaration-unsupported')
            elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                value = expression(stmt.value) if isinstance(stmt.value, ast.Call) else None
                if stmt.value is not None and not isinstance(stmt.value, ast.Call):
                    observe_expression(stmt.value)
                if len(targets) == 1 and isinstance(targets[0], ast.Name):
                    if isinstance(stmt.value, (ast.Name, ast.Attribute)):
                        diagnostic('alias-binding-unsupported', stmt, targets[0].id)
                    bind(targets[0].id, value, stmt)
                else:
                    for target in targets:
                        for name in _names(target):
                            unknown_binding(name, stmt)
                        if isinstance(target, (ast.Attribute, ast.Subscript)):
                            base = target
                            while isinstance(base, (ast.Attribute, ast.Subscript)):
                                base = base.value
                            if isinstance(base, ast.Name):
                                unknown_binding(base.id, stmt, 'receiver-mutation-unsupported')
                    diagnostic('assignment-shape-unsupported', stmt)
            elif isinstance(stmt, ast.With):
                for item in stmt.items:
                    value = expression(item.context_expr)
                    if value is not None:
                        if len(contract['flows']) >= MAX_FLOWS:
                            overflow = True
                            value = None
                        else:
                            contract['flows'].append({'root': copy.deepcopy(value['root']), 'steps': copy.deepcopy(value['steps']),
                                                      'method': '__enter__', 'line': stmt.lineno,
                                                      'receiverSource': ast.unparse(item.context_expr), 'implicitContextEntry': True})
                    if value is not None:
                        value['steps'].append({'kind': 'context-enter'})
                    if isinstance(item.optional_vars, ast.Name):
                        bind(item.optional_vars.id, value, stmt)
                    elif item.optional_vars is not None:
                        for name in _names(item.optional_vars):
                            unknown_binding(name, stmt)
                        diagnostic('context-binding-unsupported', stmt)
                statements(stmt.body)
            elif isinstance(stmt, (ast.AsyncWith, ast.AugAssign, ast.Delete, ast.Import, ast.ImportFrom)):
                for name in _writes(stmt):
                    unknown_binding(name, stmt)
                diagnostic('statement-flow-unsupported', stmt)
            else:
                for child in ast.iter_child_nodes(stmt):
                    observe_expression(child)
                if isinstance(stmt, (ast.Return, ast.Raise, ast.Break, ast.Continue)):
                    break

    statements(func_node.body)
    if overflow:
        # Never present a silently truncated path graph as a usable contract.
        contract.update(status='unsupported', flows=[], diagnostics=[{'code': 'contract-limit-exceeded', 'line': func_node.lineno}])
    elif contract['diagnostics']:
        contract['status'] = 'partial'
    return contract
