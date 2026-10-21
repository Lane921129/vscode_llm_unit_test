import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleRequestBudget } from '../prompts/roleRequestBudget';
import { estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { buildWriterRevisionRequest } from '../roles/roleContracts';
import { buildOllamaPromptEnvelope } from '../llm/ollamaPrompt';
import { getCompletedOllamaText, readOutputShapeDiagnostic } from '../llm/ollamaResponse';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const revision = { envType: 'local', mode: 'full', role: 'writer-revision', seedPending: true,
    contextWindow: 8192, inputBudget: 5734, revisionWorkload: { findingCount: 1, missingScenarioCount: 0 } } as const;
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

test('multiple concrete findings reserve their revision work without adding prompt text or changing capacity', () => {
    const capacity = { contextWindow: 16384, inputBudget: 11468 };
    const budget = roleRequestBudget({ ...revision, ...capacity, revisionCurrentCode: code,
        revisionWorkload: { findingCount: 5, missingScenarioCount: 2 } });
    assert.deepEqual(budget, { inputBudget: 12800, reservedOutputTokens: 3584, requestOutputTokens: 3584 });
    const missing = roleRequestBudget({ ...revision, ...capacity, revisionCurrentCode: code,
        revisionWorkload: { findingCount: 3, missingScenarioCount: 3 } });
    assert.equal(missing.requestOutputTokens, 3072, 'missing-scenario findings need room even if they share one category');
    const bounded = roleRequestBudget({ ...revision, revisionCurrentCode: code,
        revisionWorkload: { findingCount: 5, missingScenarioCount: 5 } });
    assert.deepEqual(bounded, { ...original, requestOutputTokens: original.reservedOutputTokens });
    for (const value of [budget, missing, bounded]) {
        assert.equal(value.inputBudget + value.reservedOutputTokens,
            value === bounded ? revision.contextWindow : capacity.contextWindow);
        assert.equal(value.reservedOutputTokens, value.requestOutputTokens);
    }
});

test('unknown or invalid work retains the original reserve and learned floors never shrink', () => {
    for (const workload of [undefined, null, {}, { findingCount: 0, missingScenarioCount: 0 },
        { findingCount: 6, missingScenarioCount: 0 }, { findingCount: 1, missingScenarioCount: 2 },
        { findingCount: 2, missingScenarioCount: -1 }, { findingCount: 1.5, missingScenarioCount: 0 },
        { findingCount: 1, missingScenarioCount: NaN }, { findingCount: Infinity, missingScenarioCount: 0 },
        { findingCount: '5', missingScenarioCount: 0 }]) {
        assert.deepEqual(roleRequestBudget({ ...revision, revisionCurrentCode: code, revisionWorkload: workload as any }), original);
    }
    for (const revisionWorkload of [undefined, { findingCount: 1, missingScenarioCount: 0 },
        { findingCount: 5, missingScenarioCount: 2 }]) {
        const learned = roleRequestBudget({ ...revision, revisionCurrentCode: code, revisionWorkload, minimumOutputTokens: 4000 });
        assert.equal(learned.requestOutputTokens, 4000);
        assert.equal(learned.reservedOutputTokens, 4000);
        assert.equal(learned.inputBudget, 4192);
    }
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
            const diagnostic = error.diagnostic as Record<string, unknown>;
            assert.equal(diagnostic.reasonCode, 'output-token-limit');
            assert.equal(diagnostic.outputTokenLimit, 1536);
            assert.equal(readOutputShapeDiagnostic(diagnostic.responseShape)?.testMethods, 1);
            return true;
        },
        'a valid Python prefix at the new cap is still rejected before parsing or execution');
});
