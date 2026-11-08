"""case-table-v1 rows are checked against the AST signature and dependency list, one row at a time."""
import io
import json
import unittest

from case_row_validator import REPORT_VERSION, REQUEST_VERSION, main, target_signature, validate_request

SOURCE = '''
import sqlite3

def bmi(weight, height, *, unit="metric"):
    return weight / (height / 100) ** 2

def only_positional(a, b=2, /, c=3):
    return a + b + c

def flexible(*args, **kwargs):
    return args, kwargs

class Garage:
    def find(self, vehicle_id, strict=False):
        return db.fetchone(vehicle_id)

    @staticmethod
    def normalize(plate):
        return plate.upper()

    @classmethod
    def build(cls, name):
        return cls()

    class Spot:
        def reserve(self, slot):
            return slot

def bmi(weight, height):
    return weight / height
'''


def request(target, rows, dependencies=('db.fetchone',), source=SOURCE):
    return {'version': REQUEST_VERSION, 'source': source, 'target': target,
            'dependencies': list(dependencies), 'rows': rows}


def row(row_id='C1', args='()', kwargs='{}', mocks=None):
    return {'id': row_id, 'args': args, 'kwargs': kwargs, 'mocks': mocks or []}


def verdicts(target, rows, **kwargs):
    report = validate_request(request(target, rows, **kwargs))
    assert report['version'] == REPORT_VERSION, report
    return [(item['id'], item['valid'], item.get('reason')) for item in report['results']]


class SignatureBindingTests(unittest.TestCase):
    def test_last_definition_wins_like_python(self):
        self.assertEqual(str(target_signature(SOURCE, 'bmi')), '(weight, height)')

    def test_args_and_kwargs_must_bind_to_the_signature(self):
        self.assertEqual(verdicts('bmi', [
            row('C1', '(70, 175)'),
            row('C2', '(70,)', "{'height': 175}"),
            row('C3', '(70, 175, 1)'),
            row('C4', '(70,)'),
            row('C5', '(70, 175)', "{'unit': 'imperial'}"),
            row('C6', '(70,)', "{'weight': 1, 'height': 2}"),
        ]), [('C1', True, None), ('C2', True, None), ('C3', False, 'signature-mismatch'),
             ('C4', False, 'signature-mismatch'), ('C5', False, 'signature-mismatch'),
             ('C6', False, 'signature-mismatch')])

    def test_positional_only_keyword_only_and_variadic_parameters(self):
        self.assertEqual(verdicts('only_positional', [
            row('C1', '(1,)'), row('C2', '(1, 2, 3)'), row('C3', '()', "{'a': 1}"), row('C4', '(1,)', "{'c': 9}"),
        ]), [('C1', True, None), ('C2', True, None), ('C3', False, 'signature-mismatch'), ('C4', True, None)])
        self.assertEqual(verdicts('flexible', [row('C1', '(1, 2, 3)', "{'any': None}")]), [('C1', True, None)])
        keyword_only = SOURCE.replace('def bmi(weight, height):\n    return weight / height\n', '')
        self.assertEqual(verdicts('bmi', [row('C1', '(70, 175)', "{'unit': 'imperial'}"), row('C2', '(70, 175, "x")')],
                                  source=keyword_only),
                         [('C1', True, None), ('C2', False, 'signature-mismatch')])

    def test_methods_drop_self_and_cls_but_not_for_staticmethods(self):
        self.assertEqual(str(target_signature(SOURCE, 'Garage.find')), '(vehicle_id, strict=None)')
        self.assertEqual(str(target_signature(SOURCE, 'Garage.normalize')), '(plate)')
        self.assertEqual(str(target_signature(SOURCE, 'Garage.build')), '(name)')
        self.assertEqual(str(target_signature(SOURCE, 'Garage.Spot.reserve')), '(slot)')
        self.assertEqual(verdicts('Garage.find', [row('C1', '(7,)'), row('C2', '(None, 7)', "{'strict': True}")]),
                         [('C1', True, None), ('C2', False, 'signature-mismatch')])

    def test_signature_is_built_without_running_the_module(self):
        hostile = 'raise SystemExit("module body ran")\n\ndef target(x=print("default ran")):\n    open("x", "w")\n'
        self.assertEqual(str(target_signature(hostile, 'target')), '(x=None)')
        self.assertEqual(verdicts('target', [row('C1', '()')], source=hostile), [('C1', True, None)])


class LiteralTests(unittest.TestCase):
    def test_args_must_be_a_tuple_literal_and_kwargs_a_string_keyed_dict(self):
        self.assertEqual(verdicts('bmi', [
            row('C1', '(70)'), row('C2', '(make_weight(), 175)'), row('C3', '(70, 175)', '[1]'),
            row('C4', '(70, 175)', '{1: 2}'), row('C5', '(70, 175)', 'dict(a=1)'), row('C6', 'x' * 20001),
        ]), [('C1', False, 'args-not-tuple'), ('C2', False, 'args-not-literal'), ('C3', False, 'kwargs-not-dict'),
             ('C4', False, 'kwargs-not-dict'), ('C5', False, 'kwargs-not-literal'), ('C6', False, 'args-too-long')])

    def test_literal_containers_and_special_values_are_accepted(self):
        self.assertEqual(verdicts('flexible', [row('C1', "(-1.5, 'é', b'x', None, (1, [2]), {'k': {1, 2}})")]),
                         [('C1', True, None)])


class DependencyTests(unittest.TestCase):
    def test_mocks_may_only_name_dependencies_from_the_ast_list(self):
        self.assertEqual(verdicts('Garage.find', [
            row('C1', '(1,)', mocks=[{'dependency': 'db.fetchone', 'behavior': 'return', 'value': 'None'}]),
            row('C2', '(1,)', mocks=[{'dependency': 'db.execute', 'behavior': 'return', 'value': 'None'}]),
            row('C3', '(1,)', mocks=[{'dependency': 'db.fetchone', 'behavior': 'raise', 'value': 'sqlite3.Error'}]),
        ]), [('C1', True, None), ('C2', False, 'unknown-dependency'), ('C3', True, None)])
        self.assertEqual(verdicts('Garage.find', [
            row('C1', '(1,)', mocks=[{'dependency': 'db.fetchone', 'behavior': 'return', 'value': 'None'}])
        ], dependencies=()), [('C1', False, 'unknown-dependency')])

    def test_mock_values_must_be_literals_and_raised_names_must_be_dotted_names(self):
        self.assertEqual(verdicts('Garage.find', [
            row('C1', '(1,)', mocks=[{'dependency': 'db.fetchone', 'behavior': 'return', 'value': 'Vehicle()'}]),
            row('C2', '(1,)', mocks=[{'dependency': 'db.fetchone', 'behavior': 'raise', 'value': 'ValueError("x")'}]),
            row('C3', '(1,)', mocks=[{'dependency': 'db.fetchone', 'behavior': 'patch', 'value': 'None'}]),
        ]), [('C1', False, 'mock-value-not-literal'), ('C2', False, 'mock-exception-invalid'), ('C3', False, 'invalid-row')])


class RowIsolationTests(unittest.TestCase):
    def test_one_bad_row_never_changes_the_verdict_of_the_others(self):
        good = row('C1', '(70, 175)')
        alone = verdicts('bmi', [good])
        mixed = verdicts('bmi', [row('C0', 'oops('), good, 'not a row', {'id': 'C3', 'args': 5}, row('C4', '(1, 2)')])
        self.assertEqual(alone, [('C1', True, None)])
        self.assertEqual(mixed, [('C0', False, 'args-not-literal'), ('C1', True, None), (None, False, 'invalid-row'),
                                 ('C3', False, 'invalid-row'), ('C4', True, None)])

    def test_needs_setup_rows_skip_binding_but_still_check_mocks(self):
        self.assertEqual(verdicts('Garage.find', [
            {'id': 'C1', 'needsSetup': '已連線的 sqlite3 Connection', 'mocks': []},
            {'id': 'C2', 'needsSetup': '已連線的 sqlite3 Connection',
             'mocks': [{'dependency': 'cursor.execute', 'behavior': 'return', 'value': 'None'}]},
            {'id': 'C3', 'needsSetup': '   ', 'mocks': []},
        ]), [('C1', True, None), ('C2', False, 'unknown-dependency'), ('C3', False, 'invalid-row')])


class RequestTests(unittest.TestCase):
    def test_request_level_problems_are_reported_as_errors_not_row_verdicts(self):
        cases = [
            (request('missing', [row()]), 'target-not-found'),
            (request('Garage.missing', [row()]), 'target-not-found'),
            (request('bmi.inner', [row()]), 'target-not-found'),
            (request('bmi; import os', [row()]), 'invalid-target'),
            (request('bmi', [row()], source='def bmi(:\n'), 'source-syntax-error'),
            ({**request('bmi', [row()]), 'version': 'v0'}, 'invalid-request'),
            ({**request('bmi', [row()]), 'rows': {}}, 'invalid-request'),
            ({**request('bmi', [row()]), 'dependencies': [1]}, 'invalid-request'),
        ]
        for payload, error in cases:
            with self.subTest(error=error, target=payload.get('target')):
                self.assertEqual(validate_request(payload), {'version': REPORT_VERSION, 'error': error})

    def test_main_reads_stdin_and_writes_one_json_report(self):
        stdout = io.StringIO()
        code = main(io.StringIO(json.dumps(request('bmi', [row('C1', '(1, 2)')]), ensure_ascii=False)), stdout)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue()),
                         {'version': REPORT_VERSION, 'target': 'bmi', 'results': [{'id': 'C1', 'valid': True}]})
        broken = io.StringIO()
        self.assertEqual(main(io.StringIO('{not json'), broken), 1)
        self.assertEqual(json.loads(broken.getvalue()), {'version': REPORT_VERSION, 'error': 'invalid-json'})


if __name__ == '__main__':
    unittest.main()
