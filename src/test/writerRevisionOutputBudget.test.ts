import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleRequestBudget } from '../prompts/roleRequestBudget';
import { estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { buildWriterRevisionRequest } from '../roles/roleContracts';
import { buildOllamaPromptEnvelope } from '../llm/ollamaPrompt';
import { getCompletedOllamaText } from '../llm/ollamaResponse';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const revision = { envType: 'local', mode: 'full', role: 'writer-revision', seedPending: true,
    contextWindow: 8192, inputBudget: 5734 } as const;
const original = { inputBudget: 5734, reservedOutputTokens: 2458 };
const code = 'import unittest\nfrom sample import increment\nclass Cases(unittest.TestCase):\n'
    + '    def test_existing(self):\n        self.assertEqual(increment(1), 2)\n';

test('small complete Writer revision pairs its output cap with the selected context', () => {
    for (const seedPending of [true, false]) {
        assert.deepEqual(roleRequestBudget({ ...revision, seedPending, revisionCurrentCode: code }),
            { inputBudget: 6656, reservedOutputTokens: 1536, requestOutputTokens: 1536 });
    }
});

test('larger complete candidates reserve growth instead of using a fixed seed limit', () => {
    for (const tokens of [1280, 1600]) {
        const candidate = '#'.repeat(tokens * 3.5);
        assert.equal(estimatePromptTokens(candidate), tokens);
        const expected = Math.ceil(tokens * 1.25) + 256;
        assert.deepEqual(roleRequestBudget({ ...revision, revisionCurrentCode: candidate }),
            { inputBudget: 8192 - expected, reservedOutputTokens: expected, requestOutputTokens: expected });
    }
    assert.deepEqual(roleRequestBudget({ ...revision, revisionCurrentCode: '#'.repeat(1762 * 3.5) }), original,
        'a larger candidate retains the old allowance and has no tighter wire cap');
});

test('remote, execution, other roles, missing and invalid current candidates retain the prior policy', () => {
    const cases = [
        { ...revision, envType: 'cloud' as const, revisionCurrentCode: code },
        { ...revision, envType: 'custom' as const, revisionCurrentCode: code },
        { ...revision, mode: 'execution' as const, revisionCurrentCode: code },
        { ...revision, role: 'reviewer' as const, revisionCurrentCode: code },
        { ...revision, role: 'bug-fixer' as const, revisionCurrentCode: code },
        { ...revision }, { ...revision, revisionCurrentCode: '' }, { ...revision, revisionCurrentCode: ' \r\n' },
        ...[null, 7, {}, []].map(value => ({ ...revision, revisionCurrentCode: value as any }))
    ];
    for (const input of cases) { assert.deepEqual(roleRequestBudget(input), original); }
});

test('small contexts and invalid capacity inputs never acquire a revision wire cap', () => {
    assert.deepEqual(roleRequestBudget({ ...revision, contextWindow: 4096, inputBudget: 2867, revisionCurrentCode: code }),
        { inputBudget: 2867, reservedOutputTokens: 1229 });
    for (const capacity of [NaN, Infinity, 0, -1, 8192.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(roleRequestBudget({ ...revision, contextWindow: capacity, revisionCurrentCode: code }).requestOutputTokens, undefined);
    }
    for (const allowance of [NaN, Infinity, -1, 5734.5, 8192]) {
        assert.equal(roleRequestBudget({ ...revision, inputBudget: allowance, revisionCurrentCode: code }).requestOutputTokens, undefined);
    }
});

test('the 6125-token failure envelope fits without slicing source, setup, observations or current code', () => {
    const source = 'def increment(value):\n    return value + 1';
    const facts = 'SOURCE\n' + source + '\nSETUP_EXACT\nTRACE_EXACT\nPASSING_CASE_EXACT\n';
    let prompt = buildWriterRevisionRequest({ code, findings: 'Correct the source-supported missing helper import.',
        moduleName: 'sample', functionName: 'increment', evidence: facts });
    const system = 'You are the test Writer. Keep the complete candidate and verified evidence.';
    const missingCharacters = 6125 * 3.5 - (system.length + 1 + prompt.length);
    prompt += '\n' + '#'.repeat(Math.floor(missingCharacters) - 1);
    assert.equal(estimatePromptTokens(system + '\n' + prompt), 6125);
    assert.equal(promptFits(system, prompt, revision.inputBudget), false);
    const budget = roleRequestBudget({ ...revision, revisionCurrentCode: code });
    assert.equal(promptFits(system, prompt, budget.inputBudget), true);
    assert.equal(promptFits(system, prompt, budget.inputBudget, 600), false, 'input correction reserves remain enforced');
    const wire = buildOllamaPromptEnvelope(system, prompt);
    assert.equal(wire.prompt, system + '\n' + prompt);
    assert.equal(wire.prompt.split(code).length - 1, 1);
    assert.ok(wire.prompt.includes(facts));
    assert.equal(budget.inputBudget + budget.requestOutputTokens!, revision.contextWindow);
    assert.throws(() => getCompletedOllamaText({ response: code, done_reason: 'length' }, budget.requestOutputTokens),
        (error: unknown) => {
            assert.ok(error instanceof AnalysisStageError);
            assert.equal(error.category, 'model-format');
            assert.deepEqual(error.diagnostic, { reasonCode: 'output-token-limit', outputTokenLimit: 1536 });
            return true;
        },
        'a valid Python prefix at the new cap is still rejected before parsing or execution');
});
