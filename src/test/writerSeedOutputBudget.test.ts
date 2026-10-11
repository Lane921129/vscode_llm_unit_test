import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleRequestBudget, BudgetedModelRole } from '../prompts/roleRequestBudget';
import { contextInputBudget, estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { buildOllamaPromptEnvelope } from '../llm/ollamaPrompt';
import { getCompletedOllamaText } from '../llm/ollamaResponse';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { getLanguage, setLanguage } from '../i18n/core';

const seed = { envType: 'local', mode: 'full', role: 'writer', seedPending: true,
    contextWindow: 8192, inputBudget: 5734 } as const;

test('one-case seed input and wire output reserve share the unchanged capacity', () => {
    const budget = roleRequestBudget(seed);
    assert.deepEqual(budget, { inputBudget: 6656, reservedOutputTokens: 1536, requestOutputTokens: 1536 });
    const envelope = buildOllamaPromptEnvelope('Complete role instructions', 'x'.repeat(22000));
    const separator = envelope.prompt.indexOf('\n');
    const system = envelope.prompt.slice(0, separator), prompt = envelope.prompt.slice(separator + 1);
    assert.ok(estimatePromptTokens(envelope.prompt) > seed.inputBudget, 'fixture exceeds the former full envelope allowance');
    assert.equal(promptFits(system, prompt, budget.inputBudget), true);
    assert.equal(promptFits(system, prompt, budget.inputBudget, 500), false, 'correction input reserve remains part of the same gate');
    assert.equal(promptFits(system, prompt + 'x'.repeat(2000), budget.inputBudget), false,
        'even a seed refuses the complete oversized envelope rather than borrowing output capacity');
    assert.equal(budget.inputBudget + budget.requestOutputTokens!, seed.contextWindow);
});

test('low-capacity seeds retain their original thirty-percent output allowance', () => {
    for (const contextWindow of [1, 2048, 4096]) {
        const inputBudget = contextInputBudget('13B', contextWindow);
        const budget = roleRequestBudget({ ...seed, contextWindow, inputBudget });
        assert.equal(budget.inputBudget, inputBudget);
        assert.equal(budget.requestOutputTokens, contextWindow - inputBudget);
        assert.equal(budget.reservedOutputTokens, contextWindow - inputBudget);
    }
});

test('other roles, revisions, expansion, execution and remote providers keep the existing allowance', () => {
    const roles: BudgetedModelRole[] = ['writer-revision', 'reviewer', 'bug-fixer', 'analyst-quality'];
    const cases = [ ...roles.map(role => ({ ...seed, role })), { ...seed, seedPending: false },
        { ...seed, mode: 'execution' as const }, { ...seed, envType: 'cloud' as const },
        { ...seed, envType: 'custom' as const } ];
    for (const input of cases) {
        assert.deepEqual(roleRequestBudget(input), { inputBudget: 5734, reservedOutputTokens: 2458 });
    }
});

test('Analyst short-plan output cap is independent of Writer phase and model size', () => {
    for (const seedPending of [true, false]) {
        assert.deepEqual(roleRequestBudget({ ...seed, role: 'analyst-planning', seedPending }),
            { inputBudget: 7168, reservedOutputTokens: 1024, requestOutputTokens: 1024 });
    }
    assert.deepEqual(roleRequestBudget({ ...seed, role: 'analyst-planning', contextWindow: 2048, inputBudget: 1433 }),
        { inputBudget: 1433, reservedOutputTokens: 615, requestOutputTokens: 615 });
    assert.deepEqual(roleRequestBudget({ ...seed, role: 'analyst-planning', envType: 'cloud' }),
        { inputBudget: 5734, reservedOutputTokens: 2458 });
});

test('length completion rejects a valid Python prefix without exposing provider content', () => {
    const validPrefix = 'import unittest\nclass Tests(unittest.TestCase):\n    def test_one(self):\n        self.assertEqual(1, 1)\n';
    assert.throws(() => getCompletedOllamaText({ response: validPrefix, done: true, done_reason: 'length',
        privateProviderField: 'withheld provider response' }, 1536), (error: unknown) => {
        assert.ok(error instanceof AnalysisStageError);
        assert.equal(error.category, 'model-format');
        assert.equal(error.stage, 'model-request');
        assert.deepEqual(error.diagnostic, { reasonCode: 'output-token-limit', outputTokenLimit: 1536 });
        assert.ok(!error.message.includes(validPrefix) && !JSON.stringify(error.diagnostic).includes('provider'));
        return true;
    });
    assert.equal(getCompletedOllamaText({ response: validPrefix, done: true, done_reason: 'stop' }, 1536), validPrefix);
    assert.equal(getCompletedOllamaText({ response: validPrefix }), validPrefix, 'legacy fixtures keep their existing compatibility');
});

test('output-limit diagnostics follow the selected English language', () => {
    const previous = getLanguage();
    try {
        setLanguage('en');
        assert.throws(() => getCompletedOllamaText({ response: 'withheld content', done_reason: 'length' }),
            (error: unknown) => {
                assert.ok(error instanceof AnalysisStageError);
                assert.match(error.message, /output limit before completion/);
                assert.doesNotMatch(error.message, /[\u3400-\u9fff]|withheld content/);
                return true;
            });
    } finally { setLanguage(previous); }
});
