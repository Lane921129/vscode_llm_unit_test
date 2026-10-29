"""Source-only library provenance for skill selection, never runtime type proof."""
import ast
import hashlib
from source_setup_call_contract import build_source_setup_call_contract, _stable_module_names, _scope_nodes, _bound_names


def build_dependency_skill_facts(func_node, target_source, target_name, module_tree):
    normalized = target_source.replace('\r\n', '\n').replace('\r', '\n')
    result = {'schemaVersion': 'dependency-skill-facts-v1', 'target': target_name,
              'targetSourceHash': hashlib.sha256(normalized.encode('utf-8')).hexdigest(),
              'authority': 'skill-selection-only', 'assertionOracle': False, 'patchAuthorization': False,
              'status': 'complete', 'bindings': []}
    contract = build_source_setup_call_contract(func_node, target_source, target_name, module_tree)
    if contract['status'] != 'complete':
        return dict(result, status='unsupported')
    stable, changed_members = _stable_module_names(module_tree)
    stable -= changed_members
    definitions = {}
    for statement in module_tree.body:
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                definitions[alias.asname or alias.name.split('.')[0]] = (
                    'import', alias.name if alias.asname else alias.name.split('.')[0], statement.lineno)
        elif isinstance(statement, ast.ImportFrom) and statement.level == 0 and statement.module:
            for alias in statement.names:
                if alias.name != '*':
                    definitions[alias.asname or alias.name] = ('import', statement.module + '.' + alias.name, statement.lineno)
        elif isinstance(statement, (ast.Assign, ast.AnnAssign)):
            targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
            for target in targets:
                if isinstance(target, ast.Name) and statement.value is not None:
                    definitions[target.id] = ('expression', statement.value, statement.lineno)

    def expression(node, seen):
        if isinstance(node, ast.Name):
            return resolve(node.id, seen)
        if isinstance(node, ast.Attribute):
            parent = expression(node.value, seen)
            return (parent[0] + '.' + node.attr, parent[1]) if parent else None
        # Only initializer syntax is followed; no arguments are evaluated.
        if isinstance(node, ast.Call):
            parent = expression(node.func, seen)
            return (parent[0], 'factory-result') if parent else None
        return None

    def resolve(name, seen):
        if name not in stable or name in seen or len(seen) >= 8 or name not in definitions:
            return None
        kind, value, _ = definitions[name]
        if kind == 'import':
            return value, kind
        return expression(value, seen | {name})

    parameters = {arg.arg for arg in [*func_node.args.posonlyargs, *func_node.args.args, *func_node.args.kwonlyargs,
                  *(arg for arg in (func_node.args.vararg, func_node.args.kwarg) if arg)]}
    local = set().union(*(_bound_names(statement) for statement in func_node.body)) | parameters
    used = {node.id for statement in func_node.body for node in _scope_nodes(statement)
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)} - local
    for name in sorted(used):
        origin = resolve(name, set())
        if origin:
            result['bindings'].append({'name': name, 'origin': origin[0], 'kind': origin[1],
                                       'line': definitions[name][2]})
    if len(result['bindings']) > 64:
        return dict(result, status='unsupported', bindings=[])
    return result
