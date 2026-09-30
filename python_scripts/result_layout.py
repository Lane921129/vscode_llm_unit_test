"""Read versioned per-function layouts, retaining legacy flat result support."""
import json
from pathlib import Path
import re


def data_directory(root):
    root = Path(root)
    data = root / 'loop' / '_run'
    if not data.exists():
        if (root / 'loop').exists():
            raise ValueError('missing result layout')
        return root
    if (json.loads((data / 'layout.json').read_text(encoding='utf-8')).get('schemaVersion') != 'function-loops-v1'
            or data.resolve() != data.absolute()):
        raise ValueError('invalid result layout')
    return data


def report_directory(data):
    data = Path(data)
    if data.name == '_run' and data.parent.name == 'loop' and data_directory(data.parent.parent) == data:
        return data.parent.parent
    return data


def local_artifact(directory, name):
    if (type(name) is not str or not name or name in ('.', '..') or Path(name).name != name
            or any(char in name for char in '/\\:')):
        raise ValueError('invalid artifact name')
    data = data_directory(directory)
    file = data / name
    root = report_directory(data)
    if not file.exists() and root != data:
        loop = re.match(r'^loop([1-9]\d*)_', name)
        if loop or re.fullmatch(r'(?:exec\d+_test\.py|(?:invocation|isolation|arithmetic)_\d+\.jsonl?)', name):
            file = root / 'loop' / (loop[1] if loop else '1') / name
    if file.exists() and (file.resolve() != file.absolute() or not file.is_file()):
        raise ValueError('invalid artifact path')
    return file
