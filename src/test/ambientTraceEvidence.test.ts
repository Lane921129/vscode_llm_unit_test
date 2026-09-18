import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTier1TestFile } from '../tier/tier1TestFileBuilder';
import { canUseDeterministicTierOne } from '../tier/tierRouter';
import { exceptionNamesFromEvidence } from '../validation/exceptionEvidence';
import { validateUnittestStructure } from '../validation/generatedTestValidator';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';
import { getUserPrompt } from '../roles/unittestWriter';

test('executed clock and random observations never produce fixed Trace baseline or exception oracles; controlled mocks still execute', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-evidence-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    try {
        const file = path.join(directory, 'sample.py');
        for (const source of [
            'from datetime import datetime\ndef target(): return datetime.now().isoformat()\n',
            'import random\ndef target(): return random.random()\n',
            'import time\ndef target():\n    if time.time(): raise ValueError("clock")\n'
        ]) {
            fs.writeFileSync(file, source);
            const traced = spawnSync(python, ['-B', pythonToolPath('trace'), file, 'target', '[[]]'], { encoding: 'utf8', timeout: 15000 });
            assert.equal(traced.status, 0, traced.stderr);
            const facts = JSON.parse(traced.stdout);
            assert.ok(facts.examples.length + facts.errors.length > 0);
            assert.equal(canUseDeterministicTierOne(facts), false);
            assert.deepEqual(exceptionNamesFromEvidence({ traceResult: facts }), []);
            assert.equal(buildTier1TestFile({ moduleName: 'sample', functionName: 'target', examples: facts.examples, errors: facts.errors }).code, undefined);
            const prompt = getUserPrompt('sample.py', 'target', source, 'large', { code: source, args: [], traceResult: facts });
            assert.match(prompt, /UNCONTROLLED AMBIENT READS/);
            assert.doesNotMatch(prompt, /=> Returns:|=> Raises:/);
        }
        fs.writeFileSync(file, 'from datetime import datetime\ndef target(): return datetime.now().isoformat()\n');
        const code = `import unittest
from datetime import datetime
from unittest.mock import patch
from sample import target
class Cases(unittest.TestCase):
    def test_fixed_clock(self):
        with patch('sample.datetime') as clock:
            clock.now.return_value = datetime(2001, 2, 3, 4, 5, 6)
            self.assertEqual(target(), '2001-02-03T04:05:06')
            clock.now.assert_called_once_with()
`;
        assert.equal(validateUnittestStructure(code, 'target', 'sample').valid, true);
        fs.writeFileSync(path.join(directory, 'controlled_test.py'), code);
        const executed = spawnSync(python, ['-B', '-m', 'unittest', 'controlled_test'], { cwd: directory, encoding: 'utf8', timeout: 10000 });
        assert.equal(executed.status, 0, executed.stdout + executed.stderr);
        assert.match(executed.stderr, /Ran 1 test/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
