import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildWriterRevisionContext } from '../prompts/compactWriterContext';
import { getUserPrompt } from '../roles/unittestWriter';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { generatedUnittestArguments, resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const source = 'def target():\n    return sqlite3.connect(DB_NAME)\n';
const context = { name: 'target', code: source, args: [], signature: [], method_kind: 'module', calls: ['sqlite3.connect'],
    file_imports: [{ kind: 'import', module: 'sqlite3', bound_name: 'sqlite3' },
        { kind: 'from', module: 'pathlib', name: 'Path', bound_name: 'Path' }],
    referenced_globals: [{ name: 'DB_PATH', code: 'DB_PATH = Path("neutral.db")' },
        { name: 'DB_NAME', code: 'DB_NAME = str(DB_PATH)' }],
    traceResult: { func_name: 'target', args: [], examples: [{ args: '()', result: '<non_assertable: FixtureConnection>',
        result_assertable: false, call_assertable: false }], errors: [] } };
const evidence: WriterEvidenceBundleV3 = { schemaVersion: 'writer-evidence-v3', sourceHash: 'neutral-setup-source', semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'neutral-setup-source', ids: [], selectedRules: [],
        guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance'] };

test('Writer retains the real global conversion and explains test-owned bindings without choosing an output', () => {
    const prompts = [getUserPrompt('sample.py', 'target', source, 'small', context, undefined, 5000, '', evidence),
        getUserPrompt('sample.py', 'target', source, 'large', context, undefined, 5000, '', evidence),
        buildWriterRevisionContext({ module: 'sample', name: 'target', source, context, evidence })];
    for (const prompt of prompts) {
        assert.ok(prompt.includes(source));
        assert.ok(prompt.includes('DB_NAME = str(DB_PATH)'));
        assert.match(prompt, /Source globals are not test globals/);
        assert.match(prompt, /str\(path\) is not the Path object/);
        assert.match(prompt, /Never use non_assertable diagnostic text or private tool classes/);
        assert.match(prompt, /source setup only, never an output oracle/);
    }
});

test('a neutral direct connection wrapper checks the converted argument and returned fixture under real guards', () => {
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-mock-setup-'));
    const moduleSource = 'from pathlib import Path\nimport sqlite3\nDB_PATH = Path("neutral.db")\nDB_NAME = str(DB_PATH)\n' + source;
    const candidate = 'import unittest\nfrom unittest.mock import patch\nimport sample\nclass Cases(unittest.TestCase):\n'
        + '    def test_target(self):\n        controlled = object()\n'
        + '        with patch("sample.sqlite3.connect", return_value=controlled) as connect_stub:\n'
        + '            self.assertIs(sample.target(), controlled)\n'
        + '            connect_stub.assert_called_once_with(sample.DB_NAME)\n';
    try {
        fs.writeFileSync(path.join(directory, 'sample.py'), moduleSource);
        const run = (code: string) => {
            fs.writeFileSync(path.join(directory, 'generated.py'), code);
            return spawnSync(python, generatedUnittestArguments('generated', directory, false, true), {
                cwd: directory, encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        };
        const wrong = run(candidate.replace('connect_stub.assert_called_once_with(sample.DB_NAME)',
            'connect_stub.assert_called_once_with(sample.DB_PATH)'));
        assert.notEqual(wrong.status, 0);
        assert.match(wrong.stderr, /AssertionError: expected call not found/);
        const correct = run(candidate);
        assert.equal(correct.status, 0, correct.stdout + correct.stderr);
        assert.match(correct.stderr, /Ran 1 test/);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), moduleSource);
        assert.equal(fs.existsSync(path.join(directory, 'neutral.db')), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
