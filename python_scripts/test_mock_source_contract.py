"""Source-bound mock identities and setup-only scaffold regressions."""
import ast
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mock_scaffold_generator import generate_scaffold
from validate_test_bindings import validate_bindings


SOURCE = 'import sqlite3 as sql\nDB_NAME = ":memory:"\ndef target():\n    return sql.connect(DB_NAME)\n'


def candidate(path='sqlite3.connect', body=None):
    return ('import unittest\nfrom unittest.mock import patch\nimport sample\n'
            'class Cases(unittest.TestCase):\n    def test_target(self):\n'
            + textwrap.indent(body or (f'with patch({path!r}) as dep:\n'
                                      '    controlled = object()\n    dep.return_value = controlled\n'
                                      '    self.assertIs(sample.target(), controlled)\n'
                                      '    dep.assert_called_once_with(sample.DB_NAME)\n'), '        '))


class MockSourceContractTests(unittest.TestCase):
    def context(self, module_source=SOURCE, **extra):
        return {'module': 'sample', 'target': 'target', 'source': 'def target():\n    return sql.connect(DB_NAME)\n',
                'moduleSource': module_source, 'requireMockBehavior': True, 'requireTargetBehavior': True, **extra}

    def scaffold(self, source, trace=None, target='target'):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder, 'sample.py')
            file.write_text(source, encoding='utf-8')
            return generate_scaffold(str(file), target, trace, 'sample')

    def test_module_import_member_aliases_observe_a_real_target_and_patch_object(self):
        candidates = [candidate('sample.sql.connect'), candidate(),
                      candidate().replace('import sample\n', 'import sample\nimport sqlite3 as external\n')
                      .replace("patch('sqlite3.connect')", "patch.object(external, 'connect')")]
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'sample.py').write_text(SOURCE, encoding='utf-8')
            for code in candidates:
                self.assertTrue(validate_bindings(code, self.context())['valid'])
                Path(folder, 'generated.py').write_text(code, encoding='utf-8')
                run = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'generated'], cwd=folder,
                                     capture_output=True, text=True, timeout=10)
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertIn('Ran 1 test', run.stderr)

    def test_equivalence_requires_current_complete_source_and_an_unchanged_module_object(self):
        invalid_sources = [SOURCE.replace('import sqlite3 as sql', 'from somewhere import sql'),
                           SOURCE.replace('DB_NAME =', 'sql = object()\nDB_NAME ='),
                           SOURCE.replace('DB_NAME =', 'sql.connect = replacement\nDB_NAME ='),
                           SOURCE + '\ndef mutate():\n    globals()["sql"] = replacement\n',
                           SOURCE + '\nif flag:\n    import other as sql\n',
                           SOURCE + '\ntry:\n    raise ValueError()\nexcept ValueError as sql:\n    pass\n',
                           SOURCE.replace('return sql.connect(DB_NAME)', 'return sql.connect("other")')]
        for source in invalid_sources:
            with self.subTest(source=source):
                self.assertFalse(validate_bindings(candidate(), self.context(source))['valid'])
        fragment_only = self.context()
        fragment_only.pop('moduleSource')
        fragment_only['dependencies'] = {'sql': 'sqlite3'}
        self.assertFalse(validate_bindings(candidate(), fragment_only)['valid'])
        from_import = 'from sqlite3 import connect\ndef target():\n    return connect(":memory:")\n'
        self.assertFalse(validate_bindings(candidate(), self.context(from_import, source=from_import))['valid'])
        replaced = candidate(body='with patch("sample.sql"), patch("sqlite3.connect") as dep:\n'
                             '    sample.target()\n    dep.assert_called_once()\n')
        self.assertFalse(validate_bindings(replaced, self.context())['valid'])
        locally_replaced = candidate(body='import sample as application\nalias = application\n'
                                    'with patch.object(alias, "sql"), patch("sqlite3.connect") as dep:\n'
                                    '    sample.target()\n    dep.assert_called_once()\n')
        self.assertFalse(validate_bindings(locally_replaced, self.context())['valid'])
        target_patch = candidate('sample.target')
        self.assertFalse(validate_bindings(target_patch, self.context())['valid'])

    def test_class_member_source_selection_has_no_same_named_module_fallback(self):
        source = 'import sqlite3 as sql\nclass Owner:\n    @staticmethod\n    def target():\n        return sql.connect(":memory:")\n'
        code = candidate().replace('sample.target()', 'sample.Owner.target()').replace('sample.DB_NAME', '":memory:"')
        context = {'module': 'sample', 'className': 'Owner', 'target': 'target', 'moduleSource': source,
                   'source': 'def target():\n    return sql.connect(":memory:")\n', 'requireMockBehavior': True}
        # The full decorated member must match the complete supplied fragment.
        context['source'] = '@staticmethod\ndef target():\n    return sql.connect(":memory:")\n'
        self.assertTrue(validate_bindings(code, context)['valid'])
        context['className'] = 'Other'
        self.assertFalse(validate_bindings(code, context)['valid'])

    def test_test_owned_undefined_and_shadowed_names_route_to_writer(self):
        undefined = candidate().replace('sample.DB_NAME', 'DB_NAME')
        result = validate_bindings(undefined, self.context())
        self.assertFalse(result['valid'])
        self.assertEqual(result['reasonCode'], 'writer-undefined-name')
        self.assertEqual(result['repairRole'], 'writer')
        shadowed = ('import unittest\nfrom pathlib import Path\nfrom unittest.mock import patch\nimport sample\n'
                    'class Cases(unittest.TestCase):\n    def test_target(self):\n'
                    '        with patch("sample.sql", return_value=Path("fixture")) as Path:\n'
                    '            self.assertIsNotNone(sample.target())\n')
        result = validate_bindings(shadowed, {'module': 'sample', 'target': 'target'})
        self.assertEqual(result['reasonCode'], 'writer-unbound-local-name')
        self.assertTrue(validate_bindings(shadowed.replace('as Path:', 'as sql_stub:'),
                                         {'module': 'sample', 'target': 'target'})['valid'])
        other_scope = ('import unittest\nimport sample\nclass Cases(unittest.TestCase):\n'
                       '    def helper(self):\n        from pathlib import Path\n'
                       '    def test_target(self):\n        self.assertEqual(sample.target(), Path("fixture"))\n')
        self.assertEqual(validate_bindings(other_scope, {'module': 'sample', 'target': 'target'})['reasonCode'],
                         'writer-undefined-name')

    def test_unknown_control_flow_and_target_source_errors_are_not_test_name_proofs(self):
        code = 'import unittest\nimport sample\nclass Cases(unittest.TestCase):\n    def test_target(self):\n'
        self.assertTrue(validate_bindings(code + '        if False:\n            absent()\n', {})['valid'])
        self.assertTrue(validate_bindings(code + '        with self.assertRaises(NameError):\n            sample.target()\n',
                                         {'module': 'sample', 'target': 'target', 'source': 'def target(): return missing_source_name'})['valid'])
        self.assertTrue(validate_bindings(code + '        value = (controlled := object())\n        self.assertIs(value, controlled)\n', {})['valid'])
        invalid_scope = validate_bindings(code + '        print(value)\n        global value\n', {})
        self.assertFalse(invalid_scope['valid'])
        self.assertEqual(invalid_scope['reasonCode'], 'writer-invalid-name-scope')
        self.assertTrue(validate_bindings('class InputFixture:\n    def test_description(self): return external_name\n', {})['valid'])

    def test_name_feedback_groups_missing_helpers_and_globals_without_changing_primary_rejection(self):
        code = candidate(body='controlled = MissingFactory(MissingInput)\n'
                              'self.assertIs(sample.target(), controlled)\n'
                              'self.assertEqual(MissingModule.value, SOURCE_KEY)\n'
                              'self.assertEqual(SOURCE_KEY, SOURCE_KEY)\n')
        result = validate_bindings(code, self.context())
        self.assertFalse(result['valid'])
        self.assertEqual((result['name'], result['method'], result['reasonCode'], result['repairRole']),
                         ('MissingFactory', 'test_target', 'writer-undefined-name', 'writer'))
        self.assertIn('Additional statically unresolved bindings (bounded scan):', result['reason'])
        for name in ('MissingInput', 'MissingModule', 'SOURCE_KEY'):
            self.assertEqual(result['reason'].count(name + ' in test_target'), 1)
        self.assertNotIn('controlled in test_target', result['reason'])
        self.assertIn('do not change assertions or install a guessed package', result['reason'])

    def test_name_feedback_includes_local_shadowing_but_stops_at_unknown_control_flow(self):
        code = ('import unittest\nfrom pathlib import Path\nfrom unittest.mock import patch\nimport sample\n'
                'class Cases(unittest.TestCase):\n    def test_target(self):\n'
                '        with patch("sample.sql", return_value=Path("fixture")) as Path:\n'
                '            controlled = MissingHelper()\n'
                '            self.assertIs(sample.target(), controlled)\n'
                '        if False:\n            ConditionalName()\n'
                '        AfterUnknown()\n')
        result = validate_bindings(code, {'module': 'sample', 'target': 'target'})
        self.assertEqual(result['name'], 'Path')
        self.assertEqual(result['reasonCode'], 'writer-unbound-local-name')
        self.assertIn('MissingHelper in test_target', result['reason'])
        self.assertNotIn('ConditionalName', result['reason'])
        self.assertNotIn('AfterUnknown', result['reason'])

    def test_name_feedback_is_bounded_and_never_truncates_an_identifier(self):
        code = candidate(body='\n'.join(f'Unresolved_{index}()' for index in range(12)) + '\n')
        result = validate_bindings(code, {})
        self.assertEqual(result['name'], 'Unresolved_0')
        for index in range(1, 8):
            self.assertIn(f'Unresolved_{index} in test_target', result['reason'])
        self.assertNotIn('Unresolved_8', result['reason'])
        huge = 'LongName_' + 'x' * 1200
        result = validate_bindings(candidate(body=f'FirstMissing()\n{huge}()\n'), {})
        self.assertEqual(result['name'], 'FirstMissing')
        self.assertNotIn('LongName_', result['reason'])
        self.assertNotIn('Additional statically', result['reason'])

    def test_missing_real_target_import_is_reported_before_generic_behavior_gates(self):
        missing = candidate().replace('sample.target()', 'target()')
        for mock_required, target_required in ((True, True), (False, True), (True, False)):
            with self.subTest(mock_required=mock_required, target_required=target_required):
                context = self.context(requireMockBehavior=mock_required, requireTargetBehavior=target_required)
                result = validate_bindings(missing, context)
                self.assertFalse(result['valid'])
                self.assertEqual(result['reasonCode'], 'writer-undefined-name')
                self.assertEqual(result['name'], 'target')
                self.assertEqual(result['method'], 'test_target')
                self.assertEqual(result['repairRole'], 'writer')
                correct = missing.replace('import sample\n', 'import sample\nfrom sample import target\n')
                self.assertTrue(validate_bindings(correct, context)['valid'])
        impostor = missing.replace('import sample\n', 'import sample\nfrom unrelated import target\n')
        result = validate_bindings(impostor, self.context())
        self.assertFalse(result['valid'])
        self.assertIn('must be imported from sample', result['reason'])
        source_error = ('import unittest\nimport sample\nclass Cases(unittest.TestCase):\n'
                        '    def test_source_error(self):\n        with self.assertRaises(NameError):\n            sample.target()\n')
        self.assertTrue(validate_bindings(source_error, {'module': 'sample', 'target': 'target',
                                                        'source': 'def target(): return missing_source_name',
                                                        'requireTargetBehavior': True})['valid'])

    def test_scaffold_does_not_mock_imported_computation_or_unknown_helpers(self):
        source = ('import math\nimport hashlib\nfrom opaque import transform\n'
                  'def target(value):\n    return transform(math.sqrt(value), hashlib.sha256(b"fixture"))\n')
        result = self.scaffold(source)
        self.assertEqual(result['patches'], [])
        self.assertEqual({item['use_point'] for item in result['unknown_calls']},
                         {'sample.math.sqrt', 'sample.hashlib.sha256', 'sample.transform'})
        self.assertFalse(result['executable'])
        self.assertIn('SETUP PLACEHOLDERS ONLY', result['scaffold'])

    def test_scaffold_proves_io_boundaries_but_not_shadowed_open_or_pure_helpers(self):
        source = ('import sqlite3 as sql\nimport math\n'
                  'def open_connection(): return sql.connect(":memory:")\n'
                  'def normalize(value): return math.sqrt(value)\n'
                  'def target(value): return open_connection(), normalize(value)\n')
        self.assertEqual(self.scaffold(source)['patches'], ['sample.open_connection'])
        self.assertEqual(self.scaffold('def open(value): return value\ndef target(): return open(1)\n')['patches'], [])
        self.assertEqual(self.scaffold('def target(open): return open("fixture")\n')['patches'], [])
        self.assertEqual(self.scaffold('def target(): return open("fixture")\n')['patches'], ['sample.open'])
        conditional = 'import sqlite3 as sql\nif flag:\n    import other as sql\ndef target(): return sql.connect("fixture")\n'
        self.assertEqual(self.scaffold(conditional)['patches'], [])
        dynamic_open = 'globals()["open"] = other\ndef target(): return open("fixture")\n'
        self.assertEqual(self.scaffold(dynamic_open)['patches'], [])

    def test_scaffold_never_promotes_unchecked_trace_text_to_real_return(self):
        result = self.scaffold(SOURCE, {'examples': [{'result': '<non_assertable: _MemoryConnection>',
                                                     'result_assertable': False, 'call_assertable': False}]})
        self.assertNotIn('Real return', result['scaffold'])
        self.assertNotIn('_MemoryConnection', result['scaffold'])
        self.assertEqual(result['trace_hints'], 'omitted-setup-is-not-an-oracle')
        self.assertIn('source shape is unknown, no value is supplied', result['scaffold'])
        self.assertNotIn('return_value = None', result['scaffold'])

    def test_scaffold_placeholders_cannot_be_accepted_as_a_complete_candidate(self):
        for code in [candidate() + '\n# SETUP PLACEHOLDERS ONLY: fill every TODO\n',
                     candidate().replace('dep.return_value = controlled',
                                         'dep.return_value = None  # TODO: set appropriate mock return value')]:
            result = validate_bindings(code, self.context())
            self.assertFalse(result['valid'])
            self.assertEqual(result['reasonCode'], 'writer-scaffold-placeholder')
            self.assertEqual(result['repairRole'], 'writer')
        self.assertTrue(validate_bindings(candidate().replace('controlled = object()', 'controlled = None'), self.context())['valid'])
        self.assertTrue(validate_bindings(candidate() + '\ntext = "# SETUP PLACEHOLDERS ONLY: literal"\n', self.context())['valid'])

    def test_scaffold_same_leaf_boundaries_get_distinct_mock_parameters(self):
        source = 'import sqlite3 as first\nimport sqlite3 as second\ndef target(): return first.connect("a"), second.connect("b")\n'
        result = self.scaffold(source)
        self.assertEqual(result['mock_names'], ['mock_connect', 'mock_connect_2'])
        ast.parse(result['scaffold'])

    def test_scaffold_uses_the_shared_property_and_constructor_contract(self):
        source = ('class Owner:\n    def __init__(receiver, /, *, configuration):\n'
                  '        receiver.configuration = configuration\n    @property\n'
                  '    def target(receiver): return receiver.configuration\n')
        result = self.scaffold(source, target='Owner.target')
        self.assertEqual(result['method_kind'], 'property')
        self.assertEqual(result['func_params'], [])
        self.assertIn('provide valid values for: configuration', result['scaffold'])
        self.assertIn('result = instance.target\n', result['scaffold'])
        self.assertNotIn('instance.target(', result['scaffold'])
        self.assertFalse(result['executable'])

    def test_scaffold_preserves_static_self_posonly_and_keyword_arguments_in_real_calls(self):
        source = ('class Owner:\n    @staticmethod\n    def target(self, /, *, flag):\n'
                  '        return self, flag\n')
        result = self.scaffold(source, target='Owner.target')
        self.assertEqual(result['func_params'], ['self', 'flag'])
        self.assertEqual(result['parameter_bindings'], {'self': 'input_self', 'flag': 'flag'})
        self.assertIn('Owner.target(input_self, flag=flag)', result['scaffold'])
        self.assertNotIn('self = None', result['scaffold'])
        # Complete the deliberately non-executable setup using explicit fixture
        # values. This exercises Python's binding rules, not just emitted text.
        code = ('import unittest\n' + source + '\nclass Cases(unittest.TestCase):\n'
                + textwrap.indent(result['scaffold'], '    '))
        code = code.replace("# TODO: define input_self explicitly for parameter 'self'; no fixture value is supplied", 'input_self = 7')
        code = code.replace("# TODO: define flag explicitly for parameter 'flag'; no fixture value is supplied", 'flag = True')
        code += '\n        self.assertEqual(result, (7, True))\n'
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'generated.py').write_text(code, encoding='utf-8')
            run = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'generated'], cwd=folder,
                                 capture_output=True, text=True, timeout=10)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn('Ran 1 test', run.stderr)

    def test_scaffold_does_not_shadow_patch_parameters_or_invent_unknown_constructor_setup(self):
        source = ('import sqlite3 as sql\ndef target(mock_connect, /, *items, flag, **options):\n'
                  '    return sql.connect(mock_connect)\n')
        result = self.scaffold(source)
        self.assertEqual(result['mock_names'], ['mock_connect_2'])
        self.assertEqual(result['func_params'], ['mock_connect', 'flag', 'items', 'options'])
        self.assertIn('target(mock_connect, flag=flag, *items, **options)', result['scaffold'])
        self.assertNotIn(' = None', result['scaffold'])
        ast.parse(result['scaffold'])
        inherited = self.scaffold('class Owner(ExternalBase):\n    def target(self): return self.value\n', target='Owner.target')
        self.assertIn('verify inherited constructor setup', inherited['scaffold'])
        self.assertNotIn('instance = Owner()', inherited['scaffold'])

    def test_prompt_section_heading_and_parameter_or_immutable_patches_report_specific_repairs(self):
        for bad_import in ('import HOST_ISOLATED_RESOURCE_CONTEXT\n',
                           'from HOST_ISOLATED_RESOURCE_CONTEXT import setup\n'):
            res = validate_bindings(bad_import + candidate(), self.context())
            self.assertFalse(res['valid'])
            self.assertIn('HOST_ISOLATED_RESOURCE_CONTEXT is a prompt section heading', res['reason'])

        ui_source = 'def close_dialog(page, dialog):\n    dialog.open = False\n    page.update()\n'
        ui_ctx = {'module': 'main', 'target': 'close_dialog', 'source': ui_source, 'moduleSource': ui_source,
                  'requireMockBehavior': True, 'requireTargetBehavior': True}
        bad_param_patch = ('import unittest\nfrom unittest.mock import patch\nfrom main import close_dialog\n'
                           'class Cases(unittest.TestCase):\n    @patch("main.page.update")\n'
                           '    def test_close(self, mock_update):\n        close_dialog(object(), object())\n'
                           '        mock_update.assert_called_once()\n')
        res = validate_bindings(bad_param_patch, ui_ctx)
        self.assertFalse(res['valid'])
        self.assertIn('page is a parameter of close_dialog, not a module attribute of main', res['reason'])

        dt_source = 'from datetime import datetime\ndef stamp():\n    return datetime.now().isoformat()\n'
        dt_ctx = {'module': 'database', 'target': 'stamp', 'source': dt_source, 'moduleSource': dt_source,
                  'dependencies': {'datetime': 'datetime.datetime'}, 'requireMockBehavior': True}
        for bad_dt in ('database.datetime.now', 'datetime.datetime.now', 'datetime.now'):
            code = ('import unittest\nfrom unittest.mock import patch\nfrom database import stamp\n'
                    f'class Cases(unittest.TestCase):\n    @patch({bad_dt!r})\n'
                    '    def test_stamp(self, mock_now):\n        stamp()\n        mock_now.assert_called_once()\n')
            res = validate_bindings(code, dt_ctx)
            self.assertFalse(res['valid'])
            self.assertIn("Patch the target module binding 'database.datetime'", res['reason'])

        helper_mod = ('from database import update_vehicle_status\n'
                      'def show_message_dialog(page, title, msg): pass\n'
                      'def status_column(page):\n    show_message_dialog(page, "t", "m")\n')
        helper_ctx = {'module': 'main', 'target': 'status_column',
                      'source': 'def status_column(page):\n    show_message_dialog(page, "t", "m")\n',
                      'moduleSource': helper_mod, 'requireMockBehavior': True}
        for wrong_path, expected in (('show_message_dialog', 'main.show_message_dialog'),
                                     ('pkg.main.show_message_dialog', 'main.show_message_dialog'),
                                     ('database.update_vehicle_status', 'main.update_vehicle_status')):
            code = ('import unittest\nfrom unittest.mock import patch\nfrom main import status_column\n'
                    f'class Cases(unittest.TestCase):\n    @patch({wrong_path!r})\n'
                    '    def test_col(self, m):\n        status_column(object())\n        m.assert_called_once()\n')
            res = validate_bindings(code, helper_ctx)
            self.assertFalse(res['valid'])
            self.assertIn(f'Patch the dependency at its target use point: {expected}, not {wrong_path}', res['reason'])

    def test_replaced_mock_parent_cannot_observe_detached_children(self):
        source = 'def target():\n    return boundary()\n'
        context = {'module': 'sample', 'target': 'target', 'source': source,
                   'moduleSource': 'def boundary(): pass\n' + source,
                   'requireMockBehavior': True, 'requireTargetBehavior': True}
        for explicit_return in ('', '    dep.return_value = MagicMock()\n'):
            with self.subTest(explicit_return=bool(explicit_return)):
                body = ('with patch("sample.boundary") as dep:\n'
                        + explicit_return
                        + '    orphan = MagicMock()\n'
                        '    dep.return_value.child = orphan\n'
                        '    alias = dep\n'
                        '    alias.return_value = object()\n'
                        '    sample.target()\n'
                        '    orphan.assert_not_called()\n')
                code = candidate(body=body).replace('from unittest.mock import patch\n',
                                                  'from unittest.mock import patch, MagicMock\n')
                self.assertFalse(validate_bindings(code, context)['valid'])

    def test_mock_parent_replacement_preserves_other_reachable_member_aliases(self):
        source = 'def target():\n    return boundary()\n'
        context = {'module': 'sample', 'target': 'target', 'source': source,
                   'moduleSource': 'def boundary(): pass\n' + source,
                   'requireMockBehavior': True, 'requireTargetBehavior': True}
        body = ('with patch("sample.boundary") as dep:\n'
                '    child = MagicMock()\n'
                '    dep.return_value.child = child\n'
                '    dep.still_reachable = child\n'
                '    dep.return_value = object()\n'
                '    sample.target()\n'
                '    child.assert_not_called()\n')
        code = candidate(body=body).replace('from unittest.mock import patch\n',
                                          'from unittest.mock import patch, MagicMock\n')
        self.assertTrue(validate_bindings(code, context)['valid'])

    def test_detached_mock_object_keeps_its_own_children_when_injected_directly(self):
        source = 'def target(page):\n    page.child()\n'
        body = ('root = MagicMock()\n'
                'root.return_value = MagicMock()\n'
                'root.return_value.child = MagicMock()\n'
                'old = root.return_value\n'
                'root.return_value = object()\n'
                'sample.target(old)\n'
                'old.child.assert_called_once_with()\n')
        code = candidate(body=body).replace('from unittest.mock import patch\n',
                                          'from unittest.mock import patch, MagicMock\n')
        context = {'module': 'sample', 'target': 'target', 'source': source,
                   'moduleSource': source, 'requireMockBehavior': True, 'requireTargetBehavior': True}
        self.assertTrue(validate_bindings(code, context)['valid'])

    def test_datetime_patch_rejection_requires_an_unchanged_current_source_binding(self):
        fragment = 'def target():\n    return datetime.now()\n'
        code = candidate(body='with patch("sample.datetime.now") as clock:\n'
                              '    sample.target()\n    clock.assert_called_once_with()\n')
        original = 'from datetime import datetime\n' + fragment
        rebound = ('from datetime import datetime\nclass Clock:\n'
                   '    @staticmethod\n    def now(): return 7\ndatetime = Clock\n' + fragment)
        for dependencies in ({}, {'datetime': 'datetime.datetime'}):
            with self.subTest(dependencies=dependencies):
                context = {'module': 'sample', 'target': 'target', 'source': fragment,
                           'moduleSource': rebound, 'dependencies': dependencies,
                           'requireMockBehavior': True, 'requireTargetBehavior': True}
                self.assertTrue(validate_bindings(code, context)['valid'])
                context['moduleSource'] = original
                result = validate_bindings(code, context)
                self.assertFalse(result['valid'])
                self.assertIn('immutable datetime/date', result['reason'])
        for module_source in ('', original.replace('return datetime.now()', 'return 1'),
                              original.replace('from datetime import datetime',
                                               'if unknown:\n    from datetime import datetime'),
                              original.replace('from datetime import datetime',
                                               'from datetime import datetime\nif unknown:\n    datetime = unknown')):
            context = {'module': 'sample', 'target': 'target', 'source': fragment,
                       'moduleSource': module_source, 'dependencies': {'datetime': 'datetime.datetime'}}
            self.assertTrue(validate_bindings(code, context)['valid'], module_source)

    def test_chained_setup_mocks_and_extra_non_use_point_decorators_preserve_proven_assertions(self):
        db_source = ('def get_conn(): pass\ndef _now_text(): pass\n'
                     'def update_loading(plate):\n    conn = get_conn()\n    cur = conn.cursor()\n'
                     '    cur.execute(plate)\n    conn.commit()\n')
        db_ctx = {'module': 'database', 'target': 'update_loading',
                  'source': 'def update_loading(plate):\n    conn = get_conn()\n    cur = conn.cursor()\n    cur.execute(plate)\n    conn.commit()\n',
                  'moduleSource': db_source, 'requireMockBehavior': True, 'requireTargetBehavior': True}
        setup_chain = ('import unittest\nfrom unittest.mock import patch, MagicMock\nfrom database import update_loading\n'
                       'class Cases(unittest.TestCase):\n    def setUp(self):\n'
                       '        self.conn = MagicMock()\n        self.cur = MagicMock()\n'
                       '        self.conn.cursor.return_value = self.cur\n'
                       '    @patch("database.get_conn")\n    @patch("database._now_text")\n'
                       '    def test_loading(self, mock_now, mock_get_conn):\n'
                       '        mock_get_conn.return_value = self.conn\n'
                       '        update_loading("ABC")\n'
                       '        self.cur.execute.assert_called_once_with("ABC")\n'
                       '        self.conn.commit.assert_called_once()\n')
        self.assertTrue(validate_bindings(setup_chain, db_ctx)['valid'])
        unpermitted_only = setup_chain.replace('self.cur.execute.assert_called_once_with("ABC")\n        self.conn.commit.assert_called_once()',
                                               'mock_now.assert_not_called()')
        res = validate_bindings(unpermitted_only, db_ctx)
        self.assertFalse(res['valid'])
        self.assertIn('database._now_text', res['reason'])
        self.assertIn('database.get_conn', res['reason'])


if __name__ == '__main__':
    unittest.main()
