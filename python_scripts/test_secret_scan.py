"""Regression tests for the safe, location-only secret scanner."""

import unittest
from pathlib import Path

from python_scripts.secret_scan import find_secret_labels, scan_worktree


class SecretScanTests(unittest.TestCase):
    def test_detects_supported_secret_shapes_without_storing_examples(self):
        samples = {
            "Google API key": "AIza" + "x" * 32,
            "Google AI Studio key": "AQ." + "x" * 24,
            "OpenAI-style key": "sk-" + "x" * 24,
            "GitHub token": "ghp_" + "x" * 24,
            "GitHub fine-grained token": "github_pat_" + "x" * 24,
            "Slack token": "xoxb-" + "x" * 24,
        }
        for expected_label, sample in samples.items():
            self.assertIn(expected_label, find_secret_labels(sample))

    def test_ordinary_configuration_words_are_not_secrets(self):
        self.assertEqual(find_secret_labels("api key is stored in SecretStorage"), [])
        self.assertEqual(find_secret_labels("test-key and local model name"), [])

    def test_scans_the_current_tracked_worktree_without_relaxing_global_git_policy(self):
        repo_root = Path(__file__).resolve().parents[1]
        self.assertEqual(scan_worktree(repo_root), [])


if __name__ == "__main__":
    unittest.main()
