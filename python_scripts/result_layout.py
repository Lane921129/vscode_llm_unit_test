"""Read versioned per-function layouts, retaining legacy flat result support."""
import json
from pathlib import Path
import re
import stat


def _unlinked_existing_path(path):
    """Reject traversed links, not legitimate Windows short/long path spellings."""
    absolute = path.absolute()
    if '..' in absolute.parts:
        return False
    for entry in (*reversed(absolute.parents), absolute):
        details = entry.lstat()
        if (stat.S_ISLNK(details.st_mode)
                or getattr(details, 'st_file_attributes', 0) & 0x400):
            return False
    return True


def data_directory(root):
    root = Path(root)
    data = root / 'loop' / '_run'
    if not data.exists():
        if (root / 'loop').exists():
            raise ValueError('missing result layout')
        return root
    layout = data / 'layout.json'
    if (not _unlinked_existing_path(layout)
            or json.loads(layout.read_text(encoding='utf-8')).get('schemaVersion') != 'function-loops-v1'):
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
    if file.exists() and (not _unlinked_existing_path(file) or not file.is_file()):
        raise ValueError('invalid artifact path')
    return file
