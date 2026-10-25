import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleRequestBudget, BudgetedModelRole } from '../prompts/roleRequestBudget';
import { contextInputBudget, estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { buildOllamaPromptEnvelope } from '../llm/ollamaPrompt';
import { getCompletedOllamaText, readOutputShapeDiagnostic } from '../llm/ollamaResponse';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { getLanguage, setLanguage } from '../i18n/core';

const seed = { envType: 'local', mode: 'full', role: 'writer', seedPending: true,
    contextWindow: 8192, inputBudget: 5734 } as const;

test('one-case seed input and wire output reserve share the unchanged capacity', () => {
    const budget = roleRequestBudget(seed);
    assert.deepEqual(roleRequestBudget({ ...seed, mode: 'execution', seedPending: false }), budget,
        'execution-first initial generation owns the same bounded seed output, independently of the full-mode phase flag');
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

test('other roles, revisions, expansion and remote providers keep the existing allowance', () => {
    const roles: BudgetedModelRole[] = ['writer-revision', 'reviewer', 'bug-fixer', 'analyst-quality'];
    const cases = [ ...roles.map(role => ({ ...seed, role })), { ...seed, seedPending: false },
        { ...seed, envType: 'cloud' as const },
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

test('an explicit local Analyst recovery floor pairs its larger output with the same capacity', () => {
    for (const mode of ['full', 'execution'] as const) {
        for (const seedPending of [true, false]) {
            const input = { ...seed, mode, role: 'analyst-planning' as const, seedPending, minimumOutputTokens: 1792 };
            const recovered = roleRequestBudget(input);
            assert.deepEqual(recovered, { inputBudget: 6400, reservedOutputTokens: 1792, requestOutputTokens: 1792 });
            assert.equal(recovered.inputBudget + recovered.requestOutputTokens!, input.contextWindow);
            assert.deepEqual(roleRequestBudget({ ...input, minimumOutputTokens: undefined }),
                { inputBudget: 7168, reservedOutputTokens: 1024, requestOutputTokens: 1024 },
                'a recovery floor is explicit request data and never changes the initial Analyst policy');
        }
    }
    const small = roleRequestBudget({ ...seed, role: 'analyst-planning', contextWindow: 2048,
        inputBudget: 1433, minimumOutputTokens: 768 });
    assert.deepEqual(small, { inputBudget: 1280, reservedOutputTokens: 768, requestOutputTokens: 768 });
});

test('Analyst and Writer explicit floors remain independent and unsupported roles or remote providers ignore floors', () => {
    const analyst = roleRequestBudget({ ...seed, role: 'analyst-planning', minimumOutputTokens: 1792 });
    const writer = roleRequestBudget({ ...seed, minimumOutputTokens: 2560 });
    assert.equal(analyst.requestOutputTokens, 1792);
    assert.equal(writer.requestOutputTokens, 2560);
    assert.equal(roleRequestBudget({ ...seed, role: 'analyst-planning' }).requestOutputTokens, 1024);
    assert.equal(roleRequestBudget(seed).requestOutputTokens, 1536);
    for (const role of ['reviewer', 'bug-fixer', 'analyst-quality'] as const) {
        assert.deepEqual(roleRequestBudget({ ...seed, role, minimumOutputTokens: 9000 }), roleRequestBudget({ ...seed, role }));
    }
    for (const envType of ['cloud', 'custom'] as const) {
        assert.deepEqual(roleRequestBudget({ ...seed, envType, role: 'analyst-planning', minimumOutputTokens: 9000 }),
            roleRequestBudget({ ...seed, envType, role: 'analyst-planning' }));
    }
});

test('invalid Analyst floors are ignored and an oversized valid floor cannot borrow input room', () => {
    const base = { ...seed, role: 'analyst-planning' as const };
    for (const minimumOutputTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.deepEqual(roleRequestBudget({ ...base, minimumOutputTokens }), roleRequestBudget(base));
    }
    assert.equal(roleRequestBudget({ ...base, minimumOutputTokens: 1 }).requestOutputTokens, 1024,
        'a smaller floor cannot shrink the existing bounded initial cap');
    const exhausted = roleRequestBudget({ ...base, minimumOutputTokens: 9000 });
    assert.equal(exhausted.requestOutputTokens, 9000);
    assert.equal(exhausted.inputBudget, 0, 'the requested output is not silently lowered below the role-owned floor');
    assert.equal(promptFits('Complete Analyst contract', 'Complete source and observations', exhausted.inputBudget), false,
        'the unchanged complete prompt must be rejected or requalified at a sufficient context before transport');
});

test('length completion rejects a valid Python prefix without exposing provider content', () => {
    const validPrefix = 'import unittest\nclass Tests(unittest.TestCase):\n    def test_one(self):\n        self.assertEqual(1, 1)\n';
    assert.throws(() => getCompletedOllamaText({ response: validPrefix, done: true, done_reason: 'length',
        privateProviderField: 'withheld provider response' }, 1536), (error: unknown) => {
        assert.ok(error instanceof AnalysisStageError);
        assert.equal(error.category, 'model-format');
        assert.equal(error.stage, 'model-request');
        const diagnostic = error.diagnostic as Record<string, unknown>;
        assert.equal(diagnostic.reasonCode, 'output-token-limit');
        assert.equal(diagnostic.outputTokenLimit, 1536);
        assert.equal(readOutputShapeDiagnostic(diagnostic.responseShape)?.testMethods, 1);
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
