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

    def test_comprehension_first_iterable_keeps_the_injected_receiver(self):
        for returned in ('[row[1] for row in cur.fetchall()]',
                         '{row[1] for row in cur.fetchall()}',
                         '{row[0]: row[1] for row in cur.fetchall()}',
                         '(row[1] for row in cur.fetchall())'):
            with self.subTest(returned=returned):
                contract = self.contract('cur.execute("query")\nreturn ' + returned, parameters='cur')
                self.assertEqual([flow['method'] for flow in contract['flows']], ['execute', 'fetchall'])
                self.assertTrue(all(flow['root'] == {'kind': 'parameter', 'name': 'cur'}
                                    and flow['steps'] == [] for flow in contract['flows']))
                self.assertEqual(contract['flows'][1]['line'], 3)
                self.assertEqual(contract['status'], 'partial')
                self.assertEqual([item['code'] for item in contract['diagnostics']], ['expression-flow-unsupported'])
                self.assertFalse(contract['assertionOracle'])
                self.assertFalse(contract['patchAuthorization'])
                self.assertNotIn('query', json.dumps(contract))

    def test_comprehension_shadow_does_not_change_first_iterable_scope(self):
        contract = self.contract('return [cur.consume() for cur in cur.fetchall()]', parameters='cur')
        self.assertEqual([flow['method'] for flow in contract['flows']], ['fetchall'])
        self.assertEqual(contract['flows'][0]['root'], {'kind': 'parameter', 'name': 'cur'})
        self.assertEqual(contract['flows'][0]['steps'], [])
        self.assertEqual(contract['status'], 'partial')

    def test_single_comprehension_records_only_consumed_result_and_item_index_shape(self):
        contract = self.contract('cur.execute("query")\nreturn [row[1] for row in cur.fetchall()]', parameters='cur')
        self.assertNotIn('resultConsumption', contract['flows'][0], 'execute result is not the row iterable')
        self.assertEqual(contract['flows'][1]['resultConsumption'],
                         {'kind': 'iterable', 'itemAccesses': [{'kind': 'index', 'index': 1}]})
        self.assertFalse(contract['assertionOracle'])
        self.assertFalse(contract['patchAuthorization'])
        self.assertNotIn('expected', json.dumps(contract))
        self.assertNotIn('tuple', json.dumps(contract), 'index access does not prove a runtime container type')
        chained = self.contract('return [row[2] for row in cur.execute("query").fetchall()]', parameters='cur')
        self.assertEqual(chained['flows'][-1]['steps'],
                         [{'kind': 'member', 'name': 'execute'}, {'kind': 'return_value'}])
        self.assertEqual(chained['flows'][-1]['resultConsumption']['itemAccesses'], [{'kind': 'index', 'index': 2}])

    def test_conditional_dynamic_rebound_and_nested_items_do_not_gain_concrete_shape(self):
        expressions = ['[row[1] for row in cur.fetchall() if keep(row)]',
                       '[row[1] for row in cur.fetchall() for other in factory()]',
                       '[row[index] for row in cur.fetchall()]',
                       '[row[True] for row in cur.fetchall()]',
                       '[row[-1] for row in cur.fetchall()]',
                       '[row[1].finish() for row in cur.fetchall()]',
                       '[row[1] if flag else row[0] for row in cur.fetchall()]']
        for returned in expressions:
            with self.subTest(returned=returned):
                contract = self.contract('return ' + returned, parameters='cur, index, flag, keep')
                self.assertTrue(all('resultConsumption' not in flow for flow in contract['flows']))
        rebound = self.contract('cur = factory()\nreturn [row[1] for row in cur.fetchall()]', parameters='cur')
        self.assertTrue(all('resultConsumption' not in flow for flow in rebound['flows']))
        branch = self.contract('if flag:\n    return [row[1] for row in cur.fetchall()]', parameters='cur, flag')
        self.assertEqual(branch['flows'], [])

    def test_comprehension_elements_filters_and_later_iterables_stay_unknown(self):
        contract = self.contract('return [row.consume() if flag else other() '
                                 'for row in cur.fetchall() if keep(row) '
                                 'for item in factory().hidden()]', parameters='cur, flag, other, keep')
        self.assertEqual([flow['method'] for flow in contract['flows']], ['fetchall'])
        self.assertEqual(contract['status'], 'partial')
        nested = self.contract('return [[item.consume() for item in factory().hidden()] '
                               'for row in cur.fetchall()]', parameters='cur')
        self.assertEqual([flow['method'] for flow in nested['flows']], ['fetchall'])
        self.assertEqual(nested['status'], 'partial')

    def test_comprehension_dynamic_first_iterables_do_not_grant_receiver_facts(self):
        bodies = [
            'return [row for row in (cur.fetchall() if flag else other.fetchall())]',
            'return [row for row in (flag and cur.fetchall())]',
            'return [row for row in (cur := other).fetchall()]',
            'return [(cur := other) for row in cur.fetchall()]',
            'return [row for row in cur.fetchmany(flag if flag else 1)]',
            'return [row for row in cur.fetchmany([factory() for _ in values])]',
            'return [row for row in cur.fetchmany(*values)]',
            'return [row for row in cur.fetchmany(**values)]',
            'return [row for row in unknown.fetchall()]',
            'return [row for row in cur[0].fetchall()]',
            'return [row for row in getattr(cur, flag)()]',
        ]
        for body in bodies:
            with self.subTest(body=body):
                contract = self.contract(body, parameters='cur, other, flag, values')
                self.assertEqual(contract['flows'], [])
                self.assertEqual(contract['status'], 'partial')

    def test_async_comprehension_and_awaited_iterables_remain_unknown(self):
        for expression in ('[row async for row in cur.fetchall()]',
                           '[row for row in await cur.fetchall()]',
                           '[row for row in cur.fetchall() async for item in other]'):
            with self.subTest(expression=expression):
                source = 'async def target(cur, other):\n    return ' + expression + '\n'
                result = build_dependency_fixture_contract(ast.parse(source).body[0], source, 'target')
                self.assertEqual(result['flows'], [])
                self.assertEqual(result['status'], 'partial')

    def test_comprehension_keeps_real_chained_calls_and_does_not_propagate_result_shape(self):
        contract = self.contract('rows = [row for row in cur.execute("query").fetchall()]\n'
                                 'rows.consume()', parameters='cur')
        self.assertEqual([flow['method'] for flow in contract['flows']], ['execute', 'fetchall'])
        self.assertEqual(contract['flows'][1]['steps'],
                         [{'kind': 'member', 'name': 'execute'}, {'kind': 'return_value'}])
        self.assertFalse(any('resultBinding' in flow for flow in contract['flows']))
        self.assertEqual(contract['status'], 'partial')

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
