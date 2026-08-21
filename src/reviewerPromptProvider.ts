/**
 * Reviewer LLM 專用提示詞模組
 * 預先驗證失敗後，由 Reviewer LLM 進行精準修復及補充測資。
 * 角色定位：依據目標原始碼與錯誤日誌，修復語意斷言、切片邊界、例外斷言與引數問題，不得刪除已通過的測試方法。
 */

export function getReviewerSystemPrompt(): string {
    return `You are an expert Python unittest REVIEWER and DEBUGGER.
Your job is to fix errors and assertion failures in the provided test file by comparing it against the ACTUAL TARGET SOURCE CODE and ERROR TRACEBACK.

CORE RULES:
1. PRESERVE PASSING TESTS: Do NOT delete or modify test methods that are already passing without errors.
2. FIX SEMANTIC ASSERTIONS: Look at the TARGET SOURCE CODE to find the true expected return value:
   - If the code returns a string (e.g. "Login Failed: Token too short"), use: self.assertEqual(result, "Login Failed: Token too short")
   - Do NOT guess or hallucinate return values. Check the return statements in the source code directly!
3. EXCEPTION HANDLING RULES:
   - If the target function (or an unhandled dependency) explicitly executes \`raise SomeError("...")\`, use:
     \`\`\`python
     with self.assertRaises(SomeError):
         func_under_test(...)
     \`\`\`
   - NEVER write \`self.assertRaises(SomeError, result)\` — this is a syntax/runtime error in unittest.
   - If the target function catches exceptions internally with \`try...except\` and returns an error message string, DO NOT use assertRaises! Use self.assertEqual(result, "expected string").
4. STRING SLICING & MATH:
   - Check exact slice indexing in source code:
     - \`token[:5]\` takes the FIRST 5 characters (e.g., '123456789012'[:5] == '12345').
     - \`token[-5:]\` takes the LAST 5 characters (e.g., '123456789012'[-5:] == '89012').
5. FUNCTION SIGNATURE & CALLS:
   - Call the target function ONLY with its valid declared parameters.
   - Do NOT pass undeclared keyword arguments (e.g., if func takes (order_id, token), do NOT pass provider="jwt").
6. IMPORTS — CRITICAL:
   - The MODULE NAME is provided in "=== TARGET FUNCTION INFO ===" below. Use EXACTLY that module name.
   - Correct: \`from core_utils import validate_and_format_token\`
   - WRONG: \`from validate_and_format_token import validate_and_format_token\` ← NEVER name import after the function!
   - WRONG: \`from c:\\Users\\... import ...\` ← NEVER use filesystem paths.
7. assertRaises SYNTAX — CRITICAL:
   - ONLY valid form: \`with self.assertRaises(ValueError):\` followed by the call on the next line.
   - NEVER pass a message string: \`with self.assertRaises(ValueError, 'msg'):\` ← TypeError, FORBIDDEN!
8. TOKEN LENGTH BOUNDARY — CRITICAL:
   - \`len(token) < 10\` raises ValueError. Token length MUST be STRICTLY LESS THAN 10 to trigger the error.
   - A token of length 9 ("123456789") → raises ValueError.
   - A token of length 10 ("1234567890") → DOES NOT raise, processes normally.
   - A token of length 71 (any long string) → DOES NOT raise. Do NOT use [:-1] on a long string expecting ValueError!
   - Use short, explicit invalid tokens like "abc" (len=3) or "123456789" (len=9).
9. OUTPUT FORMAT:
   - Output the COMPLETE, corrected, runnable test file in a single \`\`\`python ... \`\`\` code block.`;
}

export function getReviewerUserPrompt(
    brokenCode: string,
    errorOutput: string,
    funcName: string,
    funcArgs: string[],
    sourceCode?: string,
    astContext?: any,
    moduleName: string = 'module_name'
): string {
    const sigLine = funcArgs.length > 0
        ? `${funcName}(${funcArgs.join(', ')})`
        : `${funcName}()  ← Takes ZERO arguments`;

    let prompt = `=== BROKEN TEST CODE ===\n\`\`\`python\n${brokenCode}\n\`\`\`\n\n`;
    prompt += `=== PRE-VERIFICATION ERROR LOG ===\n\`\`\`text\n${errorOutput.substring(0, 2000)}\n\`\`\`\n\n`;
    prompt += `=== TARGET FUNCTION INFO ===\n`;
    prompt += `- Module Name: ${moduleName}\n`;
    prompt += `- Import Statement: from ${moduleName} import ${funcName}\n`;
    prompt += `- Exact Signature: ${sigLine}\n\n`;

    if (sourceCode) {
        prompt += `=== TARGET SOURCE CODE (Check return values and raises here) ===\n\`\`\`python\n${sourceCode.trim()}\n\`\`\`\n\n`;
    }

    if (astContext?.dependencyContexts && astContext.dependencyContexts.length > 0) {
        prompt += `=== DEPENDENCY SOURCE CODE ===\n`;
        for (const dep of astContext.dependencyContexts.slice(0, 3)) {
            if (dep.code) {
                prompt += `\`\`\`python\n# Dependency: ${dep.name}\n${dep.code.trim()}\n\`\`\`\n`;
            }
        }
        prompt += `\n`;
    }

    const trace = astContext?.traceResult;
    if (trace && !trace.load_error && (trace.examples?.length > 0 || trace.errors?.length > 0)) {
        prompt += `=== VERIFIED REAL EXECUTION TRACE ===\n`;
        for (const ex of (trace.examples || []).slice(0, 5)) {
            prompt += `  - Input: (${ex.args.join(', ')}) => Returned: ${ex.result}\n`;
        }
        for (const er of (trace.errors || []).slice(0, 5)) {
            prompt += `  - Input: (${er.args.join(', ')}) => Raised: ${er.exception}("${er.message}")\n`;
        }
        prompt += `\n`;
    }

    prompt += `INSTRUCTION:\nCarefully read the error log and the target source code. Fix all failures and errors, verify slices and assertions, and output the complete corrected test file in a \`\`\`python code block.`;
    return prompt;
}

