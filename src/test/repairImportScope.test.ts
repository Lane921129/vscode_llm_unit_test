import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeBugFixReplacementDetailed } from '../roles/bugFixer';
import { pythonToolPath } from '../pipeline/pythonTools';
import { validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { generatedUnittestArguments, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

const root = path.resolve(__dirname, '../..');
const python = resolvePythonExecutable(undefined, root);
const original = 'import unittest\nfrom unittest.mock import patch, MagicMock\nfrom sample import target\n'
    + 'class Cases(unittest.TestCase):\n    def setUp(self):\n        self.value = 2\n'
    + '    def test_value(self):\n        self.assertEqual(target(self.value), 999)\n'
    + '    def test_keep(self):\n        self.assertEqual(target(0), 1)\n';
const method = 'def test_value(self):\n    self.assertEqual(target(self.value), 3)';
const failure = 'FAIL: test_value (Cases.test_value)\nAssertionError: 3 != 999';
const fence = (body: string) => '```python\n' + body + '\n```';

function scope(candidate: string, previous = original): { valid: boolean; reasonCode: string | null } {
    const run = spawnSync(python, ['-B', pythonToolPath('repairScope')], { encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ previous, candidate, failure }) });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
}

test('four raw existing imports normalize as zero new imports in native and legacy repairs', () => {
    const imports = ['import unittest', 'from sample import target', 'import unittest', 'from sample import target'];
    for (const response of [fence(imports.join('\n') + '\n' + method),
        JSON.stringify({ method: 'test_value', replacement: method, imports }),
        fence(imports.join('\n') + '\nclass Cases(unittest.TestCase):\n'
            + method.split('\n').map(line => '    ' + line).join('\n'))]) {
        const merged = mergeBugFixReplacementDetailed(response, original, failure);
        assert.equal(merged.code, original.trimEnd().replace('999', '3'));
        assert.equal(scope(merged.code!).valid, true);
    }
});

test('Python AST recognizes equivalent split imports instead of counting four raw lines', () => {
    const imports = ['from unittest.mock import patch', 'from unittest.mock import MagicMock',
        'import   unittest', 'from sample import target'];
    const merged = mergeBugFixReplacementDetailed(fence(imports.join('\n') + '\n' + method), original, failure);
    assert.ok(merged.code);
    assert.equal(scope(merged.code).valid, true);
});

test('four new import statements are rejected by the mandatory AST gate before execution', async () => {
    const response = fence('import os\nimport sys\nimport decimal\nimport fractions\n' + method);
    const merged = mergeBugFixReplacementDetailed(response, original, failure);
    assert.ok(merged.code, 'packaging is parseable; only AST knows which imports are new');
    assert.equal(scope(merged.code).reasonCode, 'import-limit');
    let executions = 0;
    const rejections: unknown[] = [];
    await assert.rejects(validateTestCandidate(original, {
        validate: async () => undefined, review: async () => ({ issues: [] }),
        revise: async () => merged.code!,
        validateRevision: async (previous, candidate) => {
            const checked = scope(candidate, previous);
            return checked.valid ? undefined : { reason: 'Too many new import statements', reasonCode: checked.reasonCode! };
        },
        execute: async code => {
            executions++;
            assert.equal(code, original, 'the refused candidate must never execute');
            return { ok: false, out: failure, qualityGaps: [] };
        },
        event: (_stage, status, detail) => { if (status === 'scope-rejected') { rejections.push(detail); } },
        checkCancelled: () => {}
    }, 1), /修訂上限/);
    assert.equal(executions, 1);
    assert.equal(rejections.length, 1);
});

test('duplicate new imports stay one binding, while conflicting aliases remain rejected', () => {
    const repeated = mergeBugFixReplacementDetailed(fence('import math as numbers\n'.repeat(4) + method), original, failure);
    assert.equal(repeated.code?.match(/^import math as numbers$/gm)?.length, 1);
    assert.equal(scope(repeated.code!).valid, true);
    for (const imports of ['import math as target', 'from unittest.mock import *',
        'import math as extra\nimport decimal as extra']) {
        const result = mergeBugFixReplacementDetailed(fence(imports + '\n' + method), original, failure);
        assert.ok(result.code);
        assert.equal(scope(result.code).reasonCode, imports.includes('*') ? 'import-star' : 'import-conflict');
    }
});

test('a local import in another method cannot be mistaken for an existing global import', () => {
    const previous = original.replace('    def test_keep(self):', '    def test_keep(self):\n        import math');
    const result = mergeBugFixReplacementDetailed(fence('import math\n' + method), previous, failure);
    assert.match(result.code!, /^import math$/m);
    assert.equal(scope(result.code!, previous).valid, true);
});

test('extra methods, fixture edits and executable import text are never wrapper normalization', () => {
    for (const wrapped of ['class Other(unittest.TestCase):\n', 'class Cases(unittest.TestCase):\n    value = 8\n',
        'class Cases(unittest.TestCase):\n    def test_other(self):\n        pass\n']) {
        assert.equal(mergeBugFixReplacementDetailed(fence('import unittest\n'.repeat(4)
            + wrapped + method.split('\n').map(line => '    ' + line).join('\n')), original, failure).code, undefined);
    }
    assert.equal(mergeBugFixReplacementDetailed(fence('import os; os.system("payload")\n' + method), original, failure).code, undefined);
    const executableBody = mergeBugFixReplacementDetailed(fence(method + '\n    eval("payload")'), original, failure).code!;
    assert.equal(validateUnittestStructure(executableBody, 'target', 'sample').valid, false,
        'the structure gate still rejects dynamic execution inside a parseable method');
});

test('accepted duplicate-import repair preserves fixtures and passing tests in real isolated execution', () => {
    const tempRoot = path.join(root, 'test', 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(tempRoot, 'repair-import-scope-'));
    try {
        const imports = ['from unittest.mock import patch', 'from unittest.mock import MagicMock',
            'import unittest', 'import unittest'];
        const result = mergeBugFixReplacementDetailed(fence(imports.join('\n') + '\n' + method), original, failure);
        assert.equal(scope(result.code!).valid, true);
        assert.equal(validateUnittestStructure(result.code!, 'target', 'sample').valid, true);
        fs.writeFileSync(path.join(directory, 'sample.py'), 'def target(value):\n    return value + 1\n');
        fs.writeFileSync(path.join(directory, 'generated.py'), result.code!);
        const run = spawnSync(python, generatedUnittestArguments('generated', directory, false, true), {
            cwd: directory, encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.match(run.stderr, /Ran 2 tests/);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), 'def target(value):\n    return value + 1\n');
    } finally {
        assert.ok(path.resolve(directory).startsWith(path.resolve(tempRoot) + path.sep));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
