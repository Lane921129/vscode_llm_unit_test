"""Bounded quality experiments from passing literal calls, not model oracles.

The planner never imports the target. Each experiment runs in a fresh guarded
worker. Exact builtin results/state/exception arguments are evidence for the
Writer, never automatically generated or merged tests in the production route.
No arbitrary state assignment, generated code, or other method is executed.
"""
import ast
import builtins
import copy
import hashlib
import io
import json
import keyword
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import types
from contextlib import redirect_stdout, redirect_stderr

from basic_mutation_runner import find_target_scope, mutation_scope_walk
from trace_value_codec import snapshot_value, restore_value, type_field

VERSION = 'quality-experiment-result-v2'
EXPERIMENT_VERSION = 'quality-experiment-v2'
MAX_CASES = 6
MAX_CALLS = 2


class ExperimentUnsupported(ValueError):
    """Host-owned bounded reason; application exception text is never rendered."""


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False)


def fingerprint(experiment):
    # Gap wording and method names must not reset experiment identity. State
    # and exception observations are a stronger experiment than return-only.
    return digest(canonical({key: experiment[key] for key in
        ('schemaVersion', 'sourceHash', 'target', 'constructor', 'calls', 'observe', 'context')}))


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted(node.value)
        return parent + '.' + node.attr if parent else ''
    return ''


def literal(node, bindings=None):
    if isinstance(node, ast.Name) and bindings and node.id in bindings:
        return copy.deepcopy(bindings[node.id])
    value = ast.literal_eval(node)
    if not snapshot_value(value)['replayable']:
        raise ValueError('unsupported-literal')
    return value


def call_values(call, bindings=None):
    if len(call.args) > 6 or len(call.keywords) > 6 or any(k.arg is None for k in call.keywords):
        raise ValueError('unsupported-call')
    return {'args': [literal(node, bindings) for node in call.args],
            'kwargs': {k.arg: literal(k.value, bindings) for k in call.keywords}}


def class_contract(source, target):
    tree = ast.parse(source)
    parts = target.split('.')
    if len(parts) != 2 or any(not p.isidentifier() or keyword.iskeyword(p) for p in parts):
        raise ValueError('instance-target-required')
    classes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == parts[0]]
    if len(classes) != 1:
        raise ValueError('ambiguous-class')
    cls = classes[0]
    if cls.decorator_list or cls.keywords or any(not isinstance(b, ast.Name) or b.id != 'object' for b in cls.bases):
        raise ValueError('class-inheritance-or-decorator')
    methods = [n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    forbidden = {'__new__', '__getattribute__', '__getattr__', '__setattr__', '__delattr__', '__del__'}
    if any(n.name in forbidden or n.decorator_list for n in methods):
        raise ValueError('class-descriptor-or-hook')
    if any(isinstance(n, (ast.Assign, ast.AnnAssign)) and any(
            isinstance(x, ast.Name) and x.id in ('__slots__', '__dict__') for x in ast.walk(n)) for n in cls.body):
        raise ValueError('class-slots-or-dictionary-hook')
    found = [n for n in methods if n.name == parts[1]]
    if len(found) != 1 or not isinstance(found[0], ast.FunctionDef):
        raise ValueError('synchronous-instance-method-required')
    method = found[0]
    args = method.args.posonlyargs + method.args.args
    if not args or method.args.vararg or method.args.kwarg or any(isinstance(n, (ast.Yield, ast.YieldFrom, ast.Await)) for n in ast.walk(method)):
        raise ValueError('unsupported-instance-signature')
    receiver = args[0].arg
    attributes = sorted({n.attr for n in mutation_scope_walk(method)
                         if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name)
                         and n.value.id == receiver and n.attr != parts[1]})
    if not attributes or len(attributes) > 4 or any(a.startswith('__') for a in attributes):
        raise ValueError('bounded-plain-state-required')
    return tree, cls, method, attributes


def passing_seeds(code, module, class_name, method_name):
    """Static literal calls only. No invocation of test code or fixture helpers."""
    tree = ast.parse(code)
    constructors = set()
    mock_bindings = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module and (node.module == 'unittest.mock' or node.module.startswith('unittest.mock.')):
            mock_bindings.update(a.asname or a.name for a in node.names)
        if isinstance(node, ast.Import):
            mock_bindings.update(a.asname or a.name for a in node.names if a.name == 'unittest.mock')
        if isinstance(node, ast.ImportFrom) and node.module == module and node.level == 0:
            constructors.update(a.asname or a.name for a in node.names if a.name == class_name)
        if isinstance(node, ast.Import):
            constructors.update((a.asname or a.name) + '.' + class_name for a in node.names if a.name == module)
    if not constructors:
        return []
    seeds = []
    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef) or cls.decorator_list:
            continue
        methods = [n for n in cls.body if isinstance(n, ast.FunctionDef)]
        fixtures = [m for m in methods if not m.name.startswith('test_')]
        if any(m.name != 'setUp' or m.decorator_list for m in fixtures):
            continue
        setup = next((m for m in fixtures if m.name == 'setUp'), None)
        for method in methods:
            if not method.name.startswith('test_') or method.decorator_list:
                continue
            nodes = list(setup.body if setup else []) + list(method.body)
            if any(isinstance(n, ast.Call) and (dotted(n.func).split('.')[-1] in
                    ('patch', 'object', 'Mock', 'MagicMock', 'AsyncMock', 'mock_open')
                    or any(dotted(n.func) == bound or dotted(n.func).startswith(bound + '.') for bound in mock_bindings))
                    for s in nodes for n in ast.walk(s)):
                continue
            instances, bindings = {}, {}
            for statement in nodes:
                if isinstance(statement, ast.Assign) and len(statement.targets) == 1:
                    assigned, value = dotted(statement.targets[0]), statement.value
                    if isinstance(value, ast.Call) and dotted(value.func) in constructors:
                        try:
                            instances[assigned] = call_values(value, bindings)
                        except (ValueError, TypeError, SyntaxError):
                            instances.pop(assigned, None)
                        continue
                    if isinstance(statement.targets[0], ast.Name):
                        try:
                            bindings[assigned] = literal(value, bindings)
                        except (ValueError, TypeError, SyntaxError):
                            bindings.pop(assigned, None)
                    # An assigned fixture state cannot be silently omitted.
                    if isinstance(statement.targets[0], (ast.Attribute, ast.Subscript)):
                        instances.clear()
                if isinstance(statement, (ast.For, ast.While, ast.If, ast.Try, ast.AsyncWith)):
                    continue
                for call in ast.walk(statement):
                    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute) or call.func.attr != method_name:
                        continue
                    constructor = instances.get(dotted(call.func.value))
                    if constructor is None:
                        continue
                    try:
                        seed = {'constructor': copy.deepcopy(constructor), 'call': call_values(call, bindings)}
                        if snapshot_value(seed)['replayable']:
                            seeds.append(seed)
                    except (ValueError, TypeError, SyntaxError):
                        pass
    return list({canonical(snapshot_value(s)): s for s in seeds}.values())[:16]


def bind_call(method, call):
    positional = method.args.posonlyargs + method.args.args
    names = [a.arg for a in positional[1:]]
    defaults = {p.arg: literal(v) for p, v in zip(positional[-len(method.args.defaults):], method.args.defaults)} if method.args.defaults else {}
    values = {**defaults, **dict(zip(names, call['args'])), **call['kwargs']}
    if len(call['args']) > len(names) or set(values) != set(names):
        raise ValueError('incomplete-call')
    return names, values


def focus_node(method, focus):
    mutant = focus.get('mutant')
    line = mutant.get('line') if type(mutant) is dict else focus.get('line')
    if not isinstance(line, int):
        found = re.search(r'(?:(?:line|branch)[: ]+)(\d+)', focus.get('evidence', ''))
        line = int(found[1]) if found else None
    candidates = [n for n in mutation_scope_walk(method) if getattr(n, 'lineno', None) == line]
    if type(mutant) is dict:
        candidates = [n for n in candidates if n.col_offset == mutant.get('column')]
        kind = str(mutant.get('kind', '')).replace('_', '').lower()
        wanted = {'compare': ast.Compare, 'if': ast.If, 'conditionalnegation': ast.If,
                  'augassign': ast.AugAssign, 'augmentedassignment': ast.AugAssign}.get(kind)
        candidates = [n for n in candidates if wanted and isinstance(n, wanted)]
        if len(candidates) != 1:
            raise ValueError('mutant-source-mismatch')
        node = candidates[0]
        if isinstance(node, ast.Compare):
            pos = mutant.get('position')
            if type(pos) is not int or not 0 <= pos < len(node.ops) or type(node.ops[pos]).__name__ != mutant.get('from'):
                raise ValueError('mutant-source-mismatch')
        if isinstance(node, ast.AugAssign) and mutant.get('from') not in (type(node.op).__name__, 'AugAssign_' + type(node.op).__name__):
            raise ValueError('mutant-source-mismatch')
        if isinstance(node, ast.If) and mutant.get('from') not in ('If_Statement', 'condition', 'if_condition'):
            raise ValueError('mutant-source-mismatch')
        return node
    # Coverage line in a branch/assignment can be reached with a repeated call.
    if not candidates:
        raise ValueError('coverage-source-mismatch')
    return candidates[0]


def plan(payload):
    source, target = payload['source'], payload['target']
    result = {'schemaVersion': VERSION, 'status': 'unsupported', 'sourceHash': digest(source),
              'target': target, 'gapId': payload['focus']['id'], 'experiments': [], 'assertionOracle': False}
    try:
        if len(source) > 250000 or len(payload['testCode']) > 250000:
            raise ValueError('source-budget')
        if payload.get('sourceHash', result['sourceHash']) != result['sourceHash']:
            raise ValueError('source-hash-mismatch')
        _, cls, method, attributes = class_contract(source, target)
        source_path = Path(payload['sourcePath']).resolve()
        source_root = source_path.parent
        package_parts = []
        while (source_root / '__init__.py').is_file():
            package_parts.insert(0, source_root.name)
            source_root = source_root.parent
        module = '.'.join(package_parts if package_parts and source_path.stem == '__init__' else package_parts + [source_path.stem])
        if module != payload['module']:
            raise ValueError('source-module-mismatch')
        context = {'sourceRoot': str(source_root), 'sourcePath': str(source_path), 'module': module,
                   'importFixturePlanHash': digest(os.environ.get('LLM_UNIT_TEST_IMPORT_FIXTURES', ''))}
        result['context'] = context
        node = focus_node(method, payload['focus'])
        seeds = passing_seeds(payload['testCode'], payload['module'], cls.name, method.name)
        candidates = []
        for seed in seeds:
            call = seed['call']
            if isinstance(node, ast.Compare):
                names, values = bind_call(method, call)
                operands = [node.left] + node.comparators
                for left, right in zip(operands, operands[1:]):
                    if isinstance(left, ast.Constant):
                        left, right = right, left
                    if not isinstance(left, ast.Name) or left.id not in names or not isinstance(right, ast.Constant) or type(right.value) not in (int, float):
                        continue
                    for boundary in (right.value, right.value - 1, right.value + 1):
                        supplied = {**values, left.id: boundary}
                        candidates.append((seed['constructor'], [{'args': [supplied[n] for n in names], 'kwargs': {}}]))
            else:
                # Repeat the real selected target, never an arbitrary setup method.
                candidates.append((seed['constructor'], [copy.deepcopy(call), copy.deepcopy(call)]))
                candidates.append((seed['constructor'], [copy.deepcopy(call)]))
        seen = set(payload.get('triedFingerprints', []))
        duplicates = 0
        for constructor, calls in candidates:
            experiment = {'schemaVersion': EXPERIMENT_VERSION, 'sourceHash': result['sourceHash'], 'target': target,
                          'gapId': result['gapId'], 'constructor': snapshot_value(constructor),
                          'calls': [snapshot_value(c) for c in calls],
                          'observe': {'instanceAttributes': attributes, 'exceptionArgs': True},
                          'context': context, 'assertionOracle': False}
            experiment['fingerprint'] = fingerprint(experiment)
            if experiment['fingerprint'] in seen:
                duplicates += 1
                continue
            seen.add(experiment['fingerprint'])
            result['experiments'].append(experiment)
            if len(result['experiments']) >= MAX_CASES:
                break
        result['status'] = 'planned' if result['experiments'] else 'duplicate' if duplicates else 'unsupported'
        if not result['experiments']:
            result['reason'] = 'no-new-literal-experiment' if duplicates else 'no-supported-passing-literal-seed'
    except (ValueError, SyntaxError, KeyError, TypeError, RecursionError) as error:
        message = str(error)
        result['reason'] = message if re.fullmatch(r'[a-z][a-z0-9-]{0,159}', message) else type(error).__name__
    return result


def plain_instance_state(instance, cls, attributes):
    namespace = type_field(cls, '__dict__')
    descriptor = namespace.get('__dict__')
    if type(descriptor) is not types.GetSetDescriptorType:
        raise ValueError('plain-instance-dictionary-required')
    state = descriptor.__get__(instance, cls)
    if type(state) is not dict or any(a not in state or a in namespace for a in attributes):
        raise ValueError('instance-attribute-not-plain-data')
    snapshot = snapshot_value({a: state[a] for a in attributes})
    if not snapshot['replayable']:
        raise ValueError('instance-state-not-replayable')
    return snapshot


def worker(payload):
    from dynamic_tracer import load_module_from_file, package_module_context, block_trace_side_effects, TraceSafetyError
    from trace_observation_guard import observe_ambient_reads
    experiment = payload['experiment']
    output = {'fingerprint': experiment.get('fingerprint'), 'status': 'unavailable'}
    try:
        path = Path(payload['sourcePath'])
        source = path.read_bytes().decode('utf-8-sig')
        if digest(source) != experiment['sourceHash'] or fingerprint(experiment) != experiment['fingerprint']:
            raise ValueError('experiment-identity-mismatch')
        _, class_node, method_node, attributes = class_contract(source, experiment['target'])
        if experiment['schemaVersion'] != EXPERIMENT_VERSION or experiment['assertionOracle'] is not False or experiment['observe'] != {'instanceAttributes': attributes, 'exceptionArgs': True}:
            raise ValueError('invalid-experiment-contract')
        if not 1 <= len(experiment['calls']) <= MAX_CALLS:
            raise ValueError('call-budget')
        constructor = restore_value(experiment['constructor'])
        calls = [restore_value(item) for item in experiment['calls']]
        for item in [constructor] + calls:
            if type(item) is not dict or set(item) != {'args', 'kwargs'} or type(item['args']) is not list or type(item['kwargs']) is not dict:
                raise ValueError('invalid-call-values')
        module_name, root, _ = package_module_context(str(path))
        if experiment['context'] != {'sourceRoot': str(Path(root).resolve()), 'sourcePath': str(path.resolve()), 'module': module_name,
                'importFixturePlanHash': digest(os.environ.get('LLM_UNIT_TEST_IMPORT_FIXTURES', ''))}:
            raise ValueError('execution-context-mismatch')
        with observe_ambient_reads(root, importing=True) as import_reads, redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), block_trace_side_effects():
            module = load_module_from_file(str(path))
        cls = vars(module).get(class_node.name)
        if type(cls) is not type or type.__dict__['__bases__'].__get__(cls) != (object,):
            raise ValueError('runtime-class-identity')
        namespace = type_field(cls, '__dict__')
        fn, init = namespace.get(method_node.name), namespace.get('__init__')
        if type(fn) is not types.FunctionType or init is not None and type(init) is not types.FunctionType:
            raise ValueError('runtime-descriptor')
        if (os.path.normcase(os.path.realpath(fn.__code__.co_filename)) != os.path.normcase(os.path.realpath(path))
                or fn.__code__.co_firstlineno != method_node.lineno):
            raise ValueError('runtime-method-source-mismatch')
        if any(key in namespace for key in ('__getattribute__', '__getattr__', '__setattr__', '__delattr__', '__new__', '__del__', '__slots__')):
            raise ValueError('runtime-class-hook')
        steps = []
        with observe_ambient_reads(root, (fn, init)) as reads, redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), block_trace_side_effects():
            instance = cls(*constructor['args'], **constructor['kwargs'])
            if type(instance) is not cls:
                raise ValueError('constructor-instance-identity')
            before = plain_instance_state(instance, cls, attributes)
            for call in calls:
                step = {'input': snapshot_value(call), 'before': plain_instance_state(instance, cls, attributes)}
                try:
                    result = fn(instance, *call['args'], **call['kwargs'])
                except TraceSafetyError:
                    raise
                except Exception as error:
                    kind = type(error)
                    name = type_field(kind, '__name__')
                    if vars(builtins).get(name) is not kind:
                        raise ExperimentUnsupported('exception-not-replayable')
                    args = snapshot_value(BaseException.__dict__['args'].__get__(error))
                    if not args['replayable']:
                        raise ExperimentUnsupported('exception-not-replayable')
                    step.update(status='raised', exception=name, exceptionArgs=args)
                else:
                    observed = snapshot_value(result)
                    if not observed['replayable']:
                        raise ExperimentUnsupported('result-not-replayable')
                    step.update(status='returned', result=observed)
                step['after'] = plain_instance_state(instance, cls, attributes)
                steps.append(step)
                if step['status'] == 'raised':
                    break
        if import_reads or reads:
            raise ValueError('uncontrolled-ambient-read')
        if digest(path.read_bytes().decode('utf-8-sig')) != experiment['sourceHash']:
            raise ValueError('experiment-source-changed')
        evidence = {'schemaVersion': 'quality-experiment-evidence-v2',
            'sourceHash': experiment['sourceHash'], 'target': experiment['target'],
            'gapId': experiment['gapId'], 'fingerprint': experiment['fingerprint'],
            'constructor': experiment['constructor'], 'calls': experiment['calls'], 'observe': experiment['observe'],
            'initialState': before, 'steps': steps, 'context': experiment['context'], 'isolation': 'fresh-process-per-case'}
        output.update(status='observed', evidence=evidence, evidenceHash=digest(canonical(evidence)))
    except (Exception, SystemExit) as error:
        # Diagnostics contain bounded classifications, never application output.
        output['reason'] = (BaseException.__dict__['args'].__get__(error)[0][:180]
                            if type(error) is ExperimentUnsupported else type_field(type(error), '__name__'))
    return output


def render_call(name, snapshot):
    value = restore_value(snapshot)
    args = [repr(a) for a in value['args']]
    args += [f'{k}={v!r}' for k, v in value['kwargs'].items() if k.isidentifier() and not keyword.iskeyword(k)]
    if len(args) != len(value['args']) + len(value['kwargs']):
        raise ValueError('unrenderable-keyword')
    return name + '(' + ', '.join(args) + ')'


def build_tests(module, target, experiments):
    """Offline compatibility helper. Production --run returns observations only."""
    if not all(p.isidentifier() and not keyword.iskeyword(p) for p in module.split('.')):
        raise ValueError('invalid-import-module')
    class_name, method = target.split('.')
    lines = ['import unittest']
    for result in experiments:
        if result['status'] != 'observed':
            continue
        evidence = result['evidence']
        suffix = result['fingerprint'][:16]
        alias = 'QualityTarget_' + suffix
        lines.extend([f'from {module} import {class_name} as {alias}', '',
                      f'class TestVerifiedState_{suffix}(unittest.TestCase):',
                      '    def test_observed_state(self):',
                      '        instance = ' + render_call(alias, evidence['constructor'])])
        for step in evidence['steps']:
            call = render_call('instance.' + method, step['input'])
            if step['status'] == 'returned':
                lines.extend(['        result = ' + call, '        self.assertEqual(result, ' + repr(restore_value(step['result'])) + ')'])
            else:
                lines.extend([f"        with self.assertRaises({step['exception']}) as observed_exception:",
                              '            ' + call,
                              '        self.assertEqual(observed_exception.exception.args, ' + repr(restore_value(step['exceptionArgs'])) + ')'])
            for name, value in restore_value(step['after']).items():
                lines.append('        self.assertEqual(instance.' + name + ', ' + repr(value) + ')')
        lines.append('')
    return '\n'.join(lines) + '\n'


def run(payload):
    result = plan(payload)
    if result['status'] != 'planned':
        return result
    planned = result['experiments']
    result['experiments'] = []
    deadline = time.monotonic() + 16
    for experiment in planned:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            result['experiments'].append({'fingerprint': experiment['fingerprint'], 'status': 'unavailable', 'reason': 'experiment-budget'})
            continue
        try:
            proc = subprocess.run([sys.executable, '-B', __file__, '--worker'],
                input=json.dumps({'sourcePath': payload['sourcePath'], 'experiment': experiment}),
                text=True, encoding='utf-8', capture_output=True, timeout=min(3, remaining),
                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            observed = json.loads(proc.stdout) if proc.returncode == 0 else {'status': 'unavailable', 'reason': 'worker-error'}
            if observed.get('fingerprint') != experiment['fingerprint']:
                observed = {'fingerprint': experiment['fingerprint'], 'status': 'unavailable', 'reason': 'worker-identity'}
        except subprocess.TimeoutExpired:
            observed = {'fingerprint': experiment['fingerprint'], 'status': 'unavailable', 'reason': 'worker-timeout'}
        except (ValueError, OSError):
            observed = {'fingerprint': experiment['fingerprint'], 'status': 'unavailable', 'reason': 'worker-error'}
        result['experiments'].append(observed)
    result['status'] = 'observed' if any(r['status'] == 'observed' for r in result['experiments']) else 'unavailable'
    return result


def method_fingerprints(code):
    tree = ast.parse(code)
    fingerprints = set()
    method_nodes = (ast.FunctionDef, ast.AsyncFunctionDef)
    module_context = [n for n in tree.body if isinstance(n, (ast.Assign, ast.AnnAssign, *method_nodes))]
    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef):
            continue
        fixtures = [ast.dump(n, include_attributes=False) for n in cls.body
                    if not isinstance(n, method_nodes) or not n.name.startswith('test_')]
        for method in cls.body:
            if not isinstance(method, method_nodes) or not method.name.startswith('test_'):
                continue
            observed_nodes = [method, *[n for n in cls.body if not isinstance(n, method_nodes) or not n.name.startswith('test_')],
                              *cls.bases, *cls.decorator_list, *module_context]
            used = {n.id for item in observed_nodes for n in ast.walk(item) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
            context = []
            for item in tree.body:
                if isinstance(item, (ast.Import, ast.ImportFrom)):
                    for alias in item.names:
                        if (alias.asname or alias.name.split('.')[0]) in used:
                            entry = copy.deepcopy(item)
                            entry.names = [alias]
                            context.append(ast.dump(entry, include_attributes=False))
                elif isinstance(item, (ast.Assign, ast.AnnAssign, ast.FunctionDef, ast.AsyncFunctionDef)):
                    # Conservatively retain module fixtures and indirect helper
                    # dependencies. A novelty gate must not discard a real new
                    # context merely because its variable is read indirectly.
                    context.append(ast.dump(item, include_attributes=False))
            body = copy.deepcopy(method)
            body.name = 'test_'
            # Test-local renaming is not a new experiment. Preserve attributes,
            # imported names, and fixture references which can change behavior.
            bound = {n.id for n in ast.walk(body) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
            mapping = {}
            class Normalize(ast.NodeTransformer):
                def visit_Name(self, node):
                    if node.id in bound:
                        node.id = mapping.setdefault(node.id, '_local_' + str(len(mapping)))
                    return node
            body = Normalize().visit(body)
            fingerprints.add(digest(canonical([context, fixtures, [ast.dump(b, include_attributes=False) for b in cls.bases],
                [ast.dump(d, include_attributes=False) for d in cls.decorator_list], ast.dump(body, include_attributes=False)])))
    return fingerprints


def novelty(payload):
    before, after = method_fingerprints(payload['previous']), method_fingerprints(payload['candidate'])
    return {'schemaVersion': 'quality-novelty-v1', 'novelMethods': len(after - before),
            'previousMethods': len(before), 'candidateMethods': len(after), 'fingerprints': sorted(after)}


def merge_tests(payload):
    previous, addition = ast.parse(payload['previous']), ast.parse(payload['addition'])
    if any(not isinstance(n, (ast.Import, ast.ImportFrom, ast.ClassDef)) for n in addition.body):
        raise ValueError('invalid-host-test-envelope')
    classes = [n for n in addition.body if isinstance(n, ast.ClassDef)]
    if not classes or any(not re.fullmatch(r'TestVerifiedState_[a-f0-9]{16}', n.name) for n in classes):
        raise ValueError('invalid-host-test-class')
    additions = {n.name: n for n in classes}
    previous_classes = {n.name: n for n in previous.body if isinstance(n, ast.ClassDef)}
    if not payload.get('restore') and any(name in previous_classes and ast.dump(n) != ast.dump(previous_classes[name]) for name, n in additions.items()):
        raise ValueError('host-class-name-collision')
    imports = [n for n in addition.body if isinstance(n, (ast.Import, ast.ImportFrom))]
    def bindings(node):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            return {a.asname or a.name.split('.')[0] for a in node.names}
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            return {node.name}
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            return {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
        return set()
    for imp in imports:
        if any(bindings(imp) & bindings(old) and ast.dump(imp) != ast.dump(old) for old in previous.body):
            raise ValueError('host-import-name-collision')
    # Existing host classes may be restored only by an explicit retained bundle.
    previous.body = [n for n in previous.body if not isinstance(n, ast.ClassDef) or n.name not in additions]
    seen = {ast.dump(n) for n in previous.body if isinstance(n, (ast.Import, ast.ImportFrom))}
    extra_imports = [n for n in imports if ast.dump(n) not in seen]
    # Append before an existing main guard so an independently run file sees all tests.
    insert = next((i for i, n in enumerate(previous.body) if isinstance(n, ast.If) and
                   ast.dump(n.test) == ast.dump(ast.parse("__name__ == '__main__'", mode='eval').body)), len(previous.body))
    previous.body[insert:insert] = extra_imports + classes
    code = ast.unparse(ast.fix_missing_locations(previous)) + '\n'
    return {'schemaVersion': 'quality-merge-v1', 'code': code, 'testHash': digest(code), 'classes': list(additions)}


if __name__ == '__main__':
    payload = json.load(sys.stdin)
    mode = sys.argv[1] if len(sys.argv) > 1 else '--run'
    result = {'--plan': plan, '--run': run, '--worker': worker, '--novelty': novelty, '--merge': merge_tests}[mode](payload)
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))
