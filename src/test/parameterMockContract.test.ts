import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatDependencyMockContract } from '../prompts/dependencyMockContract';
import { buildWriterRevisionContext } from '../prompts/compactWriterContext';
import { getUserPrompt } from '../roles/unittestWriter';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { generatedUnittestArguments, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

const source = 'def is_ready(page):\n    return page.ready\n';
const context = { name: 'is_ready', code: source, args: ['page'], signature: [{ name: 'page', kind: 'positional_or_keyword' }],
    method_kind: 'module', calls: [], file_imports: [] };
const evidence: WriterEvidenceBundleV3 = {
    schemaVersion: 'writer-evidence-v3', sourceHash: 'neutral-source', semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'neutral-source', ids: [], selectedRules: [],
        guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance']
};

test('Writer generation and revision distinguish declared input parameters from module patch targets', () => {
    const prompts = [getUserPrompt('sample.py', 'is_ready', source, 'small', context, undefined, 4000, '', evidence),
        getUserPrompt('sample.py', 'is_ready', source, 'large', context, undefined, 4000, '', evidence),
        buildWriterRevisionContext({ module: 'sample', name: 'is_ready', source, context, evidence })];
    for (const prompt of prompts) {
        assert.ok(prompt.includes(source), 'the complete source still determines fixture shape');
        assert.match(prompt, /PARAMETER SETUP \(source signature\): \["page"\]/);
        assert.match(prompt, /Build input values in test scope and pass them to the target/);
        assert.match(prompt, /parameter names alone do not authorize patching target_module\.<parameter>/);
        assert.match(prompt, /independent source-proven global lookup may justify a module patch/);
        assert.match(prompt, /Do not infer fixture shapes or expected outputs from parameter names/);
    }
});

test('parameter hints use only known signature names and preserve explicit global-use evidence', () => {
    assert.equal(formatDependencyMockContract('sample', {}), '');
    assert.equal(formatDependencyMockContract('sample', { signature: [{ annotation: 'Page' }] }), '');
    assert.equal(formatDependencyMockContract('sample', { signature: [], args: ['unconfirmed'] }), '');
    assert.equal(formatDependencyMockContract('sample', { args: ['value=unknown()', null] }), '');
    assert.match(formatDependencyMockContract('sample', { args: ['page'] }), /\["page"\]/);
    assert.match(formatDependencyMockContract('sample', { signature: [{ name: 'K' }] }), /\["K"\]/);
    const globalSource = 'def is_ready(page):\n    return globals()["page"].ready\n';
    const prompt = buildWriterRevisionContext({ module: 'sample', name: 'is_ready', source: globalSource,
        context: { ...context, code: globalSource, referenced_globals: [{ name: 'page', code: 'page = None' }] }, evidence });
    assert.ok(prompt.includes(globalSource));
    assert.match(prompt, /independent source-proven global lookup may justify a module patch/);
    assert.doesNotMatch(prompt, /Never patch sample\.page/);
});

test('a neutral page-like input executes through real guards when passed directly, while invented module patch fails', () => {
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parameter-input-'));
    const direct = 'import unittest\nfrom types import SimpleNamespace\nfrom sample import is_ready\n'
        + 'class Cases(unittest.TestCase):\n'
        + '    def test_ready(self):\n        page = SimpleNamespace(ready=True)\n        self.assertIs(is_ready(page), True)\n'
        + '    def test_not_ready(self):\n        page = SimpleNamespace(ready=False)\n        self.assertIs(is_ready(page), False)\n';
    try {
        fs.writeFileSync(path.join(directory, 'sample.py'), source);
        const structure = validateUnittestStructure(direct, 'is_ready', 'sample');
        assert.equal(structure.valid, true, structure.reason);
        const checked = spawnSync(python, ['-B', pythonToolPath('bindings'), '--payload'], {
            encoding: 'utf8', timeout: 10000, input: JSON.stringify({ code: direct,
                context: { module: 'sample', target: 'is_ready', source, dependencies: {}, targetUsage: 'call',
                    requireTargetBehavior: structure.requiresTargetBehaviorEvidence,
                    requireMockBehavior: structure.requiresMockBehaviorEvidence } }) });
        assert.equal(checked.status, 0, checked.stderr);
        const binding = JSON.parse(checked.stdout);
        assert.equal(binding.valid, true, binding.reason);
        const run = (code: string) => {
            fs.writeFileSync(path.join(directory, 'generated.py'), code);
            return spawnSync(python, generatedUnittestArguments('generated', directory, false, true), {
                cwd: directory, encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        };
        const wrong = run('import unittest\nfrom unittest.mock import patch\nfrom sample import is_ready\n'
            + 'class Cases(unittest.TestCase):\n    @patch("sample.page")\n    def test_ready(self, page):\n'
            + '        page.ready = True\n        self.assertIs(is_ready(page), True)\n');
        assert.notEqual(wrong.status, 0);
        assert.match(wrong.stderr, /AttributeError:.*does not have the attribute 'page'/);
        const correct = run(direct);
        assert.equal(correct.status, 0, correct.stdout + correct.stderr);
        assert.match(correct.stderr, /Ran 2 tests/);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), source);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
