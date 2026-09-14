/**
 * Bug Fixer 專用提示詞模組
 * 只處理實際驗證失敗；審查與品質補測使用獨立契約。
 * 角色定位：依據目標語境、已驗證執行事實與錯誤日誌，修復可證明的測試問題；不得把來源碼或策略候選誤當 assertion oracle。
 */

import { summarizeRepairOutput } from '../validation/repairFeedback';

export function getBugFixerSystemPrompt(): string {
    return `You are a Python unittest Bug Fixer.
Fix only the concrete Python unittest failure named in BUG_FIX_REQUEST_V2.

CONTRACT:
- Preserve every existing test name. Never add, delete, rename, or rewrite a passing or unrelated test.
- Change only methods listed in ALLOWED CHANGES. If no method is identified, change at most one test method related to the reported validation error.
- Imports may be added. Replace an existing import only for ImportError or ModuleNotFoundError. Do not change setUp, tearDown, helpers, or reserved TestVerifiedTrace_* methods.
- Use the exact target import and allowed mock use-point paths supplied by the runner. A return_value does not raise; use side_effect inside the failing test for a mocked exception.
- Source and AST context identify structure and setup. They do NOT prove an exact return value. Exact assertions and exceptions require the supplied verified trace, explicit source raise, or same-test mock behavior.
- Return the complete runnable test file only. The runner enforces this repair scope before execution.
`;
}

export function failedTestNamesFromOutput(output: string): string[] {
    const found = new Set<string>();
    for (const pattern of [
        /^(test_[A-Za-z0-9_]+)\s+\([^\n]+\)\s+\.\.\.\s+(?:FAIL|ERROR)\s*$/gm,
        /^(?:FAIL|ERROR):\s+(test_[A-Za-z0-9_]+)\b/gm,
        /\bin\s+(test_[A-Za-z0-9_]+)\b/g
    ]) {
        for (const match of output.matchAll(pattern)) { found.add(match[1]); }
    }
    return [...found].sort();
}

export function getBugFixerUserPrompt(
    brokenCode: string,
    errorOutput: string,
    funcName: string,
    funcArgs: string[],
    sourceCode?: string,
    astContext?: any,
    moduleName: string = 'module_name',
    semanticGuidance?: string,
    allowedMockTargets: string[] = []
): string {
    const sigLine = funcArgs.length > 0
        ? `${funcName}(${funcArgs.join(', ')})`
        : `${funcName}()  ← Takes ZERO arguments`;

    const failedTests = failedTestNamesFromOutput(errorOutput);
    let prompt = `BUG_FIX_REQUEST_V2\n`;
    prompt += `=== ALLOWED CHANGES ===\n`;
    prompt += failedTests.length > 0
        ? `Only these failing test methods may change: ${failedTests.join(', ')}\n`
        : 'No failing test method was identified. You may change at most one relevant test method, add a missing import, or repair syntax.\n';
    prompt += 'Do not add, remove, or rename tests. Replace imports only when the latest failure is ImportError or ModuleNotFoundError.\n\n';
    prompt += `=== TARGET FUNCTION INFO ===\n`;
    prompt += `- Module Name: ${moduleName}\n`;
    prompt += `- Import Statement: from ${moduleName} import ${funcName}\n`;
    prompt += `- Allowed dependency mock use points: ${allowedMockTargets.length ? allowedMockTargets.join(', ') : 'none supplied; preserve existing verified patches'}\n`;
    prompt += `- Every target import and mock patch must use this module identity. Do not mix bare-file and package imports.\n`;
    prompt += `- Exact Signature: ${sigLine}\n\n`;

    prompt += `=== LATEST FAILURE ===\n\`\`\`text\n${summarizeRepairOutput(errorOutput)}\n\`\`\`\n\n`;
    prompt += `=== CURRENT TEST FILE ===\n\`\`\`python\n${brokenCode}\n\`\`\`\n\n`;

    if (sourceCode) {
        prompt += `=== TARGET SOURCE CODE (path and setup context; not an output oracle) ===\n\`\`\`python\n${sourceCode.trim()}\n\`\`\`\n\n`;
    }

    if (astContext && !astContext.error) {
        prompt += `=== AST CONTEXT (structure and setup evidence; not an output oracle) ===\n`;
        const typedParameters = (astContext.signature || [])
            .filter((param: any) => typeof param.annotation === 'string' && param.annotation.trim())
            .map((param: any) => `${param.name}: ${param.annotation}`);
        if (typedParameters.length > 0) {
            prompt += `- Source parameter type hints (input shape only): ${typedParameters.join('; ')}\n`;
        }
        if (astContext.method_kind) {
            prompt += `- Binding: ${astContext.method_kind}${astContext.class_name ? ` of ${astContext.class_name}` : ''}\n`;
        }
        const classInit = astContext.class_context?.init;
        if (astContext.class_context) {
            prompt += `- Class bases: ${(astContext.class_context.bases || []).join(', ') || 'none'}\n`;
            prompt += `- Constructor required parameters: ${(classInit?.required_params || []).join(', ') || 'none'}; initialized attributes: ${(classInit?.assigns || []).map((item: any) => item.name).join(', ') || 'none'}\n`;
            const typedConstructorParameters = (classInit?.signature || [])
                .filter((param: any) => typeof param.annotation === 'string' && param.annotation.trim())
                .map((param: any) => `${param.name}: ${param.annotation}`);
            if (typedConstructorParameters.length > 0) {
                prompt += `- Constructor type hints (input shape only): ${typedConstructorParameters.join('; ')}\n`;
            }
            const effectiveInit = astContext.class_context?.effective_init;
            if (effectiveInit?.defined_on && effectiveInit.defined_on !== astContext.class_name) {
                prompt += `- Inherited constructor source: ${effectiveInit.defined_on}; required parameters: ${(effectiveInit.required_params || []).join(', ') || 'none'}; initialized attributes: ${(effectiveInit.assigns || []).map((item: any) => item.name).join(', ') || 'none'}. This remains setup context, not an assertion oracle.\n`;
            }
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

    prompt += `RESPONSE:\nReturn the complete corrected test file. Make the smallest edit allowed by ALLOWED CHANGES.`;
    return prompt;
}

export function getReviewEvidence(...args: Parameters<typeof getBugFixerUserPrompt>): string {
    const context = getBugFixerUserPrompt(...args);
    return context.slice(context.indexOf('=== TARGET FUNCTION INFO ==='), context.lastIndexOf('RESPONSE:'));
}
