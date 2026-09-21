"""Runner-owned evidence that the selected source code actually entered a frame."""
import ast
from contextlib import contextmanager
import hashlib
import json
import marshal
import os
from pathlib import Path
import sys
import threading
import types


def canonical_path(value):
    return os.path.normcase(os.path.realpath(value))


def file_hash(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def selected_node(source, target):
    """Resolve only a unique top-level function or direct qualified member."""
    tree = ast.parse(source)
    parts = target.split('.')
    definitions = (ast.FunctionDef, ast.AsyncFunctionDef)
    if len(parts) == 1:
        candidates = [node for node in tree.body if isinstance(node, definitions) and node.name == target]
    elif len(parts) == 2:
        owners = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == parts[0]]
        candidates = [node for owner in owners for node in owner.body
                      if isinstance(node, definitions) and node.name == parts[1]
                      and not any(isinstance(decorator, ast.Attribute) and decorator.attr in ('setter', 'deleter')
                                  for decorator in node.decorator_list)]
    else:
        candidates = []
    if len(candidates) != 1 or not candidates[0].body or not hasattr(candidates[0], 'end_lineno'):
        raise ValueError('target-scope-unresolved')
    return candidates[0]


def target_scope(source, target):
    node = selected_node(source, target)
    lines = set(range(node.body[0].lineno, node.end_lineno + 1))
    for child in ast.walk(node):
        if child is not node and isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and child.body:
            lines.difference_update(range(child.body[0].lineno, child.end_lineno + 1))
    return lines, node.body[0].lineno == node.lineno


class TargetInvocationTracker:
    def __init__(self, source_file, target, test_file, test_run_id):
        self.source_file = canonical_path(source_file)
        self.test_file = canonical_path(test_file)
        self.target = target
        self.test_run_id = test_run_id
        self.source_hash = file_hash(source_file)
        self.test_hash = file_hash(test_file)
        source = Path(source_file).read_text(encoding='utf-8-sig')
        node = selected_node(source, target)
        # Compile only: no module import, decorator or user setup runs here.
        code = compile(source, self.source_file, 'exec', dont_inherit=True)
        parts = target.split('.')
        for index, name in enumerate(parts):
            choices = [value for value in code.co_consts if isinstance(value, types.CodeType) and value.co_name == name]
            if index == len(parts) - 1:
                first = min([node.lineno, *[decorator.lineno for decorator in node.decorator_list]])
                choices = [value for value in choices if value.co_firstlineno == first]
            if len(choices) != 1:
                raise ValueError('target-code-unresolved')
            code = choices[0]
        self.expected_code = code
        self.code_hash = hashlib.sha256(marshal.dumps(code)).hexdigest()
        self.observed = False
        self.testing = False
        self.profile_intact = True

    @contextmanager
    def observe(self):
        previous = sys.getprofile()
        previous_thread = threading.getprofile()
        expected = self.expected_code
        source_file = self.source_file
        matched = {}

        def observe_call(frame, event):
            if self.testing and event == 'call' and frame.f_code.co_name == expected.co_name:
                code = frame.f_code
                key = id(code)
                if key not in matched:
                    matched[key] = (code, code == expected and canonical_path(code.co_filename) == source_file)
                if matched[key][1]:
                    self.observed = True

        def profile(frame, event, arg):
            observe_call(frame, event)
            if previous:
                previous(frame, event, arg)

        def thread_profile(frame, event, arg):
            observe_call(frame, event)
            if previous_thread:
                previous_thread(frame, event, arg)

        # Thread bootstrap installs this hook in each new Python thread. Keep
        # its prior observer separate from the current thread's prior observer.
        threading.setprofile(thread_profile)
        sys.setprofile(profile)
        try:
            yield
        finally:
            self.testing = False
            self.profile_intact = sys.getprofile() is profile and threading.getprofile() is thread_profile
            try:
                sys.setprofile(previous)
            finally:
                threading.setprofile(previous_thread)

    def matches_test_module(self, name):
        module = sys.modules.get(name)
        filename = vars(module).get('__file__') if type(module) is types.ModuleType else None
        return isinstance(filename, str) and canonical_path(filename) == self.test_file

    def save(self, destination, status, coverage_file=None):
        current = file_hash(self.source_file) == self.source_hash and file_hash(self.test_file) == self.test_hash
        result = {
            'schemaVersion': 'target-invocation-v1', 'testRunId': self.test_run_id,
            'canonicalFile': self.source_file, 'target': self.target, 'sourceHash': self.source_hash,
            'canonicalTestFile': self.test_file, 'testHash': self.test_hash, 'targetCodeHash': self.code_hash,
            'status': status if current and self.profile_intact else 'invalidated',
            'observed': self.observed, 'profileIntact': self.profile_intact,
            'coverageDataHash': file_hash(coverage_file) if coverage_file else None
        }
        temporary = str(destination) + '.pending'
        Path(temporary).write_text(json.dumps(result), encoding='utf-8')
        os.replace(temporary, destination)


def verified_invocation(evidence_file, source_file, target, source_hash, data_file, expected_run_id, expected_test_hash):
    if not evidence_file or not expected_run_id or not expected_test_hash:
        return None
    try:
        value = json.loads(Path(evidence_file).read_text(encoding='utf-8'))
        valid = value.get('schemaVersion') == 'target-invocation-v1' and value.get('status') == 'passed' \
            and value.get('profileIntact') is True and type(value.get('observed')) is bool \
            and value.get('testRunId') == expected_run_id and value.get('testHash') == expected_test_hash \
            and value.get('sourceHash') == source_hash and value.get('target') == target \
            and canonical_path(value.get('canonicalFile', '')) == canonical_path(source_file) \
            and value.get('coverageDataHash') == file_hash(data_file) \
            and value.get('testHash') == file_hash(value['canonicalTestFile'])
        if not valid:
            return None
        return {'observed': value['observed'], 'testRunId': expected_run_id, 'testHash': expected_test_hash}
    except (OSError, ValueError, TypeError, KeyError):
        return None
