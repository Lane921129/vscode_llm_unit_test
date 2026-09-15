import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchTestRules } from '../pipeline/testRuleDispatcher';
import { PYTHON_TOOLS, pythonToolPath } from '../pipeline/pythonTools';
import { buildSemanticAnalyzerSystemPrompt } from '../roles/semanticAnalyzer';
import { QUALIFICATION_VERSION, qualificationEndpointKey, qualificationForRequest } from '../llm/modelQualification';
import { findModelProfile, restoreModelProfiles, upsertModelProfile } from '../llm/modelProfileRegistry';
import { validateTraceEvidence } from '../validation/traceAssertionEvidence';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

test('all workflow Python tools exist and runtime tools are not packaged as test files', () => {
    for (const key of Object.keys(PYTHON_TOOLS) as Array<keyof typeof PYTHON_TOOLS>) {
        assert.ok(fs.existsSync(pythonToolPath(key)), key);
        assert.ok(!path.basename(pythonToolPath(key)).startsWith('test_'), key);
    }
});

test('analyst no longer selects rules; deterministic dispatch still supplies relevant guidance', () => {
    const prompt = buildSemanticAnalyzerSystemPrompt();
    assert.doesNotMatch(prompt, /required_skills|AVAILABLE SKILL IDs|skill_id_1/);
    const selection = dispatchTestRules('def target(value):\n    if len(value) < 4: raise ValueError()\n    return value');
    assert.ok(selection.ids.includes('string_length_boundary'));
    assert.ok(selection.ids.includes('assert_raises_syntax'));
    assert.equal(selection.provenance, 'deterministic');
    assert.equal(selection.schemaVersion, 'rule-selection-v2');
    assert.ok(selection.selectedRules.every(rule => rule.triggerFacts.length > 0));
    assert.ok(selection.selectedRules.every(rule =>
        rule.triggerFacts.every(fact => !fact.startsWith('analyst-'))
        && rule.triggerFacts.every(fact => !fact.startsWith('deterministic-selector:'))
    ));
    assert.ok(selection.selectedRules.some(rule =>
        rule.ruleId === 'string_length_boundary'
        && rule.triggerFacts.some(fact => /source-line-2:.*len\(value\)/.test(fact))
    ));
});

test('old probe metadata expires without converting historical JSON success into Python success', () => {
    const old = { envType: 'local' as const, modelName: 'fixture', paramSize: '8B', contextLength: 8192,
        testGenerationReady: true, testGenerationMode: '結構化 JSON unittest' };
    const [restored] = restoreModelProfiles([old]);
    assert.equal(restored.testGenerationReady, false);
    assert.match(restored.testGenerationReason!, /過期/);
    assert.equal(restored.testGenerationMode, old.testGenerationMode);
    assert.equal(qualificationForRequest(old, old), false);
    assert.equal(qualificationForRequest({ ...old, qualificationVersion: QUALIFICATION_VERSION }, old), true);
});

test('same model on different endpoints has separate qualification and keys omit credentials', () => {
    const firstKey = qualificationEndpointKey('local', 'http://127.0.0.1:11434/');
    const secondKey = qualificationEndpointKey('local', 'http://127.0.0.1:11435/');
    assert.notEqual(firstKey, secondKey);
    assert.equal(firstKey, qualificationEndpointKey('local', 'http://user:pass@127.0.0.1:11434/?key=private'));
    const first = { envType: 'local' as const, modelName: 'fixture', paramSize: '8B', contextLength: 8192,
        testGenerationReady: true, qualificationVersion: QUALIFICATION_VERSION, endpointKey: firstKey };
    const profiles = upsertModelProfile(upsertModelProfile([], first), { ...first, endpointKey: secondKey, testGenerationReady: false });
    assert.equal(profiles.length, 2);
    assert.equal(findModelProfile(profiles, first)?.testGenerationReady, true);
    assert.equal(qualificationForRequest(first, { ...first, endpointKey: secondKey }), false);
});

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const wrap = (body: string, before = '') => 'import unittest\nfrom sample import target\n' + before
    + '\nclass Cases(unittest.TestCase):\n    def test_case(self):\n' + body.split('\n').map(line => '        ' + line).join('\n');
const check = (body: string, result = 'True', args: string[] = [], before = '') =>
    validateTraceEvidence(wrap(body, before), 'target', { examples: [{ args, result }] }, 'sample', python);

test('AST evidence catches temporary results, multiline assertions and exact boolean identity', async () => {
    assert.equal((await check('value = target()\nself.assertIs(value, False)')).valid, false);
    assert.equal((await check('value = target()\nself.assertEqual(\n    value,\n    False,\n)')).valid, false);
    assert.equal((await check('self.assertIs(target(), False)', 'None')).valid, false);
    assert.equal((await check('self.assertEqual(target(), 0)', 'False')).valid, true);
    assert.equal((await check('self.assertIs(target(), False)', 'False')).valid, true);
});

test('AST evidence does not confuse string contents, comments, overwritten results or untraced inputs', async () => {
    assert.equal((await check('self.assertEqual(target("a b"), "wrong")', '"right"', ['"ab"'])).valid, true);
    assert.equal((await check('self.assertEqual(target(), "ab")', '"a b"')).valid, false);
    assert.equal((await check('# self.assertIs(target(), False)\nself.assertTrue(target())')).valid, true);
    assert.equal((await check('value = target()\nvalue = False\nself.assertIs(value, False)')).valid, true);
    assert.equal((await check('self.assertEqual(target(99), "unknown")', '"known"', ['1'])).valid, true);
    const unknownHelper = await check('value = target()\nself.assertEqual(mutate(value), False)\nself.assertIs(value, False)');
    assert.equal(unknownHelper.valid, true);
    assert.equal((await check('value = target()\nother = (mutate(), 1)\nself.assertIs(value, False)')).valid, true);
});

test('real Trace is not applied to patched or fixture-controlled dependency behavior', async () => {
    const patched = await check('with patch("sample.read", return_value=False):\n    self.assertIs(target(), False)', 'True', [], 'from unittest.mock import patch\n');
    assert.equal(patched.valid, true);
    const fixture = wrap('self.assertIs(target(), False)').replace('    def test_case', '    def setUp(self):\n        self.value = 1\n    def test_case');
    assert.equal((await validateTraceEvidence(fixture, 'target', { examples: [{ args: [], result: 'True' }] }, 'sample', python)).valid, true);
});

test('AST evidence resolves direct import aliases and rejects neither unrelated methods nor conflicting traces', async () => {
    const alias = wrap('self.assertIs(run(), False)').replace('from sample import target', 'from sample import target as run');
    assert.equal((await validateTraceEvidence(alias, 'target', { examples: [{ args: [], result: 'True' }] }, 'sample', python)).valid, false);
    assert.equal((await check('self.assertIs(other.target(), False)')).valid, true);
    assert.equal((await validateTraceEvidence(wrap('self.assertIs(target(), False)'), 'target', {
        examples: [{ args: [], result: 'True' }, { args: [], result: 'False' }]
    }, 'sample', python)).valid, true);
});
