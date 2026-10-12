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
from ast_extractor import extract_info
from source_setup_call_contract import build_source_setup_call_contract


class SourceSetupCallContractTests(unittest.TestCase):
    def contract(self, source, name='target'):
        tree = ast.parse(source)
        selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name][0]
        fragment = '\n'.join(source.splitlines()[selected.lineno - 1:selected.end_lineno])
        before = ast.dump(tree, include_attributes=True)
        result = build_source_setup_call_contract(selected, fragment, name, tree)
        self.assertEqual(ast.dump(tree, include_attributes=True), before)
        self.assertEqual(result['targetSourceHash'], hashlib.sha256(fragment.encode()).hexdigest())
        self.assertFalse(result['assertionOracle'])
        self.assertFalse(result['patchAuthorization'])
        return result

    def test_optional_getattr_in_branch_records_real_owner_literal_and_default(self):
        source = 'import runtime as rt\nfrom pathlib import Path\ndef target():\n    if getattr(rt, "packaged", False):\n        return Path(rt.executable).resolve().parent\n    return Path(__file__).resolve().parent\n'
        result = self.contract(source)
        self.assertEqual(result['optionalLookups'], [{'owner': 'rt', 'ownerScope': 'module-global',
                                                     'attribute': 'packaged', 'defaultSource': 'False',
                                                     'source': "getattr(rt, 'packaged', False)", 'line': 4}])
        self.assertEqual(result['sourceLocations'], ['__file__'])
        self.assertEqual([call['args'] for call in result['calls']],
                         [[{'source': 'rt.executable', 'scope': 'module-global'}],
                          [{'source': '__file__', 'scope': 'module-global'}]])

    def test_dependency_arguments_keep_exact_binding_and_keyword_scope(self):
        result = self.contract('import storage\nLOCATION = "neutral"\nNAME = str(LOCATION)\ndef target(limit):\n    return storage.open(NAME, limit, mode="memory")\n')
        self.assertEqual(result['calls'], [{'callee': 'storage.open',
                                            'args': [{'source': 'NAME', 'scope': 'module-global'},
                                                     {'source': 'limit', 'scope': 'parameter'}],
                                            'keywords': [{'name': 'mode', 'source': "'memory'", 'scope': 'literal'}], 'line': 5}])
        self.assertNotIn('expected', json.dumps(result))
        self.assertNotIn('str(LOCATION)', json.dumps(result), 'conversion is not evaluated or copied into an output oracle')

    def test_local_global_and_nonlocal_shadowing_never_grant_module_argument_scope(self):
        for body in ('NAME = "local"\n    return storage.open(NAME)',
                     'global NAME\n    return storage.open(NAME)',
                     'return storage.open(NAME)',):
            parameters = 'NAME' if body.startswith('return') else ''
            result = self.contract('import storage\nNAME = "global"\ndef target(' + parameters + '):\n    ' + body + '\n')
            self.assertNotEqual(result['calls'][0]['args'][0]['scope'], 'module-global')

    def test_rebound_owner_shadowed_getattr_and_unknown_attribute_do_not_grant_create(self):
        sources = [
            'import runtime\nruntime = object()\ndef target():\n    return getattr(runtime, "enabled", False)\n',
            'import runtime\ndef target(runtime):\n    return getattr(runtime, "enabled", False)\n',
            'import runtime\ngetattr = custom\ndef target():\n    return getattr(runtime, "enabled", False)\n',
            'import runtime\ndef target(getattr):\n    return getattr(runtime, "enabled", False)\n',
            'import runtime\ndef target(name):\n    return getattr(runtime, name, False)\n',
            'import runtime\ndef target():\n    return getattr(runtime, "enabled")\n',
            'import runtime\ndef target():\n    runtime.enabled = False\n    return getattr(runtime, "enabled", False)\n',
            'import runtime, other as runtime\ndef target():\n    return getattr(runtime, "enabled", False)\n',
            'import runtime\nfrom unknown import *\ndef target():\n    return getattr(runtime, "enabled", False)\n',
            'import runtime\ndef change():\n    global runtime\n    runtime = replacement\ndef target():\n    return getattr(runtime, "enabled", False)\n',
            'import runtime\ndef target():\n    globals()["runtime"] = replacement\n    return getattr(runtime, "enabled", False)\n',
        ]
        for source in sources:
            with self.subTest(source=source):
                self.assertEqual(self.contract(source)['optionalLookups'], [])

    def test_nested_scopes_and_comprehensions_do_not_create_call_facts(self):
        result = self.contract('import storage\nNAME = "neutral"\ndef target():\n    def nested():\n        return storage.open(NAME)\n    return [storage.open(NAME) for NAME in values]\n')
        self.assertEqual(result['calls'], [])
        self.assertEqual(result['optionalLookups'], [])

    def test_argument_expression_is_spelling_only_unknown_without_execution(self):
        result = self.contract('import storage\nPATH = "neutral"\ndef target():\n    return storage.open(str(PATH), **options)\n')
        self.assertEqual(result['calls'][0]['args'], [{'source': 'str(PATH)', 'scope': 'unknown'}])
        self.assertEqual(result['calls'][0]['keywords'], [{'name': None, 'source': 'options', 'scope': 'unknown'}])

    def test_fact_or_byte_overflow_clears_whole_contract_without_slicing(self):
        for source in ('import storage\ndef target():\n' + '    storage.open("neutral")\n' * 65,
                       'import storage\ndef target():\n    return storage.open(' + repr('x' * 17000) + ')\n'):
            result = self.contract(source)
            self.assertEqual(result['status'], 'unsupported')
            self.assertEqual(result['reason'], 'contract-limit-exceeded')
            self.assertEqual(result['calls'], [])
            self.assertEqual(result['optionalLookups'], [])
            self.assertEqual(result['sourceLocations'], [])

    def test_mismatched_fragment_or_independent_ast_is_not_source_proof(self):
        source = 'def target():\n    return 1\n'
        tree = ast.parse(source)
        self.assertEqual(build_source_setup_call_contract(tree.body[0], source.replace('1', '2'), 'target', tree)['status'], 'unsupported')
        self.assertEqual(build_source_setup_call_contract(ast.parse(source).body[0], source, 'target', tree)['status'], 'unsupported')
        self.assertEqual(build_source_setup_call_contract(tree.body[0], source, 'other', tree)['status'], 'unsupported')

    def test_qualified_owner_is_exact_and_never_becomes_a_fixture_patch_root(self):
        source = 'import runtime\nclass Owner:\n    @staticmethod\n    def target():\n        return getattr(runtime, "enabled", False)\ndef target():\n    return 1\n'
        tree = ast.parse(source)
        method = tree.body[1].body[0]
        fragment = '\n'.join(line[4:] for line in source.splitlines()[method.lineno - 1:method.end_lineno])
        result = build_source_setup_call_contract(method, fragment, 'Owner.target', tree)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['target'], 'Owner.target')
        self.assertEqual(result['optionalLookups'][0]['owner'], 'runtime')
        self.assertEqual(build_source_setup_call_contract(tree.body[2], 'def target():\n    return 1', 'Owner.target', tree)['status'], 'unsupported')

    def test_extractor_indented_method_keeps_multiline_literal_and_raw_fragment_hash(self):
        source = 'import runtime\nclass Owner:\n    @staticmethod\n    def target():\n        """Keep\n        indented docstring\n        """\n        return getattr(runtime, "enabled", False)\n'
        with tempfile.TemporaryDirectory(prefix='source-call-method-') as directory:
            file = Path(directory) / 'neutral.py'
            file.write_text(source, encoding='utf-8')
            output = io.StringIO()
            with redirect_stdout(output):
                extract_info(str(file), 'Owner.target')
            result = json.loads(output.getvalue())
            contract = result['source_setup_call_contract']
            self.assertEqual(contract['status'], 'complete')
            self.assertTrue(result['code'].startswith('    def target'))
            self.assertEqual(contract['targetSourceHash'], hashlib.sha256(result['code'].encode()).hexdigest())
            self.assertEqual(contract['optionalLookups'][0]['owner'], 'runtime')

    def test_extractor_wires_source_bound_metadata_without_importing_application(self):
        source = 'import runtime\nraise RuntimeError("do not import")\ndef target():\n    return getattr(runtime, "enabled", False)\n'
        with tempfile.TemporaryDirectory(prefix='source-call-contract-') as directory:
            file = Path(directory) / 'neutral.py'
            file.write_text(source, encoding='utf-8')
            output = io.StringIO()
            with redirect_stdout(output):
                extract_info(str(file), 'target')
            result = json.loads(output.getvalue())
            self.assertEqual(result['source_setup_call_contract']['optionalLookups'][0]['owner'], 'runtime')
            self.assertEqual(result['source_setup_call_contract']['targetSourceHash'], hashlib.sha256(result['code'].encode()).hexdigest())
            self.assertEqual(file.read_text(encoding='utf-8'), source)


if __name__ == '__main__':
    unittest.main()
