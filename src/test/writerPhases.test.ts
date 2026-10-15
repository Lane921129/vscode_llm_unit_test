import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWriterAdditionRevisionPrompt, buildWriterAdditionSystemPrompt, buildWriterExpansionPrompt,
    buildWriterSeedPrompt, buildWriterSeedSystemPrompt, buildWriterCaseAdditionPrompt,
    selectWriterAdditionMethodName, buildWriterAdditionMethodInstruction } from '../roles/writerPhases';
import { PLAIN_TEST_GENERATION_PROBE_PROMPT } from '../llm/testGenerationQualification';

test('addition packaging selects stable fresh names across all AST-proven baseline classes', () => {
    const baselineHash = 'a'.repeat(64);
    const name = selectWriterAdditionMethodName(baselineHash, 'measured-gap-1', ['Cases.test_seed']);
    assert.match(name, /^test_add_[a-f0-9]{12}_[a-f0-9]{12}$/);
    assert.equal(selectWriterAdditionMethodName(baselineHash, 'measured-gap-1', []), name);
    assert.equal(selectWriterAdditionMethodName(baselineHash, 'measured-gap-1',
        [`Cases.${name}`, `Other.${name}_2`]), `${name}_3`);
    assert.notEqual(selectWriterAdditionMethodName('b'.repeat(64), 'measured-gap-1', []), name);
    assert.notEqual(selectWriterAdditionMethodName(baselineHash, 'measured-gap-2', []), name);
    const instruction = buildWriterAdditionMethodInstruction(name);
    assert.ok(instruction.endsWith(`def ${name}(self):\n`));
    assert.match(instruction, /must author its setup, target calls and assertions/);
    assert.match(instruction, /does not make a repeated scenario new/);
    assert.doesNotMatch(instruction, /assertEqual|assertRaises|return_value|pass\n/);
});

test('seed requests one evidence-supported executable case without changing the output contract', () => {
    const evidence = 'Complete binding and source evidence\nVerified target(1) = 2';
    const prompt = buildWriterSeedPrompt(evidence);
    assert.ok(prompt.startsWith(evidence));
    assert.match(prompt, /exactly one test method/);
    assert.match(prompt, /execute this seed successfully before/);
    assert.match(prompt, /do not invent an expected value or exception/i);
    assert.match(prompt, /existing output contract/);
    assert.doesNotMatch(prompt, /Return.*JSON/);
});

test('formal seed system scope overrides broad scenario requests without changing qualification or safety contracts', () => {
    const system = 'Write a comprehensive test suite following the Analyst scenarios. No direct I/O. Real target and observed assertions only.';
    const probe = PLAIN_TEST_GENERATION_PROBE_PROMPT;
    const seed = buildWriterSeedSystemPrompt(system);
    assert.ok(seed.startsWith(system), 'the original safety and oracle contract remains verbatim');
    assert.match(seed, /WRITER_SEED_V1 OUTPUT SCOPE/);
    assert.match(seed, /replace comprehensive-suite, all-boundary and wider Analyst scenario requirements/);
    assert.match(seed, /exactly ONE test method and ONE target call/);
    assert.match(seed, /use ONLY that selected executed case/);
    assert.match(seed, /Do not select another observed example or substitute an Analyst\/model hint/);
    assert.match(seed, /Expansion happens only after this seed executes successfully/);
    assert.match(seed, /isolation and oracle rules above/);
    assert.match(seed, /Execution and independent Reviewer approval remain required/);
    assert.equal(PLAIN_TEST_GENERATION_PROBE_PROMPT, probe);
    assert.match(probe, /include BOTH/);
    assert.doesNotMatch(probe, /WRITER_SEED|exactly ONE target call/);
    const addition = buildWriterAdditionSystemPrompt(system);
    assert.doesNotMatch(addition, /WRITER_SEED_V1/);
    assert.match(addition, /multiple target calls.*EVERY supplied bound case/);
});

test('addition mode resolves standalone-file system packaging without weakening any evidence or isolation rule', () => {
    const system = 'Complete runnable unittest file. No direct I/O; evidence-supported assertions only.';
    const prompt = buildWriterAdditionSystemPrompt(system);
    assert.ok(prompt.startsWith(system));
    assert.match(prompt, /replace the complete-file packaging requirement/);
    assert.match(prompt, /one Python fence/);
    assert.match(prompt, /All target binding, evidence, assertion and isolation rules above still apply/);
    assert.match(prompt, /Replace comprehensive-suite and all-survivor scope with the current focus only/);
    assert.match(prompt, /multiple target calls.*EVERY supplied bound case exactly/);
    assert.match(prompt, /do not add unrelated zero, negative or exception inputs/);
    assert.doesNotMatch(prompt, /skip.*validation|automatically approve|ignore.*evidence/i);
});

test('expansion includes the exact executable baseline and only one requested gap', () => {
    const baseline = 'import unittest\n# preserve formatting\nclass Cases(unittest.TestCase):\n    pass\n';
    const gap = 'uncovered branch at source line 10';
    const prompt = buildWriterExpansionPrompt('verified evidence', baseline, gap);
    assert.ok(prompt.includes(baseline));
    assert.equal(prompt.split(gap).length - 1, 1);
    assert.match(prompt, /preserving the executed baseline unchanged/);
    assert.match(prompt, /one focused test/);
    assert.match(prompt, /Return only the Python addition/);
    assert.match(prompt, /complete top-level def test_/);
    assert.match(prompt, /conflicting imports, fixtures and existing method changes are rejected/);
    assert.doesNotMatch(prompt, /Return the complete unittest file/);
    assert.match(prompt, /return the unchanged baseline/);
    assert.match(prompt, /does not certify coverage or mutation quality/);
    assert.match(prompt, /responsible for writing the new test/);
    assert.match(prompt, /separate Reviewer before mutation/);
    assert.match(prompt, /exact constructor and ordered target calls/);
});

test('addition revision replaces only the failed draft and preserves the immutable baseline', () => {
    const baseline = 'class Cases(unittest.TestCase):\n    def test_passed(self): self.assertEqual(target(1), 2)\n';
    const draft = baseline + '\n# unaccepted addition';
    const prompt = buildWriterAdditionRevisionPrompt('source evidence', baseline, draft, 'test_added observed return differs');
    assert.ok(prompt.includes(baseline));
    assert.ok(prompt.includes(draft));
    assert.match(prompt, /WRITER_ADDITION_REVISION_V1/);
    assert.match(prompt, /Return the replacement addition only/);
    assert.match(prompt, /original baseline, not with this failed draft/);
    assert.match(prompt, /same-candidate Reviewer approval/);
    assert.match(prompt, /test_added observed return differs/);
});

test('expansion keeps a large baseline whole for the shared request budget to decide', () => {
    const baseline = 'import unittest\n' + '# preserved line\n'.repeat(6000);
    const prompt = buildWriterExpansionPrompt('verified evidence', baseline, 'one measured gap');
    assert.ok(prompt.includes(baseline));
    assert.equal(prompt.split(baseline).length - 1, 1);
    assert.equal((prompt.match(/```/g) ?? []).length, 2);
});

test('expansion does not duplicate a baseline already supplied as an exact complete Python fence', () => {
    const baseline = 'import unittest\nclass Cases(unittest.TestCase):\n    pass\n';
    const prompt = buildWriterExpansionPrompt(`source and focus\n\`\`\`python\n${baseline}\n\`\`\`\nverified observations`, baseline, 'one missing branch');
    assert.equal(prompt.split(baseline).length - 1, 1);
    assert.match(prompt, /baseline is already supplied above/i);
});

test('a case setup projection stays explicitly distinct from the original executable baseline', () => {
    const context = 'import unittest\nfrom example import target\nclass Cases(unittest.TestCase):\n    pass\n';
    const prompt = buildWriterCaseAdditionPrompt('complete source and exact observed case', context,
        'a'.repeat(64), ['Cases.test_seed'], 'one current case');
    assert.ok(prompt.includes(context));
    assert.match(prompt, /AST projection only/);
    assert.match(prompt, /existing test bodies remain unchanged with the host/);
    assert.match(prompt, /not an executable test candidate/);
    assert.match(prompt, /validates the full family, executes, obtains independent Reviewer approval/);
    assert.ok(!prompt.includes('EXECUTED BASELINE ('));
    assert.match(prompt, /"existingMethodIds":\["Cases.test_seed"\]/);
});
test('an original baseline prefix in a larger unapproved candidate is supplied as its own complete unit', () => {
    const baseline = 'import unittest\nclass Cases(unittest.TestCase):\n    def test_seed(self):\n        self.assertEqual(1, 1)';
    const current = baseline + '\n    def test_new(self):\n        self.assertEqual(2, 2)';
    const feedback = 'The Reviewer requests a concrete additional assertion in test_new.';
    const evidence = `CURRENT UNACCEPTED CANDIDATE:\n\`\`\`python\n${current}\n\`\`\`\n${feedback}`;
    const prompt = buildWriterAdditionRevisionPrompt(evidence, baseline, current, feedback);
    const complete = [...prompt.matchAll(/^```python\n([\s\S]*?)\n```/gm)].map(match => match[1]);
    assert.equal(complete.filter(code => code === baseline).length, 1);
    assert.equal(complete.filter(code => code === current).length, 1);
    assert.ok(prompt.includes(feedback));
    assert.match(prompt, /host merges with that original baseline, not with this failed draft/);
});

test('plain source substrings cannot masquerade as complete supplied baseline or draft units', () => {
    const baseline = 'import unittest\nclass Cases(unittest.TestCase):\n    def test_seed(self):\n        self.assertEqual(1, 1)';
    const current = baseline + '\n    def test_new(self):\n        self.assertEqual(2, 2)';
    const prompt = buildWriterAdditionRevisionPrompt(`SOURCE TEXT ONLY:\n${current}`, baseline, current);
    const complete = [...prompt.matchAll(/^```python\n([\s\S]*?)\n```/gm)].map(match => match[1]);
    assert.equal(complete.filter(code => code === baseline).length, 1);
    assert.equal(complete.filter(code => code === current).length, 1);
});
