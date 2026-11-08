import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CASE_SCENARIO_ROW_LIMIT, CaseScenarioPromptFacts, getCaseRowCorrectionPrompt, getCaseScenarioPrompt, parseCaseRows
} from '../roles/semanticAnalyzer';
import { parseRequirements } from '../pipeline/caseTable/requirements';
import { readCaseTableFacts } from '../pipeline/caseTable/caseTableFacts';
import { readPipelineVersion, readSpecOracleSetting } from '../pipeline/caseTable/runCaseTablePipeline';

const forbiddenDomainTerms = /\b(?:token|jwt|bmi|payment_gateway|login_user|claims|partner)\b/i;
const facts: CaseScenarioPromptFacts = {
    signature: 'clamp(value, low=0, high=10)', className: null, methodKind: 'module', isAsync: false,
    docstring: 'Clamp value into [low, high].', raises: ['ValueError'],
    branches: [{ line: 3, kind: 'if', condition: 'low > high' }, { line: 5, kind: 'elif', condition: 'value < low' }],
    dependencies: [{ name: 'store.read' }],
    source: 'def clamp(value, low=0, high=10):\n    """Clamp value into [low, high]."""\n    if low > high:\n        raise ValueError("range")\n'
};

test('scenario prompt carries source, branches, dependencies and requirements, and caps the rows at eight', () => {
    const prompt = getCaseScenarioPrompt(facts, [{ id: 'R1', text: 'value above high returns high' }]);
    assert.equal(CASE_SCENARIO_ROW_LIMIT, 8);
    for (const expected of ['Target: clamp(value, low=0, high=10)', 'Clamp value into [low, high].', 'R1: value above high returns high',
        '- line 3: if low > high', '- line 5: elif value < low', 'Exceptions raised in the body: ValueError', '- store.read',
        facts.source, 'Write at most 8 lines', 'Output only the JSON lines (at most 8)']) {
        assert.ok(prompt.user.includes(expected), expected);
    }
    assert.match(prompt.system, /Do not predict or state the expected result/);
    assert.ok(prompt.user.trim().endsWith('with no other text.'), 'the last sentence is the output format');
    assert.equal((prompt.user.match(/^Example line:$/gm) ?? []).length, 1, 'exactly one example');
    assert.doesNotMatch(prompt.system + prompt.user, forbiddenDomainTerms);
    assert.doesNotMatch(prompt.user, /case-table-v1|hash|schema|verified/i, 'no internal contract names');
});

test('a target without docstring, requirements, branches or dependencies says so explicitly', () => {
    const prompt = getCaseScenarioPrompt({ ...facts, docstring: null, branches: [], raises: [], dependencies: [],
        className: 'Box', methodKind: 'instance' }, []);
    assert.match(prompt.user, /Docstring:\n\(none\)/);
    assert.match(prompt.user, /Requirements:\n\(none\)/);
    assert.match(prompt.user, /Branch conditions:\n\(none\)/);
    assert.match(prompt.user, /\(none\) - leave "mocks" empty/);
    assert.match(prompt.user, /Method of class Box \(instance method; args exclude self\)/);
});

test('correction prompt quotes only the broken line and names the problem', () => {
    const broken = '{"scenario":"x","category":"edge","args":"(1,)"}';
    const prompt = getCaseRowCorrectionPrompt(broken, 'unknown-category', 'category', facts, []);
    assert.ok(prompt.user.includes(broken));
    assert.match(prompt.user, /Problem: "category" is not one of the allowed values \(key "category"\)\./);
    assert.ok(prompt.user.trim().endsWith('Output only the one corrected JSON line, with no other text.'));
    assert.ok(!prompt.user.includes(facts.source), 'the correction does not resend the source');
});

test('parseCaseRows keeps the first eight accepted rows and records the rest as row-limit', () => {
    const lines = Array.from({ length: 11 }, (_, index) => JSON.stringify({ scenario: `s${index}`, category: 'normal', args: '()' }));
    lines.splice(2, 0, 'not json');
    const parsed = parseCaseRows(lines.join('\n'), { origin: 'analyst', requirementIds: [] });
    assert.equal(parsed.rows.length, 8);
    assert.deepEqual(parsed.rowLines, [1, 2, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(parsed.overLimit.map(item => item.line), [10, 11, 12]);
    assert.deepEqual(parsed.rejected, [{ line: 3, reason: 'invalid-json' }]);
    assert.equal(parseCaseRows(lines.join('\n'), { origin: 'analyst', requirementIds: [], limit: 1 }).rows.length, 1);
});

test('requirements file lines are parsed; notes are skipped and duplicate ids are rejected', () => {
    assert.deepEqual(parseRequirements('# 需求\n- R1: 下界包含 18.5\n* **R2**：上界不含\nnote line\nR10: ten'), [
        { id: 'R1', text: '下界包含 18.5' }, { id: 'R2', text: '上界不含' }, { id: 'R10', text: 'ten' }]);
    assert.throws(() => parseRequirements('R1: a\nR1: b'), /requirements-duplicate-id: R1/);
});

test('settings default to v1 and auto; facts tool errors are tool failures', () => {
    assert.equal(readPipelineVersion(undefined), 'v1');
    assert.equal(readPipelineVersion('v2'), 'v1');
    assert.equal(readPipelineVersion('v2-case-table'), 'v2-case-table');
    assert.equal(readSpecOracleSetting('off'), 'off');
    assert.equal(readSpecOracleSetting('anything'), 'auto');
    assert.throws(() => readCaseTableFacts('{"version":"case-table-facts-v1","error":"target-not-found"}'), /case-table-facts-failed/);
    assert.throws(() => readCaseTableFacts('nope'), /case-table-facts-malformed/);
});
