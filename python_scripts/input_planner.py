"""Bounded, syntax-only builtin input candidates, never expected results.

The planner does not import the target, evaluate annotations, execute defaults,
or compute a Cartesian product. Runtime tracing remains the only output oracle.
"""
import ast
import copy
import math

from trace_value_codec import restore_value, snapshot_value


SCHEMA_VERSION = 'input-plan-v1'
DEFAULT_LIMITS = {'max_cases': 24, 'max_values_per_parameter': 8,
                  'max_container_size': 4, 'max_depth': 4,
                  'max_parameters': 12, 'max_nodes': 512, 'max_text_length': 64}
_HARD_LIMITS = {'max_cases': 64, 'max_values_per_parameter': 16,
                'max_container_size': 16, 'max_depth': 6,
                'max_parameters': 32, 'max_nodes': 2048, 'max_text_length': 256}
_MISSING = object()


def _identity(value):
    """A deterministic type-sensitive key; ordered dictionaries stay ordered."""
    kind = type(value)
    if kind is dict:
        return ('dict', tuple((_identity(key), _identity(item)) for key, item in value.items()))
    if kind in (list, tuple):
        return (kind.__name__, tuple(map(_identity, value)))
    if kind in (set, frozenset):
        return (kind.__name__, tuple(sorted(map(_identity, value), key=repr)))
    return (kind.__name__, repr(value))


def _unique(values):
    seen, result = set(), []
    for value in values:
        key = _identity(value)
        if key not in seen:
            seen.add(key)
            result.append(value)
    return result


def _literal(node, limits, depth=0, remaining=None):
    """Read only bounded AST literals. ast.literal_eval on arbitrary trees is avoided."""
    remaining = remaining if remaining is not None else [limits['max_nodes']]
    remaining[0] -= 1
    if remaining[0] < 0 or depth > limits['max_depth']:
        return _MISSING
    if isinstance(node, ast.Constant):
        value = node.value
        if value is None or type(value) is bool:
            return value
        if type(value) is int and value.bit_length() <= 4096:
            return value
        if type(value) is float and math.isfinite(value):
            return value
        if type(value) in (str, bytes) and len(value) <= limits['max_text_length']:
            return value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = _literal(node.operand, limits, depth + 1, remaining)
        if type(value) in (int, float):
            return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)) and len(node.elts) <= limits['max_container_size']:
        values = [_literal(item, limits, depth + 1, remaining) for item in node.elts]
        if any(value is _MISSING for value in values):
            return _MISSING
        try:
            return list(values) if isinstance(node, ast.List) else tuple(values) if isinstance(node, ast.Tuple) else set(values)
        except TypeError:
            return _MISSING
    if isinstance(node, ast.Dict) and len(node.keys) <= limits['max_container_size']:
        keys = [_literal(item, limits, depth + 1, remaining) for item in node.keys]
        values = [_literal(item, limits, depth + 1, remaining) for item in node.values]
        if any(value is _MISSING for value in keys + values):
            return _MISSING
        try:
            return dict(zip(keys, values))
        except TypeError:
            return _MISSING
    return _MISSING


def _scope_nodes(target, limit):
    result, pending = [], list(reversed(target.body))
    while pending and len(result) < limit:
        node = pending.pop()
        result.append(node)
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda,
                                 ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            pending.extend(reversed(list(ast.iter_child_nodes(node))))
    return result, bool(pending)


def _accepts(shape, value, depth=0):
    if depth > 8 or type(shape) is not dict:
        return False
    kind = shape.get('kind')
    if kind == 'scalar':
        expected = {'int': int, 'float': float, 'bool': bool, 'str': str, 'bytes': bytes, 'none': type(None)}.get(shape.get('name'))
        return expected is not None and type(value) is expected
    if kind == 'union':
        return any(_accepts(member, value, depth + 1) for member in shape.get('members', []))
    if kind == 'literal':
        for snapshot in shape.get('values', []):
            try:
                if _identity(restore_value(snapshot)) == _identity(value):
                    return True
            except ValueError:
                pass
        return False
    expected = {'list': list, 'tuple': tuple, 'dict': dict, 'set': set, 'frozenset': frozenset}.get(kind)
    if expected is None or type(value) is not expected:
        return False
    if kind == 'dict':
        return all(_accepts(shape.get('key'), key, depth + 1) and _accepts(shape.get('value'), item, depth + 1) for key, item in value.items())
    if kind == 'tuple' and not shape.get('variadic'):
        elements = shape.get('elements', [])
        return len(value) == len(elements) and all(_accepts(child, item, depth + 1) for child, item in zip(elements, value))
    return all(_accepts(shape.get('element'), item, depth + 1) for item in value)


def _coerce_candidate(shape, value):
    if _accepts(shape, value):
        return value
    if type(shape) is dict and shape.get('kind') == 'union':
        for member in shape.get('members', []):
            converted = _coerce_candidate(member, value)
            if converted is not _MISSING:
                return converted
    if type(shape) is dict and shape.get('kind') == 'scalar' and shape.get('name') == 'float' and type(value) is int:
        try:
            converted = float(value)
            return converted if math.isfinite(converted) else _MISSING
        except OverflowError:
            pass
    return _MISSING


class _Planner:
    def __init__(self, limits):
        self.limits = dict(DEFAULT_LIMITS)
        for name, maximum in _HARD_LIMITS.items():
            value = (limits or {}).get(name)
            if type(value) is int and value > 0:
                self.limits[name] = min(value, maximum)
        self.diagnostics = []
        self.remaining = self.limits['max_nodes']
        self.inferred = {}

    def diagnostic(self, name, code, reason):
        item = {'parameter': name, 'code': code, 'reason': reason}
        if item not in self.diagnostics:
            self.diagnostics.append(item)

    def values(self, shape, name, depth=0):
        self.remaining -= 1
        if self.remaining < 0 or depth > self.limits['max_depth']:
            self.diagnostic(name, 'budget-exceeded', 'shape-depth-or-node-budget')
            return []
        if type(shape) is not dict:
            self.diagnostic(name, 'needs-input', 'invalid-type-shape')
            return []
        kind = shape.get('kind')
        if kind == 'scalar':
            return {'int': [1, 0, -1, 2, 100, -100], 'float': [1.0, 0.0, -1.0, 0.5, 10.0],
                    'bool': [True, False], 'str': ['test_value', '', 'x', 'xx'],
                    'bytes': [b'x', b'', b'xy'], 'none': [None]}.get(shape.get('name'), [])
        if kind == 'literal':
            result = []
            for snapshot in shape.get('values', [])[:self.limits['max_values_per_parameter']]:
                try:
                    value = restore_value(snapshot)
                    if value is None or type(value) in (int, float, bool, str, bytes):
                        result.append(value)
                except ValueError:
                    self.diagnostic(name, 'needs-input', 'invalid-literal-snapshot')
            return _unique(result)
        if kind == 'union':
            choices = [self.values(member, name, depth + 1) for member in shape.get('members', [])[:16]]
            return _unique([values[index] for index in range(self.limits['max_values_per_parameter'])
                            for values in choices if len(values) > index])[:self.limits['max_values_per_parameter']]
        if kind == 'unknown':
            reason = shape.get('reason', 'unresolved-type')
            self.diagnostic(name, 'needs-fixture' if shape.get('name') else 'needs-input', reason)
            return []
        if kind == 'tuple' and not shape.get('variadic'):
            elements = shape.get('elements', [])
            if len(elements) > self.limits['max_container_size']:
                self.diagnostic(name, 'budget-exceeded', 'fixed-tuple-size')
                return []
            values = [self.values(child, name, depth + 1) for child in elements]
            if any(not options for options in values):
                return []
            baseline = tuple(copy.deepcopy(options[0]) for options in values)
            result = [baseline]
            for index, options in enumerate(values):
                for alternative in options[1:4]:
                    changed = list(copy.deepcopy(baseline))
                    changed[index] = copy.deepcopy(alternative)
                    result.append(tuple(changed))
            return _unique(result)[:self.limits['max_values_per_parameter']]
        if kind == 'dict':
            keys = self.values(shape.get('key'), name, depth + 1)
            values = self.values(shape.get('value'), name, depth + 1)
            usable = []
            for key in keys:
                try:
                    hash(key)
                    if key not in usable:
                        usable.append(key)
                except TypeError:
                    continue
            if not usable or not values:
                return [{}]
            result = [{copy.deepcopy(usable[0]): copy.deepcopy(values[0])}, {}]
            if len(usable) >= 2 and self.limits['max_container_size'] >= 2:
                result.append({copy.deepcopy(key): copy.deepcopy(values[index % len(values)]) for index, key in enumerate(usable[:2])})
            result.extend({copy.deepcopy(usable[0]): copy.deepcopy(value)} for value in values[1:4])
            return _unique(result)
        constructors = {'list': list, 'tuple': tuple, 'set': set, 'frozenset': frozenset}
        if kind in constructors:
            values = self.values(shape.get('element'), name, depth + 1)
            constructor = constructors[kind]
            if kind in ('set', 'frozenset'):
                values = [value for value in values if _hashable(value)]
            if not values:
                return [constructor()]
            result = [constructor([copy.deepcopy(values[0])]), constructor()]
            if self.limits['max_container_size'] >= 2:
                result.append(constructor(copy.deepcopy(values[index % len(values)]) for index in range(2)))
            result.extend(constructor([copy.deepcopy(value)]) for value in values[1:4])
            return _unique(result)
        self.diagnostic(name, 'needs-input', 'unsupported-type-shape')
        return []

    def sized(self, shape, size, name):
        if type(size) is not int or size < 0 or type(shape) is not dict:
            return _MISSING
        kind = shape.get('kind')
        if kind == 'union':
            for member in shape.get('members', []):
                value = self.sized(member, size, name)
                if value is not _MISSING:
                    return value
            return _MISSING
        if kind == 'scalar' and shape.get('name') in ('str', 'bytes'):
            if size > self.limits['max_text_length']:
                self.diagnostic(name, 'budget-exceeded', 'condition-text-size')
                return _MISSING
            return ('x' if shape['name'] == 'str' else b'x') * size
        if size > self.limits['max_container_size']:
            self.diagnostic(name, 'budget-exceeded', 'condition-container-size')
            return _MISSING
        if kind == 'tuple' and not shape.get('variadic'):
            options = self.values(shape, name)
            return options[0] if options and len(options[0]) == size else _MISSING
        if kind not in ('list', 'tuple', 'set', 'frozenset', 'dict'):
            return _MISSING
        constructor = {'list': list, 'tuple': tuple, 'set': set, 'frozenset': frozenset, 'dict': dict}[kind]
        if size == 0:
            return constructor()
        options = self.values(shape.get('key') if kind == 'dict' else shape.get('element'), name)
        if not options:
            return _MISSING
        if kind in ('dict', 'set', 'frozenset'):
            options = [value for value in options if _hashable(value)]
            # No invented keys for a finite Literal domain or equality collisions.
            options = list(dict.fromkeys(options))
            if len(options) < size:
                return _MISSING
        if kind == 'dict':
            values = self.values(shape.get('value'), name)
            return {copy.deepcopy(key): copy.deepcopy(values[0]) for key in options[:size]} if values else _MISSING
        return constructor(copy.deepcopy(options[index % len(options)]) for index in range(size))


def _hashable(value):
    try:
        hash(value)
        return True
    except TypeError:
        return False


def _subject(node, names, allow_len):
    if isinstance(node, ast.Name) and node.id in names:
        return node.id, 'value'
    if allow_len and isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'len' and len(node.args) == 1 and not node.keywords:
        if isinstance(node.args[0], ast.Name) and node.args[0].id in names:
            return node.args[0].id, 'length'
    return None


def _comparison(node, names, allow_len, limits):
    if not isinstance(node, ast.Compare) or len(node.ops) != 1 or len(node.comparators) != 1:
        return None
    subject = _subject(node.left, names, allow_len)
    other, operator = node.comparators[0], node.ops[0]
    if subject:
        return subject, operator, other
    subject = _subject(other, names, allow_len)
    reverse = {ast.Lt: ast.Gt, ast.LtE: ast.GtE, ast.Gt: ast.Lt, ast.GtE: ast.LtE, ast.Eq: ast.Eq, ast.NotEq: ast.NotEq,
               ast.Is: ast.Is, ast.IsNot: ast.IsNot}.get(type(operator))
    if subject and reverse and _literal(node.left, limits) is not _MISSING:
        return subject, reverse(), node.left
    return None


def _test(operator, left, right):
    try:
        if isinstance(operator, ast.Eq): return left == right
        if isinstance(operator, ast.NotEq): return left != right
        if isinstance(operator, ast.Lt): return left < right
        if isinstance(operator, ast.LtE): return left <= right
        if isinstance(operator, ast.Gt): return left > right
        if isinstance(operator, ast.GtE): return left >= right
        if isinstance(operator, ast.In): return left in right
        if isinstance(operator, ast.NotIn): return left not in right
        if isinstance(operator, ast.Is): return left is right
        if isinstance(operator, ast.IsNot): return left is not right
    except (TypeError, ValueError):
        pass
    return False


def plan_inputs(tree, target_node, parameter_shapes, *, method_kind='module', excluded_names=(), limits=None):
    """Return native builtin call candidates plus serializable planning diagnostics.

    ``cases`` are tool-owned values for snapshot encoding, not JSON-compatible
    copies. Every case is a candidate with ``intent='valid'`` (shape-conforming,
    not a promise of successful execution). Defaults may be omitted without
    evaluating their expressions. Unknown explicit types are never guessed.
    """
    planner = _Planner(limits)
    bounds = planner.limits
    if not isinstance(target_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return {'schema_version': SCHEMA_VERSION, 'cases': [], 'diagnostics': [{'parameter': None, 'code': 'needs-input', 'reason': 'invalid-target'}],
                'limits': bounds, 'stats': {'cases': 0, 'parameters': 0}, 'inferred_shapes': {}}
    all_positional = list(target_node.args.posonlyargs) + list(target_node.args.args)
    defaults = dict(zip([item.arg for item in all_positional][-len(target_node.args.defaults):], target_node.args.defaults)) if target_node.args.defaults else {}
    defaults.update({item.arg: default for item, default in zip(target_node.args.kwonlyargs, target_node.args.kw_defaults) if default is not None})
    excluded = set(excluded_names)
    if method_kind in ('instance', 'class', 'property') and all_positional:
        excluded.add(all_positional[0].arg)
    positional = [item.arg for item in all_positional if item.arg not in excluded]
    keyword_only = [item.arg for item in target_node.args.kwonlyargs if item.arg not in excluded]
    names = positional + keyword_only
    result = {'schema_version': SCHEMA_VERSION, 'cases': [], 'diagnostics': planner.diagnostics,
              'limits': bounds, 'stats': {'cases': 0, 'parameters': len(names)}, 'inferred_shapes': planner.inferred}
    if len(names) > bounds['max_parameters']:
        planner.diagnostic(None, 'budget-exceeded', 'parameter-count')
        return result
    nodes, truncated = _scope_nodes(target_node, bounds['max_nodes'])
    if truncated:
        planner.diagnostic(None, 'budget-exceeded', 'source-node-budget')
    # A rebound parameter is no longer a direct input condition. Nested scopes
    # are excluded, and builtin len must remain unshadowed before using it.
    rebound = {node.id for node in nodes if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del))}
    direct_names = set(names) - rebound
    module_len = any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == 'len'
                     or isinstance(node, (ast.Assign, ast.AnnAssign, ast.Import, ast.ImportFrom)) and any(isinstance(child, ast.Name) and child.id == 'len' and isinstance(child.ctx, ast.Store)
                         or isinstance(child, ast.alias) and (child.asname or child.name.split('.')[0]) == 'len' for child in ast.walk(node)) for node in getattr(tree, 'body', []))
    allow_len = 'len' not in set(names) | rebound and not module_len
    shapes = {name: parameter_shapes.get(name, {'kind': 'unknown', 'reason': 'missing-annotation'}) for name in names}
    missing = {name for name, shape in shapes.items() if shape.get('kind') == 'unknown' and shape.get('reason') == 'missing-annotation'}
    default_values = {name: _literal(node, bounds) for name, node in defaults.items() if name in names}
    inferred_values = {name: [] for name in missing}
    numeric = set()
    for node in nodes:
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Div, ast.FloorDiv, ast.Mod, ast.Pow, ast.Sub)):
            numeric.update(child.id for child in ast.walk(node) if isinstance(child, ast.Name) and child.id in missing & direct_names)
        parts = _comparison(node, direct_names, allow_len, bounds)
        if parts and parts[0][0] in missing and parts[0][1] == 'value':
            literal = _literal(parts[2], bounds)
            if literal is not _MISSING:
                candidates = list(literal) if isinstance(parts[1], (ast.In, ast.NotIn)) and type(literal) in (list, tuple, set) else [literal]
                inferred_values[parts[0][0]].extend(value for value in candidates if value is None or type(value) in (str, bytes, bool, int, float))
        if isinstance(node, ast.Match) and isinstance(node.subject, ast.Name) and node.subject.id in missing & direct_names:
            for child in ast.walk(node):
                if isinstance(child, ast.MatchValue):
                    literal = _literal(child.value, bounds)
                    if literal is not _MISSING:
                        inferred_values[node.subject.id].append(literal)
                elif isinstance(child, ast.MatchSingleton):
                    inferred_values[node.subject.id].append(child.value)
    for name in missing:
        values = inferred_values[name]
        if default_values.get(name, _MISSING) is not _MISSING:
            values.insert(0, default_values[name])
        if name in numeric:
            # Relative scales are emitted as paired cases below. Repeating each
            # scale independently wastes probe slots and bloats repair prompts.
            values.extend([1, 0, -1, 0.5])
        values = _unique(values)
        if values:
            inferred_values[name] = values
            planner.inferred[name] = {'kind': 'source-inferred', 'reason': 'numeric-operation' if name in numeric else 'literal-default-or-condition',
                                      'types': sorted({type(value).__name__ for value in values})}
    options = {}
    for name in names:
        if name in missing and inferred_values[name]:
            options[name] = inferred_values[name]
        else:
            options[name] = planner.values(shapes[name], name)
        default = default_values.get(name, _MISSING)
        if default is not _MISSING and (name in missing or _accepts(shapes[name], default)):
            options[name] = _unique([copy.deepcopy(default)] + options[name])
        elif name in defaults and default is _MISSING:
            planner.diagnostic(name, 'needs-fixture', 'non-literal-default-not-executed')

    def admit(name, value):
        if value is _MISSING:
            return _MISSING
        if name in missing and inferred_values[name]:
            allowed = {type(item) for item in inferred_values[name]}
            return value if type(value) in allowed else _MISSING
        return _coerce_candidate(shapes[name], value)

    source_options = {name: [] for name in names}
    conditions, relations, indexes = [], [], []

    def add_source(name, value, node, reason):
        value = admit(name, value)
        if value is not _MISSING:
            source_options[name].append((value, {'source': 'source-condition', 'parameter': name, 'reason': reason,
                                                'line': node.lineno, 'intent': 'valid'}))

    for node in nodes:
        parts = _comparison(node, direct_names, allow_len, bounds)
        if parts:
            (name, mode), operator, right = parts
            if mode == 'value' and isinstance(right, ast.Name) and right.id in direct_names:
                if isinstance(operator, (ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Eq, ast.NotEq)):
                    relations.append((name, right.id, node))
                continue
            literal = _literal(right, bounds)
            if literal is _MISSING:
                continue
            conditions.append((node, name, mode, operator, literal))
            if mode == 'length' and type(literal) is int and literal >= 0:
                for size in (max(0, literal - 1), literal, literal + 1):
                    add_source(name, planner.sized(shapes[name], size, name), node, 'length-boundary')
            elif mode == 'value':
                if isinstance(operator, (ast.In, ast.NotIn)) and type(literal) in (list, tuple, set):
                    for value in literal:
                        add_source(name, value, node, 'membership-literal')
                else:
                    add_source(name, literal, node, 'comparison-literal')
                literals = list(literal) if isinstance(operator, (ast.In, ast.NotIn)) and type(literal) in (list, tuple, set) else [literal]
                for value in literals:
                    if type(value) in (int, float):
                        for delta in (-1, 1):
                            add_source(name, value + delta, node, 'numeric-boundary')
                    elif type(value) is str:
                        alternative = '__other_value__'
                        while alternative in literals:
                            alternative += '_'
                        add_source(name, alternative, node, 'nonmatching-literal')
                    elif type(value) is bool:
                        add_source(name, not value, node, 'boolean-boundary')
        if isinstance(node, (ast.If, ast.While, ast.IfExp)):
            condition = node.test.operand if isinstance(node.test, ast.UnaryOp) and isinstance(node.test.op, ast.Not) else node.test
            if isinstance(condition, ast.Name) and condition.id in direct_names:
                for candidate in options[condition.id]:
                    add_source(condition.id, candidate, node, 'direct-truthiness')
        if isinstance(node, ast.Match) and isinstance(node.subject, ast.Name) and node.subject.id in direct_names:
            name = node.subject.id
            for case in node.cases:
                if case.guard is not None:
                    continue
                for child in ast.walk(case.pattern):
                    literal = _literal(child.value, bounds) if isinstance(child, ast.MatchValue) else child.value if isinstance(child, ast.MatchSingleton) else _MISSING
                    add_source(name, literal, node, 'match-literal')
                    if type(literal) is str:
                        add_source(name, '__other_value__', node, 'match-nonmatching-literal')
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id in direct_names:
            index = _literal(node.slice, bounds)
            if type(index) is int or isinstance(node.slice, ast.Name) and node.slice.id in direct_names:
                indexes.append((node.value.id, node.slice, node))

    required_unknown = [name for name in names if name not in defaults and not options[name] and not source_options[name]]
    if required_unknown:
        return result
    baseline = {name: copy.deepcopy(options[name][0] if options[name] else source_options[name][0][0])
                for name in names if options[name] or source_options[name]}
    seen = set()
    omitted = set()
    posonly = {item.arg for item in target_node.args.posonlyargs}

    def emit(assignments, metadata, omit=()):
        values = {**baseline, **assignments}
        omit = set(omit)
        args, kwargs = [], {}
        hole = False
        for name in positional:
            if name in omit or name not in values:
                hole = True
                continue
            if hole:
                if name in posonly:
                    return
                kwargs[name] = copy.deepcopy(values[name])
            else:
                args.append(copy.deepcopy(values[name]))
        kwargs.update({name: copy.deepcopy(values[name]) for name in keyword_only if name in values and name not in omit})
        key = _identity((args, kwargs))
        if key in seen:
            # A baseline can equal a source boundary. Preserve that stronger
            # provenance so caller-guided Trace does not filter out the boundary.
            if metadata.get('source') == 'source-condition':
                for case in result['cases']:
                    if _identity((case['args'], case['kwargs'])) == key:
                        case['metadata'] = {'intent': 'valid', **metadata}
                        break
            return
        if len(result['cases']) >= bounds['max_cases']:
            planner.diagnostic(None, 'budget-exceeded', 'case-count')
            return
        seen.add(key)
        result['cases'].append({'args': args, 'kwargs': kwargs, 'metadata': {'intent': 'valid', **metadata}})

    # Put conjunction and source-proven relations near the baseline so a tight
    # case limit does not consume every slot on one parameter's easy values.
    emit({}, {'source': 'shape-baseline', 'reason': 'baseline'})
    for node in nodes:
        if not isinstance(node, ast.BoolOp) or not isinstance(node.op, ast.And):
            continue
        terms = []
        def flatten(term):
            if isinstance(term, ast.BoolOp) and isinstance(term.op, ast.And):
                for item in term.values:
                    flatten(item)
            else:
                terms.append(term)
        flatten(node)
        chosen, supported = {}, True
        grouped = {}
        for term in terms:
            found = next((item for item in conditions if item[0] is term), None)
            if found:
                grouped.setdefault(found[1], []).append(found)
            elif isinstance(term, ast.Name) and term.id in direct_names or isinstance(term, ast.UnaryOp) and isinstance(term.op, ast.Not) and isinstance(term.operand, ast.Name) and term.operand.id in direct_names:
                name = term.id if isinstance(term, ast.Name) else term.operand.id
                grouped.setdefault(name, []).append((term, name, 'truth', isinstance(term, ast.Name), None))
            else:
                supported = False
                break
        for name, checks in grouped.items():
            choices = _unique([item[0] for item in source_options[name]] + options[name])[:bounds['max_values_per_parameter']]
            def satisfies(value):
                for _, _, mode, operator, other in checks:
                    if mode == 'truth':
                        if bool(value) is not operator: return False
                    elif mode == 'length':
                        if type(value) not in (str, bytes, list, tuple, dict, set, frozenset) or not _test(operator, len(value), other): return False
                    elif not _test(operator, value, other): return False
                return True
            selection = next((value for value in choices if satisfies(value)), _MISSING)
            if selection is _MISSING:
                supported = False
                break
            chosen[name] = selection
        if supported and chosen:
            emit(chosen, {'source': 'source-condition', 'reason': 'and-conjunction', 'line': node.lineno})
    for left, right, node in relations:
        for a, b in ((0, 0), (0, 1), (1, 0)):
            first, second = admit(left, a), admit(right, b)
            if first is not _MISSING and second is not _MISSING:
                emit({left: first, right: second}, {'source': 'source-condition', 'reason': 'parameter-relation', 'line': node.lineno})
    if len(numeric) == 2:
        ordered = [name for name in names if name in numeric]
        # Probe zero in each operand independently before spending the bounded
        # case budget on ordinary values. Execution determines exception facts.
        for name in ordered:
            emit({name: 0}, {'source': 'source-condition', 'reason': 'numeric-zero-operand',
                             'parameter': name, 'line': target_node.lineno})
        for a, b in ((10, 200), (50, 150), (100, 200), (200, 100)):
            emit(dict(zip(ordered, (a, b))), {'source': 'source-condition', 'reason': 'numeric-operation-relative-scales',
                                           'line': target_node.lineno})
    for name, index_node, node in indexes:
        index = _literal(index_node, bounds)
        if type(index) is int:
            value = planner.sized(shapes[name], max(index + 1, abs(index)), name)
            if value is not _MISSING:
                emit({name: value}, {'source': 'source-condition', 'reason': 'literal-container-index', 'parameter': name, 'line': node.lineno})
        elif isinstance(index_node, ast.Name):
            for index in (0, 1):
                value, offset = planner.sized(shapes[name], index + 1, name), admit(index_node.id, index)
                if value is not _MISSING and offset is not _MISSING:
                    emit({name: value, index_node.id: offset}, {'source': 'source-condition', 'reason': 'container-index-relation', 'line': node.lineno})
    for name in names:
        if name in defaults:
            omitted.add(name)
            # A positional-only omission may require omitting its defaulted tail.
            trailing = {item for item in positional[positional.index(name):] if item in defaults} if name in posonly else {name}
            emit({}, {'source': 'default-omission', 'parameter': name, 'reason': 'omit-default'}, trailing)
        choices = source_options[name] + [(value, {'source': 'shape-variation', 'parameter': name, 'reason': 'one-parameter-variation'}) for value in options[name]]
        used = set()
        for value, metadata in choices:
            key = _identity(value)
            if key in used:
                continue
            if len(used) >= bounds['max_values_per_parameter']:
                planner.diagnostic(name, 'budget-exceeded', 'parameter-value-count')
                break
            used.add(key)
            emit({name: value}, metadata)
    if omitted:
        emit({}, {'source': 'default-omission', 'reason': 'omit-all-defaults'}, omitted)
    result['stats']['cases'] = len(result['cases'])
    result['stats']['source_nodes'] = len(nodes)
    return result
