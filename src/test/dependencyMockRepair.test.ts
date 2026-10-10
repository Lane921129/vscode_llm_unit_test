import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getBugFixerSystemPrompt, getBugFixerUserPrompt, mergeBugFixReplacementDetailed } from '../roles/bugFixer';
import { getExecutionWriterPrompt, getExecutionWriterSystemPrompt, getSystemPrompt, getTier3SystemPrompt, getUserPrompt } from '../roles/unittestWriter';
import { missingNameRepairGuidance } from '../prompts/dependencyMockContract';
import { buildCompactWriterContext } from '../prompts/compactWriterContext';
import { promptFits } from '../prompts/promptBudget';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { pythonToolPath } from '../pipeline/pythonTools';
import { generatedUnittestArguments, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

const root = path.resolve(__dirname, '../..');
const python = resolvePythonExecutable(undefined, root);
const source = 'from boundary import build as factory\ndef transform(value):\n    return factory(value).render()\n';
const context = { name: 'transform', args: ['value'], calls: ['factory(value).render', 'factory'],
    file_imports: [{ module: 'boundary', name: 'build', alias: 'factory' }] };
const evidence: WriterEvidenceBundleV3 = {
    schemaVersion: 'writer-evidence-v3', sourceHash: 'neutral-source', semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'neutral-source', ids: [], selectedRules: [],
        guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance']
};
const original = `import unittest
from unittest.mock import patch
from sample import transform
class Cases(unittest.TestCase):
    def test_transform(self):
        with patch('sample.factory', return_value='controlled') as factory:
            self.assertEqual(transform('input'), 'controlled')
            factory.assert_called_once_with('input')

    def test_keep(self):
        from unittest.mock import patch as replace
        with replace('sample.factory') as factory:
            factory.return_value.render.return_value = 'other'
            self.assertEqual(transform('other-input'), 'other')
`;
const correctedMethod = `def test_transform(self):
    from unittest.mock import patch
    with patch('sample.factory') as factory:
        factory.return_value.render.return_value = 'controlled'
        self.assertEqual(transform('input'), 'controlled')
        factory.assert_called_once_with('input')
        factory.return_value.render.assert_called_once_with()`;

function scope(previous: string, candidate: string, failure: string): { valid: boolean; reasonCode?: string } {
    const result = spawnSync(python, ['-B', pythonToolPath('repairScope')], {
        encoding: 'utf8', timeout: 10000, input: JSON.stringify({ previous, candidate, failure }) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test('Writer and repair contracts explain source-consumed return objects without choosing an oracle', () => {
    const compact = buildCompactWriterContext({ module: 'sample', name: 'transform', source, context,
        evidence, budgetTokens: 1800 });
    const prompts = [compact, getExecutionWriterSystemPrompt(), getTier3SystemPrompt(), getBugFixerSystemPrompt(),
        getUserPrompt('sample.py', 'transform', source, 'small', context),
        getUserPrompt('sample.py', 'transform', source, 'large', context)];
    for (const prompt of prompts) {
        assert.match(prompt, /Mock only source-shown receivers/);
        assert.match(prompt, /factory_mock\.return_value\.finish\.return_value/);
        assert.match(prompt, /A direct factory\(\.\.\.\) uses factory_mock\.return_value/);
        assert.match(prompt, /Never add layers or infer expected values/);
        assert.match(prompt, /target or other-method imports do not bind them/);
    }
    assert.ok(promptFits(getSystemPrompt(1, 'small'), compact, 1800), 'retain smallest existing input budget');
    assert.ok(compact.includes(source), 'preserve the complete source rather than slicing for the new rule');
});

test('execution Writer retains complete neutral evidence within the existing 2000-token budget', () => {
    const neutralSource = 'def transform(value):\n'
        + '    # Retained context describes the selected neutral source.\n'.repeat(79)
        + '    return value + 1\n';
    const completeEvidence = 'Target import: from sample import transform\nTarget source (read-only):\n' + neutralSource;
    const prompt = getExecutionWriterPrompt(completeEvidence);
    assert.ok(prompt.includes(completeEvidence), 'preserve source/evidence without clipping');
    assert.ok(promptFits(getExecutionWriterSystemPrompt(), prompt, 2000), 'mock guidance must not crowd out existing execution evidence');
    assert.match(getExecutionWriterSystemPrompt(), /EXECUTION_VERIFICATION_V1/);
    assert.match(getExecutionWriterSystemPrompt(), /For calculations without external operations, use the real target without mocks/);
    assert.match(getExecutionWriterSystemPrompt(), /hypotheses until executed/);
});

test('undefined-name repair diagnostics are bounded and do not guess imports or blame target source', () => {
    const failure = "ERROR: test_transform (Cases.test_transform)\nNameError: name 'patch' is not defined\n";
    const prompt = getBugFixerUserPrompt(original.replace('from unittest.mock import patch\n', ''), failure,
        'transform', ['value'], source, context, 'sample');
    assert.match(prompt, /undefined name "patch"/);
    assert.match(prompt, /Check the failing frame and binding scope first/);
    assert.match(prompt, /put the import inside the failing method/);
    assert.match(prompt, /at most 3 missing import statements/);
    assert.match(prompt, /do not .*repair target-source bindings/i);
    assert.match(prompt, /local imports stay in their original scope/);
    assert.match(prompt, /        from unittest.mock import patch as replace/);
    for (const output of ["AttributeError: 'str' object has no attribute 'render'", 'NameError: unresolved',
        "ValueError: name 'patch' is not defined", "NameError: name 'arbitrary package; payload' is not defined",
        `NameError: name '${'x'.repeat(81)}' is not defined`]) {
        assert.equal(missingNameRepairGuidance(output), '');
    }
    const targetFailure = missingNameRepairGuidance("NameError: name 'source_binding' is not defined");
    assert.match(targetFailure, /For a test-owned helper/);
    assert.doesNotMatch(targetFailure, /from source_binding|import source_binding/);
});

test('neutral scalar-return mock then missing-import failure is repaired by the model fragment through existing gates', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-mock-repair-'));
    try {
        fs.writeFileSync(path.join(directory, 'boundary.py'), "def build(value):\n    raise RuntimeError('boundary must be patched')\n");
        fs.writeFileSync(path.join(directory, 'sample.py'), source);
        const run = (code: string): { status: number | null; output: string } => {
            fs.writeFileSync(path.join(directory, 'generated.py'), code);
            const result = spawnSync(python, generatedUnittestArguments('generated', directory, false, true), {
                cwd: directory, encoding: 'utf8', timeout: 10000,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
            return { status: result.status, output: result.stdout + result.stderr };
        };
        const scalarFailure = run(original);
        assert.notEqual(scalarFailure.status, 0);
        assert.match(scalarFailure.output, /AttributeError: 'str' object has no attribute 'render'/);
        const omittedImport = original.replace('from unittest.mock import patch\n', '');
        const importFailure = run(omittedImport);
        assert.notEqual(importFailure.status, 0);
        assert.match(importFailure.output, /NameError: name 'patch' is not defined/);
        assert.match(importFailure.output, /test_keep .*\.\.\. ok/);

        // Adding only the missing module import still fails the unchanged scope
        // gate, and restoring that import alone still leaves the mock-shape bug.
        const importOnly = mergeBugFixReplacementDetailed('```python\nfrom unittest.mock import patch\n'
            + original.slice(original.indexOf('    def test_transform'), original.indexOf('    def test_keep')).trim()
            + '\n```', omittedImport, importFailure.output).code!;
        assert.ok(importOnly);
        assert.equal(scope(omittedImport, importOnly, importFailure.output).reasonCode, 'no-method-change');
        assert.match(run(importOnly).output, /AttributeError: 'str' object has no attribute 'render'/);

        const repaired = mergeBugFixReplacementDetailed('```python\n' + correctedMethod + '\n```', omittedImport, importFailure.output).code!;
        assert.ok(repaired);
        assert.equal(scope(omittedImport, repaired, importFailure.output).valid, true);
        assert.equal(validateUnittestStructure(repaired, 'transform', 'sample').valid, true);
        assert.ok(repaired.includes(original.slice(original.indexOf('    def test_keep')).trimEnd()));
        const fixed = run(repaired);
        assert.equal(fixed.status, 0, fixed.output);
        assert.match(fixed.output, /Ran 2 tests/);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), source);

        // A missing test import alone has a valid focused repair: a local
        // import changes only the failed method and keeps every assertion.
        const onlyImportMissing = repaired.replace(/^        from unittest.mock import patch\n/m, '');
        const onlyImportFailure = run(onlyImportMissing);
        assert.match(onlyImportFailure.output, /NameError: name 'patch' is not defined/);
        assert.equal(scope(onlyImportMissing, repaired, onlyImportFailure.output).valid, true);

        // The same rule must not add a return-object layer for flat sources.
        fs.writeFileSync(path.join(directory, 'sample.py'), source.replace('factory(value).render()', 'factory(value)'));
        const flat = original.slice(0, original.indexOf('    def test_keep'));
        assert.equal(run(flat).status, 0, 'a direct dependency return uses its own return_value');
        assert.notEqual(run(repaired).status, 0, 'an invented return-object layer does not satisfy a flat target');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('repair import guidance preserves parser limits and rejects unrelated method and binding changes', () => {
    const failure = 'ERROR: test_transform (Cases.test_transform)\nNameError: name \'patch\' is not defined';
    const tooMany = mergeBugFixReplacementDetailed('```python\nimport a\nimport b\nimport c\nimport d\n'
        + correctedMethod + '\n```', original, failure);
    assert.deepEqual(tooMany.diagnostic?.reasonCodes, ['import-limit']);
    const withThree = mergeBugFixReplacementDetailed('```python\nimport a\nimport b\nimport c\n'
        + correctedMethod + '\n```', original, failure);
    assert.ok(withThree.code, 'parsed maximum remains three');
    const repaired = mergeBugFixReplacementDetailed('```python\n' + correctedMethod + '\n```', original, failure).code!;
    assert.equal(scope(original, repaired.replace("transform('other-input'), 'other'", "transform('other-input'), 'changed'"), failure).reasonCode,
        'unrelated-method-change');
    assert.equal(scope(original, 'from boundary import build as transform\n' + repaired, failure).reasonCode, 'import-conflict');
});

test('private target and aliased connection use points execute only with explicit imports and source-shaped mocks', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-use-site-'));
    try {
        fs.writeFileSync(path.join(directory, 'boundary.py'), "def connect():\n    raise RuntimeError('unpatched boundary')\n");
        for (const managed of [false, true]) {
            const target = 'from boundary import connect as open_session\n'
                + 'def _load(key):\n'
                + (managed ? '    with open_session() as connection:\n' : '    connection = open_session()\n')
                + (managed ? '        ' : '    ') + 'cursor = connection.cursor()\n'
                + (managed ? '        ' : '    ') + "cursor.execute('lookup', (key,))\n"
                + (managed ? '        ' : '    ') + 'return cursor.fetchone()\n';
            fs.writeFileSync(path.join(directory, 'sample.py'), target);
            const correct = 'import unittest\nfrom unittest.mock import patch\nfrom sample import _load\n'
                + 'class Cases(unittest.TestCase):\n    def test_load(self):\n'
                + "        with patch('sample.open_session') as factory:\n"
                + '            connection = factory.return_value' + (managed ? '.__enter__.return_value' : '') + '\n'
                + '            cursor = connection.cursor.return_value\n'
                + "            cursor.fetchone.return_value = ('controlled',)\n"
                + "            self.assertEqual(_load('input'), ('controlled',))\n"
                + '            factory.assert_called_once_with()\n'
                + "            cursor.execute.assert_called_once_with('lookup', ('input',))\n";
            const run = (candidate: string) => {
                fs.writeFileSync(path.join(directory, 'generated.py'), candidate);
                return spawnSync(python, generatedUnittestArguments('generated', directory, false, true), {
                    cwd: directory, encoding: 'utf8', timeout: 10000,
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
            };
            assert.equal(validateUnittestStructure(correct, '_load', 'sample').valid, true);
            const passing = run(correct);
            assert.equal(passing.status, 0, passing.stdout + passing.stderr);
            const wildcard = run(correct.replace('from sample import _load', 'from sample import *'));
            assert.notEqual(wildcard.status, 0);
            assert.match(wildcard.stdout + wildcard.stderr, /NameError: name '_load' is not defined/);
            const wrongBinding = run(correct.replace("patch('sample.open_session')", "patch('boundary.connect')"));
            assert.notEqual(wrongBinding.status, 0);
            assert.match(wrongBinding.stdout + wrongBinding.stderr, /unpatched boundary/);
            const scalar = run(correct.replace("            self.assertEqual(_load", "            factory.return_value = 'not-a-connection'\n            self.assertEqual(_load"));
            assert.notEqual(scalar.status, 0);
            assert.match(scalar.stdout + scalar.stderr, managed ? /context manager protocol/ : /has no attribute 'cursor'/);
            assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), target);
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
