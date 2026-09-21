"""Decode versioned caller inputs only in Python, preserving exact value types."""
from trace_value_codec import restore_value, snapshot_value, unavailable_snapshot

SCHEMA_VERSION = 'probe-inputs-v1'
ORIGINS = {'caller_literals', 'source_guided', 'semantic_guided', 'unknown'}


def _source(value):
    if type(value) is not dict or type(value.get('kind')) is not str or value['kind'] not in ORIGINS:
        raise ValueError('Invalid probe source')
    result = {'kind': value['kind']}
    for field in ('file', 'caller', 'detail', 'requestId'):
        if field in value:
            if type(value[field]) is not str or len(value[field]) > 1024:
                raise ValueError('Invalid probe source field')
            result[field] = value[field]
    if 'line' in value:
        if type(value['line']) is not int or value['line'] <= 0 or value['line'] > 2147483647:
            raise ValueError('Invalid probe source line')
        result['line'] = value['line']
    return result


def restore_call(snapshot):
    """Validate call structure; constructor absence remains absence."""
    call = restore_value(snapshot)
    fields = {'args', 'kwargs', 'constructor_args', 'constructor_kwargs'}
    if type(call) is not dict or not {'args', 'kwargs'} <= call.keys() or not call.keys() <= fields:
        raise ValueError('Invalid probe call fields')
    constructor = 'constructor_args' in call
    if constructor != ('constructor_kwargs' in call):
        raise ValueError('Incomplete probe constructor')
    for name in ('args', 'constructor_args') if constructor else ('args',):
        if type(call[name]) not in (list, tuple):
            raise ValueError('Invalid probe positional arguments')
    for name in ('kwargs', 'constructor_kwargs') if constructor else ('kwargs',):
        if type(call[name]) is not dict or not all(type(key) is str for key in call[name]):
            raise ValueError('Invalid probe keyword arguments')
    return call


def prepare_probe_inputs(payload):
    """Return replayable worker snapshots and independent rejected-case records.

    The legacy list API remains available. A dictionary is always a versioned
    envelope; invalid versions or cases never become ordinary target arguments.
    """
    if payload is None:
        return None, []
    valid, invalid = [], []
    if type(payload) is list:
        for candidate in payload:
            encoded = snapshot_value(candidate)
            if encoded['replayable']:
                valid.append(encoded)
            else:
                invalid.append((encoded, {'kind': 'unknown'}, 'unsupported-input-snapshot'))
        return valid, invalid

    def reject(source=None, reason='invalid-input-envelope'):
        invalid.append((unavailable_snapshot(), source or {'kind': 'unknown'}, reason))

    if type(payload) is not dict or type(payload.get('cases')) is not list:
        reject()
        return valid, invalid
    version_valid = payload.get('schema_version') == SCHEMA_VERSION and set(payload) == {'schema_version', 'cases'}
    if not version_valid and not payload['cases']:
        reject()
    for item in payload['cases']:
        source = {'kind': 'unknown'}
        try:
            if type(item) is not dict or set(item) != {'input', 'source'}:
                raise ValueError('Invalid probe case fields')
            source = _source(item['source'])
            if not version_valid:
                raise ValueError('Invalid probe envelope version')
            encoded = item['input']
            if type(encoded) is dict and encoded.get('replayable') is False:
                reject(source, 'unsupported-input-snapshot')
                continue
            call = restore_call(encoded)
            call['source'] = source
            snapshot = snapshot_value(call)
            if not snapshot['replayable']:
                reject(source, 'unsupported-input-snapshot')
            else:
                valid.append(snapshot)
        except (ValueError, TypeError, KeyError, RecursionError, OverflowError):
            reject(source)
    return valid, invalid
