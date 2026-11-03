"""Bounded snapshots of exact builtin values, without user conversion hooks.

The wire representation preserves Python types. Unsupported, cyclic and truncated
values are diagnostics and cannot be decoded into execution inputs.
"""
import json
import math
import re

SCHEMA_VERSION = 'trace-value-v1'
MAX_DEPTH = 8
MAX_ITEMS = 100
MAX_NODES = 512
MAX_TEXT = 4096
_TYPE_FIELDS = {name: type.__dict__[name].__get__ for name in ('__name__', '__module__', '__qualname__', '__dict__')}


def type_field(kind, name):
    """Read builtin type storage without running metaclass descriptors/hooks."""
    return _TYPE_FIELDS[name](kind)


def safe_type_name(value):
    return type_field(type(value), '__name__')


def snapshot_value(value):
    remaining = [MAX_NODES]
    active = set()
    seen = set()
    replayable = [True]

    def unavailable(reason, name=None):
        replayable[0] = False
        result = {'type': 'unavailable', 'reason': reason}
        if name:
            result['python_type'] = name
        return result

    def encode(item, depth):
        remaining[0] -= 1
        if remaining[0] < 0 or depth > MAX_DEPTH:
            return unavailable('snapshot-budget')
        kind = type(item)
        if item is None:
            return {'type': 'none'}
        if kind is bool:
            return {'type': 'bool', 'value': item}
        if kind is int:
            if item.bit_length() > MAX_TEXT:
                return unavailable('integer-budget')
            return {'type': 'int', 'value': str(item)}
        if kind is float:
            return {'type': 'float', 'value': repr(item)} if math.isfinite(item) else unavailable('non-finite-float')
        if kind in (str, bytes):
            if len(item) > MAX_TEXT:
                return unavailable('text-budget', kind.__name__)
            return {'type': kind.__name__, 'value': item if kind is str else item.hex()}
        if kind not in (list, tuple, dict, set, frozenset):
            return unavailable('unsupported-type', type_field(kind, '__name__'))
        identity = id(item)
        if identity in active:
            return unavailable('cycle')
        if identity in seen:
            return unavailable('shared-reference')
        seen.add(identity)
        active.add(identity)
        try:
            encoded = []
            values = item.items() if kind is dict else item
            for index, child in enumerate(values):
                if index >= MAX_ITEMS or remaining[0] < 1:
                    encoded.append(unavailable('collection-budget'))
                    break
                if kind is dict:
                    encoded.append({'key': encode(child[0], depth + 1), 'value': encode(child[1], depth + 1)})
                else:
                    encoded.append(encode(child, depth + 1))
            if kind in (set, frozenset):
                encoded.sort(key=lambda node: json.dumps(node, sort_keys=True))
            return {'type': kind.__name__, 'items': encoded}
        finally:
            active.remove(identity)

    encoded = encode(value, 0)
    return {'schema_version': SCHEMA_VERSION, 'replayable': replayable[0], 'value': encoded}


def restore_value(snapshot):
    """Decode only our bounded data format; never import or invoke a type."""
    if type(snapshot) is not dict or set(snapshot) != {'schema_version', 'replayable', 'value'} or snapshot.get('schema_version') != SCHEMA_VERSION or snapshot.get('replayable') is not True:
        raise ValueError('Trace input snapshot is not replayable')
    remaining = [MAX_NODES]

    def decode(node, depth):
        remaining[0] -= 1
        if remaining[0] < 0 or depth > MAX_DEPTH or type(node) is not dict:
            raise ValueError('Invalid trace value budget')
        kind, value = node.get('type'), node.get('value')
        if type(kind) is not str:
            raise ValueError('Invalid trace value tag')
        expected_fields = {'type'} if kind == 'none' else {'type', 'items'} if kind in ('list', 'tuple', 'set', 'frozenset', 'dict') else {'type', 'value'}
        if set(node) != expected_fields:
            raise ValueError('Invalid trace value fields')
        if kind == 'none' and set(node) == {'type'}:
            return None
        if kind == 'bool' and type(value) is bool:
            return value
        if kind == 'int' and type(value) is str and len(value) <= MAX_TEXT and re.fullmatch(r'-?(?:0|[1-9]\d*)', value, re.ASCII):
            result = int(value)
            if result.bit_length() <= MAX_TEXT:
                return result
        if kind == 'float' and type(value) is str and len(value) <= 40 and re.fullmatch(r'-?\d+(?:\.\d+)?(?:e[+-]?\d+)?', value, re.ASCII | re.IGNORECASE):
            result = float(value)
            if math.isfinite(result):
                return result
        if kind == 'str' and type(value) is str and len(value) <= MAX_TEXT:
            return value
        if kind == 'bytes' and type(value) is str and len(value) <= MAX_TEXT * 2 and re.fullmatch(r'(?:[0-9a-f]{2})*', value):
            return bytes.fromhex(value)
        children = node.get('items')
        if kind in ('list', 'tuple', 'set', 'frozenset', 'dict') and type(children) is list and len(children) <= MAX_ITEMS:
            if kind == 'dict':
                if not all(type(pair) is dict and set(pair) == {'key', 'value'} for pair in children):
                    raise ValueError('Invalid trace dictionary entries')
                return {decode(pair['key'], depth + 1): decode(pair['value'], depth + 1) for pair in children}
            decoded = [decode(child, depth + 1) for child in children]
            return {'list': list, 'tuple': tuple, 'set': set, 'frozenset': frozenset}[kind](decoded)
        raise ValueError('Invalid trace value')

    try:
        result = decode(snapshot.get('value'), 0)
        # External input must be the encoder's exact format. This also rejects
        # duplicate/equal dictionary keys, duplicate set elements and unknown
        # fields instead of silently changing their meaning during decoding.
        def normalized(node):
            if node['type'] == 'float':
                # JS-owned scalar candidates use another shortest float spelling
                # (1e-7 versus 1e-07). Preserve the exact finite value and sign of
                # zero without requiring Python's display spelling on input.
                return {'type': 'float', 'value': repr(float(node['value']))}
            if 'items' in node:
                children = [{'key': normalized(pair['key']), 'value': normalized(pair['value'])}
                            for pair in node['items']] if node['type'] == 'dict' else [normalized(child) for child in node['items']]
                return {'type': node['type'], 'items': children}
            return node
        canonical_input = {**snapshot, 'value': normalized(snapshot['value'])}
        if json.dumps(snapshot_value(result), sort_keys=True, ensure_ascii=True) != json.dumps(canonical_input, sort_keys=True, ensure_ascii=True):
            raise ValueError('Non-canonical trace input snapshot')
        return result
    except (KeyError, TypeError, OverflowError, RecursionError) as error:
        raise ValueError('Invalid trace input snapshot') from error


def unavailable_snapshot():
    """A bounded diagnostic for malformed transport, never executable data."""
    return {'schema_version': SCHEMA_VERSION, 'replayable': False,
            'value': {'type': 'unavailable', 'reason': 'unsupported-type'}}


def is_lossless_json_value(value):
    """Compatibility values that survive Python -> JS -> JSON with exact types.

    Integral floats and negative zero become integers in JavaScript JSON output;
    JS also reorders array-index object keys. Typed transport handles those values.
    """
    kind = type(value)
    if value is None or kind in (str, bool):
        return True
    if kind is int:
        return abs(value) <= 9007199254740991
    if kind is float:
        return math.isfinite(value) and not value.is_integer()
    if kind is list:
        return all(is_lossless_json_value(item) for item in value)
    if kind is dict:
        return all(type(key) is str
                   and not (len(key) <= 10 and key.isascii() and key.isdecimal() and str(int(key)) == key and int(key) < 4294967295)
                   and is_lossless_json_value(item) for key, item in value.items())
    return False


def snapshot_call(args, kwargs, constructor_args=(), constructor_kwargs=None):
    constructor_kwargs = constructor_kwargs if constructor_kwargs is not None else {}
    graph = snapshot_value({'args': args, 'kwargs': kwargs,
                            'constructor_args': constructor_args, 'constructor_kwargs': constructor_kwargs})
    return {
        'replayable': graph['replayable'],
        'call_graph': graph,
        'args': snapshot_value(args),
        'kwargs': snapshot_value(kwargs),
        'constructor_args': snapshot_value(constructor_args),
        'constructor_kwargs': snapshot_value(constructor_kwargs),
    }
