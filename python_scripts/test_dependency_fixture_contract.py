import ast
from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from dependency_fixture_contract import build_dependency_fixture_contract
from ast_extractor import extract_info


class DependencyFixtureContractTests(unittest.TestCase):
    def contract(self, body, parameters='', name='target', declarations=('factory',)):
        source = 'def ' + name + '(' + parameters + '):\n' + ''.join('    ' + line + '\n' for line in body.splitlines())
        node = ast.parse(source).body[0]
        before = ast.dump(node, include_attributes=True)
        result = build_dependency_fixture_contract(node, source, name, declarations)
        self.assertEqual(ast.dump(node, include_attributes=True), before, 'analysis cannot modify the source AST')
        return result

    def test_database_receiver_chain_distinguishes_execute_result_from_cursor_result(self):
        contract = self.contract('conn = factory()\ncur = conn.cursor()\ncur.execute("query")\nrows = cur.fetchall()\nconn.close()\nreturn rows')
        flows = contract['flows']
        self.assertEqual([flow['method'] for flow in flows], [None, 'cursor', 'execute', 'fetchall', 'close'])
        expected_receiver = [{'kind': 'return_value'}, {'kind': 'member', 'name': 'cursor'}, {'kind': 'return_value'}]
        self.assertEqual(flows[2]['steps'], expected_receiver)
        self.assertEqual(flows[3]['steps'], expected_receiver)
        self.assertEqual(flows[3]['resultBinding'], 'rows')
        self.assertEqual([flow['line'] for flow in flows], [2, 3, 4, 5, 6])
        self.assertNotIn('query', json.dumps(contract), 'fixture topology is not SQL or assertion evidence')
        self.assertEqual(contract['status'], 'complete')

    def test_actual_chained_execute_fetchall_retains_the_intermediate_return_value(self):
        contract = self.contract('cur = factory().cursor()\nreturn cur.execute("query").fetchall()')
        fetchall = contract['flows'][-1]
        self.assertEqual(fetchall['method'], 'fetchall')
        self.assertEqual(fetchall['steps'][-2:], [{'kind': 'member', 'name': 'execute'}, {'kind': 'return_value'}])

    def test_injected_cursor_methods_are_shape_facts_not_a_demand_to_mock(self):
        contract = self.contract('cur.execute("query")\nreturn cur.fetchall()', parameters='cur')
        self.assertEqual([flow['root'] for flow in contract['flows']], [{'kind': 'parameter', 'name': 'cur'}] * 2)
        self.assertTrue(all(flow['steps'] == [] for flow in contract['flows']))
        self.assertEqual(contract['authority'], 'fixture-shape-only')
        self.assertFalse(contract['assertionOracle'])
        self.assertFalse(contract['patchAuthorization'])

    def test_context_entry_only_exists_when_explicit_with_occurs(self):
        contract = self.contract('with factory() as conn:\n    cur = conn.cursor()\n    cur.fetchall()')
        self.assertEqual([flow['method'] for flow in contract['flows']], [None, '__enter__', 'cursor', 'fetchall'])
        self.assertTrue(contract['flows'][1]['implicitContextEntry'])
        self.assertEqual(contract['flows'][1]['resultBinding'], 'conn')
        self.assertEqual(contract['flows'][2]['steps'], [{'kind': 'return_value'}, {'kind': 'context-enter'}])
        plain = self.contract('conn = factory()\nconn.cursor()')
        self.assertNotIn('context-enter', json.dumps(plain))
        existing = self.contract('with cur as opened:\n    opened.execute("query")', parameters='cur')
        self.assertEqual(existing['flows'][0]['resultBinding'], 'opened')
        self.assertEqual(existing['flows'][1]['steps'], [{'kind': 'context-enter'}])

    def test_alias_rebinding_and_branches_stop_propagation(self):
        bodies = [
            'conn = factory()\nother = conn\nother.cursor()',
            'conn = factory()\nconn = factory()\nconn.cursor()',
            'conn = factory()\nif flag:\n    conn = factory()\nconn.cursor()',
            'conn = factory()\nif flag:\n    conn.cursor = replacement\nconn.cursor()',
        ]
        for body in bodies:
            with self.subTest(body=body):
                contract = self.contract(body, parameters='flag')
                self.assertFalse(any(flow['method'] == 'cursor' for flow in contract['flows']))
                self.assertEqual(contract['status'], 'partial')
                self.assertTrue(contract['diagnostics'])

    def test_unknown_globals_and_local_shadowing_are_not_factory_authorization(self):
        unknown = self.contract('conn = missing()\nconn.cursor()')
        self.assertEqual(unknown['flows'], [])
        shadowed = self.contract('conn = factory()\nfactory = 3\nconn.cursor()')
        self.assertEqual(shadowed['flows'], [])
        self.assertTrue(any(item['code'] == 'receiver-unresolved' for item in shadowed['diagnostics']))

    def test_nested_callables_comprehensions_await_and_dynamic_receivers_are_not_traced(self):
        contract = self.contract('def nested():\n    factory().hidden()\ncur = factory()\nreturn cur.read()')
        self.assertEqual([flow['method'] for flow in contract['flows']], [None, 'read'])
        for body in ('return [factory().cursor() for _ in values]', 'return factory()[0].cursor()',
                     'conn = factory() if flag else factory()\nconn.cursor()', 'return getattr(values, flag)().cursor()'):
            with self.subTest(body=body):
                result = self.contract(body, parameters='values, flag')
                self.assertEqual(result['flows'], [])
                self.assertEqual(result['status'], 'partial')
        source = 'async def target():\n    conn = await factory()\n    return conn.cursor()\n'
        result = build_dependency_fixture_contract(ast.parse(source).body[0], source, 'target', ('factory',))
        self.assertEqual(result['flows'], [])

    def test_source_hash_is_explicit_normalized_target_not_raw_file(self):
        source = 'def target(cur):\r\n    return cur.fetchall()\r\n'
        node = ast.parse(source).body[0]
        contract = build_dependency_fixture_contract(node, source, 'target')
        self.assertEqual(contract['targetSourceHash'], hashlib.sha256(source.replace('\r\n', '\n').encode()).hexdigest())
        self.assertNotEqual(contract['targetSourceHash'], hashlib.sha256(source.encode()).hexdigest())
        self.assertEqual(contract['sourceHashKind'], 'normalized-target-source')
        self.assertNotIn('sourceHash', contract)

    def test_extractor_integrates_without_importing_application_or_inventing_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'sample.py'
            source.write_text('raise RuntimeError("must never execute")\nimport missing_dependency as bridge\n'
                              'def target():\n    conn = bridge.connect()\n    return conn.cursor().fetchall()\n', encoding='utf-8')
            output = io.StringIO()
            with redirect_stdout(output):
                extract_info(str(source), 'target')
        extracted = json.loads(output.getvalue())
        contract = extracted['dependency_fixture_contract']
        self.assertEqual(contract['targetSourceHash'], hashlib.sha256(extracted['code'].encode()).hexdigest())
        self.assertEqual(contract['startLine'], 3)
        self.assertEqual(contract['flows'][0]['root'], {'kind': 'use-point', 'name': 'bridge'})
        self.assertEqual(contract['flows'][0]['method'], 'connect')
        self.assertNotIn('missing_dependency', json.dumps(contract))

    def test_target_instance_and_recursive_target_are_never_fixture_roots(self):
        source = 'class Service:\n    def target(self):\n        return self.other()\n'
        contract = build_dependency_fixture_contract(ast.parse(source).body[0].body[0], source, 'Service.target')
        self.assertEqual(contract['flows'], [])
        self.assertEqual(contract['diagnostics'][0]['code'], 'target-instance-not-fixture')
        recursive = self.contract('return target()', declarations=('target',))
        self.assertEqual(recursive['flows'], [])

    def test_contract_overflow_does_not_present_truncated_topology_as_complete(self):
        contract = self.contract('\n'.join('cur.execute()' for _ in range(130)), parameters='cur')
        self.assertEqual(contract['status'], 'unsupported')
        self.assertEqual(contract['flows'], [])
        self.assertEqual(contract['diagnostics'][0]['code'], 'contract-limit-exceeded')


if __name__ == '__main__':
    unittest.main()
