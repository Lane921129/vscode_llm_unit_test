import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { withLanguage, getLanguage, setLanguage, type Language } from '../i18n/core';
import { assessPromptCapacity, isPromptCapacityDiagnostic, type PromptCapacityInput } from '../prompts/promptCapacity';
import { contextInputBudget } from '../prompts/promptBudget';
import { roleRequestBudget, type BudgetedModelRole } from '../prompts/roleRequestBudget';
import { formatPromptCapacity } from '../pipeline/promptCapacityPresentation';
import { describeStageEvent } from '../pipeline/resultPresentation';
import { formatModelQualificationLog, QUALIFICATION_VERSION } from '../llm/modelQualification';

const historical: PromptCapacityInput = { envType: 'local', mode: 'full', role: 'analyst-planning', seedPending: true,
    contextWindow: 1024, estimatedInputTokens: 2410, reservedInputTokens: 94,
    modelContextLimitVerified: true, modelContextLimit: 2048, modelContextLimitSource: 'ollama-show' };

function inLanguage<T>(language: Language, operation: () => T): T {
    const previous = getLanguage();
    setLanguage(language);
    try { return withLanguage(operation); } finally { setLanguage(previous); }
}

test('the 2K laboratory limit cannot fit the complete Analyst input, even after growth', () => {
    const capacity = assessPromptCapacity(historical);
    assert.equal(capacity.state, 'model-limit-insufficient');
    assert.equal(capacity.inputBudget, 716);
    assert.equal(capacity.reservedOutputTokens, 308);
    assert.equal(capacity.requiredInputTokens, 2504);
    assert.equal(capacity.inputShortfallTokens, 1788);
    assert.equal(capacity.limitInputBudget, 1433);
    assert.equal(capacity.limitReservedOutputTokens, 615);
    assert.equal(capacity.limitInputShortfallTokens, 1071);
    assert.equal(capacity.minimumContextTokens, 3528, 'the minimum must also cover the cap growing to 1024');
    assert.equal(isPromptCapacityDiagnostic(capacity), true);
});

test('a verified larger ceiling enables growth while unknown metadata never becomes a verified bound', () => {
    const grown = assessPromptCapacity({ ...historical, modelContextLimit: 8192 });
    assert.equal(grown.state, 'growth-required');
    assert.equal(grown.minimumContextTokens, 3528);
    const fits = assessPromptCapacity({ ...historical, contextWindow: 4096, modelContextLimit: 8192 });
    assert.equal(fits.state, 'fits-current');
    assert.equal(fits.minimumContextTokens, 3528);
    const unknown = assessPromptCapacity({ ...historical, modelContextLimitVerified: false });
    assert.equal(unknown.state, 'model-limit-unknown');
    assert.equal(unknown.modelContextLimit, null);
    assert.equal(unknown.modelContextLimitSource, 'unknown');
    assert.equal(unknown.limitInputBudget, null);
});

test('minimum capacities honor each real role policy and learned output floors without disclosing candidate text', () => {
    const roles: BudgetedModelRole[] = ['writer', 'writer-revision', 'reviewer', 'bug-fixer', 'analyst-planning', 'analyst-quality'];
    for (const role of roles) {
        const input: PromptCapacityInput = { ...historical, role, modelContextLimit: 16384,
            revisionCurrentCode: 'PRIVATE_CANDIDATE_DO_NOT_PERSIST', minimumOutputTokens: 2048 };
        const result = assessPromptCapacity(input);
        assert.ok(result.minimumContextTokens);
        const budgetAt = (contextWindow: number) => roleRequestBudget({ ...input, contextWindow,
            inputBudget: contextInputBudget('', contextWindow) });
        assert.ok(budgetAt(result.minimumContextTokens).inputBudget >= 2504, role);
        assert.ok(budgetAt(result.minimumContextTokens - 1).inputBudget < 2504, role);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANDIDATE|revisionCurrentCode/);
    }
});

test('revision workload uses the same complete input/output allowance at current and maximum capacity', () => {
    const input: PromptCapacityInput = { envType: 'local', mode: 'full', role: 'writer-revision', seedPending: false,
        contextWindow: 8192, estimatedInputTokens: 6000, reservedInputTokens: 100,
        revisionCurrentCode: 'PRIVATE_COMPLETE_TEST_FILE', revisionWorkload: { findingCount: 5, missingScenarioCount: 2 },
        modelContextLimitVerified: true, modelContextLimit: 16384 };
    const result = assessPromptCapacity(input);
    assert.equal(result.state, 'growth-required');
    for (const contextWindow of [8192, result.minimumContextTokens!, 16384]) {
        const expected = roleRequestBudget({ ...input, contextWindow, inputBudget: contextInputBudget('', contextWindow) });
        const actual = assessPromptCapacity({ ...input, contextWindow });
        assert.equal(actual.inputBudget, expected.inputBudget);
        assert.equal(actual.reservedOutputTokens, expected.reservedOutputTokens);
        assert.equal(actual.requestOutputTokens, expected.requestOutputTokens ?? null);
    }
    assert.equal(result.requestOutputTokens, 2458);
    assert.equal(result.limitReservedOutputTokens, 3584);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_COMPLETE|findingCount|revisionWorkload/);
    assert.equal(assessPromptCapacity({ ...input, modelContextLimit: 8192 }).state, 'model-limit-insufficient');
    assert.equal(assessPromptCapacity({ ...input, modelContextLimitVerified: false }).state, 'model-limit-unknown');
});

test('capacity calculations reject unsafe input and terminate when no safe capacity can reserve the output', () => {
    for (const patch of [{ contextWindow: 0 }, { estimatedInputTokens: NaN }, { reservedInputTokens: -1 },
        { estimatedInputTokens: Number.MAX_SAFE_INTEGER, reservedInputTokens: 1 },
        { modelContextLimit: 512 }, { modelContextLimit: Infinity }, { minimumOutputTokens: -1 }]) {
        assert.throws(() => assessPromptCapacity({ ...historical, ...patch }), TypeError);
    }
    const exhausted = assessPromptCapacity({ ...historical, modelContextLimitVerified: false,
        minimumOutputTokens: Number.MAX_SAFE_INTEGER });
    assert.equal(exhausted.minimumContextTokens, null);
});

test('same-request measured input can raise but never reduce the complete prompt reservation', () => {
    const observed = assessPromptCapacity({ ...historical, observedInputTokens: 2600, minimumOutputTokens: 0 });
    assert.equal(observed.estimatedInputTokens, 2410);
    assert.equal(observed.effectiveInputTokens, 2600);
    assert.equal(observed.requiredInputTokens, 2694);
    assert.equal(observed.minimumContextTokens, 3718);
    assert.equal(assessPromptCapacity({ ...historical, observedInputTokens: 2000 }).minimumContextTokens, 3528);
    assert.match(inLanguage('en', () => formatPromptCapacity(observed))!, /reported 2600 input tokens/);
});

test('capacity failures explain the actual limit and estimate in both languages without claiming quality or waiting fixes', () => {
    const capacity = assessPromptCapacity(historical);
    const zh = inLanguage('zh-tw', () => formatPromptCapacity(capacity, true));
    assert.match(zh!, /2048.*ollama-show/);
    assert.match(zh!, /2410 \+ 補正預留 94/);
    assert.match(zh!, /至少需要 3528/);
    assert.match(zh!, /增加等待時間無法增加 Context/);
    const en = inLanguage('en', () => describeStageEvent('model-request', 'budget-exceeded', { capacity }));
    assert.match(en, /model limit 2048/);
    assert.match(en, /at least 3528 tokens/);
    assert.doesNotMatch(en, /[\u3400-\u9fff]/);
    assert.match(en, /not measured token usage/);
    assert.equal(inLanguage('en', () => describeStageEvent('model-capacity', 'assessed', capacity)),
        inLanguage('en', () => formatPromptCapacity(capacity)));
});

test('presentation rejects malformed fields and never echoes arbitrary diagnostic payloads', () => {
    const capacity = assessPromptCapacity(historical);
    for (const patch of [{ version: 'future' }, { role: 'PRIVATE_RESPONSE' }, { state: 'approved' },
        { modelContextLimitSource: 'PRIVATE_PROVIDER' }, { contextWindow: NaN }, { minimumContextTokens: -1 }]) {
        assert.equal(formatPromptCapacity({ ...capacity, ...patch }, true), undefined);
    }
    assert.doesNotMatch(formatPromptCapacity({ ...capacity, providerResponse: 'PRIVATE_RESPONSE' }, true)!, /PRIVATE_RESPONSE/);
});

test('a successful connection probe explicitly distinguishes fixed-sample qualification from real target capacity', () => {
    const profile = { testGenerationReady: true, qualificationVersion: QUALIFICATION_VERSION, modelName: 'fixture-model' };
    const zh = inLanguage('zh-tw', () => formatModelQualificationLog(profile));
    assert.match(zh, /短探針只認證固定樣本/);
    const en = inLanguage('en', () => formatModelQualificationLog(profile));
    assert.match(en, /complete prompt capacity checks/);
    assert.doesNotMatch(en, /[\u3400-\u9fff]/);
    const expired = inLanguage('en', () => formatModelQualificationLog({ ...profile, qualificationVersion: 'old' }));
    assert.doesNotMatch(expired, /qualifies only its fixed sample/);
});
