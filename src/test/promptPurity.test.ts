import * as assert from 'assert';
import { test } from 'node:test';
import { getReviewerSystemPrompt } from '../bug_fixer_prompt';
import { getBaseFewShotExamples } from '../few_shot_examples';
import { buildSemanticAnalyzerSystemPrompt } from '../semantic_analyzer_prompt';

const forbiddenDomainTerms = /\b(?:token|jwt|bmi|payment_gateway|login_user|claims|partner)\b/i;

test('shared prompts and active base examples contain no project-domain vocabulary', () => {
    const sharedPromptText = [
        getReviewerSystemPrompt(),
        buildSemanticAnalyzerSystemPrompt(),
        ...getBaseFewShotExamples().flatMap(example => [example.sourceCode, example.thinking, example.testCode])
    ].join('\n');

    assert.ok(!forbiddenDomainTerms.test(sharedPromptText));
});
