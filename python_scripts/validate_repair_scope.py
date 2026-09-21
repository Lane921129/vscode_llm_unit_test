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
        r'(?m)^(?:FAIL|ERROR):\s+(test_[A-Za-z0-9_]+)\s+\(',
    ]
    for pattern in patterns:
        names.update(re.findall(pattern, failure))
    return names


def validate_detailed(previous, candidate, failure):
    previous_tree = parse(previous, 'Previous test')
    candidate_tree = parse(candidate, 'Candidate')
    if isinstance(candidate_tree, tuple):
        return False, candidate_tree[1], 'candidate-syntax'
    if isinstance(previous_tree, tuple):
        return False, 'A malformed test file belongs to Writer, not Bug Fixer.', 'previous-syntax'

    previous_imports = imports(previous_tree)
    candidate_imports = imports(candidate_tree)
    removed_imports = previous_imports - candidate_imports
    if removed_imports and not re.search(r'\b(?:ImportError|ModuleNotFoundError)\b', failure):
        return False, (
            'Bug Fixer may add imports but may replace an existing import only '
            'when the latest failure is ImportError or ModuleNotFoundError.'
        ), 'import-removal'

    def bound_names(nodes):
        names = set()
        for node in nodes:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    names.add(alias.asname or (alias.name.split('.')[0] if isinstance(node, ast.Import) else alias.name))
            elif isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                names.add(node.name)
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                names.update(child.id for target in targets for child in ast.walk(target) if isinstance(child, ast.Name))
        return names

    added_imports = [node for node in candidate_tree.body if isinstance(node, (ast.Import, ast.ImportFrom))
                     and ast.dump(node, include_attributes=False) not in previous_imports]
    added_names = bound_names(added_imports)
    if len(added_imports) > 3:
        return False, 'Bug Fixer may add at most three import statements.', 'import-limit'
    if '*' in added_names:
        return False, 'Bug Fixer may not add wildcard imports.', 'import-star'
    if added_names & bound_names(previous_tree.body):
        return False, 'Bug Fixer imports must not shadow existing bindings.', 'import-conflict'

    before = callable_map(previous_tree)
    after = callable_map(candidate_tree)
    removed = sorted(set(before) - set(after))
    added = sorted(set(after) - set(before))
    if removed:
        return False, 'Bug Fixer may not remove or rename existing callables: ' + ', '.join(removed), 'removed-callable'
    if added:
        return False, 'Bug Fixer repairs existing failures and may not add new callables: ' + ', '.join(added), 'added-callable'

    allowed = failed_test_names(failure)
    if len(allowed) != 1 or re.search(r'(?:_FailedTest|ImportError:|ModuleNotFoundError:|\bin (?:setUp|tearDown|asyncSetUp|asyncTearDown)(?:Class|Module)?\b)', failure):
        return False, 'Bug Fixer requires exactly one identified failing test method; route to Writer.', 'unidentified-failure'
    matches = [name for name in before if name.rsplit('.', 1)[-1] in allowed]
    if len(matches) != 1:
        return False, 'The failing method is absent or ambiguous; route to Writer.', 'unidentified-failure'
    selected = matches[0]
    changed = sorted(name for name in before if before[name] != after[name])
    forbidden = [name for name in changed if name != selected]
    if forbidden:
        return False, 'Bug Fixer changed passing or unrelated callables: ' + ', '.join(forbidden), 'unrelated-method-change'
    if not changed:
        return False, 'Bug Fixer produced no method change.', 'no-method-change'

    # Compare everything outside the selected body (including fixtures, class
    # attributes, decorators and signatures); adding top-level imports is the
    # only other permitted change.
    class Skeleton(ast.NodeTransformer):
        def visit_FunctionDef(self, node):
            if node.name in allowed:
                node.body = [ast.Pass()]
            return node
        visit_AsyncFunctionDef = visit_FunctionDef

    for tree in (previous_tree, candidate_tree):
        tree.body = [node for node in tree.body if not isinstance(node, (ast.Import, ast.ImportFrom))]
        Skeleton().visit(tree)
    if ast.dump(previous_tree, include_attributes=False) != ast.dump(candidate_tree, include_attributes=False):
        return False, 'Bug Fixer changed setup, decorators, signatures or code outside the failing body.', 'outside-method-change'
    return True, '', None


def validate(previous, candidate, failure):
    """Keep the existing two-value API for callers; the CLI also returns a stable code."""
    valid, reason, _ = validate_detailed(previous, candidate, failure)
    return valid, reason


def main():
    try:
        payload = json.load(sys.stdin)
        valid, reason, reason_code = validate_detailed(
            str(payload.get('previous', '')),
            str(payload.get('candidate', '')),
            str(payload.get('failure', '')),
        )
        print(json.dumps({'valid': valid, 'reason': reason, 'reasonCode': reason_code}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'valid': False, 'reason': 'Repair scope check failed.', 'reasonCode': 'scope-tool-error'}))


if __name__ == '__main__':
    main()
