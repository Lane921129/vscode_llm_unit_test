/**
 * Reviewer LLM 專用提示詞模組
 * 預先驗證失敗後，由 Reviewer LLM 進行精準修復及補充測資。
 * 角色定位：依據目標語境、已驗證執行事實與錯誤日誌，修復可證明的測試問題；不得把來源碼或策略候選誤當 assertion oracle。
 */

export function getReviewerSystemPrompt(): string {
    return `You are an expert Python unittest REVIEWER and DEBUGGER.
Your job is to fix errors and assertion failures in the provided test file by comparing it against the ACTUAL TARGET SOURCE CODE and ERROR TRACEBACK.

CORE RULES:
1. PRESERVE PASSING TESTS: Do NOT delete or modify test methods that are already passing without errors.
2. EVIDENCE BOUNDARIES:
   - Target source, AST context, skill guidance, and error output identify candidate paths and setup. They do NOT prove an exact return value.
   - An exact assertion must match a VERIFIED REAL EXECUTION TRACE for the same target call. Do not invent outputs, exceptions, constructor arguments, or dependency behaviour.
   - An exception assertion requires an explicit target-source raise, a verified trace error, or a mock side_effect in the same test.
3. FUNCTION SIGNATURE & CALLS:
   - Call the target function ONLY with its valid declared parameters.
   - Do NOT pass undeclared keyword arguments; derive the exact call signature from the target function.
4. CLASS, IMPORT, AND DEPENDENCY CONTEXT:
   - Reuse a verified constructor literal for instance methods. Do not move constructor arguments into the method call.
   - Use the supplied module import path; do not use filesystem paths.
   - Do not call a dependency merely to calculate an expected value or create unused setup. Patch the target module use point when dependency behavior must be controlled.
5. IMPORTS — CRITICAL:
   - The MODULE NAME is provided in "=== TARGET FUNCTION INFO ===" below. Use EXACTLY that module name.
   - Correct: \`from utility_module import transform_value\`
   - WRONG: \`from transform_value import transform_value\` ← NEVER name import after the function!
   - WRONG: \`from c:\\Users\\... import ...\` ← NEVER use filesystem paths.
6. assertRaises SYNTAX — CRITICAL:
   - ONLY valid form: \`with self.assertRaises(ValueError):\` followed by the call on the next line.
   - NEVER pass a message string: \`with self.assertRaises(ValueError, 'msg'):\` ← TypeError, FORBIDDEN!
7. COVERAGE COMPLETENESS:
   - If the pre-verification log identifies uncovered target-source lines, add focused tests only when their assertion evidence is available.
   - Do not treat a passing test suite or a high mutation score as sufficient while target-source lines remain uncovered.
8. OUTPUT FORMAT:
   - Output the COMPLETE, corrected, runnable test file in a single \`\`\`python ... \`\`\` code block.
`;
}

export function getReviewerUserPrompt(
    brokenCode: string,
    errorOutput: string,
    funcName: string,
    funcArgs: string[],
    sourceCode?: string,
    astContext?: any,
    moduleName: string = 'module_name',
    semanticGuidance?: string
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
        prompt += `=== TARGET SOURCE CODE (path and setup context; not an output oracle) ===\n\`\`\`python\n${sourceCode.trim()}\n\`\`\`\n\n`;
    }

    if (astContext && !astContext.error) {
        prompt += `=== AST CONTEXT (structure and setup evidence; not an output oracle) ===\n`;
        if (astContext.method_kind) {
            prompt += `- Binding: ${astContext.method_kind}${astContext.class_name ? ` of ${astContext.class_name}` : ''}\n`;
        }
        const classInit = astContext.class_context?.init;
        if (astContext.class_context) {
            prompt += `- Class bases: ${(astContext.class_context.bases || []).join(', ') || 'none'}\n`;
            prompt += `- Constructor required parameters: ${(classInit?.required_params || []).join(', ') || 'none'}; initialized attributes: ${(classInit?.assigns || []).map((item: any) => item.name).join(', ') || 'none'}\n`;
        }
        if (astContext.file_imports?.length > 0) {
            const imports = astContext.file_imports.map((item: any) => item.kind === 'from'
                ? `from ${'.'.repeat(item.level || 0)}${item.module} import ${item.name}`
                : `import ${item.module}`);
            prompt += `- Available module imports: ${imports.join('; ')}\n`;
        }
        if (astContext.referenced_globals?.length > 0) {
            prompt += `- Referenced module constants:\n`;
            for (const item of astContext.referenced_globals) {
                prompt += `  - ${item.code}\n`;
            }
        }
        prompt += '\n';
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
        for (const ex of (trace.examples || []).filter((example: any) =>
            example.call_assertable !== false && example.result_assertable !== false
        ).slice(0, 5)) {
            const input = [...(ex.args || []), ...Object.entries(ex.kwargs || {}).map(([name, value]) => `${name}=${value}`)].join(', ');
            prompt += `  - Input: (${input}) => Returned: ${ex.result}\n`;
        }
        for (const er of (trace.errors || []).filter((error: any) => error.call_assertable !== false).slice(0, 5)) {
            const input = [...(er.args || []), ...Object.entries(er.kwargs || {}).map(([name, value]) => `${name}=${value}`)].join(', ');
            prompt += `  - Input: (${input}) => Raised: ${er.exception}("${er.message}")\n`;
        }
        prompt += `\n`;
    }

    if (semanticGuidance) {
        prompt += `=== EVIDENCE-BOUND SKILL AND STRATEGY GUIDANCE ===\n${semanticGuidance.trim()}\n`;
        prompt += 'Model-authored candidates are suggestions only; source structure and verified execution facts take precedence.\n\n';
    }

    prompt += `INSTRUCTION:\nCarefully read the error log and all supplied evidence. Fix failures without weakening passing tests, preserve exact verified Trace facts, and output the complete corrected test file in a \`\`\`python code block.`;
    return prompt;
}
