"""External operator adapters executed by the shared isolated mutation runner.

Mutatest supplies discovery and AST transformations; this module does not
reimplement its mutation rules or call its legacy coverage/cache-based CLI.
Only the explicitly verified package version is accepted. Candidate collection
never imports or executes the application under test.
"""

import ast
import copy
import hashlib
import importlib.metadata
import json
import platform
import sys

from basic_mutation_runner import find_target_scope, mutation_code_change, run_mutation_trials


VERIFIED_MUTATEST_VERSION = '3.1.0'
MUTATEST_OPERATOR_VERSION = 'mutatest-ast-3.1.0-v1'
PROBE_SCHEMA_VERSION = 'external-mutation-probe-v1'


class AdapterUnavailable(RuntimeError):
    """Safe, stable diagnostic codes; arbitrary package exceptions stay private."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code
        self.reason_code = code


def _operation_name(operation):
    return operation.__name__ if isinstance(operation, type) else str(operation)


def _load_mutatest():
    try:
        version = importlib.metadata.version('mutatest')
    except importlib.metadata.PackageNotFoundError:
        raise AdapterUnavailable('package-missing') from None
    if version != VERIFIED_MUTATEST_VERSION or sys.version_info < (3, 9):
        raise AdapterUnavailable('unsupported-version')
    try:
        from mutatest.transformers import MutateAST, get_mutations_for_target
    except Exception:
        raise AdapterUnavailable('self-check-failed') from None
    return MutateAST, get_mutations_for_target


def mutatest_candidates(tree, scope, source_hash, scope_name, scope_version):
    """Enumerate the complete Mutatest operator universe inside the target body.

    A temporary AST module gives the external visitor only the selected body;
    skipping nested callable/class nodes also excludes their defaults and
    decorators. Each transformed body is then put back in the original module.
    The supplied application AST is never changed in place.
    """
    external_transformer, operations_for = _load_mutatest()
    function_scope = isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef))
    if scope is None or (not function_scope and scope is not tree):
        raise AdapterUnavailable('invalid-target-scope')

    class BodyTransformer(external_transformer):
        def visit_FunctionDef(self, node):
            return node

        visit_AsyncFunctionDef = visit_FunctionDef
        visit_ClassDef = visit_FunctionDef
        visit_Lambda = visit_FunctionDef

    transformer_type = BodyTransformer if function_scope else external_transformer
    body_tree = ast.Module(body=copy.deepcopy(scope.body), type_ignores=[]) if function_scope else copy.deepcopy(tree)
    collector = transformer_type(readonly=True)
    collector.visit(copy.deepcopy(body_tree))
    locations = sorted(collector.locs, key=lambda item: (
        item.lineno, item.col_offset, item.end_lineno or -1, item.end_col_offset or -1,
        item.ast_class, _operation_name(item.op_type)))
    original_dump = ast.dump(tree, include_attributes=False)
    normalized_source = ast.unparse(tree)
    seen = set()
    candidates = []
    excluded = dict(noop=0, duplicate=0, invalid=0)
    for location in locations:
        for operation in sorted(operations_for(location), key=lambda value: (type(value).__name__, _operation_name(value))):
            transformer = transformer_type(target_idx=location, mutation=operation)
            changed_body = transformer.visit(copy.deepcopy(body_tree))
            variant = copy.deepcopy(tree) if function_scope else changed_body
            if function_scope:
                variant_scope = find_target_scope(variant, scope_name)
                if variant_scope is None:
                    raise AdapterUnavailable('invalid-target-scope')
                variant_scope.body = changed_body.body
            ast.fix_missing_locations(variant)
            variant_dump = ast.dump(variant, include_attributes=False)
            if variant_dump == original_dump:
                excluded['noop'] += 1
                continue
            if variant_dump in seen:
                excluded['duplicate'] += 1
                continue
            try:
                compile(variant, '<external-mutation>', 'exec')
            except (SyntaxError, TypeError, ValueError):
                excluded['invalid'] += 1
                continue
            seen.add(variant_dump)
            record = {'kind': location.ast_class, 'line': location.lineno,
                      'column': location.col_offset, 'position': 0,
                      'from': _operation_name(location.op_type), 'to': _operation_name(operation)}
            variant_hash = hashlib.sha256(variant_dump.encode('utf-8')).hexdigest()
            identity = json.dumps([MUTATEST_OPERATOR_VERSION, scope_version, source_hash,
                                   scope_name, record, variant_hash], sort_keys=True, separators=(',', ':'))
            record['id'] = hashlib.sha256(identity.encode('utf-8')).hexdigest()
            mutant_source = ast.unparse(variant) + '\n'
            change = mutation_code_change(normalized_source, mutant_source)
            if change is not None:
                record['codeChange'] = change
            candidates.append((record, mutant_source))
    return {'engine': 'mutatest', 'engineVersion': VERIFIED_MUTATEST_VERSION,
            'operatorSetVersion': MUTATEST_OPERATOR_VERSION,
            'candidates': candidates, 'excluded': excluded}


def probe_engine(engine):
    """Test package/API availability without importing the user's application."""
    result = {'schemaVersion': PROBE_SCHEMA_VERSION, 'engine': engine, 'supported': False,
              'engineVersion': None, 'operatorSetVersion': None,
              'platform': platform.system(), 'diagnosticCode': 'adapter-unavailable'}
    if engine not in ('mutatest', 'mutmut'):
        return result
    if engine == 'mutmut':
        # Installing a package cannot make an unimplemented adapter available.
        # Report that limitation even when the package itself is absent.
        result['diagnosticCode'] = 'unsupported-platform' if sys.platform == 'win32' else 'adapter-unavailable'
        try:
            version = importlib.metadata.version(engine)
            if version and len(version) <= 64 and all(c in '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+-_' for c in version):
                result['engineVersion'] = version
        except Exception:
            pass
        return result
    try:
        version = importlib.metadata.version(engine)
    except importlib.metadata.PackageNotFoundError:
        result['diagnosticCode'] = 'package-missing'
        return result
    except Exception:
        result['diagnosticCode'] = 'self-check-failed'
        return result
    # Only package-style version strings are metadata; never echo arbitrary text.
    if not version or len(version) > 64 or any(c not in '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+-_' for c in version):
        result['diagnosticCode'] = 'unsupported-version'
        return result
    result['engineVersion'] = version
    if version != VERIFIED_MUTATEST_VERSION or sys.version_info < (3, 9):
        result['diagnosticCode'] = 'unsupported-version'
        return result
    try:
        source = 'def adapter_probe(a, b):\n    return a + b\n'
        tree = ast.parse(source)
        output = mutatest_candidates(tree, tree.body[0], hashlib.sha256(source.encode()).hexdigest(),
                                     'adapter_probe', 'selected-function-body-v1')
        records = [record for record, _ in output['candidates']]
        if (len(records) != 6 or {r['to'] for r in records} != {'Sub', 'Mult', 'Div', 'FloorDiv', 'Mod', 'Pow'}
                or len({r['id'] for r in records}) != 6):
            raise AdapterUnavailable('self-check-failed')
    except AdapterUnavailable as error:
        result['diagnosticCode'] = error.code
        return result
    except Exception:
        result['diagnosticCode'] = 'self-check-failed'
        return result
    result.update(supported=True, operatorSetVersion=MUTATEST_OPERATOR_VERSION, diagnosticCode=None)
    return result


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) == 2 and argv[0] == '--probe':
        print(json.dumps(probe_engine(argv[1]), ensure_ascii=True))
        return 0
    if len(argv) < 3 or len(argv) > 9:
        print(json.dumps({'error': 'invalid-arguments'}))
        return 2
    engine, source, tests = argv[:3]
    probe = probe_engine(engine)
    if not probe['supported']:
        print(json.dumps({'error': 'external-engine-unavailable', **probe}, ensure_ascii=True))
        return 2
    try:
        maximum = int(argv[3]) if len(argv) > 3 else 0
        timeout = float(argv[4]) if len(argv) > 4 else 10
        function = argv[5] or None if len(argv) > 5 else None
        class_name = argv[6] or None if len(argv) > 6 else None
        stage_timeout = float(argv[7]) if len(argv) > 7 else None
        workers = int(argv[8]) if len(argv) > 8 else 2
        result = run_mutation_trials(source, tests, max_mutations=maximum, timeout_seconds=timeout,
                                     target_function=function, target_class=class_name,
                                     stage_timeout_seconds=stage_timeout, workers=workers,
                                     candidate_provider=mutatest_candidates)
        if result.get('engine') != engine:
            # Target lookup/provider failure can precede the shared runner's
            # metadata handoff. Preserve the selected engine on that failure,
            # but never relabel an executed fallback as the external engine.
            if result.get('status') != 'failed' or result.get('counts', {}).get('executed') != 0:
                raise AdapterUnavailable('adapter-contract-mismatch')
            result.update(engine=engine, engineVersion=probe['engineVersion'],
                          operatorSetVersion=probe['operatorSetVersion'])
    except Exception:
        print(json.dumps({'error': 'external-engine-execution-failed', 'engine': engine,
                          'diagnosticCode': 'adapter-execution-failed'}))
        return 2
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
