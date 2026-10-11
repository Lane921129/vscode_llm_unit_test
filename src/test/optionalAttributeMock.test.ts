import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { pythonToolPath } from '../pipeline/pythonTools';
import { buildWriterRevisionContext } from '../prompts/compactWriterContext';
import { formatDependencyMockContract, OPTIONAL_ATTRIBUTE_MOCK_GUIDANCE } from '../prompts/dependencyMockContract';
import { getBugFixerSystemPrompt, getBugFixerUserPrompt } from '../roles/bugFixer';
import { getUserPrompt } from '../roles/unittestWriter';
import { generatedUnittestArguments, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

const targetSource = "def is_enabled():\n    return getattr(settings, 'enabled', False)\n";
const context = { name: 'is_enabled', code: targetSource, args: [], signature: [], method_kind: 'module',
    calls: ['getattr'], file_imports: [{ kind: 'from', module: 'types', name: 'SimpleNamespace' }],
    referenced_globals: [{ name: 'settings', code: 'settings = SimpleNamespace()' }] };
const sourceHash = createHash('sha256').update(targetSource).digest('hex');
const evidence: WriterEvidenceBundleV3 = {
    schemaVersion: 'writer-evidence-v3', sourceHash, semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash, ids: [], selectedRules: [],
        guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance']
};
const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));

function candidate(existing: boolean, create: boolean): string {
    return 'import unittest\nfrom unittest.mock import patch\nimport sample\nfrom sample import is_enabled\n'
        + 'class Cases(unittest.TestCase):\n    def test_optional_setting(self):\n'
        + `        self.assertIs(hasattr(sample.settings, 'enabled'), ${existing ? 'True' : 'False'})\n`
        + '        self.assertIs(is_enabled(), False)\n'
        + `        with patch.object(sample.settings, 'enabled', True${create ? ', create=True' : ''}):\n`
        + '            self.assertIs(is_enabled(), True)\n'
        + `        self.assertIs(hasattr(sample.settings, 'enabled'), ${existing ? 'True' : 'False'})\n`
        + '        self.assertIs(is_enabled(), False)\n'
        + (existing ? '        self.assertIs(sample.settings.enabled, False)\n' : '');
}

function bindings(code: string, source: string, target = 'is_enabled', className?: string) {
    const checked = spawnSync(python, ['-B', pythonToolPath('bindings'), '--payload'], {
        encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        input: JSON.stringify({ code, context: { module: 'sample', target, className, source,
            dependencies: {}, targetUsage: 'call', requireTargetBehavior: true } })
    });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    return JSON.parse(checked.stdout) as { valid: boolean; reason?: string };
}

function execute(directory: string, code: string) {
    fs.writeFileSync(path.join(directory, 'generated.py'), code);
    return spawnSync(python, generatedUnittestArguments('generated', directory, false, true), {
        cwd: directory, encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
}

test('optional-attribute setup guidance reaches complete Writer generation/revision and focused repair without inventing a patch path', () => {
    const failed = candidate(false, false);
    const failure = 'ERROR: test_optional_setting (generated.Cases.test_optional_setting)\n'
        + "AttributeError: object does not have the attribute 'enabled'";
    const prompts = [
        ...(['small', 'large'] as const).map(strategy =>
            getUserPrompt('sample.py', 'is_enabled', targetSource, strategy, context, undefined, 4000, '', evidence)),
        buildWriterRevisionContext({ module: 'sample', name: 'is_enabled', source: targetSource, context, evidence }),
        getBugFixerSystemPrompt() + '\n' + getBugFixerUserPrompt(failed, failure, 'is_enabled', [], targetSource, context, 'sample')
    ];
    for (const prompt of prompts) {
        assert.ok(prompt.includes(targetSource.trim()), 'retain the actual optional lookup beside the conditional guidance');
        assert.ok(prompt.includes(OPTIONAL_ATTRIBUTE_MOCK_GUIDANCE));
        assert.match(prompt, /only for that exact non-target use point/);
        assert.match(prompt, /retain the absent\/default case/);
        assert.match(prompt, /restore the original owner and attribute existence\/value/);
        assert.match(prompt, /Do not invent APIs, patch the target\/class, hide target AttributeError/);
        assert.match(prompt, /__file__ belong to the target module, not the generated test/);
        assert.match(prompt, /never run test-side Path\.resolve\(\) or file operations to compute expected values/);
        assert.doesNotMatch(prompt, /patch\.object\(sample, ['"]enabled['"]/);
    }
    for (const includeTopology of [false, true]) {
        assert.ok(formatDependencyMockContract('sample', context, undefined, includeTopology).includes(OPTIONAL_ATTRIBUTE_MOCK_GUIDANCE));
    }
    assert.equal(formatDependencyMockContract('sample', {}), '', 'unknown setup does not become a fabricated lookup');
    const location = formatDependencyMockContract('sample', { code: 'def locate():\n    return Path(__file__).parent', calls: ['Path'] });
    assert.ok(location.includes(OPTIONAL_ATTRIBUTE_MOCK_GUIDANCE), 'source-location targets receive the conditional setup guidance');
    const pure = formatDependencyMockContract('sample', { code: 'def render(value):\n    return str(value)', calls: ['str'] });
    assert.ok(!pure.includes(OPTIONAL_ATTRIBUTE_MOCK_GUIDANCE), 'unrelated targets retain room for required evidence and repair');
});

test('real guarded optional-attribute tests fail without create then pass while restoring absence and existing values', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'optional-attribute-'));
    try {
        for (const existing of [false, true]) {
            const source = 'from types import SimpleNamespace\n'
                + `settings = SimpleNamespace(${existing ? 'enabled=False' : ''})\n` + targetSource;
            const sourceFile = path.join(directory, 'sample.py');
            fs.writeFileSync(sourceFile, source);
            if (!existing) {
                const failed = execute(directory, candidate(false, false));
                assert.notEqual(failed.status, 0);
                assert.match(failed.stderr, /Ran 1 test/);
                assert.match(failed.stderr, /^AttributeError:.*does not have the attribute 'enabled'/m);
            }
            const corrected = candidate(existing, true);
            const structure = validateUnittestStructure(corrected, 'is_enabled', 'sample', 'call', [], undefined, true);
            assert.equal(structure.valid, true, structure.reason);
            const checked = bindings(corrected, source);
            assert.equal(checked.valid, true, checked.reason);
            const result = execute(directory, corrected);
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.match(result.stderr, /Ran 1 test/);
            assert.match(result.stderr, /\bOK\b/);
            assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('create=True cannot bypass the existing target and owner-class patch prohibitions', () => {
    const prefix = 'import unittest\nfrom unittest.mock import patch\nimport sample\n';
    const targetPatch = prefix + 'class Cases(unittest.TestCase):\n    def test_target(self):\n'
        + "        with patch.object(sample, 'is_enabled', return_value=True, create=True):\n"
        + '            self.assertIs(sample.is_enabled(), True)\n';
    const targetResult = bindings(targetPatch, targetSource);
    assert.equal(targetResult.valid, false);
    assert.match(targetResult.reason || '', /Do not mock or replace the selected target or its class/);
    const classSource = 'class Flags:\n    @staticmethod\n    def is_enabled():\n        return False\n';
    const ownerPatch = prefix + 'class Cases(unittest.TestCase):\n    def test_target(self):\n'
        + "        with patch.object(sample, 'Flags', create=True) as owner:\n"
        + '            owner.is_enabled.return_value = True\n            self.assertIs(sample.Flags.is_enabled(), True)\n';
    const classResult = bindings(ownerPatch, classSource, 'is_enabled', 'Flags');
    assert.equal(classResult.valid, false);
    assert.match(classResult.reason || '', /Do not mock or replace the selected target or its class/);
});

test('guarded source-location mock uses the target module file and restores its original Path binding', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-location-'));
    const source = 'from pathlib import Path\ndef locate():\n    return Path(__file__).resolve().parent\n';
    const sourceFile = path.join(directory, 'sample.py');
    const locationCandidate = (correctOwner: boolean) =>
        'import unittest\nfrom unittest.mock import patch\nfrom pathlib import Path as RealPath\n'
        + 'import sample\nfrom sample import locate\n'
        + 'class Cases(unittest.TestCase):\n'
        + '    def tearDown(self):\n        self.assertIs(sample.Path, RealPath)\n'
        + '    def test_location(self):\n'
        + '        self.assertIs(sample.Path, RealPath)\n'
        + "        with patch('sample.Path') as path_factory:\n"
        + "            path_factory.return_value.resolve.return_value.parent = 'controlled-directory'\n"
        + "            self.assertEqual(locate(), 'controlled-directory')\n"
        + `            path_factory.assert_called_once_with(${correctOwner ? 'sample.__file__' : '__file__'})\n`
        + '            path_factory.return_value.resolve.assert_called_once_with()\n'
        + '        self.assertIs(sample.Path, RealPath)\n';
    try {
        fs.writeFileSync(sourceFile, source);
        const failed = execute(directory, locationCandidate(false));
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, /Ran 1 test/);
        assert.match(failed.stderr, /^AssertionError: expected call not found\./m);
        assert.match(failed.stderr, /FAILED \(failures=1\)/, 'only the wrong source-location assertion fails; tearDown restores the owner');
        const corrected = locationCandidate(true);
        const structure = validateUnittestStructure(corrected, 'locate', 'sample', 'call', [], undefined, true);
        assert.equal(structure.valid, true, structure.reason);
        const checked = bindings(corrected, source, 'locate');
        assert.equal(checked.valid, true, checked.reason);
        const result = execute(directory, corrected);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, /Ran 1 test/);
        assert.match(result.stderr, /\bOK\b/);
        assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
