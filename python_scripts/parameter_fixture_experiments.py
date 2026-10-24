"""Bounded protocol-object experiments derived from an executed AI candidate.

The AST parser never runs candidate code. Recipes describe test-owned controls,
not application classes, expected values, or a generated unittest file.
"""
import ast
import copy
import io
import json
import os
import subprocess
import sys
import time
import types
from contextlib import contextmanager, redirect_stdout, redirect_stderr
from pathlib import Path
from unittest.mock import Mock

from quality_experiment_runner import canonical, digest, dotted, focus_node
from trace_value_codec import snapshot_value, restore_value, type_field

VERSION = 'parameter-fixture-result-v1'
EXPERIMENT = 'parameter-fixture-experiment-v1'
MAX_CASES = 4
FAULTS = {'Exception': Exception, 'ValueError': ValueError, 'TypeError': TypeError,
          'RuntimeError': RuntimeError, 'KeyError': KeyError, 'AttributeError': AttributeError}


class Unsupported(ValueError):
    pass


def checked(condition, reason):
    if not condition:
        raise Unsupported(reason)


def simple_name(value):
    return isinstance(value, str) and value.isidentifier() and not value.startswith('_')


def combine(terms):
    seen = set()
    for _, refs in terms:
        checked(not seen.intersection(refs), 'shared-fixture-reference')
        seen.update(refs)
    return seen


def recipe(node, bindings, aliases, depth=0):
    checked(depth <= 6, 'fixture-depth')
    if isinstance(node, ast.Name) and node.id in bindings:
        return copy.deepcopy(bindings[node.id])
    if isinstance(node, ast.Call) and dotted(node.func) in aliases:
        kind = aliases[dotted(node.func)]
        checked(not node.args and len(node.keywords) <= 8 and all(k.arg for k in node.keywords), 'fixture-constructor')
        terms = [recipe(k.value, bindings, aliases, depth + 1) for k in node.keywords]
        refs = combine(terms) | {id(node)}
        if kind == 'namespace':
            checked(all(simple_name(k.arg) for k in node.keywords), 'fixture-member')
            return {'kind': 'namespace', 'attributes': {k.arg: t[0] for k, t in zip(node.keywords, terms)}}, refs
        checked(kind == 'mock' and [k.arg for k in node.keywords] == ['return_value'], 'fixture-mock-behavior')
        return {'kind': 'callable', 'mode': 'mock', 'returns': terms[0][0]}, refs
    if isinstance(node, ast.Lambda):
        args = node.args
        checked(not args.vararg and not args.kwarg and not args.kwonlyargs and not args.defaults
                and not args.posonlyargs and len(args.args) <= 6, 'fixture-lambda-signature')
        names = [arg.arg for arg in args.args]
        if isinstance(node.body, ast.Name) and node.body.id in names:
            return {'kind': 'callable', 'mode': 'identity', 'parameters': names, 'argument': node.body.id}, {id(node)}
        checked(not any(isinstance(n, ast.Name) and n.id in names for n in ast.walk(node.body)), 'fixture-lambda-input-dependent')
        # A factory must create its object on each call; returning an existing
        # object would introduce shared identity which this protocol cannot encode.
        body, refs = recipe(node.body, bindings, aliases, depth + 1)
        checked(not refs.intersection(set().union(*(v[1] for v in bindings.values()))), 'fixture-lambda-captured-object')
        return {'kind': 'callable', 'mode': 'factory', 'parameters': names, 'returns': body}, {id(node)}
    try:
        value = ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError):
        raise Unsupported('fixture-expression') from None
    encoded = snapshot_value(value)
    checked(encoded['replayable'], 'fixture-literal')
    return {'kind': 'literal', 'value': encoded}, {id(node)} if type(value) in (list, dict, set) else set()


def seed_inputs(code, module, target, diagnostics=None, include_literals=False):
    tree = ast.parse(code)
    aliases, targets, harnesses = {}, set(), {'unittest.TestCase'}
    imported = set()
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for item in node.names:
                bound = item.asname or (item.name.split('.')[0] if isinstance(node, ast.Import) else item.name)
                checked(item.name != '*' and bound not in imported, 'fixture-import-collision')
                imported.add(bound)
        if isinstance(node, ast.Import):
            for item in node.names:
                bound = item.asname or item.name
                if item.name == 'types':
                    aliases[bound + '.SimpleNamespace'] = 'namespace'
                if item.name == module:
                    targets.add(bound + '.' + target)
                if item.name == 'unittest':
                    harnesses.add(bound + '.TestCase')
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            for item in node.names:
                bound = item.asname or item.name
                if node.module == module and item.name == target:
                    targets.add(bound)
                if node.module == 'types' and item.name == 'SimpleNamespace':
                    aliases[bound] = 'namespace'
                if node.module == 'unittest.mock' and item.name == 'Mock':
                    aliases[bound] = 'mock'
                if node.module == 'unittest' and item.name == 'TestCase':
                    harnesses.add(bound)
        elif not isinstance(node, ast.ClassDef):
            # main guard is irrelevant after unittest methods; no module setup
            # or arbitrary assignment is silently omitted from replay.
            checked(isinstance(node, ast.If) and ast.unparse(node.test) == "__name__ == '__main__'", 'fixture-module-setup')
    checked(targets, 'fixture-target-import')
    roots = {name.split('.')[0] for name in [*aliases, *targets]}
    found = []
    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef):
            continue
        if cls.decorator_list or cls.keywords or len(cls.bases) != 1 or dotted(cls.bases[0]) not in harnesses:
            continue
        if any(not isinstance(n, ast.FunctionDef) or not n.name.startswith('test_') or n.decorator_list for n in cls.body):
            continue
        for method in cls.body:
            try:
                bindings = {}
                for statement in method.body:
                    if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str):
                        continue
                    calls = [n for n in ast.walk(statement) if isinstance(n, ast.Call) and dotted(n.func) in targets]
                    if calls:
                        checked(len(calls) == 1 and not isinstance(statement, (ast.If, ast.For, ast.While, ast.Try, ast.With)), 'fixture-call-scope')
                        call = calls[0]
                        direct = isinstance(statement, ast.Assign) and statement.value is call
                        direct = direct or isinstance(statement, ast.Expr) and (statement.value is call
                            or isinstance(statement.value, ast.Call) and dotted(statement.value.func).startswith('self.assert')
                            and statement.value.args and statement.value.args[0] is call)
                        checked(direct, 'fixture-target-call-expression')
                        checked(len(call.args) <= 6 and len(call.keywords) <= 6 and all(k.arg for k in call.keywords), 'fixture-call-signature')
                        terms = [recipe(n, bindings, aliases) for n in call.args] + [recipe(k.value, bindings, aliases) for k in call.keywords]
                        combine(terms)
                        args = [t[0] for t in terms[:len(call.args)]]
                        kwargs = {k.arg: t[0] for k, t in zip(call.keywords, terms[len(call.args):])}
                        if include_literals or any(t[0]['kind'] == 'namespace' for t in terms):
                            found.append({'args': args, 'kwargs': kwargs})
                        break
                    checked(isinstance(statement, ast.Assign) and len(statement.targets) == 1, 'fixture-setup-statement')
                    assigned = statement.targets[0]
                    value = recipe(statement.value, bindings, aliases)
                    if isinstance(assigned, ast.Name):
                        checked(assigned.id not in roots, 'fixture-import-rebound')
                        bindings[assigned.id] = value
                    else:
                        checked(isinstance(assigned, ast.Attribute) and isinstance(assigned.value, ast.Name)
                                and assigned.value.id in bindings and simple_name(assigned.attr), 'fixture-assignment')
                        current, refs = bindings[assigned.value.id]
                        checked(current['kind'] == 'namespace', 'fixture-assignment-receiver')
                        combine([(current, refs), value])
                        current['attributes'][assigned.attr] = value[0]
                        checked(len(current['attributes']) <= 8, 'fixture-member-budget')
                        bindings[assigned.value.id] = current, refs | value[1]
            except Unsupported as error:
                if diagnostics is not None:
                    diagnostics.append(error.args[0])
                continue
    return list({canonical(item): item for item in found}.values())[:4]


def target_node(source, target):
    tree = ast.parse(source)
    found = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == target]
    checked(len(found) == 1 and isinstance(found[0], ast.FunctionDef) and not found[0].decorator_list, 'plain-sync-target-required')
    fn = found[0]
    checked(not fn.args.vararg and not fn.args.kwarg
            and not any(isinstance(n, (ast.Await, ast.Yield, ast.YieldFrom)) for n in ast.walk(fn)), 'fixture-target-signature')
    return fn


def fingerprint(item):
    return digest(canonical({k: item[k] for k in ('schemaVersion', 'sourceHash', 'target', 'inputs', 'context')}))


def plan(payload):
    source, target = payload['source'], payload['target']
    result = {'schemaVersion': VERSION, 'sourceHash': digest(source), 'seedHash': digest(payload['testCode']),
              'target': target, 'gapId': payload['focus']['id'], 'status': 'unsupported', 'experiments': [], 'assertionOracle': False}
    try:
        checked(len(source) <= 250000 and len(payload['testCode']) <= 120000, 'fixture-source-budget')
        checked(payload.get('sourceHash', digest(source)) == digest(source), 'fixture-source-hash')
        fn = target_node(source, target)
        focus_node(fn, payload['focus'])
        path = Path(payload['sourcePath']).resolve()
        root, parts = path.parent, []
        while (root / '__init__.py').is_file():
            parts.insert(0, root.name)
            root = root.parent
        module = '.'.join(parts if parts and path.stem == '__init__' else parts + [path.stem])
        checked(module == payload['module'], 'fixture-source-module')
        context = {'sourceRoot': str(root), 'sourcePath': str(path), 'module': module,
                   'importFixturePlanHash': digest(os.environ.get('LLM_UNIT_TEST_IMPORT_FIXTURES', ''))}
        result['context'] = context
        names = [a.arg for a in fn.args.posonlyargs + fn.args.args]
        all_names = names + [a.arg for a in fn.args.kwonlyargs]
        # Resolve only unique straight-line aliases. Rebinding removes proof.
        assigned = {}
        for n in ast.walk(fn):
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                assigned.setdefault(n.targets[0].id, []).append(n.value)

        def source_path(node, seen=frozenset()):
            if isinstance(node, ast.Name):
                if node.id in all_names:
                    return [node.id]
                if node.id not in seen and len(assigned.get(node.id, [])) == 1:
                    return source_path(assigned[node.id][0], seen | {node.id})
            if isinstance(node, ast.Attribute) and simple_name(node.attr):
                base = source_path(node.value, seen)
                return base + [node.attr] if base else None
            if isinstance(node, ast.Call):
                base = source_path(node.func, seen)
                return base + ['$return'] if base else None
            return None

        line = payload['focus'].get('line') or getattr(focus_node(fn, payload['focus']), 'lineno', 0)
        focused_try = [n for n in ast.walk(fn) if isinstance(n, ast.Try)
                       and any(h.lineno <= line <= h.end_lineno for h in n.handlers)]
        selected = focus_node(fn, payload['focus'])
        active_nodes = focused_try[0].body if focused_try else [getattr(selected, 'test', selected)]
        reads = []
        for statement in active_nodes:
            for n in ast.walk(statement):
                if isinstance(n, ast.Attribute) and isinstance(n.ctx, ast.Load):
                    route = source_path(n)
                    if route and 2 <= len(route) <= 5 and route not in reads:
                        reads.append(route)
        fault = next((dotted(h.type) for t in focused_try for h in t.handlers if dotted(h.type) in FAULTS), 'Exception')
        seen = set(payload.get('triedFingerprints', []))
        duplicate = False
        diagnostics = []
        for seed in seed_inputs(payload['testCode'], module, target, diagnostics):
            parameters = {**dict(zip(names, seed['args'])), **seed['kwargs']}
            checked(len(seed['args']) <= len(names) and set(seed['kwargs']) <= set(all_names), 'fixture-call-binding')
            for route in reads:
                original = parameters.get(route[0])
                for member in route[1:]:
                    if not original:
                        break
                    original = original.get('returns') if member == '$return' and original['kind'] == 'callable' else original.get('attributes', {}).get(member)
                if not original or route[-1] == '$return':
                    continue
                # Exception experiments first when the measured gap is an except
                # handler. Remaining variations cover explicit false/missing paths.
                operations = ['raise', 'remove', 'false'] if focused_try else ['remove', 'false']
                for operation in operations:
                    inputs = copy.deepcopy(seed)
                    params = {**dict(zip(names, inputs['args'])), **inputs['kwargs']}
                    parent = params[route[0]]
                    for member in route[1:-1]:
                        parent = parent['returns'] if member == '$return' else parent['attributes'][member]
                    checked(parent['kind'] == 'namespace', 'fixture-variation-parent')
                    if operation == 'remove':
                        del parent['attributes'][route[-1]]
                    elif operation == 'false':
                        parent['attributes'][route[-1]] = {'kind': 'literal', 'value': snapshot_value(None)}
                    else:
                        parent.setdefault('faults', {})[route[-1]] = fault
                    experiment = {'schemaVersion': EXPERIMENT, 'sourceHash': result['sourceHash'], 'target': target,
                                  'gapId': result['gapId'], 'seedHash': result['seedHash'], 'context': context, 'inputs': inputs,
                                  'variation': {'parameter': route[0], 'path': route[1:], 'operation': operation, 'exception': fault if operation == 'raise' else None},
                                  'assertionOracle': False}
                    experiment['fingerprint'] = fingerprint(experiment)
                    if experiment['fingerprint'] in seen:
                        duplicate = True
                        continue
                    seen.add(experiment['fingerprint'])
                    result['experiments'].append(experiment)
                    if len(result['experiments']) == MAX_CASES:
                        break
                if len(result['experiments']) == MAX_CASES:
                    break
            if len(result['experiments']) == MAX_CASES:
                break
        result['status'] = 'planned' if result['experiments'] else 'duplicate' if duplicate else 'unsupported'
        if not result['experiments']:
            result['reason'] = 'no-new-fixture-experiment' if duplicate else diagnostics[0] if diagnostics else 'no-supported-fixture-seed'
    except (Unsupported, SyntaxError, ValueError, TypeError, KeyError, RecursionError) as error:
        result['experiments'] = []
        result['reason'] = error.args[0] if type(error) is Unsupported else 'fixture-plan-invalid'
    return result


class ControlledNamespace:
    """Host-owned attribute fault; no code supplied by the model is executed."""
    def __init__(self, attrs, faults):
        object.__setattr__(self, '_attrs', attrs)
        object.__setattr__(self, '_faults', faults)

    def __getattribute__(self, name):
        faults = object.__getattribute__(self, '_faults')
        if name in faults:
            raise FAULTS[faults[name]]()
        attrs = object.__getattribute__(self, '_attrs')
        if name not in attrs:
            raise AttributeError(name)
        return attrs[name]


def materialize(value):
    if value['kind'] == 'literal':
        return restore_value(value['value'])
    if value['kind'] == 'namespace':
        attrs = {k: materialize(v) for k, v in value['attributes'].items()}
        return ControlledNamespace(attrs, value['faults']) if value.get('faults') else types.SimpleNamespace(**attrs)
    if value['mode'] == 'mock':
        return Mock(return_value=materialize(value['returns']))
    def factory(*args, **kwargs):
        names = value['parameters']
        checked(len(args) <= len(names) and set(kwargs) <= set(names) and not set(names[:len(args)]) & set(kwargs)
                and len(args) + len(kwargs) == len(names), 'fixture-factory-call-signature')
        if value['mode'] == 'identity':
            return dict(zip(names, args), **kwargs)[value['argument']]
        return materialize(value['returns'])
    return factory


@contextmanager
def entered_target(fn):
    previous = sys.getprofile()
    code = fn.__code__
    execution = {'targetEntered': False, 'profileIntact': False}

    def observe(frame, event, arg):
        if event == 'call' and frame.f_code is code:
            execution['targetEntered'] = True
        if previous:
            previous(frame, event, arg)
    sys.setprofile(observe)
    try:
        yield execution
    finally:
        execution['profileIntact'] = sys.getprofile() is observe
        sys.setprofile(previous)


def worker(payload):
    from dynamic_tracer import load_module_from_file, block_trace_side_effects, TraceSafetyError
    from trace_observation_guard import observe_ambient_reads
    experiment = payload['experiment']
    output = {'fingerprint': experiment.get('fingerprint'), 'status': 'unavailable'}
    try:
        # Re-derive the entire allowed experiment before materializing recipes.
        original = {k: v for k, v in payload.items() if k != 'experiment'}
        allowed = plan(original)
        checked(any(item == experiment for item in allowed['experiments']), 'fixture-experiment-identity')
        source_path = Path(payload['sourcePath'])
        checked(digest(source_path.read_bytes().decode('utf-8-sig')) == experiment['sourceHash'], 'fixture-source-changed')
        node = target_node(payload['source'], experiment['target'])
        context = experiment['context']
        with observe_ambient_reads(context['sourceRoot'], importing=True) as import_reads, redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), block_trace_side_effects():
            module = load_module_from_file(str(source_path))
        fn = vars(module).get(experiment['target'])
        checked(type(fn) is types.FunctionType and fn.__code__.co_firstlineno == node.lineno
                and os.path.normcase(os.path.realpath(fn.__code__.co_filename)) == os.path.normcase(os.path.realpath(source_path)), 'fixture-runtime-target')
        with observe_ambient_reads(context['sourceRoot'], (fn,)) as reads, entered_target(fn) as execution, redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), block_trace_side_effects():
            args = [materialize(v) for v in experiment['inputs']['args']]
            kwargs = {k: materialize(v) for k, v in experiment['inputs']['kwargs'].items()}
            try:
                returned = fn(*args, **kwargs)
            except TraceSafetyError:
                raise
            except Exception as error:
                kind = type(error)
                name = type_field(kind, '__name__')
                checked(FAULTS.get(name) is kind, 'fixture-exception-not-replayable')
                encoded = snapshot_value(BaseException.__dict__['args'].__get__(error))
                checked(encoded['replayable'], 'fixture-exception-not-replayable')
                outcome = {'status': 'raised', 'exception': name, 'exceptionArgs': encoded}
            else:
                encoded = snapshot_value(returned)
                checked(encoded['replayable'], 'fixture-result-not-replayable')
                outcome = {'status': 'returned', 'result': encoded}
        checked(not import_reads and not reads, 'fixture-uncontrolled-ambient')
        checked(execution['targetEntered'] and execution['profileIntact'], 'fixture-target-not-entered')
        checked(digest(source_path.read_bytes().decode('utf-8-sig')) == experiment['sourceHash'], 'fixture-source-changed')
        evidence = {**experiment, 'schemaVersion': 'parameter-fixture-evidence-v1', 'outcome': outcome,
                    'execution': execution, 'isolation': 'fresh-process-per-case'}
        output.update(status='observed', evidence=evidence, evidenceHash=digest(canonical(evidence)))
    except (Exception, SystemExit) as error:
        output['reason'] = (error.args[0] if type(error) is Unsupported else 'fixture-worker-' + type(error).__name__.lower()
                            if type(error) in (TypeError, ValueError, NameError, ImportError, AttributeError) else 'fixture-worker-failed')
    return output


def check_replay(payload):
    """AST-only contradiction check, not execution or an assertion oracle.

    Only one new, explicitly decoded method is compared. Unknown fixture classes,
    decorators, setup, aliases or extra calls keep their unknown status and still
    need the normal execution/review gates. The baseline cannot lend a match.
    """
    source, code, baseline = payload['source'], payload['code'], payload['baseline']
    expected = payload['evidence']
    checked(all(isinstance(value, str) and len(value) <= 250000 for value in (source, code, baseline)), 'fixture-replay-budget')
    # The observation keeps its original seed provenance. A later baseline may
    # grow while an unpresented observation remains valid for the same source.
    checked(digest(source) == expected['sourceHash'], 'fixture-replay-identity')
    output = {'schemaVersion': 'parameter-fixture-replay-v1', 'status': 'unknown', 'reasonCode': 'fixture-replay-unknown-setup',
              'sourceHash': digest(source), 'codeHash': digest(code), 'baselineHash': digest(baseline),
              'fingerprint': expected['fingerprint']}
    try:
        tree, previous = ast.parse(code), ast.parse(baseline)
        checked(sum(1 for _ in ast.walk(tree)) <= 20000, 'fixture-replay-ast-budget')
        original = {(cls.name, method.name) for cls in previous.body if isinstance(cls, ast.ClassDef)
                    for method in cls.body if isinstance(method, ast.FunctionDef) and method.name.startswith('test_')}
        added = []
        for cls in tree.body:
            if not isinstance(cls, ast.ClassDef):
                continue
            # An unrelated class body could rebind imports at definition time.
            # Never ignore that code and then claim a definite fixture shape.
            checked(len(cls.bases) == 1 and dotted(cls.bases[0]) in ('unittest.TestCase', 'TestCase'), 'fixture-replay-class-scope')
            kept = []
            for method in cls.body:
                if isinstance(method, ast.FunctionDef) and method.name.startswith('test_'):
                    if (cls.name, method.name) in original:
                        continue
                    added.append(method)
                kept.append(method)
            cls.body = kept or [ast.Pass()]
        checked(len(added) == 1, 'fixture-replay-new-method-scope')
        # A conservative lower bound only. Alias/dynamic calls stay unknown;
        # the decoder below separately proves the canonical import binding.
        checked(sum(isinstance(node, ast.Call) and dotted(node.func).split('.')[-1] == expected['target']
                    for node in ast.walk(added[0])) == 1, 'fixture-replay-call-scope')
        values = seed_inputs(ast.unparse(tree), payload['module'], expected['target'], include_literals=True)
        checked(len(values) == 1, 'fixture-replay-unknown-setup')
        actual = values[0]
        if canonical(actual) == canonical(expected['inputs']):
            output.update(status='matched', reasonCode='fixture-replay-matched')
            return output
        fn = target_node(source, expected['target'])
        names = [arg.arg for arg in fn.args.posonlyargs + fn.args.args]
        parameters = {**dict(zip(names, actual['args'])), **actual['kwargs']}
        variation = expected['variation']
        current = parameters.get(variation['parameter'])
        for member in variation['path'][:-1]:
            checked(current is not None, 'fixture-replay-unknown-setup')
            current = current.get('returns') if member == '$return' else current.get('attributes', {}).get(member)
        checked(current is not None, 'fixture-replay-unknown-setup')
        if current['kind'] != 'namespace':
            output.update(status='contradicted', reasonCode='fixture-replay-input-mismatch')
        else:
            member = variation['path'][-1]
            attributes = current['attributes']
            # A decoded SimpleNamespace has neither custom getters nor dynamic
            # attribute lookup. Literal/absent members cannot replay a fault.
            mismatch = variation['operation'] == 'raise'
            mismatch = mismatch or variation['operation'] == 'remove' and member in attributes
            mismatch = mismatch or variation['operation'] == 'false' and (
                member not in attributes or attributes[member] != {'kind': 'literal', 'value': snapshot_value(None)})
            if mismatch:
                output.update(status='contradicted', reasonCode='fixture-replay-input-mismatch')
    except (Unsupported, SyntaxError, ValueError, TypeError, KeyError, RecursionError):
        pass
    return output


def run(payload):
    result = plan(payload)
    if result['status'] != 'planned':
        return result
    planned, result['experiments'] = result['experiments'], []
    deadline = time.monotonic() + 16
    # Writer consumes one complete case per round. Spend the existing stage on
    # that case, including cold application import, rather than timing out four
    # separate interpreters before any can enter a heavy framework module.
    for experiment in planned[:1]:
        item = {'fingerprint': experiment['fingerprint'], 'status': 'unavailable', 'reason': 'fixture-worker-timeout'}
        if deadline <= time.monotonic():
            item['reason'] = 'fixture-experiment-budget'
        else:
            try:
                proc = subprocess.run([sys.executable, '-B', __file__, '--worker'], input=json.dumps({**payload, 'experiment': experiment}),
                                      text=True, encoding='utf-8', capture_output=True, timeout=deadline - time.monotonic(),
                                      env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                if proc.returncode == 0:
                    observed = json.loads(proc.stdout)
                    if observed.get('fingerprint') == experiment['fingerprint']:
                        item = observed
            except (subprocess.TimeoutExpired, ValueError, OSError):
                pass
        result['experiments'].append(item)
    result['status'] = 'observed' if any(item['status'] == 'observed' for item in result['experiments']) else 'unavailable'
    return result


if __name__ == '__main__':
    data = json.load(sys.stdin)
    result = check_replay(data) if sys.argv[1:] == ['--check-replay'] else worker(data) if sys.argv[1:] == ['--worker'] else run(data)
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))
