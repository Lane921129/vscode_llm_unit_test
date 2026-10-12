import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from probe_fixture_builder import build_fixture, bounded_literal, FixtureInputError, MAX_BYTES
from probe_input_transport import prepare_probe_inputs, restore_call


class ProbeFixtureBuilderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='manual-trace-builder-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / 'sample.py'
        self.raw = b'\xef\xbb\xbfdef advance(value):\r\n    return value + 1\r\n'
        self.source.write_bytes(self.raw)

    def build(self, case=None, **options):
        return build_fixture(str(self.root), str(options.get('file', self.source)), options.get('target', 'advance'),
                             {'cases': [{} if case is None else case]})

    def cli(self, payload, file=None, target='advance'):
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode('utf-8')
        return subprocess.run([sys.executable, '-B', str(SCRIPTS / 'probe_fixture_builder.py'), '--root', str(self.root),
                               '--file', str(file or self.source), '--target', target],
                              input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)

    def test_preserves_python_numeric_types_tuple_bytes_keyword_order_and_constructor(self):
        document = self.build({'args_literals': "[(9007199254740993, 1.0, -0.0, b'\\x00A')]",
                               'kwargs_literals': "{'second': 2, 'first': 1}",
                               'constructor_args_literals': "['prefix']", 'constructor_kwargs_literals': "{'limit': 4}"})
        entry = document['targets'][0]
        self.assertEqual(entry['file'], 'sample.py')
        self.assertEqual(entry['sourceHash'], hashlib.sha256(self.raw).hexdigest())
        restored = restore_call(entry['inputs']['cases'][0]['input'])
        data = restored['args'][0]
        self.assertIs(type(data), tuple)
        self.assertIs(type(data[0]), int)
        self.assertEqual(data[0], 9007199254740993)
        self.assertIs(type(data[1]), float)
        self.assertEqual(math.copysign(1, data[2]), -1)
        self.assertEqual(data[3], b'\x00A')
        self.assertEqual(list(restored['kwargs']), ['second', 'first'])
        self.assertEqual(restored['constructor_args'], ['prefix'])
        self.assertEqual(restored['constructor_kwargs'], {'limit': 4})

    def test_empty_carriers_and_existing_transport_accept_builder_data_without_an_oracle(self):
        document = self.build()
        encoded = document['targets'][0]['inputs']['cases'][0]['input']
        self.assertEqual(restore_call(encoded), {'args': [], 'kwargs': {}, 'constructor_args': [], 'constructor_kwargs': {}})
        envelope = {'schema_version': 'probe-inputs-v1', 'cases': [{'input': encoded,
                     'source': {'kind': 'unknown', 'detail': 'user-fixture:neutral'}}]}
        prepared, rejected = prepare_probe_inputs(envelope)
        self.assertEqual(len(prepared), 1)
        self.assertEqual(rejected, [])
        self.assertNotIn('expected', json.dumps(document))

    def test_cli_reads_source_without_importing_it_and_emits_utf8_json(self):
        marker = self.root / 'never-created.txt'
        self.source.write_text(f"open({str(marker)!r}, 'w').write('unsafe')\nraise RuntimeError('do not import')\n", encoding='utf-8')
        result = self.cli({'cases': [{'args_literals': "['測試']"}]})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b'')
        self.assertEqual(json.loads(result.stdout.decode('utf-8'))['targets'][0]['target'], 'advance')
        self.assertFalse(marker.exists())

    def test_calls_attributes_operators_and_comprehensions_are_never_evaluated(self):
        values = ['__import__("os")', 'dict(a=1)', 'set()', 'value.member', '1+2', '1<<100', '2**100',
                  '[x for x in ()]', '{**{}}', '(lambda: 1)()', 'f"{1}"']
        with patch('probe_fixture_builder.ast.literal_eval', side_effect=AssertionError('unsafe AST reached evaluator')):
            for value in values:
                with self.subTest(value=value), self.assertRaises(FixtureInputError):
                    bounded_literal(value)

    def test_negative_scalars_are_supported_but_signing_boolean_and_complex_literals_are_not(self):
        self.assertEqual(bounded_literal('-5'), -5)
        self.assertEqual(bounded_literal('+1.0'), 1.0)
        for value in ('-True', '1j', '1+2j'):
            with self.subTest(value=value), self.assertRaises(FixtureInputError):
                bounded_literal(value)

    def test_ast_depth_collection_integer_text_and_nonfinite_budgets_reject(self):
        values = ['[' * 10 + '0' + ']' * 10, '[' + ','.join(['0'] * 101) + ']',
                  '0x' + 'f' * 1100, repr('x' * 4097)]
        for value in values:
            with self.subTest(value=value), self.assertRaises(FixtureInputError):
                self.build({'args_literals': f'[{value}]'})
        with self.assertRaises(FixtureInputError) as caught:
            self.build({'args_literals': '[1e10000]'})
        self.assertEqual(caught.exception.code, 'input-unsupported-snapshot')

    def test_python_equal_dictionary_keys_are_not_silently_collapsed(self):
        for value in ("{1: 'a', 1.0: 'b'}", "{False: 'a', 0: 'b'}", "{(1,): 'a', (1.0,): 'b'}"):
            with self.subTest(value=value), self.assertRaises(FixtureInputError) as caught:
                self.build({'args_literals': f'[{value}]'})
            self.assertEqual(caught.exception.code, 'literal-duplicate-key')

    def test_worker_transport_metadata_keeps_the_full_call_within_codec_budget(self):
        values = [[0] * count for count in (100, 100, 100, 100, 93)]
        with self.assertRaises(FixtureInputError) as caught:
            self.build({'args_literals': repr(values)})
        self.assertEqual(caught.exception.code, 'input-unsupported-snapshot')

    def test_positional_and_keyword_shapes_are_enforced_instead_of_guessed(self):
        for case in ({'args_literals': '3'}, {'kwargs_literals': "{1: 'x'}"},
                     {'constructor_args_literals': "'prefix'"}, {'constructor_kwargs_literals': '[1]'}) :
            with self.subTest(case=case), self.assertRaises(FixtureInputError):
                self.build(case)

    def test_expected_values_code_and_source_claim_fields_are_not_part_of_input_schema(self):
        for extra in ({'expected': 4}, {'source': {'kind': 'caller_literals'}}, {'code': 'print(1)'}):
            result = self.cli({'cases': [{'args_literals': '[3]', **extra}]})
            self.assertEqual(result.returncode, 2)
            safe = json.loads(result.stdout)
            self.assertEqual(safe['diagnostics'], [{'code': 'input-invalid-schema', 'caseIndex': 0}])
            self.assertNotIn('args_literals', safe)

    def test_credential_literals_are_not_printed_even_as_nested_dictionary_data(self):
        secret = '-'.join(['neutral', 'opaque', '01234567890123456789'])
        result = self.cli({'cases': [{'args_literals': f'[( {{"api_key": "{secret}"}} ,)]'}]})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['diagnostics'][0]['code'], 'input-sensitive-content')
        self.assertNotIn(secret.encode(), result.stdout + result.stderr)

    def test_hex_literal_bytes_cannot_bypass_decoded_credential_detection(self):
        secret = 'sk' + '-' + 'A' * 32
        encoded = ''.join('\\x%02x' % byte for byte in secret.encode('ascii'))
        result = self.cli({'cases': [{'args_literals': "[b'" + encoded + "']"}]})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['diagnostics'][0]['code'], 'input-sensitive-content')
        self.assertNotIn(secret.encode(), result.stdout + result.stderr)

    def test_stdin_and_output_are_limited_and_failure_returns_only_safe_codes(self):
        result = self.cli(b' ' * (MAX_BYTES + 1))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['diagnostics'][0]['code'], 'input-too-large')
        for payload in ({'cases': []}, {'cases': [{}] * 33}, {'cases': [{}], 'expected': 4}):
            self.assertEqual(self.cli(payload).returncode, 2)
        with self.assertRaises(FixtureInputError) as caught:
            build_fixture(str(self.root), str(self.source), 'advance',
                          {'cases': [{'args_literals': repr(['x' * 3000])}] * 32})
        self.assertEqual(caught.exception.code, 'fixture-too-large')

    def test_original_database_external_and_remote_paths_are_not_opened(self):
        forbidden = self.root / 'original.db'
        with patch('probe_fixture_builder.Path.open', side_effect=AssertionError('forbidden source opened')):
            for file in (str(forbidden), str(self.root.parent / 'outside.py'), r'\\unread-host\share\sample.py'):
                with self.subTest(file=file), self.assertRaises(FixtureInputError):
                    self.build(file=file)

    def test_changed_source_is_refused_instead_of_emitting_stale_hash(self):
        import probe_fixture_builder as builder
        original = builder._source
        calls = 0

        def changed(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.source.write_bytes(self.raw + b'\n# drift\n')
            return original(*args)

        with patch('probe_fixture_builder._source', side_effect=changed), self.assertRaises(FixtureInputError) as caught:
            self.build()
        self.assertEqual(caught.exception.code, 'source-drifted')

    @unittest.skipIf(os.name == 'nt', 'Windows junction guard is covered by the native Node loader test')
    def test_symlink_source_and_root_are_rejected(self):
        link = self.root / 'linked.py'
        link.symlink_to(self.source)
        with self.assertRaises(FixtureInputError):
            self.build(file=link)
        folder = self.root / 'ordinary'
        folder.mkdir()
        linked_root = self.root / 'linked'
        linked_root.symlink_to(folder, target_is_directory=True)
        with self.assertRaises(FixtureInputError):
            build_fixture(str(linked_root), str(self.source), 'advance', {'cases': [{}]})


if __name__ == '__main__':
    unittest.main()
