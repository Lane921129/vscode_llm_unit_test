"""case_table_facts reads the target statically and names only patchable dependencies."""
import io
import json
import unittest

from case_table_facts import collect_facts, main, FactsError

SOURCE = '''
import os.path
import sqlite3 as db
from json import loads
from .store import Repository

LIMIT = 10

def helper():
    return 1

def target(path: str, retries: int = 3, *, strict=False) -> dict:
    """Read a record."""
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    elif retries < 0:
        raise ValueError("retries")
    conn = db.connect(path)
    cur = conn.cursor()
    row = cur.fetchone()
    with open(path) as handle:
        text = handle.read()
    while retries > LIMIT:
        retries -= 1
    data = loads(text) if text else {}
    assert isinstance(data, dict)
    value = len(str(path).strip()) + helper()
    repo = Repository()
    repo.save(row)
    path.upper()
    def inner():
        return db.never_called()
    return data

class Box:
    def method(self, item):
        self.items.append(item)
        return helper()

    @staticmethod
    def make(x):
        return x

    @classmethod
    def build(cls, x):
        return cls(x)
'''


class FactsTests(unittest.TestCase):
    def setUp(self):
        self.facts = collect_facts(SOURCE, 'target')

    def test_signature_parameters_docstring_and_raises(self):
        self.assertEqual(self.facts['signature'], 'target(path: str, retries: int = 3, strict=False) -> dict')
        self.assertEqual([p['kind'] for p in self.facts['parameters']],
                         ['positional_or_keyword', 'positional_or_keyword', 'keyword_only'])
        self.assertEqual(self.facts['docstring'], 'Read a record.')
        self.assertEqual(self.facts['raises'], ['FileNotFoundError', 'ValueError'])
        self.assertEqual(self.facts['methodKind'], 'module')

    def test_branch_conditions_cover_if_elif_while_ifexp_and_assert(self):
        self.assertEqual([(b['kind'], b['condition']) for b in self.facts['branches']], [
            ('if', 'not os.path.exists(path)'), ('elif', 'retries < 0'), ('while', 'retries > LIMIT'),
            ('conditional-expression', 'text'), ('assert', 'isinstance(data, dict)')])

    def test_dependencies_are_module_names_imports_and_local_chains(self):
        by_name = {d['name']: d for d in self.facts['dependencies']}
        self.assertEqual(by_name['os.path.exists'], {'name': 'os.path.exists', 'patch': 'os.path.exists', 'chain': []})
        self.assertEqual(by_name['db.connect'], {'name': 'db.connect', 'patch': 'db.connect', 'chain': []})
        self.assertEqual(by_name['cur.fetchone'], {'name': 'cur.fetchone', 'patch': 'db.connect',
                                                   'chain': ['()', 'cursor', '()', 'fetchone']})
        self.assertEqual(by_name['handle.read'], {'name': 'handle.read', 'patch': 'open', 'chain': ['()', '__enter__', '()', 'read']})
        self.assertEqual(by_name['open'], {'name': 'open', 'patch': 'open', 'chain': [], 'create': True})
        self.assertEqual(by_name['repo.save']['patch'], 'Repository')
        for name in ('loads', 'helper', 'Repository'):
            self.assertIn(name, by_name)
        for absent in ('len', 'str', 'isinstance', 'path.upper', 'db.never_called', 'FileNotFoundError', 'ValueError'):
            self.assertNotIn(absent, by_name, absent)

    def test_methods_drop_self_and_cls(self):
        method = collect_facts(SOURCE, 'Box.method')
        self.assertEqual((method['signature'], method['methodKind'], method['className']), ('method(item)', 'instance', 'Box'))
        self.assertEqual([d['name'] for d in method['dependencies']], ['helper'])
        self.assertEqual(collect_facts(SOURCE, 'Box.make')['signature'], 'make(x)')
        self.assertEqual(collect_facts(SOURCE, 'Box.build')['signature'], 'build(x)')

    def test_errors_and_cli(self):
        with self.assertRaises(FactsError):
            collect_facts(SOURCE, 'missing')
        with self.assertRaises(FactsError):
            collect_facts('def broken(:\n', 'broken')
        out = io.StringIO()
        self.assertEqual(main(['/nonexistent/file.py', 'target'], out), 1)
        self.assertEqual(json.loads(out.getvalue())['error'], 'source-unreadable')
        out = io.StringIO()
        self.assertEqual(main(['only-one'], out), 2)


if __name__ == '__main__':
    unittest.main()
