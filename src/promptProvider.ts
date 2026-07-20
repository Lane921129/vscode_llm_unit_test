import { getBaseFewShotExamples, getDynamicFewShotExamples, getMutationOperatorHints, formatFewShotForPrompt } from './fewShotExamples';
import { getPromptLanguageName } from './i18n';

export function getSystemPrompt(loopCount: number, strategy: 'small' | 'large', survivedMutants?: string): string {
    const langName = getPromptLanguageName();

    let prompt = `You are an expert Python Unit Testing Engineer and Mutation Testing specialist. Your ONLY task is to write a highly-covering \`unittest\` test case suite for the target code to kill all potential mutants.

【OUTPUT RULES】
1. <thinking> block: Analyze boundary conditions and test design. You MUST write this thinking section entirely in ${langName.toUpperCase()}.
2. Code block: Output EXACTLY ONE Python code block containing the complete unittest suite.
`;

    if (strategy === 'small') {
        prompt += `
The format MUST be exactly as follows:
<thinking>
(Write your analysis IN ${langName.toUpperCase()})
</thinking>

\`\`\`python
(Your unittest code here)
\`\`\`

【CODE CONTENT RULES - ANY VIOLATION CAUSES SYSTEM FAILURE】
1. The first line MUST be \`import unittest\`
2. You MUST define a test class that inherits from \`unittest.TestCase\`
3. Test methods MUST be inside the class, start with \`test_\`, and use \`self.assert*()\` methods
4. The final lines MUST be \`if __name__ == '__main__': unittest.main()\`
5. You MUST import the target function using \`from <module_name> import <function_name>\`
6. STRICTLY NO pytest, nose, or other third-party test frameworks
7. STRICTLY NO Python REPL format (lines starting with >>>)
8. STRICTLY NO top-level assert statements (asserts must be within self.assert*())
9. STRICTLY NO rewriting, modifying, or offering implementations for the target source code! You are ONLY allowed to output test code!`;
    } else {
        prompt += `
【ADVANCED TESTING GUIDELINES】
- Use advanced \`unittest.mock\` techniques (like \`patch\`, \`MagicMock\`) for external dependencies if necessary.
- Consider edge cases involving unexpected types, None values, and extreme inputs.
- You do not need to strictly follow a rigid format, but ensure your code block is standard Python \`unittest\`.`;
    }

    prompt += `\n\n【FOUNDATION FEW-SHOT EXAMPLES】
Below are examples of the correct thought process and formatting. Please study them carefully:

${formatFewShotForPrompt(getBaseFewShotExamples())}

You must consider boundary conditions and ensure the Mutation Testing score reaches 100%.
`;

    if (loopCount > 1 && survivedMutants) {
        prompt += `\n⚠️ ATTENTION: After the previous test run, the following mutants SURVIVED. Please analyze why they survived in your <thinking> block (in ${langName}), and strengthen your Assert logic to KILL them:\n${survivedMutants}`;
        const hints = getMutationOperatorHints(survivedMutants);
        if (hints) {
            prompt += `\n${hints}`;
        }
    }
    return prompt;
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
}

/**
 * 依蒸餾等級壓縮依賴資訊
 * Level 0: 完整原始碼 + docstring
 * Level 1: 只保留 return/raise 行 + docstring
 * Level 2: 只保留函式簽名 + docstring
 * Level 3: 完全放棄（標記需要手動 Mock）
 */
function distillDependency(dep: any, level: 0 | 1 | 2 | 3): string {
    if (level === 3) {
        return `--- Function: ${dep.name} (需自行 Mock，原始碼過長已省略) ---\n`;
    }
    if (level === 2) {
        const sig = dep.code?.split('\n')[0] || `def ${dep.name}(...)`;
        return `--- Function: ${dep.name} ---\nSignature: ${sig}\n${dep.docstring ? `Docstring: ${dep.docstring}\n` : ''}\n`;
    }
    if (level === 1) {
        const lines = (dep.code || '').split('\n');
        const keyLines = lines.filter((l: string) => {
            const t = l.trim();
            return t.startsWith('def ') || t.startsWith('return ') || t.startsWith('raise ');
        });
        const compressed = keyLines.join('\n');
        return `--- Function: ${dep.name} ---\n${dep.docstring ? `Docstring: ${dep.docstring}\n` : ''}Key Lines:\n\`\`\`python\n${compressed}\n\`\`\`\n\n`;
    }
    // Level 0: 完整資訊
    return `--- Function: ${dep.name} ---\n${dep.docstring ? `Docstring: ${dep.docstring}\n` : ''}Source Code:\n\`\`\`python\n${dep.code}\n\`\`\`\n\n`;
}

export function getUserPrompt(fileName: string, funcName: string, code: string, strategy: 'small' | 'large', astContext?: any, focusContexts?: string, budgetTokens: number = 20000): string {
    const target = funcName ? `function \`${funcName}\`` : `entire file`;
    let prompt = `【Target File】: ${fileName}\n【Target Scope】: ${target}\n`;
    
    if (astContext && !astContext.error) {
        prompt += `【AST Parsed Features】:\n`;
        prompt += `- Function Name: ${astContext.name}\n`;
        if (astContext.args && astContext.args.length > 0) {
            prompt += `- Parameter List: ${astContext.args.join(', ')}\n`;
        }
        if (astContext.docstring) {
            prompt += `- Docstring: ${astContext.docstring.trim()}\n`;
        }
        if (astContext.calls && astContext.calls.length > 0) {
            prompt += `- Internal Dependencies (Calls): ${astContext.calls.join(', ')}\n`;
        }

        // Budget-aware 依賴蒸餾
        if (astContext.dependencyContexts && astContext.dependencyContexts.length > 0) {
            prompt += `\n【Cross-File Dependencies Reference (External Implementations)】\n`;
            prompt += `The target function relies on the following external functions. Here are their implementations and docstrings to help you understand what they do and return:\n`;

            // 計算目前 prompt 使用量，決定每個依賴的蒸餾等級
            const baseTokens = estimateTokens(prompt);
            const codeTokens = estimateTokens(astContext.code || code);
            const remainingForDeps = budgetTokens - baseTokens - codeTokens - 400; // 400 保留給格式與 few-shot

            for (const dep of astContext.dependencyContexts) {
                const fullText = distillDependency(dep, 0);
                const level1Text = distillDependency(dep, 1);
                const level2Text = distillDependency(dep, 2);
                const currentUsed = estimateTokens(prompt);
                const remaining = budgetTokens - currentUsed;

                let level: 0 | 1 | 2 | 3;
                if (remaining > estimateTokens(fullText) + 300) {
                    level = 0;
                } else if (remaining > estimateTokens(level1Text) + 200) {
                    level = 1;
                } else if (remaining > estimateTokens(level2Text) + 100) {
                    level = 2;
                } else {
                    level = 3;
                }
                prompt += distillDependency(dep, level);
            }
        }

        // Budget-aware Few-Shot 動態範例
        const currentUsedBeforeFewShot = estimateTokens(prompt);
        const remainingForFewShot = budgetTokens - currentUsedBeforeFewShot - estimateTokens(astContext.code || code) - 200;
        if (remainingForFewShot > 300) {
            const dynamicExamples = getDynamicFewShotExamples(astContext, astContext.code || code);
            if (dynamicExamples.length > 0) {
                // 大 budget 才放多個範例
                const examplesForBudget = remainingForFewShot > 800 ? dynamicExamples : dynamicExamples.slice(0, 1);
                prompt += `\n【Dynamic Reference Examples for Current AST Features】\n${formatFewShotForPrompt(examplesForBudget)}\n`;
            }
        }
    }

    if (focusContexts) {
        prompt += `\n【Dynamic Focus Analysis】\nYour tests missed the following mutants. Please focus on these target lines:\n\n${focusContexts}\n`;
        prompt += `\n(Note: To keep you focused, only the code snippets surrounding the surviving mutants are provided. Please analyze why the mutation survived in \`<thinking>\`, and write targeted Asserts to kill them. Add the new Asserts to your previously written test class.)\n`;
    } else {
        if (astContext && !astContext.error) {
            prompt += `\n【Original Source Code】:\n\`\`\`python\n${astContext.code || code}\n\`\`\``;
        } else {
            prompt += `\n【Original Source Code】:\n\`\`\`python\n${code}\n\`\`\``;
        }
    }

    if (strategy === 'small') {
        prompt += `\n\nNow, based on the above information, you MUST immediately generate the test suite following the strict output format rules.\n\n[Expected AI Response]\n(You MUST start your output directly with <thinking> and do NOT output any other headings!)\n<thinking>\n`;
    } else {
        prompt += `\n\nNow, please generate the test suite considering the advanced guidelines.\n`;
    }
    
    return prompt;
}