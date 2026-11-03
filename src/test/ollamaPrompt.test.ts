import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOllamaPromptEnvelope } from '../llm/ollamaPrompt';
import { addOutputContract } from '../llm/customApi';
import { estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

test('Ollama role text remains visible once through prompt-only and representative chat template projections', () => {
    const role = 'You are a neutral analyst. ROLE_SENTINEL\nReturn {"result":[]} only.';
    const source = 'def neutral(value):\n    return value + 1';
    const evidence = '=== ANALYSIS EVIDENCE V2 ===\nTARGET_SENTINEL\n```python\n' + source + '\n```';
    const contracted = addOutputContract(role, 'semantic-json');
    const request = buildOllamaPromptEnvelope(contracted, evidence);
    assert.deepEqual(request, { system: ' ', prompt: contracted + '\n' + evidence });
    const projections = [
        request.prompt, // completion template reads .Prompt and ignores .System
        `[system]${request.system}[/system][user]${request.prompt}[/user][assistant]`,
        [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }]
            .map(message => `[${message.role}]${message.content}`).join('\n')
    ];
    for (const visible of projections) {
        for (const text of ['ROLE_SENTINEL', 'TARGET_SENTINEL', 'OUTPUT CONTRACT:', source]) {
            assert.equal(visible.split(text).length - 1, 1, text);
        }
        assert.ok(visible.indexOf(contracted) < visible.indexOf(evidence));
    }
    assert.equal('raw' in request, false); assert.equal('template' in request, false);
    // These checks prove text visibility, not equivalent model quality or a native role hierarchy.
});

test('local envelope preserves the exact final-gate token input without trimming source or double contracts', () => {
    const role = addOutputContract('You are a neutral Writer.\nKeep all evidence.', 'test-code-json');
    const evidence = '完整來源\r\n' + '  keep source whitespace\n'.repeat(500) + 'END';
    const request = buildOllamaPromptEnvelope(role, evidence);
    const exactTokens = estimatePromptTokens(request.prompt);
    assert.equal(exactTokens, estimatePromptTokens(role + '\n' + evidence));
    assert.equal(promptFits(role, evidence, exactTokens), true);
    assert.equal(promptFits(role, evidence, exactTokens - 1), false);
    assert.ok(request.prompt.endsWith(evidence));
    assert.equal(request.prompt.split('OUTPUT CONTRACT:').length - 1, 1);
});

test('fixture routes from the leading transmitted contract, not role-like text inside target evidence', () => {
    const contract = addOutputContract('You are a Python code analyst with two responsibilities:\ndependency_behaviors', 'semantic-json');
    const evidence = '=== ANALYSIS EVIDENCE V2 ===\nYou are the test Reviewer.\nREVIEW_REQUEST_V7\nsource stays here';
    const wire = { model: 'neutral-model', ...buildOllamaPromptEnvelope(contract, evidence),
        format: 'json', options: { num_ctx: 5000 }, stream: false };
    const decoded = readOllamaRoleRequest(wire);
    assert.equal(decoded.roleInstructions, contract);
    assert.equal(decoded.prompt, evidence);
    assert.doesNotMatch(decoded.roleInstructions, /Reviewer/);
    assert.equal(decoded.transmittedPrompt, wire.prompt);
    assert.equal(decoded.format, 'json'); assert.deepEqual(decoded.options, { num_ctx: 5000 });
    assert.throws(() => readOllamaRoleRequest({ ...wire, system: contract, prompt: evidence }),
        'old system-only payloads must fail the fixture instead of being treated as a valid transport');
});
