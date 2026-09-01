import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { getReviewerSystemPrompt, getReviewerUserPrompt } from '../bug_fixer_prompt';
import { getBaseFewShotExamples } from '../few_shot_examples';
import {
    buildSemanticAnalyzerSystemPrompt,
    formatSemanticContextForPrompt,
    getSemanticAnalyzerUserPrompt,
    SemanticAnalysis
} from '../semantic_analyzer_prompt';

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
    const writerSource = fs.readFileSync(path.join(__dirname, '../../src/unittest_writer_prompt.ts'), 'utf8');

    assert.ok(!/payment_token|login_user|validate_and_format_token/i.test(writerSource));
});

test('writer prompt calls static methods through the class without inventing an instance', () => {
    const writerSource = fs.readFileSync(path.join(__dirname, '../../src/unittest_writer_prompt.ts'), 'utf8');

    assert.match(writerSource, /method_kind === 'static'.*method_kind === 'class'/s);
    assert.match(writerSource, /Do NOT instantiate the class/);
    assert.match(writerSource, /\$\{astContext\.class_name\}\.\$\{funcName\}/);
    assert.match(writerSource, /Verified Python observations for dependency/);
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
