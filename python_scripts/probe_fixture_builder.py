"""Build source-bound Trace input data without importing or executing an application."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from trace_value_codec import snapshot_call, snapshot_value, restore_value
from secret_scan import find_secret_labels

SCHEMA_VERSION = 'probe-input-fixtures-v1'
MAX_BYTES = 64 * 1024
MAX_CASES = 32
MAX_LITERAL_TEXT = 8192
MAX_SOURCE_BYTES = 16 * 1024 * 1024
FIELDS = ('args_literals', 'kwargs_literals', 'constructor_args_literals', 'constructor_kwargs_literals')
DEFAULTS = ('[]', '{}', '[]', '{}')


class FixtureInputError(ValueError):
    def __init__(self, code, case_index=None):
        super().__init__(code)
        self.code, self.case_index = code, case_index


def _local_path(text):
    return (type(text) is str and bool(text) and '\0' not in text
            and not text.startswith(('\\\\', '//')) and not re.match(r'^[A-Za-z]:[^\\/]', text)
            and ':' not in re.sub(r'^[A-Za-z]:', '', text))


def _no_links(path):
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0):
            raise FixtureInputError('source-path-rejected')


def _source(root, file):
    if not _local_path(root) or not Path(root).is_absolute() or not _local_path(file):
        raise FixtureInputError('source-path-rejected')
    root_path = Path(os.path.abspath(root))
    _no_links(root_path)
    root_path = root_path.resolve(strict=True)
    if not root_path.is_dir():
        raise FixtureInputError('source-path-rejected')
    source_path = Path(os.path.abspath(root_path / file))
    if source_path == root_path or root_path not in source_path.parents or source_path.suffix.lower() not in ('.py', '.pyw'):
        raise FixtureInputError('source-path-rejected')
    _no_links(source_path)
    source_path = source_path.resolve(strict=True)
    if source_path == root_path or root_path not in source_path.parents or source_path.suffix.lower() not in ('.py', '.pyw'):
        raise FixtureInputError('source-path-rejected')
    with source_path.open('rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_SOURCE_BYTES:
            raise FixtureInputError('source-path-rejected')
        content = stream.read(MAX_SOURCE_BYTES + 1)
        after = os.fstat(stream.fileno())
    _no_links(source_path)
    current = os.lstat(source_path)
    identities = [(item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns)
                  for item in (before, after, current)]
    # Windows Python can expose different ctime meanings for fstat and lstat.
    # Compare ctime only between the same open handle; path identity/mtime remain exact.
    if len(content) != before.st_size or len(content) > MAX_SOURCE_BYTES or len(set(identities)) != 1 or before.st_ctime_ns != after.st_ctime_ns:
        raise FixtureInputError('source-drifted')
    content.decode('utf-8', errors='strict')
    return root_path, source_path, content


def _sensitive(text):
    return bool(find_secret_labels(text) or re.search(r'\bBearer\s+[A-Za-z0-9._~+/-]{24,}', text, re.I)
                or re.search(r'\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[\'"]?\s*[:=]\s*[\'"][A-Za-z0-9_./+\-=]{24,}[\'"]', text, re.I))


def _sensitive_value(value):
    if type(value) is str:
        return _sensitive(value)
    if type(value) is bytes:
        return _sensitive(value.decode('utf-8', errors='replace'))
    if type(value) is dict:
        return any(type(key) is str and type(child) in (str, bytes) and _sensitive(
                       f'{key} = {json.dumps(child.decode("utf-8", errors="replace") if type(child) is bytes else child)}')
                   or _sensitive_value(key) or _sensitive_value(child) for key, child in value.items())
    if type(value) in (list, tuple, set, frozenset):
        return any(_sensitive_value(child) for child in value)
    return False


def bounded_literal(text):
    """Only bounded literal AST nodes reach literal_eval; Calls/operators never do."""
    if type(text) is not str or len(text) > MAX_LITERAL_TEXT:
        raise FixtureInputError('literal-budget')
    try:
        tree = ast.parse(text, mode='eval')
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        raise FixtureInputError('literal-invalid') from None
    count = 0

    def check(node, depth=0):
        nonlocal count
        count += 1
        if count > 512 or depth > 8:
            raise FixtureInputError('literal-budget')
        if type(node) is ast.Expression:
            check(node.body, depth)
        elif type(node) is ast.Constant:
            value = node.value
            if type(value) not in (type(None), bool, int, float, str, bytes):
                raise FixtureInputError('literal-unsupported')
            if type(value) is int and value.bit_length() > 4096 or type(value) in (str, bytes) and len(value) > 4096:
                raise FixtureInputError('literal-budget')
        elif type(node) in (ast.List, ast.Tuple, ast.Set):
            if len(node.elts) > 100:
                raise FixtureInputError('literal-budget')
            for child in node.elts:
                check(child, depth + 1)
        elif type(node) is ast.Dict:
            if len(node.keys) > 100:
                raise FixtureInputError('literal-budget')
            if any(key is None for key in node.keys):
                raise FixtureInputError('literal-unsupported')
            for key, value in zip(node.keys, node.values):
                check(key, depth + 1)
                check(value, depth + 1)
            # literal_eval would silently collapse equal Python keys; refuse that ambiguity.
            try:
                decoded_keys = [ast.literal_eval(key) for key in node.keys]
                unique_keys = set(decoded_keys)
            except (TypeError, ValueError):
                raise FixtureInputError('literal-invalid') from None
            if len(unique_keys) != len(decoded_keys):
                raise FixtureInputError('literal-duplicate-key')
        elif type(node) is ast.UnaryOp and type(node.op) in (ast.USub, ast.UAdd) and type(node.operand) is ast.Constant and type(node.operand.value) in (int, float):
            check(node.operand, depth + 1)
        else:
            raise FixtureInputError('literal-unsupported')

    check(tree)
    try:
        return ast.literal_eval(tree)
    except (ValueError, TypeError, SyntaxError, RecursionError, MemoryError):
        raise FixtureInputError('literal-invalid') from None


def build_fixture(root, file, target, payload):
    if type(target) is not str or len(target) > 512 or len(target.split('.')) > 2 or not all(part.isidentifier() for part in target.split('.')):
        raise FixtureInputError('target-invalid')
    if type(payload) is not dict or set(payload) != {'cases'} or type(payload['cases']) is not list:
        raise FixtureInputError('input-invalid-schema')
    if not 1 <= len(payload['cases']) <= MAX_CASES:
        raise FixtureInputError('input-case-limit')
    if _sensitive(json.dumps(payload, ensure_ascii=False)):
        raise FixtureInputError('input-sensitive-content')
    root_path, source_path, source_bytes = _source(root, file)
    cases = []
    for index, case in enumerate(payload['cases']):
        try:
            if type(case) is not dict or not set(case) <= set(FIELDS):
                raise FixtureInputError('input-invalid-schema')
            literals = [case.get(field, default) for field, default in zip(FIELDS, DEFAULTS)]
            values = [bounded_literal(text) for text in literals]
            if any(_sensitive_value(value) for value in values):
                raise FixtureInputError('input-sensitive-content')
            args, kwargs, constructor_args, constructor_kwargs = values
            if type(args) not in (list, tuple) or type(constructor_args) not in (list, tuple):
                raise FixtureInputError('input-positional-sequence-required')
            if any(type(item) is not dict or not all(type(key) is str for key in item) for item in (kwargs, constructor_kwargs)):
                raise FixtureInputError('input-keyword-dictionary-required')
            for mapping in (kwargs, constructor_kwargs):
                for key, value in mapping.items():
                    if type(value) is str and _sensitive(f'{key} = {json.dumps(value)}'):
                        raise FixtureInputError('input-sensitive-content')
            # The carrier is a positional sequence; nested argument types remain exact.
            snapshot = snapshot_call(list(args), kwargs, list(constructor_args), constructor_kwargs)
            if not snapshot['replayable']:
                raise FixtureInputError('input-unsupported-snapshot')
            encoded = snapshot['call_graph']
            restored = restore_value(encoded)
            restored['source'] = {'kind': 'unknown', 'detail': 'user-fixture'}
            if not snapshot_value(restored)['replayable']:
                raise FixtureInputError('input-unsupported-snapshot')
            cases.append({'input': encoded})
        except FixtureInputError as error:
            error.case_index = index
            raise
    # Re-read only the source, never application resources, to detect changes while building.
    _, verified_path, verified_bytes = _source(str(root_path), str(source_path))
    if source_path != verified_path or source_bytes != verified_bytes:
        raise FixtureInputError('source-drifted')
    document = {'schemaVersion': SCHEMA_VERSION, 'targets': [{
        'file': source_path.relative_to(root_path).as_posix(), 'target': target,
        'sourceHash': hashlib.sha256(source_bytes).hexdigest(),
        'inputs': {'schema_version': 'probe-inputs-v1', 'cases': cases}}]}
    text = json.dumps(document, ensure_ascii=False, separators=(',', ':'))
    if len(text.encode('utf-8')) + 1 > MAX_BYTES:
        raise FixtureInputError('fixture-too-large')
    if _sensitive(text):
        raise FixtureInputError('input-sensitive-content')
    return document


def main(argv=None):
    parser = argparse.ArgumentParser(description='Build input-only, source-bound Trace JSON from safe Python literals.')
    parser.add_argument('--root', required=True)
    parser.add_argument('--file', required=True)
    parser.add_argument('--target', required=True)
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise FixtureInputError('input-too-large')
        try:
            payload = json.loads(raw.decode('utf-8'))
        except (UnicodeError, ValueError, RecursionError):
            raise FixtureInputError('input-invalid-json') from None
        document = build_fixture(args.root, args.file, args.target, payload)
        print(json.dumps(document, ensure_ascii=False, separators=(',', ':')))
        return 0
    except (FixtureInputError, OSError, UnicodeError, ValueError, RecursionError, MemoryError) as error:
        code = error.code if isinstance(error, FixtureInputError) else 'fixture-build-unavailable'
        diagnostic = {'code': code}
        if isinstance(error, FixtureInputError) and error.case_index is not None:
            diagnostic['caseIndex'] = error.case_index
        print(json.dumps({'schemaVersion': 'probe-fixture-builder-result-v1', 'status': 'rejected',
                          'diagnostics': [diagnostic], 'inputOnly': True}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
