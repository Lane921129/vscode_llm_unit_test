import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { addOutputContract } from '../llm/customApi';
import { estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE, SEMANTIC_CONTRACT_REPAIR_SUFFIX } from '../roles/semanticContractRepair';

test('Analyst correction reserve counts the final role and setup envelope before the initial request', () => {
    const system = addOutputContract('Return a concrete evidence-bound analysis plan.', 'semantic-json');
    const source = '=== ANALYSIS EVIDENCE V2 ===\n完整來源\r\ndef choose(value):\n    return value\n';
    const setup = '\nHOST_ISOLATED_RESOURCE_CONTEXT\n' + JSON.stringify({
        tables: [{ name: 'records', columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }] }]
    });
    const prompt = source + setup;
    const initialTokens = estimatePromptTokens(system + '\n' + prompt);
    const budget = initialTokens + SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE;
    assert.equal(promptFits(system, prompt, budget, SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE), true);
    assert.equal(promptFits(system, prompt, budget - 1, SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE), false);
    assert.equal(promptFits(system, source + SEMANTIC_CONTRACT_REPAIR_SUFFIX + setup, budget), true);
    assert.equal(promptFits(system, prompt, initialTokens), true, 'roles without a format retry keep their existing budget');
    assert.equal(promptFits(system, prompt, initialTokens, SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE), false);
});

test('an invalid correction reservation never increases the available model input budget', () => {
    for (const reserve of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(promptFits('role', 'evidence', 100, reserve), false);
    }
});
