import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { getUserPrompt } from '../roles/unittestWriter';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { promptFits } from '../prompts/promptBudget';

const sourceHash = 'a'.repeat(64);
const evidence: WriterEvidenceBundleV3 = {
    schemaVersion: 'writer-evidence-v3', sourceHash, semanticGuidance: 'Source-guided case; no observed expected value.',
    ruleSelection: { schemaVersion: 'rule-selection-v2', selectedRules: [], ids: [], guidance: '',
        provenance: 'deterministic', sourceHash, dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance']
};

test('addition prompts retain source/setup while asking for a new method instead of a whole file', () => {
    const target = 'def target(value):\n    return helper(value) + LIMIT\n';
    const helper = 'def helper(value):\n    return value * 2\n';
    const context = { name: 'target', code: target, args: ['value'], target_import_module: 'sample',
        referenced_globals: [{ name: 'LIMIT', code: 'LIMIT = 99' }],
        dependencyContexts: [{ name: 'helper', code: helper, args: ['value'] }] };
    const full = getUserPrompt('sample.py', 'target', target, 'small', context, '', 6000, '', evidence);
    const addition = getUserPrompt('sample.py', 'target', target, 'small',
        { ...context, writerGenerationPhase: 'addition' }, '', 6000, '', evidence);
    assert.ok(addition.length < full.length);
    assert.ok(addition.includes(target));
    assert.ok(addition.includes(helper));
    assert.ok(addition.includes('LIMIT = 99'));
    assert.ok(addition.includes(sourceHash));
    assert.match(addition, /requested NEW unittest method only/);
    assert.doesNotMatch(addition, /Write one complete unittest file|GeneratedSeedTests|WRITER_SEED_PACKAGING/);
});

test('full large Writer retains required source and setup through the same concise projection as small', () => {
    const target = 'def target(value):\n    return helper(value) + LIMIT\n';
    const helper = 'def helper(value):\n    return value * 2\n';
    const context = { name: 'target', code: target, args: ['value'], target_import_module: 'sample',
        signature: [{ name: 'value', kind: 'positional_or_keyword', annotation: null, default: null, required: true }],
        file_imports: [{ module: 'vendor', name: '*', alias: null }],
        referenced_globals: [{ name: 'LIMIT', code: 'LIMIT = 99' }],
        dependencyContexts: [{ name: 'helper', code: helper, sourceHash: 'b'.repeat(64), args: ['value'] }] };
    const prompts = (['small', 'large'] as const).map(strategy =>
        getUserPrompt('sample.py', 'target', target, strategy, context, '', 6000, '', evidence));
    for (const prompt of prompts) {
        assert.ok(prompt.includes(target));
        assert.ok(prompt.includes(helper), 'necessary helper source is not an optional example');
        assert.ok(prompt.includes(sourceHash));
        assert.match(prompt, /LIMIT = 99/);
        assert.match(prompt, /vendor/);
        assert.match(prompt, /No evidence means omit that assertion, never guess/);
        assert.equal(prompt.split(target).length - 1, 1);
        assert.equal(prompt.split(helper).length - 1, 1);
    }
    assert.equal(prompts[1], prompts[0], 'large detail must not reintroduce the duplicated legacy layout');
});

test('an oversized full Writer source remains whole for the final request gate to reject', () => {
    const target = 'def target(value):\n' + '    # complete required source\n'.repeat(500) + '    return value\n';
    const prompt = getUserPrompt('sample.py', 'target', target, 'large',
        { name: 'target', code: target, args: ['value'] }, '', 300, '', evidence);
    assert.ok(prompt.includes(target));
    assert.equal(prompt.split(target).length - 1, 1);
    assert.equal(promptFits('complete role contract', prompt, 300), false);
});
