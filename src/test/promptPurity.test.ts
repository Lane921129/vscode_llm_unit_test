import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { getReviewerSystemPrompt, getReviewerUserPrompt } from '../bug_fixer_prompt';
import { getBaseFewShotExamples } from '../few_shot_examples';
import { buildSemanticAnalyzerSystemPrompt } from '../semantic_analyzer_prompt';

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
});
