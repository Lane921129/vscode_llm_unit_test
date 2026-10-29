import ast
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest

from ast_extractor import extract_info
from dependency_skill_facts import build_dependency_skill_facts


class DependencySkillFactsTests(unittest.TestCase):
    def facts(self, source, target='target'):
        tree = ast.parse(source)
        node = next(item for item in tree.body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == target)
        fragment = '\n'.join(source.splitlines()[node.lineno - 1:node.end_lineno])
        before = ast.dump(tree, include_attributes=True)
        result = build_dependency_skill_facts(node, fragment, target, tree)
        self.assertEqual(ast.dump(tree, include_attributes=True), before)
        self.assertFalse(result['assertionOracle'])
        self.assertFalse(result['patchAuthorization'])
        return result

    def test_orm_factory_argument_selects_library_without_importing_it(self):
        source = 'from sqlalchemy import create_engine as factory\nRESOURCE = factory("private")\nimport storage\ndef target():\n    storage.metadata.create_all(bind=RESOURCE)\n'
        facts = self.facts(source)
        self.assertIn({'name': 'RESOURCE', 'origin': 'sqlalchemy.create_engine', 'kind': 'factory-result', 'line': 2}, facts['bindings'])
        self.assertNotIn('private', json.dumps(facts))

    def test_client_factory_and_alias_preserve_original_module_origin(self):
        source = 'import httpx as transport\nCLIENT = transport.Client()\nALIAS = CLIENT\ndef target():\n    return ALIAS.get("/snapshot").json()\n'
        self.assertEqual(self.facts(source)['bindings'], [{'name': 'ALIAS', 'origin': 'httpx.Client', 'kind': 'factory-result', 'line': 3}])

    def test_unrelated_import_and_nested_scope_do_not_create_binding_facts(self):
        source = 'import sqlalchemy\nimport httpx\nCLIENT = httpx.Client()\ndef target():\n    def inner():\n        return CLIENT.get("/")\n    return 1\n'
        self.assertEqual(self.facts(source)['bindings'], [])

    def test_rebindings_dynamic_namespace_and_parameter_shadowing_stay_unknown(self):
        for source in (
            'import httpx\nCLIENT = httpx.Client()\nCLIENT = other\ndef target():\n    return CLIENT.get("/")\n',
            'import httpx\nCLIENT = httpx.Client()\ndef target(CLIENT):\n    return CLIENT.get("/")\n',
            'import httpx\nCLIENT = httpx.Client()\ndef target():\n    CLIENT = other\n    return CLIENT.get("/")\n',
            'import httpx\nCLIENT = httpx.Client()\ndef mutate():\n    global CLIENT\n    CLIENT = other\ndef target():\n    return CLIENT.get("/")\n',
            'import httpx\nCLIENT = httpx.Client()\nglobals()["CLIENT"] = other\ndef target():\n    return CLIENT.get("/")\n',
            'import httpx\nCLIENT = httpx.Client()\nCLIENT.get = other\ndef target():\n    return CLIENT.get("/")\n',
            'from httpx import *\ndef target():\n    return get("/")\n',
        ):
            with self.subTest(source=source):
                self.assertEqual(self.facts(source)['bindings'], [])

    def test_cycle_depth_and_relative_import_are_not_guessed(self):
        for setup in ('A = B\nB = A', 'from .transport import CLIENT\nA = CLIENT',
                      'import httpx\nA = httpx.Client()\n' + '\n'.join(f'A{i} = ' + ('A' if i == 0 else f'A{i-1}') for i in range(10))):
            name = 'A9' if 'A9' in setup else 'A'
            self.assertEqual(self.facts(setup + f'\ndef target():\n    return {name}.get("/")\n')['bindings'], [])

    def test_real_extractor_delivers_source_bound_facts(self):
        source = 'import urllib.request as transport\nCLIENT = transport.build_opener()\ndef target():\n    return CLIENT.open("/")\n'
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'source.py'
            file.write_text(source, encoding='utf-8')
            output = io.StringIO()
            with redirect_stdout(output):
                extract_info(str(file), 'target')
            context = json.loads(output.getvalue())
        self.assertEqual(context['dependency_skill_facts']['targetSourceHash'], context['source_location']['sourceHash'])
        self.assertEqual(context['dependency_skill_facts']['bindings'][0]['origin'], 'urllib.request.build_opener')


if __name__ == '__main__':
    unittest.main()
