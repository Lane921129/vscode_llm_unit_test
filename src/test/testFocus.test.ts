import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { focusedSeedOutputFloor, isTestFocus, requiresQualifiedRoles, resolveTestFocus, testFocusInstruction, TEST_FOCUSES } from '../pipeline/testFocus';
import { selectQualityFocus } from '../roles/qualityAnalyst';
import { contextGrowthCeiling, resolveLocalRuntimeContext } from '../prompts/promptBudget';
import { planContextGrowth } from '../prompts/contextGrowth';
import { getWebviewContent } from '../ui/webviewContent';
import { englishMessages } from '../i18n/messages';
import en from '../i18n/en';
import zh from '../i18n/zh-tw';

test('focus changes priority while preserving all quality gates and role qualification', () => {
    for (const focus of TEST_FOCUSES) {
        assert.equal(isTestFocus(focus), true);
        assert.equal(requiresQualifiedRoles(focus), true);
        assert.match(testFocusInstruction(focus), /one case\/gap at a time/);
        assert.match(testFocusInstruction(focus), /All execution, review, coverage and mutation gates still apply/);
    }
    for (const legacy of ['auto', 'tier1', 'tier4', 'small']) { assert.equal(resolveTestFocus(legacy), 'full'); }
    assert.equal(requiresQualifiedRoles('auto'), true);
    assert.equal(isTestFocus('unknown'), false);
});

test('coverage and mutation priorities choose measured gaps without deleting the others', () => {
    const coverage: any = { available: true, missingTargetLines: [12], missingTargetBranches: ['12->14'], targetExecuted: true };
    const survivors = ['M1 comparison', 'M2 arithmetic'];
    assert.equal(selectQualityFocus(coverage, survivors, 1, survivors, [], 'coverage')?.kind, 'coverage');
    assert.equal(selectQualityFocus(coverage, survivors, 1, [], [], 'mutation')?.kind, 'survivor');
    assert.equal(selectQualityFocus(coverage, survivors, 1, ['M1 comparison'], [], 'boundary')?.evidence, 'M1 comparison');
    assert.equal(selectQualityFocus(coverage, [], 1, [], [], 'mutation')?.kind, 'coverage');
    assert.equal(selectQualityFocus({ ...coverage, missingTargetLines: [], missingTargetBranches: [] }, survivors, 1, [], [], 'coverage')?.kind, 'survivor');
    assert.deepEqual(survivors, ['M1 comparison', 'M2 arithmetic']);
    assert.deepEqual(coverage.missingTargetLines, [12]);
});

test('manual capacity does not falsify metadata or authorize further automatic growth', () => {
    const metadata = { paramSize: '70B', contextLength: 2048, contextLengthKnown: true };
    const selected = resolveLocalRuntimeContext({ ...metadata, runtimeContextTokens: 100000 });
    assert.equal(selected.ok, true);
    if (!selected.ok) { throw new Error('manual request was blocked'); }
    assert.equal(selected.contextWindow, 100000);
    assert.equal(metadata.contextLength, 2048);
    const ceiling = contextGrowthCeiling(metadata, selected.contextWindow);
    assert.equal(ceiling.modelContextLimitVerified, false);
    assert.equal(planContextGrowth({ currentContextTokens: selected.contextWindow, estimatedPromptTokens: 2000, ...ceiling }).status, 'unchanged');
    assert.deepEqual(planContextGrowth({ currentContextTokens: selected.contextWindow, estimatedPromptTokens: 200000, ...ceiling }),
        { status: 'blocked', reasonCode: 'model-context-limit-unverified' });
});

test('seed allowance uses available context rather than parameter size and retains prompt headroom', () => {
    assert.equal(focusedSeedOutputFloor(8192, 3203), 4096);
    assert.equal(focusedSeedOutputFloor(8192, 6000, 100), 1964);
    assert.equal(focusedSeedOutputFloor(2048, 3000), 0);
    for (const value of [NaN, Infinity, -1, 0.5]) { assert.equal(focusedSeedOutputFloor(value, 0), 0); }
});

test('English and Chinese sidebars expose focus choices without model-size Tier choices', () => {
    for (const dictionary of [en, zh]) {
        const translate = (key: string) => key.split('.').reduce((value: any, part) => value[part], dictionary);
        const html = getWebviewContent(translate, 'en', 'tier4');
        for (const focus of TEST_FOCUSES) { assert.ok(html.includes(`value="${focus}"`)); }
        assert.doesNotMatch(html, /value="tier[1-4]"/);
        assert.match(html, /value="full" selected/);
        assert.equal(typeof dictionary.ui.runtimeContextOverride, 'string');
    }
    assert.equal(typeof englishMessages['完整'], 'string');
});
