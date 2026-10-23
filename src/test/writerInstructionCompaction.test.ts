import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSystemPrompt, getUserPrompt } from '../roles/unittestWriter';
import { buildWriterSeedPrompt, buildWriterSeedSystemPrompt } from '../roles/writerPhases';
import { createHash } from 'node:crypto';
import { ImportFixturePlan, withImportFixtures } from '../pipeline/importFixtures';
import { isolatedResourceSystemRule } from '../prompts/isolatedResourceContext';
import { estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { roleRequestBudget } from '../prompts/roleRequestBudget';
import { buildOllamaPromptEnvelope } from '../llm/ollamaPrompt';
import { formatWriterSeedPackaging } from '../pipeline/targetContract';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

// Freeze the prior instructions as a size/control fixture, rather than changing
// the input/output budget or removing evidence to make the new prompt fit.
const previousSmallSystem = () => `You are a Python unit test writer. Return one complete runnable unittest file, no prose.

Output format:
\`\`\`python
(your unittest code)
\`\`\`

Import unittest, target and test helpers explicitly. Use the exact target module/class binding, unittest.TestCase, test_ methods and self.assert*; no pytest or top-level assert.
Keep the real target; never copy/redefine/mock it or its owner class. Assertions require exact Verified Real Execution Results, a proven source path or same-test controlled behavior; never guess outputs or exception types.
For an evidenced exception use \`with self.assertRaises(ExceptionType):\`, never a message string as its second argument. Do not call dependencies to calculate expected values.
For pure standard-library parsing, formatting or calculation, prefer real target calls with source-supported literal inputs. Imported helpers alone do not require mocks. Mock only source-shown external or ambient boundaries when control is needed. Never patch immutable built-in class members; replace the owning module binding if necessary. Inputs and source expressions do not prove expected values; retain verified-observation or explicit same-test evidence requirements.
Patch external dependencies at source-shown use points, with fresh per-test state; no direct test network/file/shell/dynamic execution or shared SQLite.${isolatedResourceSystemRule()}`;

const previousSeed = (evidence: string) => `${evidence}\n\nWRITER_SEED_V1\n`
    + 'Create the smallest complete runnable unittest file: exactly one test method for one evidence-supported case. '
    + 'Call the real selected target and assert its observed return, exception, or explicitly controlled dependency behavior. '
    + 'Include every required import and fixture. Prefer one exact verified observation; do not invent an expected value or exception. '
    + 'Do not enumerate rule names as tests, add speculative edge cases, copy the implementation, or mock the target. '
    + 'The host must execute this seed successfully before asking for expansion. Return the complete Python test file using the existing output contract.';

const plan: ImportFixturePlan = { schemaVersion: 'import-fixtures-v1', id: 'a'.repeat(64), root: '/neutral/project',
    rules: [{ file: 'settings.py', sourceHash: 'b'.repeat(64), resources: [{ kind: 'directory', path: 'test-input' }] }] };

test('formal seed removes suite instructions and optional proposals while preserving the whole evidence source', () => {
    const source = 'def target(value):\n    return value * 3 - 2\n';
    const evidence: any = { schemaVersion: 'writer-evidence-v3', sourceHash: createHash('sha256').update(source).digest('hex'), semanticGuidance: '',
        ruleSelection: { ids: [], selectedRules: [] }, semanticPlan: { hypotheses: { marker: 'UNRELATED_FAMILY_PROPOSAL' } } };
    const context = { code: source, name: 'target', args: ['value'], is_async: false, target_import_module: 'sample' };
    const seed = getUserPrompt('sample.py', 'target', source, 'small',
        { ...context, writerGenerationPhase: 'seed' }, '', 12000, '', evidence);
    const expansion = getUserPrompt('sample.py', 'target', source, 'small', context, '', 12000, '', evidence);
    assert.ok(seed.includes(source));
    assert.match(seed, /Target import: from sample import target/);
    assert.doesNotMatch(seed, /UNRELATED_FAMILY_PROPOSAL|OPTIONAL ANALYST HYPOTHESES/);
    assert.match(seed, /WRITER_SEED_PACKAGING_V1/);
    assert.doesNotMatch(expansion, /WRITER_SEED_PACKAGING_V1/);
    assert.match(expansion, /UNRELATED_FAMILY_PROPOSAL/);
    withImportFixtures(plan, () => {
        const small = buildWriterSeedSystemPrompt(getSystemPrompt(1, 'small'));
        const large = buildWriterSeedSystemPrompt(getSystemPrompt(1, 'large'));
        assert.equal(small, large);
        assert.ok(large.endsWith(isolatedResourceSystemRule()));
        assert.doesNotMatch(large, /comprehensive|kill all mutation|TEST DESIGN GUIDANCE/);
        assert.match(large, /exactly ONE test method and ONE target call/);
    });
});

test('seed packaging supplies only canonical imports and the proper harness, never a test body or oracle', () => {
    for (const is_async of [false, true]) {
        const packaging = formatWriterSeedPackaging('sample', 'Owner.target', { class_name: 'Owner', is_async });
        const prefix = /```python\n([\s\S]*?)\n```/.exec(packaging)![1];
        assert.match(prefix, /from sample import Owner/);
        assert.match(prefix, /import types\n/, 'the advertised SimpleNamespace fixture has an explicit stdlib import');
        assert.match(prefix, is_async ? /unittest.IsolatedAsyncioTestCase/ : /unittest.TestCase/);
        assert.match(prefix, is_async ? /async def test_seed/ : /    def test_seed/);
        assert.doesNotMatch(prefix, /assertEqual|assertRaises|return_value|Owner\(/);
        assert.equal(validateUnittestStructure(prefix, 'Owner.target', 'sample').valid, false,
            'the host packaging cannot be accepted as a model-authored runnable test');
    }
    assert.equal(formatWriterSeedPackaging('sample', 'target', {}), '');
    assert.equal(formatWriterSeedPackaging('unsafe\nimport secret', 'target', { is_async: false }), '');
    assert.equal(formatWriterSeedPackaging('sample', 'unittest', { is_async: false }), '');
    assert.match(formatWriterSeedPackaging('sample', 'GeneratedSeedTests', { is_async: false }), /class GeneratedSeedCases/);
    assert.doesNotMatch(formatWriterSeedPackaging('sample', 'types', { is_async: false }), /^import types$/m,
        'the helper import must not shadow a selected target named types');
});

test('short seed context preserves full helper source, setup, selected rules and source identity', () => {
    const source = 'def target(value):\n    return helper(CONFIG, value)\n';
    const helper = 'def helper(config, value):\n    return value + config.offset\n';
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const evidence: any = { schemaVersion: 'writer-evidence-v3', sourceHash, semanticGuidance: '',
        ruleSelection: { ids: ['neutral-rule'], selectedRules: [{ ruleId: 'neutral-rule', title: 'Neutral construction',
            triggerFacts: ['source-supported setup'], relatedAnalystHints: [], guidance: ['RULE_MUST_REMAIN'] }] } };
    const context = { code: source, name: 'target', args: ['value'], is_async: false, writerGenerationPhase: 'seed',
        target_import_module: 'sample', calls: ['helper'], referenced_globals: [{ name: 'CONFIG', code: 'CONFIG = read_config()' }],
        dependencyContexts: [{ name: 'helper', code: helper }] };
    const prompt = getUserPrompt('sample.py', 'target', source, 'small', context, '', 1, '', evidence);
    for (const complete of [source, helper, 'CONFIG = read_config()', sourceHash, 'RULE_MUST_REMAIN']) {
        assert.ok(prompt.includes(complete), 'required data cannot be shortened even when the caller budget is tiny');
    }
    assert.match(prompt, /WRITER_SEED_PACKAGING_V1/);
    assert.doesNotMatch(prompt, /OPTIONAL ANALYST HYPOTHESES|TEST DESIGN GUIDANCE/);
});

test('small Writer retains every binding, assertion, isolation and pure-library instruction', () => {
    const system = getSystemPrompt(1, 'small');
    for (const constraint of [
        /^You are a Python unit test writer\./, /Complete runnable file/, /one Python fence, no prose/,
        /Explicit imports: unittest, target, helpers/, /Exact module\/class binding/,
        /unittest\.TestCase, test_ methods, self\.assert\*/, /No pytest\/top-level assert/,
        /Never copy\/redefine\/mock target\/owner class/,
        /exact Verified Real Execution Results, proven source path or same-test controls/,
        /never guess outputs\/exceptions/, /with self\.assertRaises\(ExceptionType\):/,
        /no message second argument/, /no dependency calls for expected/,
        /Pure stdlib parsing\/formatting\/calculation: real target, source-supported literals/,
        /helper imports need no mocks/, /Inputs\/source expressions prove no expected values/,
        /Patch external\/ambient source use points only when needed/,
        /fresh per-test state/, /Never patch immutable built-in class members; replace owning module binding/,
        /No direct test network\/file\/shell\/dynamic execution or shared SQLite/
    ]) { assert.match(system, constraint); }
    assert.doesNotMatch(system, /HOST_ISOLATED_RESOURCE_CONTEXT/);
    withImportFixtures(plan, () => assert.ok(getSystemPrompt(1, 'small').endsWith(isolatedResourceSystemRule()),
        'the unchanged resource rule remains complete when the host has resources'));
});

test('seed compaction preserves complete evidence and the original executable single-case contract', () => {
    const evidence = 'SOURCE: def target(): return clock.now()\nSETUP: exact target module\n'
        + 'OBSERVATIONS: {"complete":false,"case_ids":["one","two"],"result_assertable":false,'
        + '"oracle_reason":"uncontrolled-ambient-read","timeout":true}\nRULES: control the source use point';
    const prompt = buildWriterSeedPrompt(evidence);
    assert.ok(prompt.startsWith(evidence + '\n\nWRITER_SEED_V1\n'));
    assert.equal(prompt.split(evidence).length - 1, 1);
    for (const constraint of [/One test method and one real target call/, /explicit imports\/fixtures/,
        /WRITER_SEED_CASE_FACTS_V1 if supplied; else one source-supported, same-test controlled dependency case/,
        /Diagnostics never supply fixture values\/types\/imports/, /No guesses/, /speculative tests/,
        /copied source or target mocks/, /Pass execution before expansion/,
        /existing output contract/]) { assert.match(prompt, constraint); }
    assert.doesNotMatch(prompt, /Return.*JSON/);
});

test('generic small system and seed save at least 200 tokens without removing resource restrictions', () => {
    for (const resourcePlan of [null, plan]) {
        withImportFixtures(resourcePlan, () => {
            const previous = previousSmallSystem() + '\n' + previousSeed('');
            const compact = getSystemPrompt(1, 'small') + '\n' + buildWriterSeedPrompt('');
            assert.ok(estimatePromptTokens(previous) - estimatePromptTokens(compact) >= 200,
                JSON.stringify({ previous: estimatePromptTokens(previous), compact: estimatePromptTokens(compact) }));
            assert.ok(getSystemPrompt(1, 'small').endsWith(isolatedResourceSystemRule()));
        });
    }
});

test('an intact required envelope that previously used 6792 tokens fits the same 8192 context after instruction compaction', () => {
    withImportFixtures(plan, () => {
        const required = 'SOURCE: def target(): return clock.now()\nSETUP: complete source bindings\n'
            + 'OBSERVATIONS: {"complete":false,"result_assertable":false,"case_ids":["a","b"],'
            + '"oracle_reason":"uncontrolled-ambient-read","timeout":true}\nRULES: source-shown clock control\n';
        const resources = '\nHOST_ISOLATED_RESOURCE_CONTEXT\nComplete schema, origins and controlled input declarations';
        const oldPrefix = previousSmallSystem() + '\n' + previousSeed(required) + resources;
        const requiredPadding = 'X'.repeat(Math.floor(6792 * 3.5) - oldPrefix.length);
        const evidence = required + requiredPadding;
        const previous = previousSmallSystem() + '\n' + previousSeed(evidence) + resources;
        assert.equal(estimatePromptTokens(previous), 6792);
        const budget = roleRequestBudget({ envType: 'local', mode: 'full', role: 'writer', seedPending: true,
            contextWindow: 8192, inputBudget: 5734 });
        assert.equal(budget.inputBudget, 6656);
        assert.equal(budget.requestOutputTokens, 1536);
        assert.equal(promptFits(previousSmallSystem(), previousSeed(evidence) + resources, budget.inputBudget), false);
        const system = getSystemPrompt(1, 'small'), prompt = buildWriterSeedPrompt(evidence) + resources;
        assert.equal(promptFits(system, prompt, budget.inputBudget), true);
        const wire = buildOllamaPromptEnvelope(system, prompt);
        assert.ok(wire.prompt.includes(evidence));
        assert.ok(wire.prompt.endsWith(resources));
        assert.equal(wire.prompt.split(evidence).length - 1, 1);
        assert.equal(wire.prompt, system + '\n' + prompt);
    });
});
