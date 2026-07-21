import { getBaseFewShotExamples, getDynamicFewShotExamples, getMutationOperatorHints, formatFewShotForPrompt } from './fewShotExamples';
import { getPromptLanguageName } from './i18n';

export function getSystemPrompt(loopCount: number, strategy: 'small' | 'large', survivedMutants?: string): string {
    const langName = getPromptLanguageName();

    // Small model: lean, no emoji, no decorative brackets, minimal rules
    if (strategy === 'small') {
        let prompt = `You are a Python unit test writer. Write a unittest.TestCase for the given function.

Output format:
<thinking>
(brief analysis in ${langName.toUpperCase()})
</thinking>

\`\`\`python
import unittest
from MODULE_NAME import FUNCTION_NAME

class TestFUNCTION_NAME(unittest.TestCase):
    def test_case_1(self):
        result = FUNCTION_NAME(INPUT)
        self.assertEqual(result, EXPECTED)

if __name__ == '__main__':
    unittest.main()
\`\`\`

Rules:
1. Start with import unittest. Import the target function from its module (not relative import, not module_name placeholder).
2. Each test method starts with test_ and uses self.assert*().
3. Do NOT copy or redefine the source function. Write test methods only.
4. No pytest. No top-level assert.`;

        if (loopCount > 1 && survivedMutants) {
            prompt += `\n\nSome mutants survived. Fix the tests to kill them:\n${survivedMutants}`;
            const hints = getMutationOperatorHints(survivedMutants);
            if (hints) { prompt += `\n${hints}`; }
        }
        return prompt;
    }

    // Large model: full guidelines
    let prompt = `You are an expert Python Unit Testing Engineer and Mutation Testing specialist. Your ONLY task is to write a highly-covering unittest test case suite to kill all potential mutants.

Output format:
<thinking>
(analysis in ${langName.toUpperCase()})
</thinking>

\`\`\`python
(complete unittest code)
\`\`\`

Guidelines:
- Use unittest.TestCase. Import the function using absolute import (e.g. from service_auth import login_user).
- Use unittest.mock (patch, MagicMock) for external dependencies.
- Cover edge cases: None, empty, boundary values, exception paths.
- Do NOT copy the source code into your output.
`;

    prompt += `\nFEW-SHOT EXAMPLES:\n${formatFewShotForPrompt(getBaseFewShotExamples())}\n`;

    if (loopCount > 1 && survivedMutants) {
        prompt += `\nSome mutants survived. Analyze and kill them:\n${survivedMutants}`;
        const hints = getMutationOperatorHints(survivedMutants);
        if (hints) { prompt += `\n${hints}`; }
    }
    return prompt;
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
}

function distillDependency(dep: any, level: 0 | 1 | 2 | 3): string {
    if (level === 3) {
        return `Dependency: ${dep.name} (code too long, mock it)\n`;
    }
    if (level === 2) {
        const sig = dep.code?.split('\n')[0] || `def ${dep.name}(...)`;
        return `Dependency: ${dep.name}\nSignature: ${sig}\n${dep.docstring ? `Docstring: ${dep.docstring}\n` : ''}\n`;
    }
    if (level === 1) {
        const lines = (dep.code || '').split('\n');
        const keyLines = lines.filter((l: string) => {
            const t = l.trim();
            return t.startsWith('def ') || t.startsWith('return ') || t.startsWith('raise ');
        });
        return `Dependency: ${dep.name}\n${dep.docstring ? `Docstring: ${dep.docstring}\n` : ''}Key lines:\n\`\`\`python\n${keyLines.join('\n')}\n\`\`\`\n\n`;
    }
    return `Dependency: ${dep.name}\n${dep.docstring ? `Docstring: ${dep.docstring}\n` : ''}Source:\n\`\`\`python\n${dep.code}\n\`\`\`\n\n`;
}

export function getUserPrompt(
    fileName: string,
    funcName: string,
    code: string,
    strategy: 'small' | 'large',
    astContext?: any,
    focusContexts?: string,
    budgetTokens: number = 20000
): string {
    const moduleName = fileName.replace(/\\/g, '/').split('/').pop()?.replace('.py', '') || 'module';
    let prompt = `Target file: ${fileName}\nTarget function: ${funcName}\n`;

    if (astContext && !astContext.error) {
        prompt += `\nFunction info:\n`;
        prompt += `- Name: ${astContext.name}\n`;
        if (astContext.args && astContext.args.length > 0) {
            prompt += `- Parameters: ${astContext.args.join(', ')}\n`;
        }
        if (astContext.docstring) {
            prompt += `- Docstring: ${astContext.docstring.trim()}\n`;
        }
        if (astContext.calls && astContext.calls.length > 0) {
            prompt += `- Calls: ${astContext.calls.join(', ')}\n`;
        }

        // Dependency contexts (budget-aware distillation)
        if (astContext.dependencyContexts && astContext.dependencyContexts.length > 0) {
            prompt += `\nExternal dependencies (for understanding return types and behavior):\n`;
            for (const dep of astContext.dependencyContexts) {
                const remaining = budgetTokens - estimateTokens(prompt);
                let level: 0 | 1 | 2 | 3;
                const full = distillDependency(dep, 0);
                const l1   = distillDependency(dep, 1);
                const l2   = distillDependency(dep, 2);
                if (remaining > estimateTokens(full) + 300) level = 0;
                else if (remaining > estimateTokens(l1) + 200) level = 1;
                else if (remaining > estimateTokens(l2) + 100) level = 2;
                else level = 3;
                prompt += distillDependency(dep, level);

                // Caller contexts for this dependency
                if (dep.callerContexts && dep.callerContexts.length > 0 && (budgetTokens - estimateTokens(prompt)) > 150) {
                    prompt += `Call sites for ${dep.name} (test all of these):\n`;
                    for (const ctx of dep.callerContexts) {
                        const argsStr = ctx.args.join(', ');
                        const kwargsStr = Object.entries(ctx.kwargs).map(([k, v]) => `${k}=${v}`).join(', ');
                        const callSig = [argsStr, kwargsStr].filter(Boolean).join(', ');
                        prompt += `  ${ctx.caller_file} / ${ctx.caller_func}: ${dep.name}(${callSig})\n`;
                    }
                    prompt += `\n`;
                }
            }
        }

        // Caller contexts for the target function itself
        if (astContext.callerContexts && astContext.callerContexts.length > 0 && (budgetTokens - estimateTokens(prompt)) > 150) {
            prompt += `\nThis function is called from multiple places. Cover all call contexts:\n`;
            for (const ctx of astContext.callerContexts) {
                const argsStr = ctx.args.join(', ');
                const kwargsStr = Object.entries(ctx.kwargs).map(([k, v]) => `${k}=${v}`).join(', ');
                const callSig = [argsStr, kwargsStr].filter(Boolean).join(', ');
                prompt += `  ${ctx.caller_file} / ${ctx.caller_func}: ${astContext.name}(${callSig})\n`;
            }
            prompt += `\n`;
        }

        // Dynamic few-shot only for large models
        if (strategy === 'large') {
            const remaining = budgetTokens - estimateTokens(prompt) - estimateTokens(astContext.code || code) - 200;
            if (remaining > 300) {
                const examples = getDynamicFewShotExamples(astContext, astContext.code || code);
                if (examples.length > 0) {
                    const subset = remaining > 800 ? examples : examples.slice(0, 1);
                    prompt += `\nExamples:\n${formatFewShotForPrompt(subset)}\n`;
                }
            }
        }
    }

    if (focusContexts) {
        prompt += `\nFailed mutants to kill:\n${focusContexts}\n`;
        prompt += `(Add targeted asserts to kill each mutant. Do not rewrite the whole test file.)\n`;
    } else {
        const src = (astContext && !astContext.error) ? (astContext.code || code) : code;
        prompt += `\nSource code (write tests for this, do not copy it):\n\`\`\`python\n${src}\n\`\`\``;
    }

    if (strategy === 'small') {
        prompt += `\n\nImport from: from ${moduleName} import ${funcName}\n\nWrite the test file now:\n<thinking>\n`;
    } else {
        prompt += `\n\nWrite the complete unittest test file now.\n`;
    }

    return prompt;
}