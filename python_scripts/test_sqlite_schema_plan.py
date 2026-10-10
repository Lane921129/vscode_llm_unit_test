import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from sqlite_schema_plan import parse_ddl, plan_schema, UnsupportedSchema


class LiteralSchemaTests(unittest.TestCase):
    def test_defaults_constraints_and_rowid_null_semantics(self):
        table = parse_ddl("""CREATE TABLE IF NOT EXISTS sample (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE DEFAULT 'it''s neutral',
            amount REAL DEFAULT 1.25, enabled INTEGER DEFAULT TRUE,
            missing TEXT DEFAULT NULL, UNIQUE (CODE, amount));""")[0]
        self.assertEqual(table['columns'][0], {'name': 'id', 'type': 'INTEGER', 'primaryKey': True, 'autoIncrement': True})
        self.assertNotIn('notNull', table['columns'][0])
        self.assertEqual(table['columns'][1]['default'], "it's neutral")
        self.assertEqual(table['columns'][2]['default'], 1.25)
        self.assertIs(table['columns'][3]['default'], True)
        self.assertIsNone(table['columns'][4]['default'])
        self.assertEqual(table['unique'], [['code', 'amount']])

    def test_unsupported_semantics_are_never_weakened(self):
        for ddl in (
            'CREATE TABLE t (v TEXT CHECK(length(v)>0))',
            'CREATE TABLE t (v TEXT COLLATE NOCASE)',
            'CREATE TABLE t (v INTEGER REFERENCES other(id))',
            'CREATE TABLE t (v TEXT DEFAULT CURRENT_TIMESTAMP)',
            'CREATE TABLE t (v INTEGER DEFAULT (1+1))',
            'CREATE TABLE t (v INTEGER PRIMARY KEY DESC)',
            'CREATE TABLE t (v INTEGER PRIMARY KEY ON CONFLICT IGNORE)',
            'CREATE TABLE t (v INTEGER PRIMARY KEY NOT NULL AUTOINCREMENT)',
            'CREATE TABLE t (v INTEGER AUTOINCREMENT PRIMARY KEY)',
            'CREATE TABLE t (v INTEGER, PRIMARY KEY(v))',
            'CREATE TABLE t (v INTEGER) STRICT',
            'CREATE TABLE t (v INTEGER PRIMARY KEY) WITHOUT ROWID',
            'CREATE TABLE t AS SELECT 1',
            'CREATE TABLE t (v TEXT DEFAULT 1.0)',
            'CREATE TABLE t (v BLOB DEFAULT 1e0)',
            'CREATE TABLE t (v INTEGER DEFAULT 9007199254740992)',
            'CREATE TABLE t (v INTEGER DEFAULT 9007199254740992.0)',
            'CREATE TABLE t (v REAL DEFAULT 1e999)',
            "CREATE TABLE t (v TEXT DEFAULT 'nul\0')",
            'CREATE TABLE t (v TEXT, UNIQUE(v), UNIQUE(v))',
            'CREATE TABLE t (a TEXT, b TEXT, UNIQUE(a,b), UNIQUE(b,a))',
            'CREATE TABLE select (id INTEGER)',
            'CREATE TABLE t (primary INTEGER)',
            'CREATE TABLE sqlite_shadow (v TEXT)',
            "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('seed');",
        ):
            with self.subTest(ddl=ddl), self.assertRaises(UnsupportedSchema):
                parse_ddl(ddl)

    def test_multiple_literal_tables_and_bounds(self):
        self.assertEqual(len(parse_ddl('CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);')), 2)
        with self.assertRaises(UnsupportedSchema):
            parse_ddl("CREATE TABLE t (v TEXT DEFAULT '" + 'x' * 4097 + "')")
        self.assertEqual(parse_ddl('CREATE TABLE "select" ("primary" INTEGER)')[0]['columns'][0]['name'], 'primary')


class SourceSchemaTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='schema-plan-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def plan(self, source, extra=None):
        file = self.root / 'sample.py'
        file.write_text(source, encoding='utf-8')
        files = [str(file)]
        for name, text in (extra or {}).items():
            other = self.root / name
            other.parent.mkdir(parents=True, exist_ok=True)
            other.write_text(text, encoding='utf-8')
            files.append(str(other))
        return plan_schema({'root': str(self.root), 'files': files})

    def test_static_helper_and_global_path_prove_exact_resource_without_execution(self):
        source = '''import sqlite3
from pathlib import Path
def database_path():
    base = Path(__file__).parent
    return base / "owned.sqlite"
DB = database_path()
def initialize():
    conn = sqlite3.connect(DB)
    cursor = conn.cursor()
    cursor.execute("CREATE TABLE IF NOT EXISTS sample (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE DEFAULT 'neutral')")
    cursor.execute("INSERT INTO sample(code) VALUES ('never seed')")
    raise RuntimeError("initializer must not execute")
raise RuntimeError("module must not execute")
'''
        original = self.root / 'owned.sqlite'
        original.write_bytes(b'original-resource-sentinel')
        with patch('sqlite3.connect', side_effect=AssertionError('no DB access')):
            result = self.plan(source)
        self.assertEqual(result['diagnostics'], [])
        self.assertEqual(len(result['candidates']), 1)
        candidate = result['candidates'][0]
        self.assertEqual(candidate['resource'], {'kind': 'sqlite', 'path': 'owned.sqlite'})
        self.assertEqual(candidate['sourceHash'], hashlib.sha256((self.root / 'sample.py').read_bytes()).hexdigest())
        self.assertNotIn('rows', candidate['table'])
        self.assertEqual(original.read_bytes(), b'original-resource-sentinel')

    def test_two_connections_keep_distinct_resource_identity(self):
        result = self.plan('''from sqlite3 import connect as open_db
def initialize():
    first = open_db("first.sqlite")
    second = open_db("second.sqlite")
    first.execute("CREATE TABLE IF NOT EXISTS a (id INTEGER)")
    second.execute("CREATE TABLE IF NOT EXISTS b (id INTEGER)")
''')
        self.assertEqual([(c['resource']['path'], c['table']['name']) for c in result['candidates']],
                         [('first.sqlite', 'a'), ('second.sqlite', 'b')])

    def test_unknown_path_and_fake_receiver_are_diagnostics(self):
        cases = [
            ('import sqlite3\nfrom config import DB\nc = sqlite3.connect(DB)\n', 'dynamic-database-path'),
            ('from arbitrary import connect\nc = connect("owned.sqlite")\n', 'unproven-sqlite-receiver'),
            ('import sqlite3\nsqlite3.connect = replacement\nc = sqlite3.connect("owned.sqlite")\n', 'unproven-sqlite-receiver'),
            ('import sqlite3\nother = sqlite3\nother.connect = replacement\nc = sqlite3.connect("owned.sqlite")\n', 'unproven-sqlite-receiver'),
            ('import sqlite3\nfrom replacement import *\nc = sqlite3.connect("owned.sqlite")\n', 'unproven-sqlite-receiver'),
            ('import sqlite3\nsqlite3.__dict__["connect"] = replacement\nc = sqlite3.connect("owned.sqlite")\n', 'unproven-sqlite-receiver'),
            ('import sqlite3\nmutate(sqlite3)\nc = sqlite3.connect("owned.sqlite")\n', 'unproven-sqlite-receiver'),
            ('import sqlite3\nclass sqlite3: pass\nc = sqlite3.connect("owned.sqlite")\n', 'unproven-sqlite-receiver'),
            ('import sqlite3\ndef p():\n    touch_original()\n    return "owned.sqlite"\nc = sqlite3.connect(p())\n', 'dynamic-database-path'),
        ]
        for prefix, reason in cases:
            with self.subTest(reason=reason):
                result = self.plan(prefix + 'c.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER)")\n')
                self.assertEqual(result['candidates'], [])
                self.assertIn(reason, [d['reason'] for d in result['diagnostics']])

    def test_local_sqlite_shadow_and_branch_receivers_do_not_prove_sqlite(self):
        result = self.plan('import sqlite3\nc = sqlite3.connect("owned.sqlite")\nc.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER)")\n', {'sqlite3.py': 'raise RuntimeError("do not import")'})
        self.assertEqual(result['candidates'], [])

    def test_function_lexical_bindings_include_unreachable_imports_and_assignments(self):
        result = self.plan('import sqlite3\ndef initialize():\n'
            + '    c = sqlite3.connect("owned.sqlite")\n    c.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER)")\n'
            + '    import replacement as sqlite3\n')
        self.assertEqual(result['candidates'], [])
        result = self.plan('import sqlite3\nDB = "owned.sqlite"\ndef p():\n    return DB\n    DB = "other.sqlite"\n'
            + 'def initialize():\n    c = sqlite3.connect(p())\n    c.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER)")\n')
        self.assertEqual(result['candidates'], [])
        result = self.plan('import sqlite3\nDB = "owned.sqlite"\ndef p():\n    global DB\n    DB = "other.sqlite"\n    return DB\n'
            + 'p()\nc = sqlite3.connect(DB)\nc.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER)")\n')
        self.assertEqual(result['candidates'], [])
        result = self.plan('import sqlite3\nif unknown:\n    c = sqlite3.connect("owned.sqlite")\nc.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER)")\n')
        self.assertEqual(result['candidates'], [])

    def test_invalid_source_scope_never_reads_outside_root(self):
        for request in ({'root': '.', 'files': []}, {'root': str(self.root), 'files': [str(self.root.parent / 'outside.py')]}):
            with self.assertRaises(ValueError):
                plan_schema(request)

    def test_non_idempotent_source_ddl_is_not_precreated(self):
        result = self.plan('import sqlite3\nc = sqlite3.connect("owned.sqlite")\nc.execute("CREATE TABLE sample (id INTEGER)")\n')
        self.assertEqual(result['candidates'], [])
        self.assertEqual(result['diagnostics'][0]['reason'], 'non-idempotent-schema')


if __name__ == '__main__':
    unittest.main()
