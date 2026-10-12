"""Deduplicate equivalent planned calls without reusing executions or resource state."""
import json

from trace_value_codec import restore_value


def deduplicate_planned_calls(inputs, describe):
    entries = []
    seen = {}
    allowed_fields = {'args', 'kwargs', 'constructor_args', 'constructor_kwargs', 'source'}
    for encoded in inputs:
        key = None
        source = {'kind': 'unknown'}
        try:
            candidate = restore_value(encoded) if encoded.get('replayable') else None
            before, source = describe(candidate) if candidate is not None else (None, source)
            # Unknown payload fields may describe receiver/setup state. Preserve
            # those attempts, as well as explicit unknown/user-fixture inputs.
            if (type(candidate) is dict and set(candidate).issubset(allowed_fields)
                    and source.get('kind') in ('caller_literals', 'source_guided', 'semantic_guided')
                    and before and before.get('replayable')):
                key = json.dumps([before, source['kind']], sort_keys=True, ensure_ascii=True, separators=(',', ':'))
        except (TypeError, ValueError, KeyError, RecursionError):
            key = None
        if key is not None and key in seen:
            seen[key]['source_sites'].append(source)
            continue
        entry = {'input': encoded, 'source_sites': [source]}
        entries.append(entry)
        if key is not None:
            seen[key] = entry
    return entries, {'schema_version': 'probe-case-deduplication-v1',
                     'planned_count': len(inputs), 'unique_count': len(entries),
                     'duplicate_count': len(inputs) - len(entries),
                     'source_count': sum(len(entry['source_sites']) for entry in entries)}
