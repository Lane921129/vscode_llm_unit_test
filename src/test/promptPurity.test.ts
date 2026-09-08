import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { getReviewerSystemPrompt, getReviewerUserPrompt } from '../prompts/bugFixerPrompt';
import { getBaseFewShotExamples } from '../prompts/fewShotExamples';
import {
    buildSemanticAnalyzerSystemPrompt,
    formatSemanticContextForPrompt,
    getSemanticAnalyzerUserPrompt,
    SemanticAnalysis
} from '../prompts/semanticAnalyzerPrompt';
import { compactSemanticGuidanceForBudget, getTier1EvidenceBoundSystemPrompt, getTier3UserPrompt, getTier4SelfRepairPrompt, getUserPrompt } from '../prompts/unittestWriterPrompt';

const forbiddenDomainTerms = /\b(?:token|jwt|bmi|payment_gateway|login_user|claims|partner)\b/i;

test('shared prompts and active base examples contain no project-domain vocabulary', () => {
    const sharedPromptText = [
        getReviewerSystemPrompt(),
        getReviewerUserPrompt('import unittest', 'example error', 'transform_value', ['value'], 'def transform_value(value):\n    return value', {}, 'utility_module'),
        buildSemanticAnalyzerSystemPrompt(),
        ...getBaseFewShotExamples().flatMap(example => [example.sourceCode, example.thinking, example.testCode])
    ].join('\n');

    assert.ok(!forbiddenDomainTerms.test(sharedPromptText));
});

test('writer prompt source does not retain legacy application-specific examples', () => {
    const writerSource = fs.readFileSync(path.join(__dirname, '../../src/prompts/unittestWriterPrompt.ts'), 'utf8');

    assert.ok(!/payment_token|login_user|validate_and_format_token/i.test(writerSource));
});

test('writer output contract does not branch on a provider or model name', () => {
    const writerSource = fs.readFileSync(path.join(__dirname, '../../src/prompts/unittestWriterPrompt.ts'), 'utf8');

    assert.ok(!/useThinkingTag|noThinkingModels|qwen|tinyllama|gemma|mistral/i.test(writerSource));
    assert.match(writerSource, /const thinking = false;/);
    assert.match(writerSource, /\\`\\`\\`python/);
    assert.doesNotMatch(writerSource, /<thinking>|<\/thinking>/);
});

test('Tier 1 LLM prompt binds assertions to execution evidence and keeps skill cards scoped', () => {
    const prompt = getTier1EvidenceBoundSystemPrompt();

    assert.match(prompt, /Verified Real Execution Result/);
    assert.match(prompt, /Selected skill cards are scoped guidance/);
    assert.match(prompt, /structural, isolated execution, coverage, and mutation checks/);
    assert.doesNotMatch(prompt, forbiddenDomainTerms);
});

test('reviewer prompt uses complete AST and skill context without treating source as an output oracle', () => {
    const systemPrompt = getReviewerSystemPrompt();
    const prompt = getReviewerUserPrompt(
        'import unittest', 'coverage missed line 5', 'render', ['value'], 'def render(value):\n    return PREFIX + value', {
            method_kind: 'instance', class_name: 'Renderer',
            class_context: { bases: ['BaseRenderer'], init: { required_params: ['prefix'], assigns: [{ name: 'prefix' }] } },
            file_imports: [{ kind: 'from', module: 'settings', name: 'PREFIX', level: 0 }],
            referenced_globals: [{ name: 'PREFIX', code: "PREFIX = '>'" }],
            traceResult: { examples: [{ args: ["'x'"], kwargs: {}, result: "'>x'" }] }
        }, 'renderer', '=== SKILL CART ===\nUse selected evidence only.'
    );

    assert.match(systemPrompt, /They do NOT prove an exact return value/);
    assert.doesNotMatch(systemPrompt, /If the code returns a string|value\[:N\]/);
    assert.match(prompt, /AST CONTEXT/);
    assert.match(prompt, /Constructor required parameters: prefix/);
    assert.match(prompt, /PREFIX = '>'/);
    assert.match(prompt, /EVIDENCE-BOUND SKILL AND STRATEGY GUIDANCE/);
    assert.match(prompt, /Input: \('x'\) => Returned: '>x'/);
});

test('writer prompt calls static methods through the class without inventing an instance', () => {
    const writerSource = fs.readFileSync(path.join(__dirname, '../../src/prompts/unittestWriterPrompt.ts'), 'utf8');

    assert.match(writerSource, /method_kind === 'static'.*method_kind === 'class'/s);
    assert.match(writerSource, /Do NOT instantiate the class/);
    assert.match(writerSource, /\$\{astContext\.class_name\}\.\$\{funcName\}/);
    assert.match(writerSource, /Verified Python observations for dependency/);
});

test('writer prompt reuses verified constructor literals for instance-method trace assertions', () => {
    const prompt = getUserPrompt('worker.py', 'render', 'def render(value): pass', 'small', {
        name: 'render',
        args: ['value'],
        class_name: 'Service',
        method_kind: 'instance',
        callerContexts: [{
            args: ["'value'"],
            kwargs: {},
            trace_constructor_args: ['prefix:'],
            trace_constructor_kwargs: {},
            constructor_args: ["'prefix:'"],
            constructor_kwargs: {}
        }]
    });

    assert.match(prompt, /self\._obj = Service\('prefix:'\)/);
    assert.match(prompt, /do NOT pass these constructor values to render\(\)/);
});

test('Tier 3 scaffold prompt distinguishes verified constructor setup from method arguments', () => {
    const prompt = getTier3UserPrompt(
        'render',
        'def test_render(self):\n    pass',
        'worker',
        [{ args: ["'value'"], result: "'prefix:value'" }],
        "Service('prefix:')"
    );

    assert.match(prompt, /instance = Service\('prefix:'\)/);
    assert.match(prompt, /Do NOT pass them to render\(\.\.\.\)/);
});

test('Tier 3 scaffold prompt receives source and evidence-bound skill guidance', () => {
    const prompt = getTier3UserPrompt(
        'read_first_line',
        'def test_read_first_line(self, mock_open):\n    pass',
        'reader', [], undefined,
        "def read_first_line(path):\n    with open(path) as handle:\n        return handle.readline()",
        '=== FUNCTION-SPECIFIC RULES ===\n[File I/O Mocking]\n  Patch at the point of use.'
    );

    assert.match(prompt, /Target source \(evidence; do not copy it into the test\)/);
    assert.match(prompt, /File I\/O Mocking/);
    assert.match(prompt, /source and verified execution facts take precedence/);
});

test('Tier 4 repair prompt does not require habitual None or empty-input tests', () => {
    const writerSource = fs.readFileSync(path.join(__dirname, '../../src/prompts/unittestWriterPrompt.ts'), 'utf8');

    assert.match(writerSource, /Do not add None or empty-input tests merely by habit/);
    assert.doesNotMatch(writerSource, /Cover all edge cases: None, empty, boundary values, all exception paths/);
});

test('Tier 4 self-repair receives the same source, AST, Trace, and skill evidence as Reviewer', () => {
    const prompt = getTier4SelfRepairPrompt(
        'assertion failed', 'import unittest', 'compute', ['value'], 'def compute(value):\n    return value', {
            file_imports: [{ kind: 'import', module: 'math' }],
            referenced_globals: [{ name: 'LIMIT', code: 'LIMIT = 3' }],
            traceResult: { examples: [{ args: ['3'], result: '6' }] }
        }, 'calculator', '=== SKILL CART ===\n[Float Precision]'
    );

    assert.match(prompt, /TARGET SOURCE CODE/);
    assert.match(prompt, /Available module imports: import math/);
    assert.match(prompt, /LIMIT = 3/);
    assert.match(prompt, /Input: \(3\) => Returned: 6/);
    assert.match(prompt, /Float Precision/);
    assert.match(prompt, /TIER 4 SELF-REPAIR INSTRUCTION/);
});

test('writer prompt preserves the canonical package import path from AST context', () => {
    const writerSource = fs.readFileSync(path.join(__dirname, '../../src/prompts/unittestWriterPrompt.ts'), 'utf8');

    assert.match(writerSource, /astContext\?\.target_import_module/);
    assert.match(writerSource, /from \$\{moduleName\} import \$\{funcName\}/);
});

test('semantic prompt supplies verified dependency repr facts instead of JavaScript object descriptions', () => {
    const prompt = getSemanticAnalyzerUserPrompt(
        'def render(value):\n    return normalize(value)',
        [{
            name: 'normalize',
            code: 'def normalize(value):\n    return {"value": value}',
            traceResult: {
                examples: [{ args: ["'x'"], result: "{'value': 'x'}" }],
                errors: []
            }
        }]
    );

    assert.match(prompt, /VERIFIED DEPENDENCY EXECUTION FACTS/);
    assert.match(prompt, /normalize\('x'\) => \{'value': 'x'\}/);
    assert.ok(!prompt.includes('[object Object]'));
});

test('semantic analyzer receives bounded AST setup context without treating it as an output oracle', () => {
    const prompt = getSemanticAnalyzerUserPrompt(
        'def process(value):\n    return PREFIX + self.client.send(value)',
        [],
        [],
        {
            file_imports: [
                { kind: 'from', module: 'settings', name: 'PREFIX', bound_name: 'PREFIX' },
                { kind: 'import', module: 'transport', alias: 'transport', bound_name: 'transport' }
            ],
            referenced_globals: [{ name: 'PREFIX', code: "PREFIX = '>'" }],
            class_name: 'Worker', method_kind: 'instance',
            class_context: {
                name: 'Worker', bases: ['BaseWorker'],
                init: {
                    signature: [{ name: 'client', required: true, default: null }],
                    assigns: [{ name: 'client', code: 'self.client = client' }]
                }
            }
        }
    );

    assert.match(prompt, /MODULE AND CLASS SETUP CONTEXT/);
    assert.match(prompt, /from settings import PREFIX/);
    assert.match(prompt, /import transport as transport/);
    assert.match(prompt, /PREFIX = '>'/);
    assert.match(prompt, /Target binding: instance member of Worker/);
    assert.match(prompt, /Constructor parameters: client \(required\)/);
    assert.match(prompt, /self\.client = client/);
    assert.match(prompt, /does not prove a return value, exception, or external side effect/);
});

test('semantic context omits unverified dependency return claims while retaining verified facts', () => {
    const analysis: SemanticAnalysis = {
        dependency_behaviors: [{
            name: 'normalize',
            when_caller_passes: 'value',
            always_returns: '[object Object]',
            can_raise: []
        }],
        unreachable_paths: [],
        equivalent_mutant_candidates: [],
        required_skills: [],
        test_strategy: {
            approach: 'unit', input_hints: [], assertion_style: 'mixed', mock_needed: false, key_rules: []
        }
    };
    const context = formatSemanticContextForPrompt(analysis, [{
        name: 'normalize',
        traceResult: { examples: [{ args: ["'x'"], result: "{'value': 'x'}" }] }
    }]);

    assert.match(context, /normalize\('x'\) => \{'value': 'x'\}/);
    assert.ok(!context.includes('Always returns: [object Object]'));
    assert.match(context, /Unverified dependency-return claims were omitted/);
});

test('writer prompt keeps Dynamic Trace facts exact instead of inventing universal boundaries', () => {
    const prompt = getUserPrompt('sample.py', 'validate', 'def validate(value):\n    return value', 'small', {
        name: 'validate',
        args: ['value'],
        traceResult: {
            examples: [{ args: ["'valid'"], result: "'ok'", result_assertable: true, call_assertable: true }],
            errors: [{ args: ["'x'"], exception: 'ValueError', message: 'short', call_assertable: true }],
        },
    });

    assert.match(prompt, /TRACE EVIDENCE LIMIT/);
    assert.match(prompt, /only that exact call/);
    assert.doesNotMatch(prompt, /CRITICAL BOUNDARY RULES|ALWAYS raises|ALWAYS returns normally/);
});

test('writer prompt presents AST branch conditions as input coverage facts, never output facts', () => {
    const prompt = getUserPrompt('sample.py', 'classify', 'def classify(value, text): pass', 'small', {
        name: 'classify',
        args: ['value', 'text'],
        condition_facts: [
            { kind: 'comparison', parameter: 'value', subject: 'value', operator: 'LtE', literal: '3', line: 2 },
            { kind: 'comparison', parameter: 'text', subject: 'length', operator: 'Gt', literal: '4', line: 4 },
            { kind: 'membership', parameter: 'mode', subject: 'value', operator: 'In', literals: ["'fast'", "'safe'"], line: 6 },
            { kind: 'match', parameter: 'variant', subject: 'value', literals: ["'left'", "'right'"], line: 8 },
        ],
    });

    assert.match(prompt, /AST branch-condition facts/);
    assert.match(prompt, /Source line 2: value <= 3/);
    assert.match(prompt, /Source line 4: len\(text\) > 4/);
    assert.match(prompt, /Source line 6: mode in \('fast', 'safe'\)/);
    assert.match(prompt, /Source line 8: match variant includes cases \('left', 'right'\)/);
    assert.match(prompt, /do NOT prove a return value or exception/);
    assert.doesNotMatch(prompt, /value <= 3.*Returns|len\(text\) > 4.*Raises/s);
});

test('writer prompt receives evidence-bound semantic guidance within its token budget', () => {
    const guidance = '=== FUNCTION-SPECIFIC RULES (Selected for this function) ===\n[Generator Result Testing]\n  Materialize finite results.';
    const prompt = getUserPrompt(
        'sample.py', 'every_second', 'def every_second(values):\n    yield from values', 'small',
        { name: 'every_second', args: ['values'] }, undefined, 20_000, '', guidance
    );
    const constrained = getUserPrompt(
        'sample.py', 'every_second', 'def every_second(values):\n    yield from values', 'small',
        { name: 'every_second', args: ['values'] }, undefined, 1, '', guidance
    );

    assert.match(prompt, /EVIDENCE-BOUND SEMANTIC GUIDANCE/);
    assert.match(prompt, /Generator Result Testing/);
    assert.match(prompt, /source code and verified execution facts take precedence/);
    assert.doesNotMatch(constrained, /EVIDENCE-BOUND SEMANTIC GUIDANCE/);
});

test('semantic guidance budget keeps complete evidence and skill sections before candidate suggestions', () => {
    const guidance = [
        '=== SEMANTIC GUIDANCE ===',
        'Use verified execution facts and source code as evidence.',
        '',
        '=== CANDIDATE PATH GUIDANCE ===',
        'Candidate path A is a model suggestion that must be verified against source or trace.',
        'Candidate path B is another model suggestion that must be verified against source or trace.',
        '',
        '=== FUNCTION-SPECIFIC RULES (Selected for this function) ===',
        '[Generator Result Testing]',
        '  Materialize finite results before assertion.',
        '',
        '=== TEST DATA STRATEGY (AI-derived, validate against source before use) ===',
        'Overall approach: exercise source branches.'
    ].join('\n');
    const compact = compactSemanticGuidanceForBudget(guidance, 65) || '';

    assert.match(compact, /SEMANTIC GUIDANCE/);
    assert.match(compact, /Generator Result Testing/);
    assert.doesNotMatch(compact, /Candidate path A/);
    assert.match(compact, /budget-reduced/);
});

test('writer prompt does not turn try/except or dependency warnings into universal exception claims', () => {
    const exceptionPrompt = getUserPrompt('sample.py', 'render', 'def render(value):\n    try:\n        return normalize(value)\n    except ValueError:\n        return "fallback"', 'small', {
        name: 'render',
        args: ['value'],
        code: 'def render(value):\n    try:\n        return normalize(value)\n    except ValueError:\n        return "fallback"',
    });
    const dependencyPrompt = getUserPrompt('sample.py', 'render', 'def render(value):\n    return normalize(value)', 'small', {
        name: 'render',
        args: ['value'],
        code: 'def render(value):\n    return normalize(value)',
        dependencyContexts: [{ name: 'normalize', code: 'def normalize(value):\n    raise ValueError()' }],
    });

    assert.match(exceptionPrompt, /does not prove every path or every exception is caught/);
    assert.match(dependencyPrompt, /may propagate/);
    assert.doesNotMatch(exceptionPrompt + dependencyPrompt, /NEVER raises exceptions|MUST use.*assertRaises/s);
});

test('writer prompt treats static return expressions as shapes rather than exact output facts', () => {
    const prompt = getUserPrompt('sample.py', 'render', 'def render(value):\n    return normalize(value)', 'small', {
        name: 'render',
        args: ['value'],
        code: 'def render(value):\n    return normalize(value)',
    });

    assert.match(prompt, /RETURN EXPRESSION SHAPES/);
    assert.match(prompt, /Possible expression shape: normalize\(value\)/);
    assert.match(prompt, /NOT output facts/);
    assert.match(prompt, /Do NOT use these expressions as an exact expected value/);
    assert.doesNotMatch(prompt, /Use ONLY the above structures in assertEqual/);
});

test('writer prompt prevents Tier 2 from directly calling a dependency as unused setup', () => {
    const prompt = getUserPrompt('checkout.py', 'submit', 'def submit(value): return normalize(value)', 'small', {
        name: 'submit',
        args: ['value'],
        dependencyContexts: [{ name: 'normalize', code: 'def normalize(value): return value' }],
    });
    const tier1Prompt = getTier1EvidenceBoundSystemPrompt();

    assert.match(prompt, /Do NOT directly call a dependency merely to compute an expected value or assign unused setup/);
    assert.match(prompt, /patch it at checkout's use point/);
    assert.match(tier1Prompt, /Do not call a dependency directly merely to calculate an expected value/);
    assert.doesNotMatch(prompt + tier1Prompt, forbiddenDomainTerms);
});

test('semantic strategy labels model-proposed inputs as candidates rather than facts', () => {
    const context = formatSemanticContextForPrompt({
        dependency_behaviors: [],
        unreachable_paths: [],
        equivalent_mutant_candidates: [],
        required_skills: [],
        test_strategy: {
            approach: 'exercise source branches',
            input_hints: [{
                param_name: 'value', strategy: 'candidate boundary', boundary_inputs: ['0'], invalid_inputs: ['-1'], notes: ''
            }],
            assertion_style: 'mixed', mock_needed: false, key_rules: []
        }
    });

    assert.match(context, /AI-derived, validate against source before use/);
    assert.match(context, /Candidate normal inputs/);
    assert.match(context, /assertRaises requires an explicit source raise or verified error/);
    assert.doesNotMatch(context, /use these exact values in test cases/);
});
