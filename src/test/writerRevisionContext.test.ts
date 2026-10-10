import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWriterRevisionContext } from '../prompts/compactWriterContext';
import { formatDependencyMockContract, formatSourceImport } from '../prompts/dependencyMockContract';
import { buildWriterRevisionRequest, referenceRepeatedTestFile } from '../roles/roleContracts';
import { getExecutionWriterPrompt, getUserPrompt } from '../roles/unittestWriter';
import { getReviewEvidence } from '../roles/bugFixer';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { promptFits } from '../prompts/promptBudget';

const evidence: WriterEvidenceBundleV3 = {
    schemaVersion: 'writer-evidence-v3', sourceHash: 'source-v1', semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'source-v1', ids: ['setup-rule'],
        selectedRules: [{ ruleId: 'setup-rule', title: 'Retain exact setup', guidance: ['KEEP_REQUIRED_RULE'] }] as any,
        guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance']
};
const code = 'import unittest\nfrom sample import _load\nclass Cases(unittest.TestCase):\n    def test_load(self):\n        self.assertEqual(_load(), 1)\n';
const fence = (value: string) => '```python\n' + value + '\n```';

test('Writer binding contract preserves aliases and relative imports without guessing mock permissions', () => {
    const context = { calls: ['open_session', 'client.fetch', 'local_method'], file_imports: [
        { kind: 'from', module: 'boundary', level: 1, name: 'connect', alias: 'open_session', bound_name: 'open_session' },
        { kind: 'import', module: 'transport.api', alias: 'client', bound_name: 'client' },
        { kind: 'from', module: 'helpers', name: '*', bound_name: '*' }
    ] };
    const contract = formatDependencyMockContract('pkg.sample', context, ['pkg.sample.open_session']);
    assert.match(contract, /from \.boundary import connect as open_session/);
    assert.match(contract, /import transport\.api as client/);
    assert.match(contract, /"suppliedUsePoints":\["pkg.sample.open_session"\]/);
    assert.doesNotMatch(contract, /pkg\.sample\.local_method|pkg\.sample\.client\.fetch/);
    assert.match(contract, /scope\/rebindings/);
    assert.match(contract, /locals and constructor-injected objects are not module patch targets/);
    assert.match(contract, /not an exhaustive whitelist/);
    assert.match(formatDependencyMockContract('pkg.sample', context), /No patch list was supplied/);
    assert.equal(formatSourceImport({ kind: 'import', module: 'transport.api' }), 'import transport.api');
    for (const strategy of ['small', 'large'] as const) {
        const prompt = getUserPrompt('sample.py', '_load', 'def _load(): return 1', strategy, context);
        assert.match(prompt, /underscore-prefixed targets are not imported by \*/);
        assert.match(prompt, /from \.boundary import connect as open_session/);
        assert.match(prompt, /never replace the connection with a string/);
        assert.match(prompt, /A configured mock alone is not an assertion/);
    }
});

test('revision context retains required evidence and complete dependency sources once, without generation proposals', () => {
    const source = 'def _load(value):\n    return value';
    const helper = 'def helper(value):\n' + '    # complete neutral helper context\n'.repeat(300) + '    return value';
    const context = { args: ['value'], calls: ['helper'],
        signature: [{ name: 'value', required: true }],
        class_context: { init: { code: 'def __init__(self, client): self.client = client' } },
        referenced_globals: [{ name: 'LIMIT', code: 'LIMIT = 7' }],
        traceResult: { examples: [{ args: ['1'], result: '1', result_assertable: false,
            safety: { reason: 'uncontrolled-ambient-read' } }], errors: [] },
        dependencyContexts: [
            { name: 'first', code: helper, sourceHash: 'helper-v1', retrieval: { status: 'resolved' },
                signature: [{ name: 'value' }], traceResult: { examples: [{ args: ['1'], result: '2' }] } },
            { name: 'second', code: helper, sourceHash: 'helper-v1', traceResult: { examples: [{ args: ['1'], result: '3' }] } },
            { name: 'selected_again', code: source }
        ] };
    const prompt = buildWriterRevisionContext({ module: 'sample', name: '_load', source, context,
        evidence: { ...evidence, semanticPlan: { hypotheses: [{ claim: 'OPTIONAL_HYPOTHESIS' }] } as any,
            mergedTargetObservations: { examples: [{ args: ['999'], result: 'OTHER_CALLER' }] } as any },
        allowedMockTargets: ['sample.helper'] });
    assert.equal(prompt.split(helper).length - 1, 1);
    assert.equal(prompt.split(source).length - 1, 1);
    for (const required of ['KEEP_REQUIRED_RULE', 'def __init__', 'LIMIT = 7', '"result_assertable":false',
        'uncontrolled-ambient-read', '"result":"2"', '"result":"3"', '"signature":[{"name":"value"}]']) {
        assert.ok(prompt.includes(required), required);
    }
    assert.match(prompt, /identical to RETRIEVED DEPENDENCY first/);
    assert.match(prompt, /reuse that source, not its observations/);
    assert.doesNotMatch(prompt, /VERIFIED PATTERN|OPTIONAL_HYPOTHESIS|OTHER_CALLER|Initially choose 1–3|omitted as whole units/);
    assert.equal((prompt.match(/```/g) || []).length % 2, 0);
    const revision = { code, findings: 'Fix setup only', moduleName: 'sample', functionName: '_load' };
    const previous = getReviewEvidence('', '', '_load', ['value'], source, context, 'sample');
    assert.equal(promptFits('', buildWriterRevisionRequest({ ...revision, evidence: previous }), 6000), false,
        'duplicating complete dependency bodies exceeds the unchanged budget');
    assert.equal(promptFits('', buildWriterRevisionRequest({ ...revision, evidence: prompt }), 6000), true,
        'the same complete sources and observations fit when identical bodies are referenced once');
    const tooLarge = buildWriterRevisionContext({ module: 'sample', name: '_load', source: helper.repeat(10), evidence });
    assert.ok(tooLarge.includes(helper.repeat(10)), 'required source remains complete even above the budget');
    assert.equal(promptFits('', tooLarge, 6000), false);
});

test('repair prompts reference only identical whole files and preserve unique source and failure evidence', () => {
    const context = 'SOURCE_AND_SAFETY\n' + fence(code) + '\nOBSERVATION\n' + fence(code);
    const findings = 'Concrete failure\n' + fence(code) + '\nKeep this diagnostic';
    const requests = [buildWriterRevisionRequest({ code, findings, moduleName: 'sample', functionName: '_load', evidence: context }),
        getExecutionWriterPrompt(context, code, findings)];
    for (const prompt of requests) {
        assert.equal(prompt.split(code).length - 1, 1);
        for (const required of ['SOURCE_AND_SAFETY', 'OBSERVATION', 'Concrete failure', 'Keep this diagnostic']) {
            assert.ok(prompt.includes(required));
        }
        assert.match(prompt, /identical complete current test file/);
        assert.equal((prompt.match(/```/g) || []).length % 2, 0);
    }
    for (const different of [fence(code + '# a distinct complete file'), fence(code.replace('_load(), 1', '_load(), 2')),
        code, '```text\n' + code + '\n```',
        '````python\ndef source():\n    return """\n' + fence(code) + '\n"""\n````']) {
        assert.equal(referenceRepeatedTestFile(different, code), different, 'never replace a partial or different program');
    }
});
