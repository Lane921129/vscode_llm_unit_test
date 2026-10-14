import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { planWriterOutputGrowth, WriterOutputBudget } from '../prompts/writerOutputBudget';
import { roleRequestBudget } from '../prompts/roleRequestBudget';
import { planContextGrowth } from '../prompts/contextGrowth';

const request = { envType: 'local', mode: 'full', role: 'writer', seedPending: true,
    contextWindow: 8192, inputBudget: 5734 } as const;

test('a truncated Writer cap increases output room and requires matching context capacity', () => {
    const session = new WriterOutputBudget();
    assert.equal(session.grow(1536, 16384), 2560);
    const budget = roleRequestBudget({ ...request, minimumOutputTokens: session.minimumTokens });
    assert.equal(budget.requestOutputTokens, 2560);
    assert.equal(budget.inputBudget, 5632);
    const growth = planContextGrowth({ currentContextTokens: 8192, modelContextLimit: 16384,
        modelContextLimitVerified: true, estimatedPromptTokens: 6400, reservedInputTokens: 80,
        requestOutputTokens: budget.requestOutputTokens });
    assert.equal(growth.status, 'grown');
    if (growth.status === 'grown') {
        const next = roleRequestBudget({ ...request, contextWindow: growth.contextTokens,
            inputBudget: Math.floor(growth.contextTokens * .7), minimumOutputTokens: session.minimumTokens });
        assert.ok(next.inputBudget >= 6480);
        assert.equal(next.requestOutputTokens, 2560);
    }
});

test('output growth rejects unknown caps, unsafe values and impossible upper bounds', () => {
    const session = new WriterOutputBudget();
    for (const cap of [undefined, 0, NaN, Infinity, '1536', Number.MAX_SAFE_INTEGER]) {
        assert.equal(session.grow(cap, 16384), undefined);
    }
    assert.equal(session.minimumTokens, 0);
    assert.equal(session.grow(2000, 2048), undefined);
    assert.equal(session.grow(1536, undefined), undefined);
    assert.equal(session.grow(1536, 16384), 2560);
    assert.equal(session.grow(1536, 16384), undefined);
});

test('learned Writer output floors never shrink a complete revision or alter roles without output recovery', () => {
    const code = 'class TestExample:\n' + '    # retained setup and assertions\n'.repeat(400);
    const revision = roleRequestBudget({ ...request, role: 'writer-revision', revisionCurrentCode: code,
        minimumOutputTokens: 2560 });
    assert.ok(revision.requestOutputTokens! > 2560);
    assert.equal(roleRequestBudget({ ...request, role: 'analyst-quality', minimumOutputTokens: 9000 }).requestOutputTokens, undefined);
    assert.deepEqual(roleRequestBudget({ ...request, envType: 'cloud', minimumOutputTokens: 9000 }),
        roleRequestBudget({ ...request, envType: 'cloud' }));
});

test('unknown model ceiling still permits a larger output inside the current captured capacity', () => {
    const plan = planWriterOutputGrowth({ exhaustedCap: 1536, currentContextTokens: 8192,
        modelContextLimitVerified: false, estimatedPromptTokens: 4788, observedPromptTokens: 5729,
        reservedInputTokens: 0 });
    assert.deepEqual(plan, { status: 'grown', outputTokens: 2335, requiredInputTokens: 5857,
        capacityCeiling: 8192, boundedBy: 'capacity' });
    const budget = roleRequestBudget({ ...request, minimumOutputTokens: plan.status === 'grown' ? plan.outputTokens : undefined });
    assert.ok(budget.inputBudget >= 5729 + 128);
});

test('known upper limit and actual input counts allow matching context growth rather than input underestimation', () => {
    const plan = planWriterOutputGrowth({ exhaustedCap: 1536, currentContextTokens: 8192,
        modelContextLimitVerified: true, modelContextLimit: 16384, estimatedPromptTokens: 4788,
        observedPromptTokens: 5729, reservedInputTokens: 0 });
    assert.equal(plan.status, 'grown');
    if (plan.status !== 'grown') { return; }
    assert.equal(plan.outputTokens, 2560);
    const growth = planContextGrowth({ currentContextTokens: 8192, modelContextLimit: 16384,
        modelContextLimitVerified: true, estimatedPromptTokens: 5729, reservedInputTokens: 128,
        requestOutputTokens: plan.outputTokens });
    assert.equal(growth.status, 'grown');
    if (growth.status === 'grown') { assert.ok(growth.inputBudget >= plan.requiredInputTokens); }
});

test('a slow length response can recover with a smaller bounded cap without exceeding its request time', () => {
    const plan = planWriterOutputGrowth({ exhaustedCap: 1536, currentContextTokens: 8192,
        modelContextLimitVerified: false, estimatedPromptTokens: 4788, observedPromptTokens: 5729,
        reservedInputTokens: 0, timedOutputLimit: 2008 });
    assert.equal(plan.status, 'grown');
    if (plan.status === 'grown') { assert.equal(plan.outputTokens, 2008); assert.equal(plan.boundedBy, 'time'); }
    assert.deepEqual(planWriterOutputGrowth({ exhaustedCap: 1536, currentContextTokens: 8192,
        modelContextLimitVerified: false, estimatedPromptTokens: 4788, reservedInputTokens: 0, timedOutputLimit: 1600 }),
        { status: 'blocked', reasonCode: 'insufficient-output-retry-time' });
});

test('invalid or exhausted input cannot borrow unknown model limits or shrink the learned floor', () => {
    const base = { exhaustedCap: 1536, currentContextTokens: 8192,
        modelContextLimitVerified: false, estimatedPromptTokens: 7000, reservedInputTokens: 0 };
    assert.deepEqual(planWriterOutputGrowth({ ...base, modelContextLimit: 999999 }),
        { status: 'blocked', reasonCode: 'no-output-headroom' });
    for (const invalid of [NaN, Infinity, -1, 12.5]) {
        assert.equal(planWriterOutputGrowth({ ...base, observedPromptTokens: invalid }).status, 'blocked');
        assert.equal(planWriterOutputGrowth({ ...base, timedOutputLimit: invalid }).status, 'blocked');
    }
    const budget = new WriterOutputBudget();
    assert.equal(budget.learn(2008), true);
    assert.equal(budget.learn(1536), false);
    assert.equal(budget.minimumTokens, 2008);
});
