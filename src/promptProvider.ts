import { getBaseFewShotExamples, getDynamicFewShotExamples, getMutationOperatorHints, formatFewShotForPrompt } from './fewShotExamples';
import { getPromptLanguageName } from './i18n';

// ─────────────────────────────────────────────────────────────
// Tier 1：填空法 Prompt（2–3B 極小模型）
// 每次只問 AI 填寫一個斷言行，Prompt 上限 ~80 tokens
// ─────────────────────────────────────────────────────────────

/**
 * Tier 1 System Prompt：告知模型只需補全一行斷言，不要輸出其他內容
 */
export function getTier1SystemPrompt(): string {
    return `Complete ONE assertion line. Output ONLY the completed line. No explanation. No other code.`;
}

/**
 * Tier 1 User Prompt：給定函式呼叫與真實回傳值，讓 AI 補全斷言
 * @param funcCall  已產生的函式呼叫字串，e.g. "func('abc', 'jwt')"
 * @param returnVal 真實回傳值的 repr，e.g. "{'valid': True, 'type': 'user'}"
 * @param isError   若為 True，表示這個輸入會 raise，需要填 assertRaises
 * @param errorType 例外類型，e.g. "ValueError"
 */
export function getTier1UserPrompt(
    funcCall: string,
    returnVal: string,
    isError: boolean = false,
    errorType: string = 'Exception'
): string {
    if (isError) {
        return `Input raises ${errorType}("${returnVal}").
Complete: with self.assertRaises(${errorType}):
              ___`;
    }
    return `Return value: ${returnVal}
Complete ONE line: self.assertEqual(result, ___)`;
}

// ─────────────────────────────────────────────────────────────
// Tier 3：Mock Scaffold 策略（34–70B 中大模型）
// ─────────────────────────────────────────────────────────────

export function getTier3SystemPrompt(): string {
    const langName = getPromptLanguageName();
    return `You are an expert Python unit test engineer.
You will receive a pre-built test scaffold with @patch mock decorators already configured.
Your task: fill in the TODO sections only.
- Set meaningful input values for the parameters.
- Call the target function.
- Write assertions using real return values provided.
- Do NOT modify @patch decorators or mock.return_value lines.
- Do NOT add new imports.
Output format:
\`\`\`python
(completed test method body only, no class wrapper)
\`\`\``;
}

export function getTier3UserPrompt(
    funcName: string,
    scaffold: string,
    moduleName: string,
    traceExamples: Array<{args: string[], result: string}> = []
): string {
    let prompt = `Target function: ${funcName} (from module: ${moduleName})\n\n`;
    if (traceExamples.length > 0) {
        prompt += `Verified real return values to use in assertions:\n`;
        for (const ex of traceExamples.slice(0, 3)) {
            prompt += `  - Input(${ex.args.join(', ')}) => ${ex.result}\n`;
        }
        prompt += `\n`;
    }
    prompt += `Test scaffold (fill in the TODO sections):\n\`\`\`python\n${scaffold}\n\`\`\`\n\nFill in the TODO sections now:`;
    return prompt;
}

// ─────────────────────────────────────────────────────────────
// Tier 4：全自主 + Self-repair（100B+/Cloud）
// ─────────────────────────────────────────────────────────────

export function getTier4SystemPrompt(): string {
    const langName = getPromptLanguageName();
    return `You are an expert Python unit test engineer. Write a complete, production-quality unittest.TestCase.

Output format:
<thinking>
(analysis in ${langName.toUpperCase()})
</thinking>

\`\`\`python
(complete unittest file)
\`\`\`

Guidelines:
- Use absolute imports (e.g. from service_auth import login_user).
- Use unittest.mock (patch, MagicMock) for all external dependencies.
- Cover all edge cases: None, empty, boundary values, all exception paths.
- Every test method name must start with test_.
- Do NOT copy the source code.`;
}

export function getTier4SelfRepairPrompt(stderr: string): string {
    return `Your test file failed pre-verification with these errors:

\`\`\`
${stderr.substring(0, 2000)}
\`\`\`

Fix ONLY the failing test methods. Output the complete corrected test file.`;
}



/**
 * 某些小模型（Qwen、llama 系列等）對 <thinking> 標籤有副作用（無限迴圈輸出）
 * 這些模型不使用 thinking 標籤，改成直接輸出 code block
 */
function useThinkingTag(modelName: string): boolean {
    const m = modelName.toLowerCase();
    // 已知對 thinking 標籤有副作用的模型家族
    const noThinkingModels = ['qwen', 'llama', 'phi', 'tinyllama', 'gemma', 'mistral'];
    for (const bad of noThinkingModels) {
        if (m.includes(bad)) return false;
    }
    return true;
}

export function getSystemPrompt(
    loopCount: number,
    strategy: 'small' | 'large',
    survivedMutants?: string,
    modelName: string = ''
): string {
    const langName = getPromptLanguageName();
    const thinking = useThinkingTag(modelName);

    if (strategy === 'small') {
        const formatBlock = thinking
            ? `Output format:\n<thinking>\n(brief analysis in ${langName.toUpperCase()})\n</thinking>\n\n\`\`\`python\n(your unittest code)\n\`\`\``
            : `Output format:\n\`\`\`python\n(your unittest code)\n\`\`\``;

        let prompt = `You are a Python unit test writer. Write a unittest.TestCase for the given function.

${formatBlock}

Rules:
1. Start with import unittest. Import the function using: from MODULE import FUNCTION (absolute, not relative).
2. Each test method starts with test_ and uses self.assert*().
3. Do NOT copy or redefine the source function. Write test methods only.
4. No pytest. No top-level assert.
5. CRITICAL: If an input Raises an Exception (e.g. ValueError), you MUST use \`with self.assertRaises(ExceptionType):\` block. Do NOT assign the result of a call that raises an exception.`;

        if (loopCount > 1 && survivedMutants) {
            prompt += `\n\nSome mutants survived. Fix the tests to kill them:\n${survivedMutants}`;
            const hints = getMutationOperatorHints(survivedMutants);
            if (hints) { prompt += `\n${hints}`; }
        }
        return prompt;
    }

    // Large model: full guidelines
    let prompt = `You are an expert Python Unit Testing Engineer. Write a comprehensive unittest.TestCase to kill all mutation testing survivors.

Output format:
<thinking>
(analysis in ${langName.toUpperCase()})
</thinking>

\`\`\`python
(complete unittest code)
\`\`\`

Guidelines:
- Use absolute import (e.g. from service_auth import login_user).
- Use unittest.mock (patch, MagicMock) for external dependencies.
- Cover edge cases: None, empty, boundary values, exception paths.
- Do NOT copy the source code into your output.
`;

    prompt += `\nFEW-SHOT EXAMPLES:\n${formatFewShotForPrompt(getBaseFewShotExamples(), thinking)}\n`;

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
    budgetTokens: number = 20000,
    modelName: string = ''
): string {
    const moduleName = fileName.replace(/\\/g, '/').split('/').pop()?.replace('.py', '') || 'module';
    const thinking = useThinkingTag(modelName);

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

        // 動態執行追蹤結果（真實 input→output 範例，讓 LLM 不用猜 assert 值）
        const trace = astContext.traceResult;
        if (trace && !trace.load_error && (trace.examples.length > 0 || trace.errors.length > 0)) {
            prompt += `\nVerified Real Execution Results (Use these EXACT values in your test assertions):\n`;
            for (const ex of trace.examples.slice(0, 5)) {
                prompt += `  - Input: (${ex.args.join(', ')}) => Returns: ${ex.result} (Use: self.assertEqual(...))\n`;
            }
            for (const er of trace.errors.slice(0, 5)) {
                prompt += `  - Input: (${er.args.join(', ')}) => Raises: ${er.exception}("${er.message}") (MUST Use: with self.assertRaises(${er.exception}): ...)\n`;
            }
            prompt += `\n`;
        }

        // Dependency contexts (budget-aware distillation)
        if (astContext.dependencyContexts && astContext.dependencyContexts.length > 0) {
            prompt += `\nExternal dependencies:\n`;
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
            prompt += `\nThis function is called with different arguments in the project. Cover all:\n`;
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
                    prompt += `\nExamples:\n${formatFewShotForPrompt(subset, thinking)}\n`;
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
        const trigger = thinking
            ? `\n\nImport from: from ${moduleName} import ${funcName}\n\nWrite the test file now:\n<thinking>\n`
            : `\n\nImport from: from ${moduleName} import ${funcName}\n\nWrite the test file now:\n\`\`\`python\n`;
        prompt += trigger;
    } else {
        prompt += `\n\nWrite the complete unittest test file now.\n`;
    }

    return prompt;
}