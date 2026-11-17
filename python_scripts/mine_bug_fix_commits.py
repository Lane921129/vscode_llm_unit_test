"""Read-only, conservative Git/AST screening of historical Python bug fixes.

No upstream module is imported or executed. A candidate must change exactly one
Python file and one existing function body; all other semantic AST stays equal.
The keyword screen is a candidate heuristic, not proof that a change is a bug.
"""
from __future__ import annotations

import argparse
import ast
import copy
import fnmatch
import io
import json
from pathlib import Path
import re
import subprocess
import tokenize

BUG_WORDS = re.compile(r"fix|bug|regression|issue|(?:close[sd]?|resolve[sd]?)\s+#\d+", re.I)
FEATURE_WORDS = re.compile(r"\b(?:feature|new functionality|add support|introduc\w*|enhanc\w*|optimi[sz]\w*|performance|speedup|refactor\w*|memory footprint|pep[- ]?8|formatting|code style)\b", re.I)
DEFAULT_PATHS = ("bottle.py", "validators", "src/validators")
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)


def git(repo: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE)


def source_text(data: bytes) -> str:
    encoding, _ = tokenize.detect_encoding(io.BytesIO(data).readline)
    return data.decode(encoding)


def normalized(node) -> str:
    result = copy.deepcopy(node)
    nodes = ast.walk(result) if isinstance(result, ast.AST) else (
        item for child in result for item in ast.walk(child))
    for item in nodes:
        if isinstance(item, (ast.Module, ast.ClassDef, *FUNCTIONS)) and item.body:
            first = item.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                item.body = item.body[1:]
        if isinstance(item, ast.Constant):
            item.kind = None
    if isinstance(result, list):
        return "\n".join(ast.dump(item, include_attributes=False) for item in result)
    return ast.dump(result, include_attributes=False)


def functions(tree: ast.AST):
    found = {}
    occurrences = {}
    def walk(node, parents=()):
        scope = parents
        if isinstance(node, (ast.ClassDef, *FUNCTIONS)):
            scope = (*parents, node.name)
            if isinstance(node, FUNCTIONS):
                name = ".".join(scope)
                # Conditional compatibility definitions may share a qualified
                # name. Pair them by lexical occurrence without discarding
                # unrelated, uniquely named changes elsewhere in the module.
                occurrences[name] = occurrences.get(name, 0) + 1
                key = name if occurrences[name] == 1 else f"{name}#{occurrences[name]}"
                found[key] = node
        for child in ast.iter_child_nodes(node):
            walk(child, scope)
    walk(tree)
    return found


def direct_body(node: ast.AST) -> str:
    """Nested bodies count as separate functions, not twice as parent edits."""
    class EraseNested(ast.NodeTransformer):
        def visit_FunctionDef(self, child):
            child.body = []
            return child
        visit_AsyncFunctionDef = visit_FunctionDef
    body = [EraseNested().visit(copy.deepcopy(item)) for item in node.body]
    # Treat a leading docstring as documentation, as normalized() does for defs.
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    return normalized(body)


def single_body_change(before: str, after: str):
    try:
        old, new = ast.parse(before), ast.parse(after)
        old_functions, new_functions = functions(old), functions(new)
    except (SyntaxError, ValueError):
        return None
    if set(old_functions) != set(new_functions) or normalized(old) == normalized(new):
        return None
    changed = [name for name in old_functions if direct_body(old_functions[name]) != direct_body(new_functions[name])]
    if len(changed) != 1:
        return None
    name = changed[0]
    replaced = copy.deepcopy(old)
    functions(replaced)[name].body = copy.deepcopy(new_functions[name].body)
    if normalized(replaced) != normalized(new):
        return None  # signature/decorator/module/class-level changes are excluded
    return name, old_functions[name], new_functions[name]


def function_source(source: str, node: ast.AST) -> str:
    start = min([node.lineno] + [decorator.lineno for decorator in node.decorator_list])
    return "\n".join(source.splitlines()[start - 1:node.end_lineno]) + "\n"


def in_scope(file: str, paths) -> bool:
    return file.endswith(".py") and any(file == pattern or file.startswith(pattern.rstrip("/") + "/")
        or fnmatch.fnmatchcase(file, pattern) for pattern in paths)


def mine(repo: Path, paths=DEFAULT_PATHS, rev="HEAD", limit=None):
    repo = repo.resolve()
    head = git(repo, "rev-parse", "--verify", rev + "^{commit}").decode().strip()
    raw = git(repo, "log", "--no-merges", "--format=%H%x00%aI%x00%B%x00", head, "--", *paths).split(b"\0")
    candidates, screened = [], 0
    for index in range(0, len(raw) - 2, 3):
        commit, date, message = (part.decode("utf-8", "replace").strip() for part in raw[index:index + 3])
        if not BUG_WORDS.search(message) or FEATURE_WORDS.search(message):
            continue
        screened += 1
        files = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).decode("utf-8", "replace").splitlines()
        # Strict across the entire commit, including tests and documentation.
        if len(files) != 1 or not in_scope(files[0], paths):
            continue
        file = files[0]
        try:
            before = source_text(git(repo, "show", f"{commit}^:{file}"))
            after = source_text(git(repo, "show", f"{commit}:{file}"))
        except (subprocess.CalledProcessError, UnicodeError, SyntaxError):
            continue
        changed = single_body_change(before, after)
        if not changed:
            continue
        name, old_node, new_node = changed
        stats = git(repo, "diff", "--numstat", commit + "^", commit, "--", file).decode().split()
        added, deleted = int(stats[0]), int(stats[1])
        candidates.append({"commit": commit, "parent": git(repo, "rev-parse", commit + "^").decode().strip(),
            "date": date, "message": message, "file": file, "function": name,
            "diffLines": {"added": added, "deleted": deleted, "total": added + deleted},
            "hasDocstring": ast.get_docstring(new_node) is not None,
            "hasDocstringBefore": ast.get_docstring(old_node) is not None,
            "before": function_source(before, old_node), "after": function_source(after, new_node)})
        if limit is not None and len(candidates) >= limit:
            break
    return {"version": "historical-bug-candidates-v1", "revision": head, "paths": list(paths),
        "screenedKeywordCommits": screened, "candidates": candidates}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("--files", nargs="+", default=list(DEFAULT_PATHS), help="Git paths/directories to screen")
    parser.add_argument("--rev", default="HEAD", help="Commit/ref whose history is scanned")
    parser.add_argument("--limit", type=int, help="Optional positive candidate limit; omitted means all matches")
    parser.add_argument("--output", type=Path, help="JSON output; default stdout")
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    try:
        report = mine(args.repo, args.files, args.rev, args.limit)
    except (subprocess.CalledProcessError, OSError) as error:
        parser.exit(1, f"Git history could not be read: {type(error).__name__}\n")
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
