"""Real imports verify initialization and calls use different bound code bodies."""
import ast
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mutation_activation import FunctionMutationActivation, write_manifest, validate_evidence
import basic_mutation_runner as runner
from runtime_policy import guarded_runtime, RuntimePolicyError

SOURCE = b'def target(value):\r\n    return value + 1\r\nalias = target\r\nINITIAL = alias(2)\r\n'


class MutationActivationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mutation-activation-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.previous = Path.cwd()
        self.addCleanup(os.chdir, self.previous)
        os.chdir(self.root)
        self.addCleanup(sys.modules.pop, 'activation_subject', None)
        self.paths = list(sys.path)
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), self.paths))
        sys.path.insert(0, str(self.root))
        self.module_file = self.root / 'activation_subject.py'
        self.test_file = self.root / 'test_subject.py'
        self.test_file.write_bytes(b'import activation_subject\n')

    def prepare(self, body=None, variant=None):
        tree = ast.parse(SOURCE)
        tree.body[0].body = ast.parse(body or 'return value - 1').body
        ast.fix_missing_locations(tree)
        self.variant = variant or (ast.unparse(tree) + '\n').encode('utf-8')
        self.module_file.write_bytes(self.variant)
        self.manifest = write_manifest(self.root, SOURCE, 'target', [self.module_file], self.test_file)
        return FunctionMutationActivation(self.manifest)

    def test_original_initialization_then_actual_mutant_and_retained_alias_run(self):
        activation = self.prepare()
        with activation, guarded_runtime():
            subject = importlib.import_module('activation_subject')
            self.assertEqual(subject.INITIAL, 3)
            self.assertEqual(subject.target(2), 1)
            self.assertIs(subject.alias, subject.target)
            self.assertEqual(subject.alias(2), 1)
        evidence = activation.evidence()
        expected = {'sourceHash': hashlib.sha256(SOURCE).hexdigest(), 'variantHash': hashlib.sha256(self.variant).hexdigest(),
                    'testHash': hashlib.sha256(self.test_file.read_bytes()).hexdigest(), 'target': 'target'}
        self.assertTrue(validate_evidence(evidence, expected), evidence)
        self.assertEqual(self.module_file.read_bytes(), self.variant)
        for key in expected:
            changed = dict(evidence, **{key: 'wrong'})
            self.assertFalse(validate_evidence(changed, expected))

    def test_changed_module_initialization_signature_or_variant_bytes_are_not_accepted(self):
        variants = [SOURCE.replace(b'INITIAL = alias(2)', b'INITIAL = 99'),
                    SOURCE.replace(b'def target(value)', b'def target(value=10)'),
                    SOURCE.replace(b'def target(value)', b'def target(value, other)')]
        for variant in variants:
            with self.assertRaisesRegex(ValueError, 'outside selected body'):
                self.prepare(variant=variant)
            self.assertNotIn('activation_subject', sys.modules)
        self.prepare()
        self.module_file.write_bytes(self.variant + b'# drift\n')
        with self.assertRaisesRegex(ValueError, 'variant changed'):
            FunctionMutationActivation(self.manifest)

    def test_source_test_or_trial_manifest_drift_is_rejected_before_import(self):
        self.prepare()
        original = self.root / 'activation-original.source'
        original.write_bytes(SOURCE + b'# drift\n')
        with self.assertRaisesRegex(ValueError, 'source or test changed'):
            FunctionMutationActivation(self.manifest)
        self.prepare()
        self.test_file.write_bytes(b'# changed\n')
        with self.assertRaisesRegex(ValueError, 'source or test changed'):
            FunctionMutationActivation(self.manifest)
        self.prepare()
        data = json.loads(self.manifest.read_bytes())
        data['original'] = '../outside.py'
        self.manifest.write_bytes(json.dumps(data).encode())
        with self.assertRaisesRegex(ValueError, 'escapes trial'):
            FunctionMutationActivation(self.manifest)

    def test_a_mutated_call_cannot_escape_the_existing_runtime_guard(self):
        activation = self.prepare('open("must-not-write.txt", "w").write("bad")\nreturn value')
        with self.assertRaises(RuntimePolicyError), activation, guarded_runtime():
            subject = importlib.import_module('activation_subject')
            self.assertEqual(subject.INITIAL, 3)
            subject.target(2)
        self.assertFalse((self.root / 'must-not-write.txt').exists())

    def test_not_loaded_or_tampered_target_does_not_claim_activation(self):
        activation = self.prepare()
        with activation, guarded_runtime():
            pass
        self.assertEqual(activation.evidence()['status'], 'not-activated')
        with activation, guarded_runtime():
            subject = importlib.import_module('activation_subject')
            subject.target.__code__ = (lambda value: value).__code__
        self.assertEqual(activation.evidence()['status'], 'invalidated')

    def test_trials_keep_original_import_and_do_not_count_init_errors_as_kills(self):
        source = self.root / 'sample.py'
        tests = self.root / 'test_sample.py'
        source.write_text('def scale():\n    return 1\nVALUE = 10 / scale()\n', encoding='utf-8')
        tests.write_text('import unittest\nfrom sample import scale, VALUE\nclass Cases(unittest.TestCase):\n'
                         '    def test_scale(self):\n        self.assertEqual(VALUE, 10)\n        self.assertEqual(scale(), 1)\n',
                         encoding='utf-8')
        inactive = runner.run_mutation_trials(source, tests, max_mutations=0, timeout_seconds=10,
                                              target_function='scale', workers=1)
        self.assertEqual(inactive['executionBackend'], 'isolated-unittest-v1')
        self.assertGreater(inactive['counts']['error'], 0)
        self.assertTrue(any(item['status'] == 'ERROR' for item in inactive['mutants']))
        active = runner.run_mutation_trials(source, tests, max_mutations=0, timeout_seconds=10,
                                            target_function='scale', workers=1, activate_functions=True)
        self.assertEqual(active['executionBackend'], 'isolated-unittest-function-v2')
        self.assertEqual(active['activationPolicy'], 'after-module-initialization-v1')
        self.assertTrue(active['baseline_passed'])
        self.assertEqual(active['counts']['error'], 0)
        self.assertGreater(active['counts']['killed'], 0)
        self.assertEqual(active['baselineFunctionActivation']['status'], 'activated')
        for item in active['mutants']:
            if item['status'] in ('KILLED', 'SURVIVED'):
                self.assertEqual(item['functionActivation']['status'], 'activated')
                self.assertEqual(item['functionActivation']['variantHash'], item['variantSourceHash'])


if __name__ == '__main__':
    unittest.main()
