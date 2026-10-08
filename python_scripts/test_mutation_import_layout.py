"""Mutation copies follow static target imports without inventing resource aliases."""
import builtins
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

from basic_mutation_runner import mutation_import_layout, prepare_trial_directory, run_mutation_trials, trial_environment


class MutationImportLayoutTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.container = self.base / 'container'
        self.root = self.container / 'project'
        self.root.mkdir(parents=True)
        for package in (self.container, self.root):
            (package / '__init__.py').write_text('', encoding='utf-8')
        self.output = self.base / 'output'
        self.output.mkdir()
        self.source = self.root / 'app.py'
        self.source_text = ('from pathlib import Path\nROOT=Path(__file__).resolve().parent\n'
            'INTERNAL=(ROOT/"container"/"Data"/"label.txt").read_text()\n'
            'EXTERNAL=(ROOT.parent/"Data"/"label.txt").read_text()\n'
            'def target(amount): return amount + len(INTERNAL) + len(EXTERNAL)\n')
        self.source.write_text(self.source_text, encoding='utf-8')
        self.test = self.output / 'test_app.py'
        self.write_test('from container.project.app import target')
        self.originals = []
        for directory in (self.root / 'container' / 'Data', self.container / 'Data'):
            directory.mkdir(parents=True)
            sentinel = directory / 'label.txt'
            sentinel.write_text('PRODUCTION-NOT-A-SEED', encoding='utf-8')
            self.originals.append(sentinel)
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.plan = {'schemaVersion': 'import-fixtures-v1', 'id': 'b' * 64, 'root': str(self.root), 'rules': [
            {'file': 'app.py', 'sourceHash': digest, 'resourceSourceHash': digest, 'resources': [
                {'path': 'container/Data', 'kind': 'directory'},
                {'path': 'container/Data/label.txt', 'kind': 'text', 'text': 'aa'},
                {'path': 'Data', 'scope': 'project-parent', 'kind': 'directory'},
                {'path': 'Data/label.txt', 'scope': 'project-parent', 'kind': 'text', 'text': 'b'}]}]}
        self.lease = self.base / 'lease'
        self.lease.mkdir()
        (self.lease / '.llm-unit-test-resource-lease.json').write_text(json.dumps({
            'schemaVersion': 'isolated-resource-lease-v1', 'ownerPid': os.getpid()}), encoding='utf-8')
        self.environment = {**os.environ, 'PYTHONPATH': os.pathsep.join([
            str(TOOLS), str(self.base), str(self.root), str(self.output)]),
            'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8',
            'LLM_UNIT_TEST_IMPORT_FIXTURES': json.dumps(self.plan),
            'LLM_UNIT_TEST_RESOURCE_LEASE': str(self.lease)}

    def write_test(self, imports):
        self.test.write_text('import unittest\n' + imports + '\nclass Cases(unittest.TestCase):\n'
            '    def test_value(self): self.assertEqual(target(4), 7)\n', encoding='utf-8')

    def tool(self, name, args, *, payload=None, environment=None, cwd=None):
        result = subprocess.run([sys.executable, '-B', str(TOOLS / name), *map(str, args)],
            env=environment or self.environment, cwd=cwd or self.output,
            input=json.dumps(payload) if payload is not None else None,
            capture_output=True, text=True, encoding='utf-8', timeout=50)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def assert_originals_preserved(self):
        self.assertEqual(self.source.read_text(encoding='utf-8'), self.source_text)
        for sentinel in self.originals:
            self.assertEqual(sentinel.read_text(encoding='utf-8'), 'PRODUCTION-NOT-A-SEED')
            self.assertEqual(sorted(item.name for item in sentinel.parent.iterdir()), ['label.txt'])
        self.assertEqual(sorted(item.name for item in self.lease.iterdir()), ['.llm-unit-test-resource-lease.json'])

    def assert_scored_mutation(self, engine='builtin'):
        tool, prefix = ('basic_mutation_runner.py', []) if engine == 'builtin' else ('external_mutation_runner.py', [engine])
        completed = self.tool(tool, [*prefix, self.source, self.test, 2, 10, 'target'])
        result = json.loads(completed.stdout)
        self.assertEqual(result['engine'], engine)
        self.assertTrue(result['baseline_passed'], result.get('baseline_output'))
        self.assertTrue(result['scoreAvailable'], result)
        self.assertGreater(result['counts']['killed'], 0)
        self.assertEqual(result['counts']['error'], 0)
        self.assertEqual(result['baselineImportFixtures']['id'], self.plan['id'])
        self.assert_originals_preserved()
        return result

    def refresh_plan(self):
        self.source.write_text(self.source_text, encoding='utf-8')
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.plan['rules'][0].update(sourceHash=digest, resourceSourceHash=digest)
        self.environment['LLM_UNIT_TEST_IMPORT_FIXTURES'] = json.dumps(self.plan)

    def test_package_only_resources_pass_preflight_runner_and_builtin_without_original_reads(self):
        preflight = self.tool('module_preflight.py', [], payload={'file': str(self.source),
            'module': 'container.project.app', 'sourceRoot': str(self.root),
            'importPaths': [str(self.base), str(self.root)]})
        self.assertTrue(json.loads(preflight.stdout)['ok'])
        self.tool('generated_test_runner.py', [self.test.stem])
        original_open = builtins.open
        protected = {os.path.normcase(os.path.abspath(file)) for file in self.originals}
        def guarded_open(file, *args, **kwargs):
            if isinstance(file, (str, bytes, os.PathLike)):
                self.assertNotIn(os.path.normcase(os.path.abspath(file)), protected,
                                 'mutation copy must not read original resource contents')
            return original_open(file, *args, **kwargs)
        with patch.dict(os.environ, self.environment), patch('builtins.open', side_effect=guarded_open):
            result = run_mutation_trials(self.source, self.test, max_mutations=2,
                timeout_seconds=10, target_function='target', workers=1)
        self.assertTrue(result['baseline_passed'], result.get('baseline_output'))
        self.assertTrue(result['scoreAvailable'], result)
        self.assertGreater(result['counts']['killed'], 0)
        self.assertEqual(result['counts']['error'], 0)
        self.assert_originals_preserved()

    def test_package_only_resources_use_real_mutatest(self):
        from external_mutation_runner import probe_engine
        if not probe_engine('mutatest')['supported']:
            self.skipTest('verified mutatest 3.1.0 AST API is not installed')
        self.assert_scored_mutation('mutatest')

    def test_bare_target_keeps_its_required_flat_copy(self):
        self.write_test('from app import target')
        self.assert_scored_mutation()

    def test_mixed_imports_keep_both_copies_and_still_reject_genuine_resource_alias_ambiguity(self):
        from isolated_resources import IsolatedResources
        self.write_test('from app import target\nfrom container.project.app import target as packaged')
        with self.test.open('a', encoding='utf-8') as stream:
            stream.write('    def test_packaged(self): self.assertEqual(packaged(4), 7)\n')
        self.tool('generated_test_runner.py', [self.test.stem])
        with patch.dict(os.environ, self.environment):
            trial = self.base / 'mixed_trial'
            copied_test = prepare_trial_directory(self.source, self.test, trial, self.source_text)
            self.assertTrue((trial / 'app.py').is_file())
            self.assertTrue((trial / 'container' / 'project' / 'app.py').is_file())
            environment = trial_environment(trial, self.source, copied_test)
            with self.assertRaisesRegex(ValueError, 'Ambiguous isolated resource mutation binding'):
                IsolatedResources(json.loads(environment['LLM_UNIT_TEST_IMPORT_FIXTURES']))
        for engine, tool, prefix in [('builtin', 'basic_mutation_runner.py', []),
                                     ('mutatest', 'external_mutation_runner.py', ['mutatest'])]:
            with self.subTest(engine=engine):
                if engine == 'mutatest':
                    from external_mutation_runner import probe_engine
                    if not probe_engine(engine)['supported']:
                        self.skipTest('verified mutatest 3.1.0 AST API is not installed')
                result = json.loads(self.tool(tool, [*prefix, self.source, self.test, 2, 10, 'target']).stdout)
                self.assertEqual(result['engine'], engine)
                self.assertFalse(result['baseline_passed'])
                self.assertEqual(result['baselineStatus'], 'error')
                self.assertFalse(result['scoreAvailable'])
                self.assertEqual(result['counts']['executed'], 0)
                self.assertEqual(result['counts']['killed'], 0)
        self.assert_originals_preserved()

    def test_nonambiguous_mixed_imports_mutate_both_required_targets(self):
        # A different logical directory avoids the real mixed-layout collision;
        # both imports must still see copies of every mutation, not the source.
        self.source_text = self.source_text.replace('ROOT/"container"', 'ROOT/"Local"')
        original_directory, renamed_directory = self.root / 'container', self.root / 'Local'
        self.assertEqual(original_directory.resolve().parent, self.root.resolve())
        self.assertEqual(renamed_directory.resolve().parent, self.root.resolve())
        original_directory.rename(renamed_directory)
        self.originals[0] = renamed_directory / 'Data' / 'label.txt'
        for spec in self.plan['rules'][0]['resources']:
            if not spec.get('scope'):
                spec['path'] = spec['path'].replace('container/', 'Local/', 1)
        self.refresh_plan()
        self.write_test('from app import target\nfrom container.project.app import target as packaged')
        with self.test.open('a', encoding='utf-8') as stream:
            stream.write('    def test_packaged(self): self.assertEqual(packaged(4), 7)\n')
        self.assert_scored_mutation()
        trial = self.base / 'mixed_trial'
        with patch.dict(os.environ, self.environment):
            copied_test = prepare_trial_directory(self.source, self.test, trial, self.source_text)
            environment = trial_environment(trial, self.source, copied_test)
        for copied_source in (trial / 'app.py', trial / 'container' / 'project' / 'app.py'):
            with self.subTest(copy=str(copied_source.relative_to(trial))):
                copied_source.write_text(self.source_text.replace(
                    'return amount + len(INTERNAL) + len(EXTERNAL)', 'return None'), encoding='utf-8')
                with patch.dict(os.environ, self.environment):
                    environment = trial_environment(trial, self.source, copied_test)
                completed = subprocess.run([sys.executable, '-B', str(TOOLS / 'generated_test_runner.py'),
                    copied_test.stem], env=environment, cwd=trial, capture_output=True, text=True,
                    encoding='utf-8', timeout=20)
                self.assertEqual(completed.returncode, 1, completed.stderr)
                self.assertIn('None != 7', completed.stderr)
                copied_source.write_text(self.source_text, encoding='utf-8')
        self.assert_originals_preserved()

    def test_package_copy_is_mutated_and_untracked_flat_file_creates_no_fixture_alias(self):
        trial = self.base / 'package_trial'
        with patch.dict(os.environ, self.environment):
            copied_test = prepare_trial_directory(self.source, self.test, trial, self.source_text)
            self.assertFalse((trial / 'app.py').exists())
            # A coincidental same-name file is not evidence that a rule belongs
            # to a copy. It must never reintroduce the old inferred alias.
            (trial / 'app.py').write_text(self.source_text, encoding='utf-8')
            environment = trial_environment(trial, self.source, copied_test)
        canonical = trial / 'container' / 'project' / 'app.py'
        rebased = json.loads(environment['LLM_UNIT_TEST_IMPORT_FIXTURES'])
        self.assertEqual([Path(rule['resolvedFile']) for rule in rebased['rules'] if rule.get('resolvedFile')], [canonical])
        self.tool('generated_test_runner.py', [copied_test.stem], cwd=trial, environment=environment)
        canonical.write_text(self.source_text.replace('return amount + len(INTERNAL) + len(EXTERNAL)',
                                                      'return None'), encoding='utf-8')
        with patch.dict(os.environ, self.environment):
            environment = trial_environment(trial, self.source, copied_test)
        completed = subprocess.run([sys.executable, '-B', str(TOOLS / 'generated_test_runner.py'), copied_test.stem],
            env=environment, cwd=trial, capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertIn('None != 7', completed.stderr)
        self.assert_originals_preserved()

    def assert_transitive_bare_import_uses_package_copy(self, through_helper):
        if through_helper:
            (self.root / 'helper.py').write_text('from app import target as exposed\n', encoding='utf-8')
            exposed_import = 'from container.project.helper import exposed'
        else:
            (self.root / '__init__.py').write_text('from app import target as exposed\n', encoding='utf-8')
            exposed_import = 'from container.project import exposed'
        self.test.write_text('import unittest\nfrom container.project.app import target\n' + exposed_import +
            '\nclass Cases(unittest.TestCase):\n'
            '    def test_type(self): self.assertIsInstance(target(4), int)\n'
            '    def test_exposed(self): self.assertEqual(exposed(4), 7)\n', encoding='utf-8')
        trial = self.base / 'transitive_trial'
        with patch.dict(os.environ, self.environment):
            copied_test = prepare_trial_directory(self.source, self.test, trial, self.source_text)
            environment = trial_environment(trial, self.source, copied_test)
        self.assertFalse((trial / 'app.py').exists(), 'transitive imports must not add an unused flat copy')
        canonical = trial / 'container' / 'project' / 'app.py'
        self.tool('generated_test_runner.py', [copied_test.stem], cwd=trial, environment=environment)
        # The direct test intentionally accepts this changed integer. Only the
        # transitive import can kill it; falling back to original app.py passes.
        canonical.write_text(self.source_text.replace('amount + len(INTERNAL)', 'amount - len(INTERNAL)'),
                             encoding='utf-8')
        with patch.dict(os.environ, self.environment):
            environment = trial_environment(trial, self.source, copied_test)
        completed = subprocess.run([sys.executable, '-B', str(TOOLS / 'generated_test_runner.py'), copied_test.stem],
            env=environment, cwd=trial, capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertIn('3 != 7', completed.stderr)
        self.assertIn('test_exposed', completed.stderr)
        self.assert_scored_mutation()

    def test_package_init_bare_target_import_uses_same_mutant_file(self):
        self.assert_transitive_bare_import_uses_package_copy(through_helper=False)

    def test_package_helper_bare_target_import_uses_same_mutant_file(self):
        self.assert_transitive_bare_import_uses_package_copy(through_helper=True)

    def test_nested_package_suffix_imports_use_same_mutant_at_every_depth(self):
        deep_base = self.base / 'nested'
        package = deep_base / 'outer' / 'middle' / 'pkg'
        package.mkdir(parents=True)
        for ancestor in (package, package.parent, package.parent.parent):
            (ancestor / '__init__.py').write_text('', encoding='utf-8')
        source = package / 'app.py'
        source_text = 'def target(value): return value + 1\n'
        source.write_text(source_text, encoding='utf-8')
        tests = deep_base / 'test_nested.py'
        environment = {**self.environment, 'PYTHONPATH': os.pathsep.join([
            str(deep_base), str(package), str(package.parent), str(package.parent.parent)])}
        environment.pop('LLM_UNIT_TEST_IMPORT_FIXTURES', None)
        environment.pop('LLM_UNIT_TEST_RESOURCE_LEASE', None)
        for index, (suffix, helper) in enumerate([
                ('app', False), ('pkg.app', False), ('middle.pkg.app', False),
                ('pkg.app', True), ('middle.pkg.app', True)]):
            with self.subTest(suffix=suffix, helper=helper):
                package_init = package / '__init__.py'
                package_init.write_text('' if helper else f'from {suffix} import target as exposed\n', encoding='utf-8')
                (package / 'helper.py').write_text(f'from {suffix} import target as exposed\n', encoding='utf-8')
                exposed_module = 'outer.middle.pkg.helper' if helper else 'outer.middle.pkg'
                tests.write_text('import unittest\nfrom outer.middle.pkg.app import target\n'
                    f'from {exposed_module} import exposed\nclass Cases(unittest.TestCase):\n'
                    '    def test_type(self): self.assertIsInstance(target(4), int)\n'
                    '    def test_exposed(self): self.assertEqual(exposed(4), 5)\n', encoding='utf-8')
                trial = deep_base / f'trial_{index}'
                with patch.dict(os.environ, environment, clear=True):
                    copied_test = prepare_trial_directory(source, tests, trial, source_text)
                    trial_env = trial_environment(trial, source, copied_test)
                canonical = trial / 'outer' / 'middle' / 'pkg' / 'app.py'
                self.assertFalse((trial / 'app.py').exists())
                self.assertEqual(trial_env['PYTHONPATH'].split(os.pathsep)[:4], [str(trial),
                    str(canonical.parent), str(canonical.parent.parent), str(canonical.parent.parent.parent)])
                self.tool('generated_test_runner.py', [copied_test.stem], cwd=trial, environment=trial_env)
                canonical.write_text(source_text.replace('value + 1', 'value - 1'), encoding='utf-8')
                completed = subprocess.run([sys.executable, '-B', str(TOOLS / 'generated_test_runner.py'), copied_test.stem],
                    env=trial_env, cwd=trial, capture_output=True, text=True, encoding='utf-8', timeout=20)
                self.assertEqual(completed.returncode, 1, completed.stderr)
                self.assertIn('3 != 5', completed.stderr)
                self.assertIn('test_exposed', completed.stderr)
                self.assertEqual(source.read_text(encoding='utf-8'), source_text)
        self.assert_originals_preserved()

    def test_dynamic_or_missing_target_binding_returns_structured_unscored_error(self):
        for imports in ('from container.project.app import target\nimport importlib\n'
                        'target = importlib.import_module("app").target',
                        'from importlib import import_module as load\ntarget = load("app").target',
                        'import importlib as loader\ntarget = loader.import_module("app").target',
                        'import builtins as core\ntarget = core.__import__("app").target',
                        'from container.project.app import target\ntarget = __import__("app").target',
                        'def target(amount): return 7',
                        'this is invalid syntax'):
            with self.subTest(imports=imports):
                self.write_test(imports)
                result = json.loads(self.tool('basic_mutation_runner.py', [self.source, self.test, 1, 10, 'target']).stdout)
                self.assertEqual(result['baselineStatus'], 'error')
                self.assertEqual(result['diagnosticCode'], 'mutation-trial-setup-failed')
                self.assertFalse(result['baseline_passed'])
                self.assertFalse(result['scoreAvailable'])
                self.assertEqual(result['counts']['executed'], 0)
                self.assertEqual(result['counts']['killed'], 0)
        self.assert_originals_preserved()

    def test_ordinary_target_and_method_named_import_module_keep_static_layout(self):
        self.source_text = ('def import_module(value): return value + 3\n'
                            'class Loader:\n    def import_module(self, value): return value + 3\n')
        self.refresh_plan()
        for imports in ('from app import import_module as target',
                        'import app as module\ntarget = module.import_module',
                        'from app import Loader\ntarget = Loader().import_module'):
            with self.subTest(imports=imports):
                self.write_test(imports)
                # Exercise actual calls too; method spelling alone is not
                # evidence of dynamic import semantics.
                text = self.test.read_text(encoding='utf-8')
                if 'as module' in imports:
                    text = text.replace('target(4)', 'module.import_module(4)')
                elif 'Loader' in imports:
                    text = text.replace('target(4)', 'Loader().import_module(4)')
                self.test.write_text(text, encoding='utf-8')
                layout = mutation_import_layout(self.source, self.test, self.base / 'trial')
                self.assertEqual(layout['targets'], [self.base / 'trial' / 'app.py'])
        self.assert_originals_preserved()

    def test_static_bare_and_package_alias_forms_select_only_required_copies(self):
        trial = self.base / 'trial'
        for imports, target in [
                ('import app as subject\ntarget = subject.target', trial / 'app.py'),
                ('from app import target', trial / 'app.py'),
                ('from container.project.app import target', trial / 'container' / 'project' / 'app.py'),
                ('from container.project import app as subject\ntarget = subject.target',
                 trial / 'container' / 'project' / 'app.py'),
                ('import container.project.app as subject\ntarget = subject.target',
                 trial / 'container' / 'project' / 'app.py')]:
            with self.subTest(imports=imports):
                self.write_test(imports)
                self.assertEqual(mutation_import_layout(self.source, self.test, trial)['targets'], [target])

    def test_copied_dependency_uses_explicit_binding_and_hash_mismatch_fails_closed(self):
        dependency = self.root / 'settings.py'
        dependency.write_text('VALUE = 2\n', encoding='utf-8')
        self.plan['rules'].append({'file': 'settings.py',
            'sourceHash': hashlib.sha256(dependency.read_bytes()).hexdigest(), 'mkdir': True})
        self.environment['LLM_UNIT_TEST_IMPORT_FIXTURES'] = json.dumps(self.plan)
        trial = self.base / 'dependency_trial'
        with patch.dict(os.environ, self.environment):
            copied_test = prepare_trial_directory(self.source, self.test, trial, self.source_text)
            environment = trial_environment(trial, self.source, copied_test)
            rebased = json.loads(environment['LLM_UNIT_TEST_IMPORT_FIXTURES'])
            copied_dependency = trial / 'container' / 'project' / 'settings.py'
            self.assertIn(str(copied_dependency), [rule.get('resolvedFile') for rule in rebased['rules']])
            copied_dependency.write_text('VALUE = 3\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Mutation fixture dependency changed'):
                trial_environment(trial, self.source, copied_test)
        self.assert_originals_preserved()


if __name__ == '__main__':
    unittest.main()
