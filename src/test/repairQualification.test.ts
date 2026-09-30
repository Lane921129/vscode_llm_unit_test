import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { runRoleQualificationProbes } from '../llm/roleQualification';
import { runIsolatedProbe } from '../llm/modelProbeExecution';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const reply = (body: string) => '```python\ndef test_increment(self):\n    ' + body + '\n```';
const qualify = (raw: string, executor: (code: string) => Promise<boolean>) => runRoleQualificationProbes(
    { state: 'verified', reason: 'fixture' }, async (_prompt, format) => format === 'json' ? '{"findings":[]}' : raw, executor);

test('repair qualification requires the actual corrected case to execute in the selected Python', async () => {
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    let executions = 0;
    const result = await qualify(reply('self.assertEqual(increment(1), 2)'), async code => {
        executions++;
        return runIsolatedProbe(code, 5000, python);
    });
    assert.equal(result.bugFixer.state, 'verified');
    assert.equal(executions, 1);
    assert.equal((await qualify(reply('self.assertEqual(increment(1), 2)'), async () => false)).bugFixer.state, 'unverified');
});

test('no-op, weakened, changed-input, self-derived and out-of-scope probes cannot be qualified', async () => {
    for (const body of ['self.assertEqual(increment(1), 3)', 'self.assertEqual(2, 2)',
        'self.assertEqual(increment(-1), 0)', 'self.assertEqual(increment(1), increment(1))',
        'self.skipTest("skip")', 'increment = lambda value: 2\n    self.assertEqual(increment(1), 2)']) {
        const result = await qualify(reply(body), async () => { throw Error('invalid probe must not execute'); });
        assert.equal(result.bugFixer.state, 'unverified', body);
    }
});
