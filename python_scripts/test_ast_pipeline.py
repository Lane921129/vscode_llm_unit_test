import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


SCRIPTS_DIR = pathlib.Path(__file__).parent
sys.path.insert(0, str(SCRIPTS_DIR))
from mock_scaffold_generator import generate_scaffold
from dynamic_tracer import trace_function
from basic_mutation_runner import run_mutation_trials
from complexity_assessor import assess_complexity


class AstPipelineTests(unittest.TestCase):
    def run_script(self, script_name, *args):
        completed = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / script_name), *map(str, args)],
            check=True,
            capture_output=True,
            encoding='utf-8'
        )
        return json.loads(completed.stdout)

    def validate_target_calls(self, code, target, signature):
        completed = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / 'validate_target_calls.py'),
                target,
                json.dumps(signature),
            ],
            check=True,
            capture_output=True,
            encoding='utf-8',
            input=code,
        )
        return json.loads(completed.stdout)

    def test_target_call_validator_rejects_unknown_keyword_outside_type_error_assertion(self):
        signature = [
            {'name': 'order_id', 'kind': 'positional_or_keyword'},
            {'name': 'payment_token', 'kind': 'positional_or_keyword'},
        ]
        code = '''import unittest

class TestCheckout(unittest.TestCase):
    def test_unknown_keyword(self):
        with self.assertRaises(ValueError):
            checkout_order("id", "token", provider="unknown")
'''

        result = self.validate_target_calls(code, 'checkout_order', signature)

        self.assertFalse(result['valid'])
        self.assertIn('未定義的 keyword 引數 provider', result['reason'])

    def test_target_call_validator_allows_explicit_type_error_signature_tests(self):
        signature = [{'name': 'value', 'kind': 'positional_or_keyword'}]
        code = '''import unittest

class TestValue(unittest.TestCase):
    def test_invalid_signature(self):
        with self.assertRaises(TypeError):
            transform("value", unexpected=True)
'''

        self.assertTrue(self.validate_target_calls(code, 'transform', signature)['valid'])

    def test_target_call_validator_validates_imported_target_aliases(self):
        signature = [{'name': 'value', 'kind': 'positional_or_keyword'}]
        code = '''import unittest
from utility import transform as subject

class TestTransform(unittest.TestCase):
    def test_invalid_alias_call(self):
        self.assertEqual(subject('value', unexpected=True), 'value')
'''

        result = self.validate_target_calls(code, 'transform', signature)

        self.assertFalse(result['valid'])
        self.assertIn('未定義的 keyword', result['reason'])

    def test_target_call_validator_allows_var_keyword_signatures(self):
        signature = [
            {'name': 'value', 'kind': 'positional_or_keyword'},
            {'name': 'extras', 'kind': 'var_keyword'},
        ]
        code = '''import unittest

class TestValue(unittest.TestCase):
    def test_keyword(self):
        self.assertEqual(transform("value", mode="strict"), "value")
'''

        self.assertTrue(self.validate_target_calls(code, 'transform', signature)['valid'])

    def test_extractor_includes_context_needed_for_a_class_method(self):
        source = '''import os as operating_system
from helpers import normalize as normalize_value

MAXIMUM = 10

class Worker:
    DEFAULT = "ready"

    def __init__(self, config, client=None):
        self.config = config
        self.client = client

    def process(self, value):
        if value > MAXIMUM:
            return operating_system.path.exists(self.config) and normalize_value(value)
        return self.DEFAULT
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'process')

        self.assertEqual(data['class_name'], 'Worker')
        self.assertEqual(data['method_kind'], 'instance')
        self.assertIn('operating_system.path.exists', data['calls'])
        self.assertIn('normalize_value', data['calls'])
        self.assertEqual(data['referenced_globals'], [{'name': 'MAXIMUM', 'code': 'MAXIMUM = 10'}])
        self.assertEqual(data['class_context']['init']['params'], ['config', 'client'])
        self.assertEqual(data['class_context']['init']['required_params'], ['config'])
        self.assertEqual(data['class_context']['init']['optional_params'], ['client'])
        self.assertEqual([item['name'] for item in data['class_context']['init']['assigns']], ['config', 'client'])
        self.assertEqual({item['bound_name'] for item in data['file_imports']}, {'operating_system', 'normalize_value'})

    def test_extractor_does_not_treat_local_bindings_or_nested_scopes_as_module_context(self):
        source = '''from helpers import normalize

LIMIT = 10

def process(normalize, value):
    LIMIT = 2
    def deferred():
        return normalize(LIMIT)
    return normalize(value) + LIMIT
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'process')

        self.assertEqual(data['dependencies'], [])
        self.assertEqual(data['referenced_globals'], [])
        self.assertEqual(data['calls'], ['normalize'])

    def test_extractor_exposes_safe_same_module_inherited_constructor_context(self):
        source = '''class BaseWorker:
    DEFAULT_RETRIES = 2

    def __init__(self, client, retries=DEFAULT_RETRIES):
        self.client = client
        self.retries = retries

class Worker(BaseWorker):
    def process(self, payload):
        return self.client.send(payload, retries=self.retries)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'Worker.process')

        context = data['class_context']
        self.assertEqual(context['init']['params'], [])
        self.assertEqual(context['effective_init']['defined_on'], 'BaseWorker')
        self.assertEqual(context['effective_init']['required_params'], ['client'])
        self.assertEqual(context['effective_init']['optional_params'], ['retries'])
        self.assertEqual(
            [item['name'] for item in context['effective_init']['assigns']],
            ['client', 'retries']
        )
        self.assertEqual([item['name'] for item in context['inherited_context']], ['BaseWorker'])
        self.assertEqual(
            [item['name'] for item in context['inherited_context'][0]['class_attrs']],
            ['DEFAULT_RETRIES']
        )

    def test_extractor_does_not_claim_an_imported_base_constructor_signature(self):
        source = '''from framework import BaseWorker

class Worker(BaseWorker):
    def process(self, payload):
        return self.client.send(payload)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'Worker.process')

        self.assertEqual(data['class_context']['inherited_context'], [])
        self.assertNotIn('effective_init', data['class_context'])

    def test_extractor_does_not_skip_an_unknown_earlier_multiple_inheritance_base(self):
        source = '''from framework import ExternalBase

class LocalBase:
    def __init__(self, client):
        self.client = client

class Worker(ExternalBase, LocalBase):
    def process(self, payload):
        return self.client.send(payload)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'Worker.process')

        self.assertEqual([item['name'] for item in data['class_context']['inherited_context']], ['LocalBase'])
        self.assertNotIn('effective_init', data['class_context'])

    def test_extractor_keeps_a_declared_global_but_not_a_nonlocal_as_module_context(self):
        source = '''LIMIT = 10

def update(value):
    global LIMIT
    LIMIT = value
    return LIMIT

def enclosing():
    LIMIT = 3
    def read():
        nonlocal LIMIT
        return LIMIT
    return read
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            global_data = self.run_script('ast_extractor.py', target, 'update')
            nonlocal_data = self.run_script('ast_extractor.py', target, 'read')

        self.assertEqual(global_data['referenced_globals'], [{'name': 'LIMIT', 'code': 'LIMIT = 10'}])
        self.assertEqual(nonlocal_data['referenced_globals'], [])

    def test_extractor_does_not_treat_comprehension_bindings_as_global_or_imported_dependencies(self):
        source = '''from helpers import normalize

LIMIT = 10

def process(values, functions):
    labels = [LIMIT for LIMIT in values if LIMIT]
    return [normalize(value) for normalize in functions for value in values]
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'process')

        self.assertEqual(data['referenced_globals'], [])
        self.assertEqual(data['dependencies'], [])
        self.assertEqual(data['calls'], ['normalize'])

    def test_extractor_reports_executable_target_lines_without_nested_callable_lines(self):
        source = '''def choose(value):
    if value:
        return "yes"
    def deferred():
        return "nested"
    return "no"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'choose.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'choose')

        self.assertEqual(data['executable_lines'], [2, 3, 6])

    def test_extractor_does_not_treat_nested_helper_state_as_constructor_state(self):
        source = '''class Worker:
    def __init__(self, config):
        self.config = config
        def deferred_setup():
            self.transient = "not initialized"
        self.ready = True

    def process(self):
        return self.ready
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'Worker.process')

        self.assertEqual(
            [item['name'] for item in data['class_context']['init']['assigns']],
            ['config', 'ready']
        )

    def test_extractor_reports_only_explicit_target_exceptions(self):
        source = '''def validate(value):
    if not value:
        raise ValueError("missing")
    def deferred():
        raise RuntimeError("not part of validate")
    return value
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'validate.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'validate')

        self.assertEqual(data['raised_exceptions'], ['ValueError'])

    def test_extractor_reports_only_direct_parameter_branch_conditions(self):
        source = '''def classify(value, text):
    if value <= 3:
        return "small"
    if len(text) > 4:
        return "long"
    if normalize(value) == 9:
        return "external"
    def deferred():
        if value == 7:
            return "nested"
    return "other"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'classify.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'classify')

        self.assertEqual(data['condition_facts'], [
            {
                'kind': 'comparison', 'parameter': 'value', 'subject': 'value',
                'operator': 'LtE', 'literal': '3', 'line': 2,
            },
            {
                'kind': 'comparison', 'parameter': 'text', 'subject': 'length',
                'operator': 'Gt', 'literal': '4', 'line': 4,
            },
        ])

    def test_extractor_normalizes_reverse_and_literal_membership_conditions(self):
        source = '''def classify(value, text, mode):
    if 3 < value:
        return "large"
    if 2 >= len(text):
        return "short"
    if mode in ("fast", "safe"):
        return "known"
    if "prefix" in mode:
        return "not-a-safe-candidate-shape"
    return "other"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'classify.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'classify')

        self.assertEqual(data['condition_facts'], [
            {
                'kind': 'comparison', 'parameter': 'value', 'subject': 'value',
                'operator': 'Gt', 'literal': '3', 'line': 2,
            },
            {
                'kind': 'comparison', 'parameter': 'text', 'subject': 'length',
                'operator': 'LtE', 'literal': '2', 'line': 4,
            },
            {
                'kind': 'membership', 'parameter': 'mode', 'subject': 'value',
                'operator': 'In', 'literals': ["'fast'", "'safe'"], 'line': 6,
            },
        ])

    def test_extractor_reports_only_unguarded_literal_match_cases(self):
        source = '''def route(mode):
    match mode:
        case "fast" | "safe":
            return "known"
        case None:
            return "none"
        case "guarded" if enabled():
            return "runtime"
        case _:
            return "other"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'route.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'route')

        self.assertEqual(data['condition_facts'], [{
            'kind': 'match', 'parameter': 'mode', 'subject': 'value',
            'literals': ["'fast'", "'safe'", 'None'], 'line': 2,
        }])

    def test_extractor_distinguishes_target_generator_from_nested_generator(self):
        source = '''def emitted(values):
    for value in values:
        yield value

def ordinary():
    def deferred():
        yield "nested"
    return deferred
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'generators.py'
            target.write_text(source, encoding='utf-8')
            emitted = self.run_script('ast_extractor.py', target, 'emitted')
            ordinary = self.run_script('ast_extractor.py', target, 'ordinary')

        self.assertTrue(emitted['is_generator'])
        self.assertFalse(ordinary['is_generator'])

    def test_extractor_preserves_relative_import_levels(self):
        source = '''from .helpers import normalize as normalize_value
from ..shared import validate
from . import sibling

def process(value):
    return normalize_value(value) and validate(value) and sibling.run(value)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'consumer.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'process')

        imports = {
            item['bound_name']: (item['module'], item.get('level', 0))
            for item in data['file_imports']
        }
        self.assertEqual(imports, {
            'normalize_value': ('helpers', 1),
            'validate': ('shared', 2),
            'sibling': ('', 1),
        })
        dependencies = {
            (item['name'], item['module'], item.get('level', 0))
            for item in data['dependencies']
        }
        self.assertEqual(dependencies, {
            ('normalize', 'helpers', 1),
            ('validate', 'shared', 2),
            ('sibling', '', 1),
        })

    def test_caller_finder_ignores_a_same_named_local_function(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'core.py'
            target.write_text('def validate(value):\n    return value\n', encoding='utf-8')
            (root / 'consumer.py').write_text(
                'from core import validate as core_validate\n\ndef invoke():\n    return core_validate(1)\n',
                encoding='utf-8'
            )
            (root / 'collision.py').write_text(
                'def validate(value):\n    return value + 1\n\ndef invoke():\n    return validate(2)\n',
                encoding='utf-8'
            )
            (root / 'variable_consumer.py').write_text(
                'from core import validate\n\ndef invoke(value):\n    return validate(value)\n',
                encoding='utf-8'
            )
            calls = self.run_script('ast_caller_finder.py', 'validate', root, target)

        by_file = {call['caller_file']: call for call in calls}
        self.assertEqual(set(by_file), {'consumer.py', 'variable_consumer.py'})
        self.assertEqual(by_file['consumer.py']['call_expr'], 'core_validate(1)')
        self.assertEqual(by_file['consumer.py']['trace_args'], [1])
        self.assertEqual(by_file['consumer.py']['trace_kwargs'], {})
        self.assertIsNone(by_file['variable_consumer.py']['trace_args'])
        self.assertIsNone(by_file['variable_consumer.py']['trace_kwargs'])

    def test_caller_finder_excludes_shadowed_direct_import_aliases(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'core.py'
            target.write_text('def validate(value):\n    return value\n', encoding='utf-8')
            (root / 'consumer.py').write_text(
                '''from core import validate as core_validate

def confirmed_target():
    return core_validate(1)

def parameter_shadow(core_validate):
    return core_validate(2)

def local_shadow():
    core_validate = lambda value: value + 1
    return core_validate(3)

def outer_shadow():
    core_validate = lambda value: value + 2
    def nested():
        return core_validate(4)
    return nested()

def global_shadow():
    global core_validate
    core_validate = lambda value: value + 3
    return core_validate(5)

core_validate = lambda value: value + 3

def module_rebound():
    return core_validate(6)
''',
                encoding='utf-8'
            )
            calls = self.run_script('ast_caller_finder.py', 'validate', root, target)

        self.assertEqual(
            [(call['caller_func'], call['trace_args']) for call in calls],
            [('confirmed_target', [1])]
        )

    def test_caller_finder_resolves_qualified_class_members_and_constructor_literals(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'worker.py'
            target.write_text(
                '''def render(value):
    return "module:" + value

class Service:
    def __init__(self, prefix):
        self.prefix = prefix

    def render(self, value):
        return self.prefix + value

    @staticmethod
    def decorate(value):
        return "[" + value + "]"
''',
                encoding='utf-8'
            )
            (root / 'consumer.py').write_text(
                '''from worker import Service as Subject
import worker as worker_module

def render_value():
    return Subject("prefix:").render("value")

def render_bound_value():
    subject = Subject("bound:")
    return subject.render("value")

def ignore_rebound_value():
    subject = Subject("unused:")
    subject = object()
    return subject.render("value")

def decorate_value():
    return worker_module.Service.decorate("value")

def module_render():
    return worker_module.render("wrong")
''',
                encoding='utf-8'
            )
            (root / 'collision.py').write_text(
                '''class Service:
    def render(self, value):
        return "wrong:" + value

def render_value():
    return Service("wrong:").render("value")
''',
                encoding='utf-8'
            )
            render_calls = self.run_script('ast_caller_finder.py', 'Service.render', root, target)
            decorate_calls = self.run_script('ast_caller_finder.py', 'Service.decorate', root, target)

        self.assertEqual([call['caller_file'] for call in render_calls], ['consumer.py', 'consumer.py'])
        self.assertEqual(render_calls[0]['trace_args'], ['value'])
        self.assertEqual(render_calls[0]['trace_constructor_args'], ['prefix:'])
        self.assertEqual(render_calls[0]['trace_constructor_kwargs'], {})
        self.assertEqual(render_calls[0]['constructor_args'], ["'prefix:'"])
        self.assertEqual(render_calls[0]['constructor_kwargs'], {})
        self.assertEqual(render_calls[1]['trace_args'], ['value'])
        self.assertEqual(render_calls[1]['trace_constructor_args'], ['bound:'])
        self.assertEqual([call['caller_file'] for call in decorate_calls], ['consumer.py'])
        self.assertEqual(decorate_calls[0]['trace_args'], ['value'])
        self.assertIsNone(decorate_calls[0]['trace_constructor_args'])

    def test_caller_finder_resolves_dotted_import_paths_for_module_and_class_calls(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            package = root / 'pkg'
            package.mkdir()
            (package / '__init__.py').write_text('', encoding='utf-8')
            target = package / 'worker.py'
            target.write_text(
                '''def transform(value):
    return value + 1

class Service:
    def __init__(self, prefix):
        self.prefix = prefix

    def render(self, value):
        return self.prefix + value
''',
                encoding='utf-8'
            )
            (root / 'consumer.py').write_text(
                '''import pkg.worker

def module_call():
    return pkg.worker.transform(2)

def inline_instance_call():
    return pkg.worker.Service("inline:").render("value")

def bound_instance_call():
    subject = pkg.worker.Service("bound:")
    return subject.render("value")

def unrelated_chain():
    return pkg.other.transform(99)
''',
                encoding='utf-8'
            )

            transform_calls = self.run_script('ast_caller_finder.py', 'transform', root, target)
            render_calls = self.run_script('ast_caller_finder.py', 'Service.render', root, target)

        self.assertEqual(
            [(call['caller_func'], call['trace_args']) for call in transform_calls],
            [('module_call', [2])]
        )
        self.assertEqual(
            [(call['caller_func'], call['trace_constructor_args'], call['trace_args']) for call in render_calls],
            [
                ('inline_instance_call', ['inline:'], ['value']),
                ('bound_instance_call', ['bound:'], ['value']),
            ]
        )

    def test_caller_finder_resolves_relative_package_imports_without_cross_package_guessing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            package = root / 'sample_package'
            package.mkdir()
            (package / '__init__.py').write_text('', encoding='utf-8')
            target = package / 'consumer.py'
            target.write_text(
                'def format_label(value):\n    return "label:" + value.strip().lower()\n',
                encoding='utf-8'
            )
            (package / 'entrypoints.py').write_text(
                'from .consumer import format_label\nfrom . import consumer\n\n'
                'def render_primary():\n    return format_label("  Alpha  ")\n\n'
                'def render_secondary():\n    return format_label("Beta")\n\n'
                'def render_module_reference():\n    return consumer.format_label("Gamma")\n\n'
                'def render_shadowed_module_reference():\n'
                '    consumer = object()\n'
                '    return consumer.format_label("ignore")\n',
                encoding='utf-8'
            )
            unrelated = root / 'unrelated'
            unrelated.mkdir()
            (unrelated / '__init__.py').write_text('', encoding='utf-8')
            (unrelated / 'consumer.py').write_text('def format_label(value):\n    return value\n', encoding='utf-8')
            (unrelated / 'entrypoints.py').write_text(
                'from .consumer import format_label\n\n'
                'def render_wrong():\n    return format_label("ignore")\n',
                encoding='utf-8'
            )

            calls = self.run_script('ast_caller_finder.py', 'format_label', root, target)

        self.assertEqual(
            [(call['caller_file'], call['caller_func'], call['trace_args']) for call in calls],
            [
                ('sample_package/entrypoints.py', 'render_primary', ['  Alpha  ']),
                ('sample_package/entrypoints.py', 'render_secondary', ['Beta']),
                ('sample_package/entrypoints.py', 'render_module_reference', ['Gamma']),
            ]
        )

    def test_caller_finder_uses_only_safe_inherited_class_callers_for_base_method_trace(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'worker.py'
            target.write_text(
                '''class Base:
    def __init__(self, prefix):
        self.prefix = prefix

    def render(self, value):
        return self.prefix + value

class SafeChild(Base):
    pass

class OverrideChild(Base):
    def render(self, value):
        return "override:" + value
''',
                encoding='utf-8'
            )
            (root / 'consumer.py').write_text(
                '''from worker import SafeChild as ImportedChild, OverrideChild
import worker as worker_module

class LocalChild(ImportedChild):
    pass

class LocalOverride(ImportedChild):
    def render(self, value):
        return "local:" + value

class MultipleBases(ImportedChild, object):
    pass

@replace_class
class DecoratedChild(ImportedChild):
    pass

def through_import():
    return ImportedChild("import:").render("value")

def through_module():
    return worker_module.SafeChild("module:").render("value")

def through_local_binding():
    subject = LocalChild("local:")
    return subject.render("value")

def ignored_override():
    return OverrideChild("wrong:").render("value")

def ignored_local_override():
    return LocalOverride("wrong:").render("value")

def ignored_multiple_bases():
    return MultipleBases("wrong:").render("value")

def ignored_decorated_class():
    return DecoratedChild("wrong:").render("value")

class Base:
    def render(self, value):
        return "unrelated:" + value

def ignored_same_named_local_base():
    return Base().render("wrong")
''',
                encoding='utf-8'
            )
            calls = self.run_script('ast_caller_finder.py', 'Base.render', root, target)

        self.assertEqual(
            [(call['caller_func'], call['trace_constructor_args'], call['trace_args']) for call in calls],
            [
                ('through_import', ['import:'], ['value']),
                ('through_module', ['module:'], ['value']),
                ('through_local_binding', ['local:'], ['value']),
            ]
        )

    def test_extractor_preserves_required_defaults_and_keyword_only_parameters(self):
        source = '''def combine(left, /, middle, right=3, *, flag=True, required_option, **extras):
    return left + middle + right
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'sample.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'combine')

        self.assertEqual(data['required_args'], ['left', 'middle', 'required_option'])
        self.assertEqual(
            [(item['name'], item['kind'], item['default'], item['required']) for item in data['signature']],
            [
                ('left', 'positional_only', None, True),
                ('middle', 'positional_or_keyword', None, True),
                ('right', 'positional_or_keyword', '3', False),
                ('flag', 'keyword_only', 'True', False),
                ('required_option', 'keyword_only', None, True),
                ('extras', 'var_keyword', None, False),
            ]
        )

    def test_mock_scaffold_patches_the_target_module_usage_point_and_supports_async_methods(self):
        source = '''import transport_lib as transport
from helpers import normalize as normalize_value

class Worker:
    def __init__(self, config):
        self.config = config

    async def process(self, value):
        response = transport.send(value)
        return await normalize_value(response)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            result = generate_scaffold(str(target), 'process')

        self.assertEqual(result['patches'], ['worker.transport.send', 'worker.normalize_value'])
        self.assertEqual(result['mock_names'], ['mock_send', 'mock_normalize_value'])
        self.assertTrue(result['is_async'])
        self.assertEqual(result['class_name'], 'Worker')
        self.assertIn("@patch('worker.normalize_value')\n@patch('worker.transport.send')", result['scaffold'])
        self.assertIn('async def test_process(self, mock_send, mock_normalize_value):', result['scaffold'])
        self.assertIn('instance = Worker(...)', result['scaffold'])
        self.assertIn('result = await instance.process(value)', result['scaffold'])

    def test_mock_scaffold_uses_the_canonical_module_name_for_patch_paths(self):
        source = '''from shared import load

def process(value):
    return load(value)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'service.py'
            target.write_text(source, encoding='utf-8')
            result = generate_scaffold(str(target), 'process', target_module='src.service')

        self.assertEqual(result['patches'], ['src.service.load'])
        self.assertIn("@patch('src.service.load')", result['scaffold'])

    def test_mock_scaffold_patches_same_module_database_boundary_helpers(self):
        source = '''import sqlite3

def open_connection():
    return sqlite3.connect("application.db")

def add_record(value):
    connection = open_connection()
    connection.execute("INSERT INTO records(value) VALUES (?)", (value,))
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'repository.py'
            target.write_text(source, encoding='utf-8')
            result = generate_scaffold(str(target), 'add_record', target_module='app.repository')

        self.assertEqual(result['patches'], ['app.repository.open_connection'])
        self.assertEqual(result['mock_names'], ['mock_open_connection'])
        self.assertIn("@patch('app.repository.open_connection')", result['scaffold'])

    def test_mock_scaffold_patches_direct_builtin_open_at_target_use_point(self):
        source = '''def read_first_line(path):
    with open(path, encoding='utf-8') as handle:
        return handle.readline().strip()
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'reader.py'
            target.write_text(source, encoding='utf-8')
            result = generate_scaffold(str(target), 'read_first_line', target_module='app.reader')

        self.assertEqual(result['patches'], ['app.reader.open'])
        self.assertEqual(result['mock_names'], ['mock_open'])
        self.assertIn("@patch('app.reader.open')", result['scaffold'])

    def test_mock_scaffold_does_not_patch_an_unrelated_open_word(self):
        source = '''def describe(value):
    return f"open:{value}"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'reader.py'
            target.write_text(source, encoding='utf-8')
            result = generate_scaffold(str(target), 'describe', target_module='app.reader')

        self.assertEqual(result['patches'], [])

    def test_dynamic_tracer_awaits_async_target_before_recording_the_result(self):
        source = '''async def double(value):
    return value * 2
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'async_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'double', [{'args': [3], 'kwargs': {}}])

        self.assertIsNone(result['load_error'])
        self.assertEqual(result['examples'], [
            {'args': ['3'], 'result': '6', 'result_type': 'int'}
        ])

    def test_dynamic_tracer_marks_object_repr_as_non_deterministic_oracle(self):
        source = '''class Result:
    pass

def build():
    return Result()
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'object_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'build')

        example = result['examples'][0]
        self.assertEqual(example['result'], '<non_assertable: Result>')
        self.assertFalse(example['result_assertable'])

    def test_dynamic_tracer_cli_keeps_target_output_out_of_json_stdout(self):
        source = '''import sys

def echo(value):
    print("ordinary output")
    print("error output", file=sys.stderr)
    return value
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'echo.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('dynamic_tracer.py', target, 'echo')

        self.assertIsNone(data['load_error'])
        self.assertTrue(data['examples'])

    def test_dynamic_tracer_blocks_target_file_writes_without_recording_them_as_exceptions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            written = root / 'must_not_exist.txt'
            target = root / 'writer.py'
            target.write_text(
                "def save(value):\n"
                f"    with open({str(written)!r}, 'w', encoding='utf-8') as handle:\n"
                "        handle.write(value)\n"
                "    return value\n",
                encoding='utf-8'
            )
            result = trace_function(str(target), 'save', [{'args': ['value'], 'kwargs': {}}])

        self.assertFalse(written.exists())
        self.assertEqual(result['examples'], [])
        self.assertEqual(result['errors'], [])
        self.assertIn('file write', result['blocked_operations'][0])

    def test_dynamic_tracer_blocks_io_open_file_writes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            written = root / 'must_not_exist.txt'
            target = root / 'io_writer.py'
            target.write_text(
                "import io\n"
                "def save(value):\n"
                f"    with io.open({str(written)!r}, 'w', encoding='utf-8') as handle:\n"
                "        handle.write(value)\n"
                "    return value\n",
                encoding='utf-8'
            )
            result = trace_function(str(target), 'save', [{'args': ['value'], 'kwargs': {}}])

        self.assertFalse(written.exists())
        self.assertEqual(result['examples'], [])
        self.assertIn('file write', result['blocked_operations'][0])

    def test_dynamic_tracer_blocks_import_time_file_writes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            written = root / 'must_not_exist.txt'
            target = root / 'import_writer.py'
            target.write_text(
                "from pathlib import Path\n"
                f"Path({str(written)!r}).write_text('unsafe', encoding='utf-8')\n"
                "def value():\n"
                "    return 1\n",
                encoding='utf-8'
            )
            result = trace_function(str(target), 'value')

        self.assertFalse(written.exists())
        self.assertIn('Dynamic trace safety gate blocked', result['load_error'])
        self.assertIn('Path.write_text', result['blocked_operations'][0])

    def test_dynamic_tracer_blocks_network_and_process_operations(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'external_effects.py'
            target.write_text(
                "import socket\n"
                "import subprocess\n"
                "def connect():\n"
                "    return socket.create_connection(('example.invalid', 443))\n"
                "def run_command():\n"
                "    return subprocess.run(['echo', 'unsafe'])\n",
                encoding='utf-8'
            )
            network_result = trace_function(str(target), 'connect')
            process_result = trace_function(str(target), 'run_command')

        self.assertIn('network connection', network_result['blocked_operations'][0])
        self.assertIn('subprocess.run', process_result['blocked_operations'][0])

    def test_dynamic_tracer_loads_a_package_module_with_relative_imports(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            package = root / 'helpers_pkg'
            package.mkdir()
            (package / '__init__.py').write_text('', encoding='utf-8')
            (package / 'normalizer.py').write_text(
                'def normalize(value):\n    return value * 2\n', encoding='utf-8'
            )
            target = package / 'service.py'
            target.write_text(
                'from .normalizer import normalize\n\ndef transform(value):\n    return normalize(value) + 1\n',
                encoding='utf-8'
            )
            result = trace_function(str(target), 'transform', [{'args': [3], 'kwargs': {}}])

        self.assertIsNone(result['load_error'])
        self.assertEqual(result['examples'][0]['result'], '7')

    def test_dynamic_tracer_materializes_generator_values_for_a_reproducible_oracle(self):
        source = '''def numbers(limit):
    for value in range(limit):
        yield value * 2
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'generator_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'numbers', [{'args': [3], 'kwargs': {}}])

        self.assertEqual(result['examples'][0]['result'], '[0, 2, 4]')
        self.assertEqual(result['examples'][0]['result_type'], 'generator')
        self.assertFalse(result['examples'][0]['result_truncated'])

    def test_dynamic_tracer_materializes_async_generator_values_for_a_reproducible_oracle(self):
        source = '''async def numbers(limit):
    for value in range(limit):
        yield value * 2
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'async_generator_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'numbers', [{'args': [3], 'kwargs': {}}])

        self.assertEqual(result['examples'][0]['result'], '[0, 2, 4]')
        self.assertEqual(result['examples'][0]['result_type'], 'async_generator')
        self.assertFalse(result['examples'][0]['result_truncated'])

    def test_dynamic_tracer_does_not_treat_an_uninitialized_class_as_a_real_trace(self):
        source = '''class Worker:
    def __init__(self, prefix):
        self.prefix = prefix

    def render(self, value):
        return self.prefix + value
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'render', [{'args': ['x'], 'kwargs': {}}])

        self.assertIn('Cannot safely instantiate class', result['load_error'])
        self.assertEqual(result['examples'], [])
        self.assertEqual(result['errors'], [])

    def test_static_and_class_methods_do_not_require_constructor_instantiation(self):
        source = '''class Worker:
    def __init__(self, required):
        self.required = required

    @staticmethod
    def static_double(value):
        return value * 2

    @classmethod
    def class_label(cls, value):
        return cls.__name__ + ":" + value
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            static_result = trace_function(str(target), 'static_double', [{'args': [3], 'kwargs': {}}])
            class_result = trace_function(str(target), 'class_label', [{'args': ['x'], 'kwargs': {}}])
            static_data = self.run_script('ast_extractor.py', target, 'static_double')
            class_data = self.run_script('ast_extractor.py', target, 'class_label')
            scaffold = generate_scaffold(str(target), 'static_double')

        self.assertEqual(static_data['method_kind'], 'static')
        self.assertEqual(class_data['method_kind'], 'class')
        self.assertIsNone(static_result['load_error'])
        self.assertEqual(static_result['examples'][0]['result'], '6')
        self.assertIsNone(class_result['load_error'])
        self.assertEqual(class_result['examples'][0]['result'], "'Worker:x'")
        self.assertEqual(scaffold['method_kind'], 'static')
        self.assertIn('result = Worker.static_double(value)', scaffold['scaffold'])
        self.assertNotIn('instance = Worker(...)', scaffold['scaffold'])

    def test_qualified_class_method_selection_stays_with_the_selected_class(self):
        source = '''class First:
    @staticmethod
    def label(value):
        return "first:" + value

class Second:
    @staticmethod
    def label(value):
        return "second:" + value
'''
        test_source = '''import unittest
from worker import Second

class TestSecond(unittest.TestCase):
    def test_label(self):
        self.assertEqual(Second.label("x"), "second:x")
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'worker.py'
            test_file = root / 'test_worker.py'
            target.write_text(source, encoding='utf-8')
            test_file.write_text(test_source, encoding='utf-8')
            ast_data = self.run_script('ast_extractor.py', target, 'Second.label')
            trace = trace_function(str(target), 'Second.label', [{'args': ['x'], 'kwargs': {}}])
            scaffold = generate_scaffold(str(target), 'Second.label')
            complexity = assess_complexity(str(target), 'Second.label')
            mutation = run_mutation_trials(target, test_file, target_function='Second.label')

        self.assertEqual(ast_data['class_name'], 'Second')
        self.assertEqual(ast_data['name'], 'label')
        self.assertIsNone(trace['load_error'])
        self.assertEqual(trace['examples'][0]['result'], "'second:x'")
        self.assertEqual(scaffold['class_name'], 'Second')
        self.assertIn('result = Second.label(value)', scaffold['scaffold'])
        self.assertNotIn('First.label', scaffold['scaffold'])
        self.assertNotEqual(complexity['level'], 'Unknown')
        self.assertTrue(mutation['scope_found'])
        self.assertGreater(mutation['total'], 0)
        self.assertEqual(mutation['survived'], 0)

    def test_builtin_mutation_runner_scores_qualified_async_instance_methods(self):
        source = '''class Service:
    def __init__(self, prefix):
        self.prefix = prefix

    async def render(self, value):
        if value == "bad":
            raise ValueError("bad")
        return self.prefix + value
'''
        test_source = '''import asyncio
import unittest
from worker import Service

class TestService(unittest.TestCase):
    def setUp(self):
        self.subject = Service("prefix:")

    def test_render(self):
        self.assertEqual(asyncio.run(self.subject.render("value")), "prefix:value")

    def test_bad_value(self):
        with self.assertRaises(ValueError):
            asyncio.run(self.subject.render("bad"))
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'worker.py'
            test_file = root / 'test_worker.py'
            target.write_text(source, encoding='utf-8')
            test_file.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(target, test_file, target_function='Service.render')

        self.assertTrue(result['scope_found'])
        self.assertTrue(result['baseline_passed'])
        self.assertGreater(result['total'], 0)
        self.assertEqual(result['errors'], 0)
        self.assertEqual(result['survived'], 0)

    def test_dynamic_tracer_uses_literal_constructor_context_for_qualified_instance_methods(self):
        source = '''class Service:
    def __init__(self, prefix):
        self.prefix = prefix

    def render(self, value):
        if value == "other":
            return self.prefix + "fallback"
        return self.prefix + value
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'Service.render', [{
                'args': ['known'],
                'kwargs': {},
                'constructor_args': ['prefix:'],
                'constructor_kwargs': {},
            }])

        self.assertIsNone(result['load_error'])
        observed = {(item['args'][0], item['result']) for item in result['examples']}
        self.assertIn(("'known'", "'prefix:known'"), observed)
        self.assertIn(("'other'", "'prefix:fallback'"), observed)

    def test_dynamic_tracer_preserves_required_keyword_only_arguments(self):
        source = '''def multiply(value: int, *, factor: int):
    return value * factor
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'keyword_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'multiply', [{'args': [3], 'kwargs': {'factor': 2}}])

        self.assertIsNone(result['load_error'])
        self.assertEqual(result['examples'], [{
            'args': ['3'], 'kwargs': {'factor': '2'}, 'result': '6', 'result_type': 'int'
        }])

    def test_property_getter_exposes_accessor_context_and_real_trace(self):
        source = '''class Feature:
    def __init__(self):
        self._enabled = True

    @property
    def enabled(self):
        return self._enabled

    @enabled.setter
    def enabled(self, value):
        self._enabled = bool(value)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'feature.py'
            target.write_text(source, encoding='utf-8')
            ast_data = self.run_script('ast_extractor.py', target, 'enabled')
            trace = trace_function(str(target), 'enabled')

        self.assertEqual(ast_data['method_kind'], 'property')
        self.assertEqual(ast_data['property_context']['name'], 'enabled')
        self.assertIsNotNone(ast_data['property_context']['getter'])
        self.assertIsNotNone(ast_data['property_context']['setter'])
        self.assertIsNone(trace['load_error'])
        self.assertEqual(trace['examples'], [{'args': [], 'result': 'True', 'result_type': 'bool'}])

    def test_dynamic_tracer_supports_standard_library_cached_property(self):
        source = '''from functools import cached_property

class Settings:
    @cached_property
    def label(self):
        return "ready"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'settings.py'
            target.write_text(source, encoding='utf-8')
            ast_data = self.run_script('ast_extractor.py', target, 'label')
            trace = trace_function(str(target), 'label')

        self.assertEqual(ast_data['method_kind'], 'property')
        self.assertIsNone(trace['load_error'])
        self.assertEqual(trace['examples'], [{'args': [], 'result': "'ready'", 'result_type': 'str'}])

    def test_dynamic_tracer_uses_literal_annotation_values_as_safe_probes(self):
        source = '''from typing import Literal

def render(stage: Literal["draft", "published"]):
    return "stage:" + stage
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'literal_target.py'
            target.write_text(source, encoding='utf-8')
            trace = trace_function(str(target), 'render')

        observed = {(item['args'][0], item['result']) for item in trace['examples']}
        self.assertIsNone(trace['load_error'])
        self.assertIn(("'draft'", "'stage:draft'"), observed)
        self.assertIn(("'published'", "'stage:published'"), observed)

    def test_dynamic_tracer_reaches_scalar_branches_from_source_conditions(self):
        source = '''def route(value: str, mode: str):
    if not value or len(value) < 4:
        raise ValueError("value is too short")
    if mode == "first":
        return "first-route"
    if mode == "second":
        return "second-route"
    return "default-route"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'route_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'route')

        self.assertIsNone(result['load_error'])
        self.assertIn(
            {'args': ["'test_value'", "'first'"], 'result': "'first-route'", 'result_type': 'str'},
            result['examples']
        )
        self.assertIn(
            {'args': ["'test_value'", "'second'"], 'result': "'second-route'", 'result_type': 'str'},
            result['examples']
        )
        self.assertTrue(any(error['exception'] == 'ValueError' for error in result['errors']))

    def test_dynamic_tracer_reaches_multi_parameter_conjunctions_from_source_conditions(self):
        source = '''def route(state: str, mode: str):
    if state == "enabled" and mode == "strict":
        return "selected"
    return "default"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'route_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'route')

        self.assertIsNone(result['load_error'])
        self.assertIn(
            {'args': ["'enabled'", "'strict'"], 'result': "'selected'", 'result_type': 'str'},
            result['examples']
        )

    def test_dynamic_tracer_ignores_nested_callable_conditions_when_deriving_inputs(self):
        source = '''def route(value: str):
    def deferred():
        if value == "nested":
            return "not-target"
    if value == "outer":
        return "target"
    return "default"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'route_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'route')

        observed_inputs = [item['args'] for item in result['examples']]
        self.assertIn(["'outer'"], observed_inputs)
        self.assertNotIn(["'nested'"], observed_inputs)

    def test_dynamic_tracer_reaches_reverse_and_literal_membership_branches(self):
        source = '''def route(value: int, mode: str):
    if 3 < value:
        return "large"
    if mode in ("fast", "safe"):
        return "known"
    return "other"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'route_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'route')

        self.assertIsNone(result['load_error'])
        self.assertIn(
            {'args': ['4', "'test_value'"], 'result': "'large'", 'result_type': 'str'},
            result['examples']
        )
        self.assertIn(
            {'args': ['1', "'fast'"], 'result': "'known'", 'result_type': 'str'},
            result['examples']
        )

    def test_dynamic_tracer_uses_relative_numeric_probes_for_derived_thresholds(self):
        source = '''def classify(numerator, denominator):
    score = round(numerator / (denominator / 100) ** 2, 2)
    if score < 18.5:
        return "low"
    if score < 24:
        return "middle"
    if score < 27:
        return "high"
    return "top"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'derived_thresholds.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'classify')

        observed = {example['result'] for example in result['examples']}
        self.assertTrue({"'low'", "'middle'", "'high'", "'top'"}.issubset(observed))

    def test_dynamic_tracer_reaches_match_case_literals_and_default_path(self):
        source = '''def route(kind: str):
    match kind:
        case "new" | "queued":
            return "pending"
        case "active":
            return "running"
        case _:
            return "other"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'route_match.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'route')

        observed = {(item['args'][0], item['result']) for item in result['examples']}
        self.assertIn(("'new'", "'pending'"), observed)
        self.assertIn(("'queued'", "'pending'"), observed)
        self.assertIn(("'active'", "'running'"), observed)
        self.assertIn(("'__other_value__'", "'other'"), observed)

    def test_dynamic_tracer_keeps_literal_caller_input_and_adds_other_branches(self):
        source = '''def route(value: str, mode: str):
    if len(value) < 4:
        raise ValueError("value is too short")
    if mode == "first":
        return "first-route"
    if mode == "second":
        return "second-route"
    return "default-route"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'route_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'route', [{'args': ['known-value', 'first'], 'kwargs': {}}])

        observed_inputs = [example['args'] for example in result['examples']]
        self.assertIn(["'known-value'", "'first'"], observed_inputs)
        self.assertIn(["'test_value'", "'second'"], observed_inputs)

    def test_builtin_mutation_runner_kills_a_boundary_mutation_without_changing_source(self):
        source = '''def classify(value):
    return "positive" if value > 0 else "not-positive"
'''
        test_source = '''import unittest
from target import classify

class TestClassify(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(classify(1), "positive")

    def test_boundary(self):
        self.assertEqual(classify(0), "not-positive")
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'target.py'
            test_file = root / 'test_target.py'
            target.write_text(source, encoding='utf-8')
            test_file.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(target, test_file)
            original_source = target.read_text(encoding='utf-8')

        self.assertEqual(original_source, source)
        self.assertGreaterEqual(result['total'], 1)
        self.assertGreaterEqual(result['killed'], 1)
        self.assertEqual(result['survived'], 0)

    def test_builtin_mutation_runner_refuses_to_score_a_failing_isolated_baseline(self):
        source = '''def choose(value):
    return "yes" if value else "no"
'''
        test_source = '''import unittest
from target import choose

class TestChoose(unittest.TestCase):
    def test_broken_baseline(self):
        self.assertEqual(choose(True), "no")
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'target.py'
            test_file = root / 'test_target.py'
            target.write_text(source, encoding='utf-8')
            test_file.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(target, test_file)

        self.assertFalse(result['baseline_passed'])
        self.assertEqual(result['total'], 0)
        self.assertEqual(result['mutants'], [])
        self.assertIn('FAILED', result['baseline_output'])

    def test_builtin_mutation_runner_tolerates_non_utf8_target_output(self):
        source = '''import os

def label(value):
    os.write(1, b"\\xa9")
    return "yes" if value else "no"
'''
        test_source = '''import unittest
from target import label

class TestLabel(unittest.TestCase):
    def test_yes(self):
        self.assertEqual(label(True), "yes")

    def test_no(self):
        self.assertEqual(label(False), "no")
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'target.py'
            test_file = root / 'test_target.py'
            target.write_text(source, encoding='utf-8')
            test_file.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(target, test_file)

        self.assertGreater(result['total'], 0)
        self.assertEqual(result['errors'], 0)

    def test_builtin_mutation_runner_limits_candidates_to_selected_function(self):
        source = '''def target(value):
    return "positive" if value > 0 else "not-positive"

def unrelated(value):
    return "large" if value > 100 else "small"
'''
        test_source = '''import unittest
from sample import target

class TestTarget(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(target(1), "positive")

    def test_not_positive(self):
        self.assertEqual(target(0), "not-positive")
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            source_path = root / 'sample.py'
            test_path = root / 'test_sample.py'
            source_path.write_text(source, encoding='utf-8')
            test_path.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(
                str(source_path),
                str(test_path),
                target_function='target'
            )

        self.assertTrue(result['scope_found'])
        self.assertEqual(result['scope'], 'target')
        self.assertEqual(result['total'], 4)
        self.assertEqual(result['killed'], 4)

    def test_builtin_mutation_runner_mutates_numeric_constants(self):
        source = '''def increment(value):
    return value + 1
'''
        test_source = '''import unittest
from sample import increment

class TestIncrement(unittest.TestCase):
    def test_increment(self):
        self.assertEqual(increment(1), 2)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            source_path = root / 'sample.py'
            test_path = root / 'test_sample.py'
            source_path.write_text(source, encoding='utf-8')
            test_path.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(
                str(source_path),
                str(test_path),
                target_function='increment'
            )

        self.assertEqual(result['total'], 3)
        numeric_mutants = [
            mutant for mutant in result['mutants']
            if mutant['kind'] == 'numeric_constant'
        ]
        self.assertEqual(len(numeric_mutants), 1)
        self.assertEqual(numeric_mutants[0]['status'], 'KILLED')
        self.assertEqual(result['killed'], 3)

    def test_builtin_mutation_runner_mutates_boolean_operators(self):
        source = '''def both_enabled(left, right):
    return "enabled" if left and right else "disabled"
'''
        test_source = '''import unittest
from target import both_enabled

class TestBothEnabled(unittest.TestCase):
    def test_both_enabled(self):
        self.assertEqual(both_enabled(True, True), "enabled")

    def test_one_disabled(self):
        self.assertEqual(both_enabled(True, False), "disabled")
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'target.py'
            test_file = root / 'test_target.py'
            target.write_text(source, encoding='utf-8')
            test_file.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(target, test_file)

        boolean_mutants = [mutant for mutant in result['mutants'] if mutant['kind'] == 'boolean_operator']
        self.assertEqual(len(boolean_mutants), 1)
        self.assertEqual(boolean_mutants[0]['status'], 'KILLED')

    def test_builtin_mutation_runner_mutates_if_predicates(self):
        source = '''def choose(flag):
    if flag:
        return "enabled"
    return "disabled"
'''
        test_source = '''import unittest
from target import choose

class TestChoose(unittest.TestCase):
    def test_enabled(self):
        self.assertEqual(choose(True), "enabled")

    def test_disabled(self):
        self.assertEqual(choose(False), "disabled")
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'target.py'
            test_file = root / 'test_target.py'
            target.write_text(source, encoding='utf-8')
            test_file.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(target, test_file, target_function='choose')

        predicates = [mutant for mutant in result['mutants'] if mutant['kind'] == 'conditional_negation']
        self.assertEqual(len(predicates), 1)
        self.assertEqual(predicates[0]['status'], 'KILLED')
        self.assertEqual(result['survived'], 0)

    def test_builtin_mutation_runner_mutates_ternaries_loops_and_augmented_assignments(self):
        source = '''def advance(limit, enabled):
    current = 0
    while current < limit:
        current += 1
    return current if enabled else -current
'''
        test_source = '''import unittest
from sample import advance

class TestAdvance(unittest.TestCase):
    def test_enabled(self):
        self.assertEqual(advance(3, True), 3)

    def test_disabled(self):
        self.assertEqual(advance(3, False), -3)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            source_path = root / 'sample.py'
            test_path = root / 'test_sample.py'
            source_path.write_text(source, encoding='utf-8')
            test_path.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(source_path, test_path, target_function='advance')

        kinds = {mutant['kind']: mutant['status'] for mutant in result['mutants']}
        self.assertEqual(kinds['loop_condition_negation'], 'KILLED')
        self.assertEqual(kinds['conditional_expression_negation'], 'KILLED')
        self.assertEqual(kinds['augmented_assignment'], 'KILLED')

    def test_builtin_mutation_runner_keeps_candidate_indexes_aligned_after_unsupported_operator(self):
        source = '''def increment(value, exponent):
    ignored = value ** exponent
    return value + 1
'''
        test_source = '''import unittest
from sample import increment

class TestIncrement(unittest.TestCase):
    def test_increment(self):
        self.assertEqual(increment(2, 3), 3)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            source_path = root / 'sample.py'
            test_path = root / 'test_sample.py'
            source_path.write_text(source, encoding='utf-8')
            test_path.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(source_path, test_path, target_function='increment')

        binary_mutants = [mutant for mutant in result['mutants'] if mutant['kind'] == 'binary']
        self.assertEqual(len(binary_mutants), 1)
        self.assertEqual(binary_mutants[0]['status'], 'KILLED')

    def test_builtin_mutation_runner_excludes_nested_callable_mutants_from_selected_function_score(self):
        source = '''def increment(value):
    def unrelated_helper(flag):
        if flag:
            return 1
        return 0
    return value + 1
'''
        test_source = '''import unittest
from sample import increment

class TestIncrement(unittest.TestCase):
    def test_increment(self):
        self.assertEqual(increment(2), 3)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            source_path = root / 'sample.py'
            test_path = root / 'test_sample.py'
            source_path.write_text(source, encoding='utf-8')
            test_path.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(source_path, test_path, target_function='increment')

        self.assertEqual(result['total'], 3)
        self.assertEqual(result['survived'], 0)
        self.assertTrue(all(mutant['line'] != 3 for mutant in result['mutants']))

    def test_builtin_mutation_runner_mutates_match_case_literals(self):
        source = '''def route(kind):
    match kind:
        case "new":
            return "pending"
        case "active":
            return "running"
        case _:
            return "other"
'''
        test_source = '''import unittest
from sample import route

class TestRoute(unittest.TestCase):
    def test_new(self):
        self.assertEqual(route("new"), "pending")

    def test_active(self):
        self.assertEqual(route("active"), "running")

    def test_default(self):
        self.assertEqual(route("archived"), "other")
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            source_path = root / 'sample.py'
            test_path = root / 'test_sample.py'
            source_path.write_text(source, encoding='utf-8')
            test_path.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(source_path, test_path, target_function='route')

        match_mutants = [mutant for mutant in result['mutants'] if mutant['kind'] == 'match_literal']
        self.assertEqual(len(match_mutants), 2)
        self.assertTrue(all(mutant['status'] == 'KILLED' for mutant in match_mutants))
        self.assertEqual(result['survived'], 0)

    def test_builtin_mutation_runner_mutates_structured_return_values(self):
        source = '''def describe(enabled):
    if enabled:
        return {"state": "enabled"}
    return {"state": "disabled"}
'''
        test_source = '''import unittest
from sample import describe

class TestDescribe(unittest.TestCase):
    def test_enabled(self):
        self.assertEqual(describe(True), {"state": "enabled"})

    def test_disabled(self):
        self.assertEqual(describe(False), {"state": "disabled"})
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            source_path = root / 'sample.py'
            test_path = root / 'test_sample.py'
            source_path.write_text(source, encoding='utf-8')
            test_path.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(source_path, test_path, target_function='describe')

        return_mutants = [mutant for mutant in result['mutants'] if mutant['kind'] == 'return_value']
        self.assertEqual(len(return_mutants), 2)
        self.assertTrue(all(mutant['status'] == 'KILLED' for mutant in return_mutants))

    def test_builtin_mutation_runner_uses_mutant_for_package_imports(self):
        source = '''def choose(enabled):
    if enabled:
        return "yes"
    return "no"
'''
        test_source = '''import unittest
from src.choose import choose

class TestChoose(unittest.TestCase):
    def test_enabled(self):
        self.assertEqual(choose(True), "yes")
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            package = root / 'src'
            package.mkdir()
            source_path = package / 'choose.py'
            test_path = root / 'test_choose.py'
            source_path.write_text(source, encoding='utf-8')
            test_path.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(source_path, test_path, target_function='choose')

        predicates = [mutant for mutant in result['mutants'] if mutant['kind'] == 'conditional_negation']
        self.assertEqual(len(predicates), 1)
        self.assertEqual(predicates[0]['status'], 'KILLED')


if __name__ == '__main__':
    unittest.main()
