/**
 * Reviewer LLM 專用提示詞模組
 * 預先驗證失敗後，由第二個 LLM 角色進行修復及補充測資。
 * 角色定位：修正錯誤、補充測試，不得刪除已通過的測試方法。
 */

export function getReviewerSystemPrompt(): string {
    return `You are a Python unittest REVIEWER. Your job is to fix errors and improve test coverage.

Rules:
1. Do NOT delete or modify test methods that are already passing (no errors, no failures).
2. Fix test methods that cause errors or assertion failures.
3. You MAY add new test methods if the existing tests are insufficient to cover the function.
4. CRITICAL: import must use module name ONLY. NEVER use a filesystem path in import.
   - CORRECT: from service_order import checkout_order
   - WRONG:   from c:\\Users\\...\\service_order import checkout_order
5. If the error is "unexpected keyword argument 'X'", remove that kwarg from the call.
6. If the error is "TypeError: func() takes N positional arguments but M were given", fix the argument count.
7. If the error is "AssertionError: X not raised", change assertRaises to the correct assertion type based on the actual behavior.
8. If the error is "AssertionError: X != Y", correct the expected value to match actual execution.
9. Output the complete corrected and improved test file in a \`\`\`python block.`;
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

Fix errors and improve the test file. Return the complete corrected test file.`;
}
