"""Predictions compare by literal value (isclose for floats) and exception class name with MRO."""
import unittest
import os as _os
import sys as _sys

# Make sibling scripts importable when this module runs alone (test:related), like the other test modules.
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

from case_oracle_compare import compare


def ret(value):
    return {'kind': 'return', 'value': value}


def exc(name):
    return {'kind': 'raise', 'value': name}


class OracleCompareTests(unittest.TestCase):
    def test_float_tolerance_and_containers(self):
        report = compare({'actual': ret('(0.30000000000000004, [1, 2])'), 'predictions': [ret('(0.3, [1, 2])')] * 3})
        self.assertEqual(report, {'parsed': True, 'consistent': True, 'matchesActual': True, 'actualLiteral': True})
        self.assertFalse(compare({'actual': ret('(1, 2)'), 'predictions': [ret('[1, 2]')]})['matchesActual'], 'tuple is not list')
        self.assertFalse(compare({'actual': ret('1'), 'predictions': [ret('True')]})['matchesActual'], 'bool is not int')

    def test_inconsistent_or_unparseable_predictions(self):
        self.assertFalse(compare({'actual': ret('5'), 'predictions': [ret('5'), ret('6'), ret('5')]})['consistent'])
        report = compare({'actual': ret('5'), 'predictions': [ret('five')]})
        self.assertEqual((report['parsed'], report['consistent']), (False, False))

    def test_exceptions_match_by_name_or_parent_class_never_by_message(self):
        mro = ['NotFound', 'LookupError', 'Exception', 'BaseException']
        self.assertTrue(compare({'actual': exc('NotFound'), 'actualMro': mro, 'predictions': [exc('LookupError')] * 3})['matchesActual'])
        self.assertTrue(compare({'actual': exc('NotFound'), 'actualMro': mro, 'predictions': [exc('errors.NotFound')]})['matchesActual'])
        self.assertFalse(compare({'actual': exc('NotFound'), 'actualMro': mro, 'predictions': [exc('ValueError')]})['matchesActual'])
        self.assertFalse(compare({'actual': ret('None'), 'predictions': [exc('ValueError')]})['matchesActual'])

    def test_non_literal_actual_is_never_a_mismatch(self):
        report = compare({'actual': ret('<object at 0x1>'), 'predictions': [ret('1')]})
        self.assertEqual((report['actualLiteral'], report['matchesActual']), (False, False))


if __name__ == '__main__':
    unittest.main()
