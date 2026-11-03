import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dynamic_tracer import TraceSafetyError, import_diagnostic
from runtime_policy import guarded_runtime


class ResourceDiagnosticTests(unittest.TestCase):
    def test_blocked_read_identifies_resource_and_source_without_source_literal(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = str(Path(directory, 'housefun_scraper.py'))
            code = compile('open("C:/not-an-approved-resource/password=never-copy-this.txt")', filename, 'exec')
            try:
                with guarded_runtime(error_type=TraceSafetyError):
                    exec(code, {})
            except TraceSafetyError as error:
                diagnostic = import_diagnostic(error, directory)
            else:
                self.fail('read must be blocked before accessing a resource')
            self.assertEqual(diagnostic['origin'], {'file': 'housefun_scraper.py', 'line': 1})
            self.assertEqual(diagnostic['resource']['fixtureType'], 'text')
            self.assertRegex(diagnostic['resource']['id'], '^resource-[a-f0-9]{16}$')
            self.assertNotIn('never-copy-this', json.dumps(diagnostic))
            self.assertNotIn('password=', json.dumps(diagnostic))


if __name__ == '__main__':
    unittest.main()
