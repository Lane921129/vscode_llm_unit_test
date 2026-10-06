import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWriterExpansionPrompt, buildWriterSeedPrompt } from '../roles/writerPhases';

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

test('expansion includes the exact executable baseline and only one requested gap', () => {
    const baseline = 'import unittest\n# preserve formatting\nclass Cases(unittest.TestCase):\n    pass\n';
    const gap = 'uncovered branch at source line 10';
    const prompt = buildWriterExpansionPrompt('verified evidence', baseline, gap);
    assert.ok(prompt.includes(baseline));
    assert.equal(prompt.split(gap).length - 1, 1);
    assert.match(prompt, /preserving the executed baseline unchanged/);
    assert.match(prompt, /adding one focused test/);
    assert.match(prompt, /return the unchanged baseline/);
    assert.match(prompt, /does not certify coverage or mutation quality/);
    assert.match(prompt, /responsible for writing the new test/);
    assert.match(prompt, /separate Reviewer before mutation/);
    assert.match(prompt, /exact constructor and ordered target calls/);
});

test('expansion keeps a large baseline whole for the shared request budget to decide', () => {
    const baseline = 'import unittest\n' + '# preserved line\n'.repeat(6000);
    const prompt = buildWriterExpansionPrompt('verified evidence', baseline, 'one measured gap');
    assert.ok(prompt.includes(baseline));
    assert.equal(prompt.split(baseline).length - 1, 1);
    assert.equal((prompt.match(/```/g) ?? []).length, 2);
});

test('expansion does not duplicate a baseline already included in the evidence prompt', () => {
    const baseline = 'import unittest\nclass Cases(unittest.TestCase):\n    pass\n';
    const prompt = buildWriterExpansionPrompt(`source and focus\n${baseline}\nverified observations`, baseline, 'one missing branch');
    assert.equal(prompt.split(baseline).length - 1, 1);
    assert.match(prompt, /baseline is already supplied above/i);
});
