import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { planContextGrowth } from '../prompts/contextGrowth';
import { contextInputBudget } from '../prompts/promptBudget';
import { roleRequestBudget } from '../prompts/roleRequestBudget';
import { qualificationAppliesToRequest, LOCAL_RUNTIME_QUALIFICATION_VERSION, QUALIFICATION_VERSION,
    qualificationEndpointKey } from '../llm/modelQualification';

const base = { currentContextTokens: 4096, modelContextLimit: 16384,
    modelContextLimitVerified: true, estimatedPromptTokens: 4000 };

test('default reserve grows the full envelope just enough with correction space and rounding', () => {
    const input = Object.freeze({ ...base, reservedInputTokens: 600 });
    const plan = planContextGrowth(input);
    assert.equal(plan.status, 'grown');
    if (plan.status !== 'grown') { return; }
    assert.equal(plan.contextTokens, 7168);
    assert.equal(plan.minimumContextTokens, 6572);
    assert.equal(plan.requiredInputTokens, 4600);
    assert.equal(plan.inputBudget, contextInputBudget('', plan.contextTokens));
    assert.equal(plan.reservedOutputTokens, plan.contextTokens - plan.inputBudget);
    assert.ok(contextInputBudget('', plan.minimumContextTokens - 1) < plan.requiredInputTokens);
    assert.ok(plan.inputBudget >= plan.requiredInputTokens + 128);
    assert.equal(plan.qualificationRevalidationRequired, true);
    assert.equal(input.currentContextTokens, 4096, 'planning does not overwrite a saved or current choice');
});

test('a known Analyst wire cap reclaims only its actual reserve at the grown capacity', () => {
    const plan = planContextGrowth({ ...base, estimatedPromptTokens: 3300,
        requestOutputTokens: 1024, reservedInputTokens: 500 });
    assert.equal(plan.status, 'grown');
    if (plan.status !== 'grown') { return; }
    assert.equal(plan.contextTokens, 5120);
    assert.equal(plan.minimumContextTokens, 4824);
    const role = roleRequestBudget({ envType: 'local', mode: 'full', role: 'analyst-planning',
        seedPending: true, contextWindow: plan.contextTokens, inputBudget: contextInputBudget('', plan.contextTokens) });
    assert.equal(role.requestOutputTokens, 1024);
    assert.equal(plan.inputBudget, role.inputBudget);
    assert.equal(plan.reservedOutputTokens, role.reservedOutputTokens);
    assert.ok(plan.inputBudget >= plan.requiredInputTokens);
});

test('seed expansion does not borrow its known output cap for a large complete prompt', () => {
    const plan = planContextGrowth({ ...base, estimatedPromptTokens: 5000, requestOutputTokens: 1536 });
    assert.equal(plan.status, 'grown');
    if (plan.status !== 'grown') { return; }
    assert.equal(plan.contextTokens, 7168);
    assert.equal(plan.inputBudget, 5632);
    assert.equal(plan.reservedOutputTokens, 1536);
    assert.equal(plan.minimumContextTokens, 6536);
});

test('capacity never shrinks and an already fitting prompt needs no new qualification', () => {
    for (const requestOutputTokens of [undefined, 1024]) {
        const plan = planContextGrowth({ ...base, currentContextTokens: 8192,
            estimatedPromptTokens: 100, requestOutputTokens });
        assert.equal(plan.status, 'unchanged');
        if (plan.status !== 'unchanged') { continue; }
        assert.equal(plan.contextTokens, 8192);
        assert.equal(plan.qualificationRevalidationRequired, false);
    }
    const unknownButFits = planContextGrowth({ ...base, modelContextLimit: undefined,
        modelContextLimitVerified: false, estimatedPromptTokens: 100 });
    assert.equal(unknownButFits.status, 'unchanged', 'unknown metadata authorizes no growth but need not change an existing fitting request');
});

test('the verified non-aligned ceiling is used without dropping required input or output', () => {
    const plan = planContextGrowth({ ...base, modelContextLimit: 6500, estimatedPromptTokens: 4400 });
    assert.equal(plan.status, 'grown');
    if (plan.status !== 'grown') { return; }
    assert.equal(plan.contextTokens, 6500, 'rounding may not exceed the exact verified limit');
    assert.ok(plan.inputBudget >= 4528);
    const exactCeiling = planContextGrowth({ ...base, modelContextLimit: 6500,
        estimatedPromptTokens: 5476, requestOutputTokens: 1024 });
    assert.equal(exactCeiling.status, 'grown');
    if (exactCeiling.status !== 'grown') { return; }
    assert.equal(exactCeiling.contextTokens, 6500);
    assert.equal(exactCeiling.inputBudget, 5476, 'headroom is optional; complete required evidence is not');
});

test('unknown metadata, reached limits and impossible complete envelopes fail closed', () => {
    const cases = [
        [{ ...base, modelContextLimitVerified: false }, 'model-context-limit-unverified'],
        [{ ...base, modelContextLimit: undefined, modelContextLimitVerified: false }, 'model-context-limit-unverified'],
        [{ ...base, currentContextTokens: 16384, estimatedPromptTokens: 12000 }, 'model-context-limit-reached'],
        [{ ...base, currentContextTokens: 16385 }, 'current-context-exceeds-model-limit'],
        [{ ...base, estimatedPromptTokens: 11500 }, 'prompt-exceeds-model-context'],
        [{ ...base, estimatedPromptTokens: 10000, reservedInputTokens: 1500 }, 'prompt-exceeds-model-context'],
        [{ ...base, estimatedPromptTokens: 16000, requestOutputTokens: 1024 }, 'prompt-exceeds-model-context']
    ] as const;
    for (const [input, reasonCode] of cases) {
        assert.deepEqual(planContextGrowth(input), { status: 'blocked', reasonCode });
    }
});

test('invalid or unsafe numbers cannot become a guessed context or reserve', () => {
    for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        for (const field of ['currentContextTokens', 'modelContextLimit', 'estimatedPromptTokens',
            'reservedInputTokens', 'requestOutputTokens'] as const) {
            assert.deepEqual(planContextGrowth({ ...base, [field]: invalid }),
                { status: 'blocked', reasonCode: 'invalid-context-growth-input' });
        }
    }
    for (const field of ['currentContextTokens', 'modelContextLimit', 'requestOutputTokens'] as const) {
        assert.deepEqual(planContextGrowth({ ...base, [field]: 0 }),
            { status: 'blocked', reasonCode: 'invalid-context-growth-input' });
    }
    assert.deepEqual(planContextGrowth({ ...base, modelContextLimit: undefined }),
        { status: 'blocked', reasonCode: 'invalid-context-growth-input' });
    assert.deepEqual(planContextGrowth({ ...base, estimatedPromptTokens: Number.MAX_SAFE_INTEGER, reservedInputTokens: 1 }),
        { status: 'blocked', reasonCode: 'invalid-context-growth-input' });
});

test('safe-integer ceiling rounding cannot overflow or silently remove the wire reserve', () => {
    const plan = planContextGrowth({ ...base, modelContextLimit: Number.MAX_SAFE_INTEGER,
        estimatedPromptTokens: Number.MAX_SAFE_INTEGER - 2, requestOutputTokens: 1 });
    assert.equal(plan.status, 'grown');
    if (plan.status !== 'grown') { return; }
    assert.equal(plan.contextTokens, Number.MAX_SAFE_INTEGER);
    assert.equal(plan.reservedOutputTokens, 1);
    assert.ok(Number.isSafeInteger(plan.contextTokens));
    assert.ok(plan.inputBudget >= plan.requiredInputTokens);
});

test('changing num_ctx invalidates exact-runtime qualification until re-probed at the new capacity', () => {
    const endpointKey = qualificationEndpointKey('local');
    const profile = { envType: 'local' as const, modelName: 'fixture-model', qualificationVersion: QUALIFICATION_VERSION,
        endpointKey, qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION as typeof LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 4096 } };
    const request = { envType: 'local' as const, modelName: profile.modelName, endpointKey, runtimeContextTokens: 4096 };
    assert.equal(qualificationAppliesToRequest(profile, request), true);
    const plan = planContextGrowth(base);
    assert.equal(plan.status, 'grown');
    if (plan.status !== 'grown') { return; }
    const grownRequest = { ...request, runtimeContextTokens: plan.contextTokens };
    assert.equal(qualificationAppliesToRequest(profile, grownRequest), false,
        'a successful probe at a smaller allocation cannot authorize the grown request');
    assert.equal(qualificationAppliesToRequest({ ...profile,
        qualificationRuntime: { ...profile.qualificationRuntime, numCtx: plan.contextTokens } }, grownRequest), true);
    assert.equal(profile.qualificationRuntime.numCtx, 4096, 'planning and verification do not alter the original saved profile');
});
