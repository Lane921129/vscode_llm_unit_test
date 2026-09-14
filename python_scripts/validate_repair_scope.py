"""Reject broad Bug Fixer rewrites before executing generated tests.

Input is one JSON object on stdin with ``previous``, ``candidate`` and
``failure`` strings. Output is ``{"valid": bool, "reason": str}``.
"""

import ast
import json
import re
import sys


def parse(code, label):
    try:
        return ast.parse(code)
    except SyntaxError as error:
        return None, f'{label} Python syntax error: {error}'


def callable_map(tree):
    found = {}

    class Visitor(ast.NodeVisitor):
        def __init__(self):
            self.classes = []

        def visit_ClassDef(self, node):
            self.classes.append(node.name)
            self.generic_visit(node)
            self.classes.pop()

        def _add(self, node):
            prefix = '.'.join(self.classes)
            key = f'{prefix}.{node.name}' if prefix else node.name
            found[key] = ast.dump(node, include_attributes=False)

        def visit_FunctionDef(self, node):
            self._add(node)
            # A test/helper body is an atomic repair unit. Nested functions do
            # not create independently editable test cases.

        def visit_AsyncFunctionDef(self, node):
            self._add(node)

    Visitor().visit(tree)
    return found


def imports(tree):
    return {
        ast.dump(node, include_attributes=False)
        for node in tree.body
        if isinstance(node, (ast.Import, ast.ImportFrom))
    }


def failed_test_names(failure):
    names = set()
    patterns = [
        r'(?m)^(test_[A-Za-z0-9_]+)\s+\([^\n]+\)\s+\.\.\.\s+(?:FAIL|ERROR)\s*$',
        r'(?m)^(?:FAIL|ERROR):\s+(test_[A-Za-z0-9_]+)\b',
        r'\bin\s+(test_[A-Za-z0-9_]+)\b',
    ]
    for pattern in patterns:
        names.update(re.findall(pattern, failure))
    return names


def validate(previous, candidate, failure):
    previous_tree = parse(previous, 'Previous test')
    candidate_tree = parse(candidate, 'Candidate')
    if isinstance(candidate_tree, tuple):
        return False, candidate_tree[1]
    if isinstance(previous_tree, tuple):
        # A syntactically invalid input has no trustworthy AST to preserve.
        # The candidate is still subject to the normal structure, evidence,
        # scenario-regression and execution gates after this check.
        return True, ''

    previous_imports = imports(previous_tree)
    candidate_imports = imports(candidate_tree)
    removed_imports = previous_imports - candidate_imports
    if removed_imports and not re.search(r'\b(?:ImportError|ModuleNotFoundError)\b', failure):
        return False, (
            'Bug Fixer may add imports but may replace an existing import only '
            'when the latest failure is ImportError or ModuleNotFoundError.'
        )

    before = callable_map(previous_tree)
    after = callable_map(candidate_tree)
    removed = sorted(set(before) - set(after))
    added = sorted(set(after) - set(before))
    if removed:
        return False, 'Bug Fixer may not remove or rename existing callables: ' + ', '.join(removed)
    if added:
        return False, 'Bug Fixer repairs existing failures and may not add new callables: ' + ', '.join(added)

    allowed = failed_test_names(failure)
    changed = sorted(name for name in before if before[name] != after[name])
    if allowed:
        forbidden = [name for name in changed if name.rsplit('.', 1)[-1] not in allowed]
    else:
        changed_tests = [name for name in changed if name.rsplit('.', 1)[-1].startswith('test_')]
        changed_helpers = [name for name in changed if not name.rsplit('.', 1)[-1].startswith('test_')]
        forbidden = changed_helpers + changed_tests[1:]
    if forbidden:
        allowed_text = ', '.join(sorted(allowed)) if allowed else 'none identified'
        return False, (
            'Bug Fixer changed passing or unrelated callables: '
            + ', '.join(forbidden)
            + f'. Latest failure permits changes only to: {allowed_text}. '
            + 'Keep all other test bodies and fixtures AST-equivalent.'
        )
    return True, ''


def main():
    try:
        payload = json.load(sys.stdin)
        valid, reason = validate(
            str(payload.get('previous', '')),
            str(payload.get('candidate', '')),
            str(payload.get('failure', '')),
        )
        print(json.dumps({'valid': valid, 'reason': reason}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'valid': False, 'reason': f'Repair scope check failed: {error}'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
