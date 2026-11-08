"""Compare spec predictions with each other and with the captured outcome (architecture 3.3).

stdin:  {"actual": {"kind", "value"}, "actualMro": [...], "predictions": [{"kind", "value"}, ...]}
stdout: {"parsed": bool, "consistent": bool, "matchesActual": bool, "actualLiteral": bool}

Return values are compared after ast.literal_eval: floats with
math.isclose(rel_tol=1e-9, abs_tol=1e-12), tuples/lists/dicts/sets recursively.
Exceptions compare by class name, accepting any class in the actual MRO;
messages are never compared.
"""
import ast
import json
import math
import sys

_MISSING = object()


def literal(text):
    try:
        return ast.literal_eval(text)
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return _MISSING


def same_value(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return math.isclose(left, right, rel_tol=1e-9, abs_tol=1e-12)
    if isinstance(left, (list, tuple)) and isinstance(right, (list, tuple)):
        return type(left) is type(right) and len(left) == len(right) and all(map(same_value, left, right))
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(same_value(left[key], right[key]) for key in left)
    return type(left) is type(right) and left == right


def exception_name(text):
    return text.split('.')[-1]


def same_outcome(left, right):
    if left['kind'] != right['kind']:
        return False
    if left['kind'] == 'raise':
        return exception_name(left['value']) == exception_name(right['value'])
    return same_value(literal(left['value']), literal(right['value']))


def compare(request):
    predictions = request.get('predictions') or []
    actual = request['actual']
    parsed = bool(predictions) and all(p['kind'] == 'raise' or literal(p['value']) is not _MISSING for p in predictions)
    actual_literal = actual['kind'] == 'raise' or literal(actual['value']) is not _MISSING
    consistent = parsed and all(same_outcome(predictions[0], other) for other in predictions[1:])
    if not consistent or not actual_literal:
        matches = False
    elif predictions[0]['kind'] == 'raise':
        mro = request.get('actualMro') or [exception_name(actual['value'])]
        matches = actual['kind'] == 'raise' and exception_name(predictions[0]['value']) in mro
    else:
        matches = same_outcome(predictions[0], actual)
    return {'parsed': parsed, 'consistent': consistent, 'matchesActual': matches, 'actualLiteral': actual_literal}


def main(stdin=None, stdout=None):
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    try:
        report = compare(json.loads(stdin.read()))
    except (ValueError, KeyError, TypeError):
        report = {'error': 'invalid-request'}
    stdout.write(json.dumps(report))
    return 1 if 'error' in report else 0


if __name__ == '__main__':
    sys.exit(main())
