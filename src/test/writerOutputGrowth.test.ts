import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { WriterOutputBudget } from '../prompts/writerOutputBudget';
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

test('learned Writer output floors never shrink a complete revision or alter another role', () => {
    const code = 'class TestExample:\n' + '    # retained setup and assertions\n'.repeat(400);
    const revision = roleRequestBudget({ ...request, role: 'writer-revision', revisionCurrentCode: code,
        minimumOutputTokens: 2560 });
    assert.ok(revision.requestOutputTokens! > 2560);
    assert.equal(roleRequestBudget({ ...request, role: 'analyst-planning', minimumOutputTokens: 9000 }).requestOutputTokens, 1024);
    assert.deepEqual(roleRequestBudget({ ...request, envType: 'cloud', minimumOutputTokens: 9000 }),
        roleRequestBudget({ ...request, envType: 'cloud' }));
});
