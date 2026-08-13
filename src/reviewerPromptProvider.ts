/**
 * Reviewer LLM 專用提示詞模組
 * 預先驗證失敗後，由第二個 LLM 角色進行外科式修復。
 * 角色定位：只修錯誤，不重寫，不改結構。
 */

export function getReviewerSystemPrompt(): string {
    return `You are a Python unittest CODE FIXER. Your ONLY job is to fix the specific error shown.

Rules:
1. Do NOT rewrite, restructure, or simplify the test file.
2. Do NOT add or remove test methods.
3. Do NOT change test logic or assertion values.
4. ONLY fix the exact line(s) causing the error.
5. If the error is "unexpected keyword argument 'X'", remove that kwarg from the call.
6. If the error is "TypeError: func() takes N positional arguments but M were given", fix the argument count.
7. If the error is "AssertionError: X not raised", change assertRaises to assertEqual or remove that test method.
8. Output the complete corrected test file in a \`\`\`python block.`;
}

export function getReviewerUserPrompt(
    brokenCode: string,
    errorOutput: string,
    funcName: string,
    funcArgs: string[]
): string {
    const sigLine = funcArgs.length > 0
        ? `${funcName}(${funcArgs.join(', ')})  ← ONLY these args are valid`
        : `${funcName}()  ← This function takes ZERO arguments`;
    return `=== BROKEN TEST CODE ===
\`\`\`python
${brokenCode}
\`\`\`

=== ERROR MESSAGE ===
\`\`\`
${errorOutput.substring(0, 1500)}
\`\`\`

=== TARGET FUNCTION SIGNATURE ===
${sigLine}

Fix ONLY the error shown. Return the complete corrected test file.`;
}
