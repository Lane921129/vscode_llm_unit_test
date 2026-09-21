"""Private stdin worker. Every invocation imports one target in a fresh process."""
import json
import sys

from dynamic_tracer import _trace_function_local
from trace_value_codec import restore_value


def main():
    payload = json.loads(sys.stdin.read(1024 * 1024))
    inputs = None if payload.get('inputs') is None else [restore_value(item) for item in payload['inputs']]
    result = _trace_function_local(
        payload['file_path'], payload['func_name'], inputs,
        exact_inputs=payload['mode'] == 'case', prepare_only=payload['mode'] == 'plan',
    )
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
