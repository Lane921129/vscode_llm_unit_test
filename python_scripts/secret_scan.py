"""High-confidence secret scanner for tracked files and Git history.

The scanner deliberately reports only a pattern label and a file/ref location,
never the matching text.  It is a guardrail for accidental credential commits,
not a replacement for rotating a credential that was already disclosed.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path
from typing import Iterable


PATTERN_SOURCES: tuple[tuple[str, str], ...] = (
    ("Google API key", r"AIza[0-9A-Za-z_-]{30,}"),
    ("Google AI Studio key", r"AQ\.[A-Za-z0-9._-]{20,}"),
    ("OpenAI-style key", r"sk-[A-Za-z0-9_-]{20,}"),
    ("GitHub token", r"gh[pousr]_[A-Za-z0-9_]{20,}"),
    ("GitHub fine-grained token", r"github_pat_[A-Za-z0-9_]{20,}"),
    ("Slack token", r"xox[baprs]-[A-Za-z0-9-]{20,}"),
)
PATTERNS = tuple((label, re.compile(expression)) for label, expression in PATTERN_SOURCES)
GIT_GREP_PATTERN = "(" + "|".join(expression for _, expression in PATTERN_SOURCES) + ")"


def find_secret_labels(text: str) -> list[str]:
    """Return labels only, so callers can never accidentally print a secret."""
    return [label for label, pattern in PATTERNS if pattern.search(text)]


def run_git(repo_root: Path, args: list[str]) -> subprocess.CompletedProcess[bytes]:
    # Explicitly trust only this resolved repository.  This keeps the scanner
    # usable in protected local shells without weakening Git's global policy.
    safe_repo = repo_root.resolve().as_posix()
    return subprocess.run(
        ["git", "-c", f"safe.directory={safe_repo}", "-C", str(repo_root), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def tracked_files(repo_root: Path) -> Iterable[Path]:
    result = run_git(repo_root, ["ls-files", "-z"])
    if result.returncode != 0:
        raise RuntimeError("無法讀取 Git tracked files。")
    for raw_path in result.stdout.split(b"\0"):
        if raw_path:
            yield repo_root / raw_path.decode("utf-8", errors="surrogateescape")


def scan_worktree(repo_root: Path) -> list[str]:
    findings: list[str] = []
    for file_path in tracked_files(repo_root):
        try:
            content = file_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for label in find_secret_labels(content):
            findings.append(f"WORKTREE:{file_path.relative_to(repo_root).as_posix()} [{label}]")
    return findings


def scan_history(repo_root: Path) -> list[str]:
    """Use Git's text-aware grep and return only ref/path locations."""
    commits = run_git(repo_root, ["rev-list", "--all"])
    if commits.returncode != 0:
        raise RuntimeError("無法讀取 Git 歷史。")

    findings: set[str] = set()
    for commit in commits.stdout.decode("ascii", errors="ignore").splitlines():
        result = run_git(repo_root, ["grep", "-I", "-l", "-E", GIT_GREP_PATTERN, commit, "--"])
        if result.returncode not in (0, 1):
            raise RuntimeError(f"無法掃描 Git commit {commit[:12]}。")
        for location in result.stdout.decode("utf-8", errors="replace").splitlines():
            findings.add(f"HISTORY:{location}")
    return sorted(findings)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scan tracked source safely for likely secrets.")
    parser.add_argument("--history", action="store_true", help="Also scan every reachable Git commit.")
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parents[1]
    findings = scan_worktree(repo_root)
    if args.history:
        findings.extend(scan_history(repo_root))
    if findings:
        print("Secret scan failed. Matching values are intentionally hidden:", file=sys.stderr)
        for finding in sorted(set(findings)):
            print(f"- {finding}", file=sys.stderr)
        return 1
    scope = "tracked files and reachable Git history" if args.history else "tracked files"
    print(f"Secret scan passed: no high-confidence secret patterns in {scope}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
