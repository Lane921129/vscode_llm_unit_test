import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mine_bug_fix_commits import mine, single_body_change, main


class HistoricalBugMiningTests(unittest.TestCase):
    def test_ast_requires_one_body_and_preserves_signature_and_outer_code(self):
        old = 'LIMIT = 3\ndef f(x):\n    """Doc."""\n    return x > 0\ndef g(x):\n    return x\n'
        fixed = old.replace('x > 0', 'x >= 0')
        self.assertEqual(single_body_change(old, fixed)[0], 'f')
        for rejected in [old.replace('return x > 0', 'return (x > 0) # comment'),
                         old.replace('Doc.', 'Documentation.'),
                         fixed.replace('LIMIT = 3', 'LIMIT = 4'),
                         fixed.replace('def f(x):', 'def f(x, y=0):'),
                         fixed.replace('def g(x):\n    return x', 'def g(x):\n    return x+1'),
                         fixed + 'def extra():\n    return 1\n']:
            self.assertIsNone(single_body_change(old, rejected))

    def test_nested_and_async_methods_are_not_double_counted(self):
        old = 'class Box:\n    async def f(self, x):\n        def nested(y):\n            return y > 0\n        return nested(x)\n'
        self.assertEqual(single_body_change(old, old.replace('y > 0', 'y >= 0'))[0], 'Box.f.nested')
        self.assertIsNone(single_body_change(old, old.replace('y > 0', 'y >= 0').replace('return nested(x)', 'return not nested(x)')))

    def test_unchanged_conditional_duplicates_do_not_hide_an_unrelated_fix(self):
        old = 'if LEGACY:\n    def compat(x):\n        return x\nelse:\n    def compat(x):\n        return str(x)\ndef f(x):\n    return x > 0\n'
        self.assertEqual(single_body_change(old, old.replace('x > 0', 'x >= 0'))[0], 'f')
        self.assertEqual(single_body_change(old, old.replace('str(x)', 'repr(x)'))[0], 'compat#2')
        self.assertIsNone(single_body_change(old, old.replace('x > 0', 'x >= 0').replace('str(x)', 'repr(x)')))

    def test_real_git_history_filters_messages_files_format_and_optimization(self):
        with tempfile.TemporaryDirectory(prefix='historical-bug-test-') as temporary:
            repo = Path(temporary)
            def git(*args):
                return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.PIPE).decode().strip()
            git('init', '-q')
            git('config', 'user.name', 'Fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            file = repo / 'bottle.py'
            file.write_text('def f(x):\n    """Return positive."""\n    return x > 0\n', encoding='utf-8')
            git('add', '.')
            git('commit', '-qm', 'initial')
            def commit(message, text):
                file.write_text(text, encoding='utf-8')
                git('add', '.')
                git('commit', '-qm', message)
                return git('rev-parse', 'HEAD')
            eligible = commit('fix boundary regression', 'def f(x):\n    """Return positive."""\n    return x >= 0\n')
            commit('fix comments only', file.read_text() + '# comment\n')
            commit('fix performance optimization', file.read_text().replace('x >= 0', 'x >= 1'))
            commit('fix: reduce memory footprint', file.read_text().replace('x >= 1', 'x > 1'))
            commit('fix pep8 errors', file.read_text().replace('x > 1', 'not x <= 1'))
            commit('ordinary change', file.read_text().replace('not x <= 1', 'x >= 2'))
            (repo/'notes.txt').write_text('note',encoding='utf-8')
            commit('bug fix with another changed file', file.read_text().replace('x >= 2','x >= 3'))
            report = mine(repo)
            self.assertEqual([item['commit'] for item in report['candidates']], [eligible])
            candidate = report['candidates'][0]
            self.assertTrue(candidate['hasDocstring'])
            self.assertEqual(candidate['function'], 'f')
            self.assertEqual(candidate['diffLines'], {'added': 1, 'deleted': 1, 'total': 2})
            self.assertIn('return x > 0',candidate['before'])
            self.assertIn('return x >= 0',candidate['after'])
            output=repo/'report.json'
            self.assertEqual(main([str(repo),'--files','bottle.py','--limit','1','--output',str(output)]),0)
            self.assertEqual(json.loads(output.read_text(encoding='utf-8'))['candidates'][0]['commit'],eligible)


if __name__ == '__main__':
    unittest.main()
