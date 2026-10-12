import ast
from contextlib import redirect_stdout
import io
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from ast_extractor import extract_info, find_function_in_tree
from static_type_shape import resolve_parameter_shapes, TYPE_SHAPE_VERSION
from trace_value_codec import restore_value
from input_planner import plan_inputs


class StaticTypeShapeTests(unittest.TestCase):
    def test_deduplicated_baseline_keeps_source_condition_provenance(self):
        tree = ast.parse('def target(value):\n    if value == "other": return 1\n    return 2')
        node = tree.body[0]
        plan = plan_inputs(tree, node, resolve_parameter_shapes(tree, node, ()))
        boundaries = [case for case in plan['cases'] if case['args'] == ['other']]
        self.assertEqual(len(boundaries), 1)
        self.assertEqual(boundaries[0]['metadata']['source'], 'source-condition')

    def test_numeric_operands_retain_zero_cases_before_bounded_variations(self):
        tree = ast.parse('def target(a, b): return a / (b / 100) ** 2')
        node = tree.body[0]
        plan = plan_inputs(tree, node, resolve_parameter_shapes(tree, node, ()), limits={'max_cases': 4})
        calls = [case['args'] for case in plan['cases']]
        self.assertIn([0, 1], calls)
        self.assertIn([1, 0], calls)
        self.assertLessEqual(len(calls), 4)

    def test_fixed_tuple_variations_distinguish_arithmetic_from_index_offsets(self):
        tree = ast.parse('def target(pair: tuple[int, str]): return pair[0] + len(pair[1]) + 1')
        node = tree.body[0]
        plan = plan_inputs(tree, node, resolve_parameter_shapes(tree, node, ()))
        pairs = [case['args'][0] for case in plan['cases']]
        self.assertIn((2, 'test_value'), pairs)
        self.assertTrue(all(type(pair) is tuple for pair in pairs))

    def shapes(self, source, target='target', excluded=()):
        tree = ast.parse(source)
        node = find_function_in_tree(tree, target)[0]
        self.assertIsNotNone(node)
        return resolve_parameter_shapes(tree, node, excluded)

    def scalar(self, name):
        return {'kind': 'scalar', 'name': name}

    def extract(self, source, target):
        with tempfile.TemporaryDirectory(prefix='neutral-static-shape-') as directory:
            file = pathlib.Path(directory) / 'sample.py'
            file.write_text(source, encoding='utf-8')
            output = io.StringIO()
            with redirect_stdout(output):
                extract_info(str(file), target)
            result = json.loads(output.getvalue())
            self.assertNotIn('error', result)
            return result

    def test_exact_scalars_and_parameter_kinds_without_name_guessing(self):
        shapes = self.shapes('def target(a:int, b:float, /, c:bool, d:str, e:bytes, f:None, *, g, **extras): pass')
        for name, kind in zip('abcdef', ('int', 'float', 'bool', 'str', 'bytes', 'none')):
            self.assertEqual(shapes[name], self.scalar(kind))
        self.assertEqual(shapes['g'], {'kind': 'unknown', 'reason': 'missing-annotation'})
        self.assertEqual(shapes['extras']['kind'], 'unknown')

    def test_builtin_containers_and_nested_elements_keep_structure(self):
        shapes = self.shapes('def target(a:list[int], b:tuple[str, bytes], c:tuple[int,...], '
                             'd:dict[int,list[tuple[str,bool]]], e:set[float], f:frozenset[bytes], g:tuple[()]): pass')
        self.assertEqual(shapes['a'], {'kind': 'list', 'element': self.scalar('int')})
        self.assertEqual(shapes['b'], {'kind': 'tuple', 'variadic': False, 'elements': [self.scalar('str'), self.scalar('bytes')]})
        self.assertEqual(shapes['c'], {'kind': 'tuple', 'variadic': True, 'element': self.scalar('int')})
        self.assertEqual(shapes['d']['key'], self.scalar('int'))
        self.assertEqual(shapes['d']['value']['element']['elements'], [self.scalar('str'), self.scalar('bool')])
        self.assertEqual(shapes['e'], {'kind': 'set', 'element': self.scalar('float')})
        self.assertEqual(shapes['f'], {'kind': 'frozenset', 'element': self.scalar('bytes')})
        self.assertEqual(shapes['g'], {'kind': 'tuple', 'variadic': False, 'elements': []})

    def test_proven_typing_and_builtin_import_aliases(self):
        shapes = self.shapes('import typing as t\nimport builtins as b\n'
                             'from typing import Dict as Mapping, Tuple as Pair, FrozenSet as Frozen\n'
                             'from builtins import list as Sequence\n'
                             'def target(a:t.List[b.int], b:Mapping[str,Pair[int,bytes]], c:Frozen[str], d:Sequence[bool]): pass')
        self.assertEqual(shapes['a'], {'kind': 'list', 'element': self.scalar('int')})
        self.assertEqual(shapes['b']['value']['elements'], [self.scalar('int'), self.scalar('bytes')])
        self.assertEqual(shapes['c']['kind'], 'frozenset')
        self.assertEqual(shapes['d']['element'], self.scalar('bool'))

    def test_literal_optional_and_union_values_are_typed_bounded_candidates(self):
        shapes = self.shapes('from typing import Literal as Choice, Optional, Union\n'
                             "def target(a:Choice[1, True, -0.0, b'X', 'value', None, 1], b:Optional[list[int]], c:Union[int,str]|None): pass")
        values = [restore_value(value) for value in shapes['a']['values']]
        self.assertEqual(len(values), 6)
        self.assertIs(type(values[0]), int)
        self.assertIs(type(values[1]), bool)
        self.assertEqual(values[3], b'X')
        self.assertEqual(shapes['b']['members'], [{'kind': 'list', 'element': self.scalar('int')}, self.scalar('none')])
        self.assertEqual(shapes['c']['members'], [self.scalar('int'), self.scalar('str'), self.scalar('none')])

    def test_safe_quoted_forward_annotations_parse_without_execution(self):
        shapes = self.shapes('from typing import Optional as Maybe\n'
                             'def target(a:"list[tuple[int, str]]", b:"Maybe[bytes]", c:"factory()", d:"[invalid"): pass')
        self.assertEqual(shapes['a']['element']['elements'], [self.scalar('int'), self.scalar('str')])
        self.assertEqual(shapes['b']['members'], [self.scalar('bytes'), self.scalar('none')])
        self.assertEqual(shapes['c']['reason'], 'unsupported-expression')
        self.assertEqual(shapes['d']['reason'], 'invalid-forward-annotation')

    def test_missing_and_shadowed_names_do_not_borrow_builtin_or_typing_types(self):
        cases = [
            ('list = object()\ndef target(value:list[int]): pass', 'shadowed-name'),
            ('from typing import List as Seq\nSeq = object()\ndef target(value:Seq[int]): pass', 'shadowed-name'),
            ('if condition:\n    from typing import List as Seq\ndef target(value:Seq[int]): pass', 'conditional-binding'),
            ('from arbitrary import *\ndef target(value:list[int]): pass', 'wildcard-binding'),
            ('def target(value:MissingType): pass', 'unresolved-name'),
            ('import typing as t\nt.List = object()\ndef target(value:t.List[int]): pass', 'mutated-type-binding'),
        ]
        for source, reason in cases:
            with self.subTest(source=source):
                self.assertEqual(self.shapes(source)['value']['reason'], reason)

    def test_target_own_locals_and_parameter_names_do_not_shadow_annotation_scope(self):
        shapes = self.shapes('from typing import List as Seq\n'
                             'def target(Seq:Seq[int], self:list[str], cls:bytes):\n    list = 4\n    Seq = 5\n')
        self.assertEqual(shapes['Seq']['element'], self.scalar('int'))
        self.assertEqual(shapes['self']['element'], self.scalar('str'))
        self.assertEqual(shapes['cls'], self.scalar('bytes'))

    def test_enclosing_function_locals_are_lexically_shadowed_before_assignment(self):
        shapes = self.shapes('def outer():\n    def target(value:list[int]): pass\n    list = object()\n')
        self.assertEqual(shapes['value']['reason'], 'lexical-shadowing')
        proven = self.shapes('def outer():\n    from typing import List as Seq\n    def target(value:Seq[int]): pass\n')
        self.assertEqual(proven['value']['element'], self.scalar('int'))

    def test_class_scope_imports_and_rebindings_are_distinct_from_method_body(self):
        shapes = self.shapes('class Box:\n    from typing import List as Seq\n'
                             '    int = str\n    def target(self, a:Seq[bytes], b:int):\n        Seq = 4\n', 'Box.target', ('self',))
        self.assertNotIn('self', shapes)
        self.assertEqual(shapes['a']['element'], self.scalar('bytes'))
        self.assertEqual(shapes['b']['reason'], 'shadowed-name')

    def test_future_or_quoted_import_rebinding_stays_unknown(self):
        for annotation, prefix in [('Seq[int]', 'from __future__ import annotations\n'), ('"Seq[int]"', '')]:
            shapes = self.shapes(prefix + 'from typing import List as Seq\n'
                                 f'def target(value:{annotation}): pass\nSeq = object()\n')
            self.assertEqual(shapes['value']['reason'], 'deferred-rebinding')
        eager = self.shapes('from typing import List as Seq\ndef target(value:Seq[int]): pass\nSeq = object()\n')
        self.assertEqual(eager['value']['element'], self.scalar('int'))

    def test_custom_types_are_fixture_needs_and_factories_never_execute(self):
        shapes = self.shapes('from absent_dependency import External\nclass Local: pass\n'
                             'def factory(): raise AssertionError("never execute")\n'
                             'def target(a:Local,b:External,c:factory()): pass')
        self.assertEqual(shapes['a']['reason'], 'needs-fixture')
        self.assertEqual(shapes['b']['reason'], 'needs-fixture')
        self.assertEqual(shapes['c']['reason'], 'unsupported-expression')

    def test_budgets_and_invalid_type_arguments_are_explicit(self):
        nested = 'list[' * 12 + 'int' + ']' * 12
        shapes = self.shapes(f'def target(a:{nested},b:dict[int],c:tuple[...,int],d:list[int,str]): pass')
        nested_shape = shapes['a']
        while nested_shape['kind'] == 'list':
            nested_shape = nested_shape['element']
        self.assertEqual(nested_shape['reason'], 'shape-budget')
        for name in 'bcd':
            self.assertEqual(shapes[name]['reason'], 'invalid-type-arguments')

    def test_extractor_preserves_annotation_text_and_adds_shapes_to_constructor_and_helpers(self):
        source = ('from typing import List as Seq\n'
                  'def helper(values: Seq[int]): return len(values)\n'
                  'class Base:\n    def __init__(receiver, payload: Seq[bytes]): receiver.payload = payload\n'
                  'class Box(Base):\n    def target(receiver, value: Seq[int]): return helper(value)\n')
        info = self.extract(source, 'Box.target')
        self.assertEqual(info['type_shape_version'], TYPE_SHAPE_VERSION)
        self.assertEqual(info['signature'][0]['name'], 'value')
        self.assertEqual(info['signature'][0]['annotation'], 'Seq[int]')
        self.assertEqual(info['signature'][0]['type_shape']['element'], self.scalar('int'))
        init = info['class_context']['effective_init']['signature']
        self.assertEqual(init[0]['name'], 'payload')
        self.assertEqual(init[0]['type_shape']['element'], self.scalar('bytes'))
        self.assertEqual(info['localDependencyContexts'][0]['signature'][0]['type_shape']['element'], self.scalar('int'))

    def test_extractor_only_excludes_a_bound_first_receiver_not_self_named_user_parameters(self):
        source = ('class Box:\n'
                  '    @staticmethod\n    def target(self:int, cls:bytes): return self\n'
                  '    @classmethod\n    def other(owner, self:str): return self\n')
        static = self.extract(source, 'Box.target')
        bound = self.extract(source, 'Box.other')
        self.assertEqual(static['args'], ['self', 'cls'])
        self.assertEqual(bound['args'], ['self'])
        self.assertEqual(bound['signature'][0]['type_shape'], self.scalar('str'))


if __name__ == '__main__':
    unittest.main()
