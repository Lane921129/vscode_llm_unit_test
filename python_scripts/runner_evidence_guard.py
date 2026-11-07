"""Keep candidate-owned monkeypatches out of runner evidence serialization."""
import builtins
import io
import json
from contextlib import contextmanager

from runtime_policy import block_operation


@contextmanager
def preserve_runner_evidence():
    # Capture inside the runtime guard, so its guarded open functions remain in
    # force. Properly scoped application mocks restore themselves and are fine.
    bindings = [(builtins, 'open'), (io, 'open'), (json, 'dump'), (json, 'dumps'), (json, '_default_encoder'),
                (json, 'JSONEncoder'), (json.JSONEncoder, 'encode'),
                (json.JSONEncoder, 'iterencode'), (json.JSONEncoder, 'default')]
    original = [(owner, name, getattr(owner, name)) for owner, name in bindings]
    try:
        yield
    finally:
        changed = False
        for owner, name, value in original:
            if getattr(owner, name, None) is not value:
                changed = True
                setattr(owner, name, value)
        if changed:
            # Record while guarded_runtime is still active. Even a swallowed
            # violation must leave valid isolation evidence and fail the test.
            block_operation('runner evidence interference')
