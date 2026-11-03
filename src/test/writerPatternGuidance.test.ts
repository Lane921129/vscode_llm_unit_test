import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompactWriterContext } from '../prompts/compactWriterContext';
import { formatWriterPatternGuide, VERIFIED_WRITER_EXAMPLES } from '../prompts/verifiedWriterExamples';
import { formatFewShotForPrompt, getBaseFewShotExamples, getDynamicFewShotExamples } from '../prompts/fewShotExamples';
import { getSystemPrompt, getUserPrompt } from '../roles/unittestWriter';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';

const evidence: WriterEvidenceBundleV3 = {
    schemaVersion: 'writer-evidence-v3', sourceHash: 'neutral-source', semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'neutral-source', ids: [], selectedRules: [],
        guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance']
};

test('pattern guides retain setup lessons without supplying foreign candidate code or answers', () => {
    for (const example of VERIFIED_WRITER_EXAMPLES) {
        const guidance = formatWriterPatternGuide(example);
        assert.match(guidance, /setup guidance only/);
        assert.match(guidance, /Target import\/binding/);
        assert.doesNotMatch(guidance, /example_target|from \w+ import|class Cases|def (?:load|test_)|['"]controlled['"]|example\.db|SELECT label/);
        assert.ok(!guidance.includes(example.tests));
        assert.ok(!guidance.includes(example.source));
    }
});

test('compact Writer keeps the selected source and import without a second executable target', () => {
    const source = 'def submit(value):\n    return boundary(value)';
    const prompt = buildCompactWriterContext({ module: 'pkg.actions', name: 'submit', source,
        context: { args: ['value'], calls: ['boundary'], dependencyContexts: [{ name: 'boundary',
            code: 'def boundary(value):\n    return value', sourceHash: 'dependency-source' }] }, evidence, budgetTokens: 20000 });
    assert.ok(prompt.includes(source));
    assert.match(prompt, /from pkg\.actions import submit/);
    assert.match(prompt, /VERIFIED PATTERN patch-scope-v1/);
    assert.doesNotMatch(prompt, /from example_target import|example_target\.dependency|class Cases\(|test_load\(/);
});

test('legacy and large Writer prompts send design guidance rather than arithmetic or import templates', () => {
    const source = 'def selected(values):\n    for value in values:\n        if value:\n            return value\n    return None';
    const prompts = [getSystemPrompt(1, 'small'), getSystemPrompt(1, 'large'),
        getUserPrompt('actions.py', 'selected', source, 'large', { args: ['values'], code: source }, '', 20000),
        formatFewShotForPrompt([...getBaseFewShotExamples(), ...getDynamicFewShotExamples({}, source)])];
    for (const prompt of prompts) {
        assert.doesNotMatch(prompt, /from target_module import|from module_name import|class TestAdd|class TestDivide|class TestGetDiscount|class TestSumList/);
        assert.doesNotMatch(prompt, /assertEqual\(add\(2, 3\), 5\)|assertEqual\(divide\(8, 2\), 4\)/);
    }
    assert.ok(prompts[2].includes(source));
    assert.match(prompts[2], /from actions import selected/);
});
