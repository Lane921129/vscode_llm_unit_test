import { getBaseFewShotExamples, getDynamicFewShotExamples, getMutationOperatorHints, formatFewShotForPrompt } from '../prompts/fewShotExamples';
import { formatWriterEvidenceBundleForPrompt, WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { formatTargetContract } from '../pipeline/targetContract';
import { buildCompactWriterContext } from '../prompts/compactWriterContext';
import { buildVerifiedConstructorCall } from '../tier/tier1TestBuilder';

/**
 * Tier 1 is intentionally small, but it is still an LLM judgement step: the
 * model selects useful observable behaviours and test organization from the
 * supplied evidence. The deterministic pipeline then proves the candidate.
 */
export function getTier1EvidenceBoundSystemPrompt(): string {
    return `You are a careful Python unittest engineer. Write one complete, runnable unittest file for the target function.

Output ONLY one Python code fence containing the complete file. Do not include analysis or prose.

Evidence rules:
1. Use the target source and AST facts only to choose relevant paths and candidate inputs. They never prove an output or exception by themselves.
2. An exact assertion or assertRaises type must be supported by a Verified Real Execution Result. Do not invent return values, exceptions, constructor arguments, imports, or external behaviour.
3. Use the supplied class context and verified constructor setup exactly when testing an instance method. Do not pass constructor arguments to the method.
4. Selected test-generation rules are scoped guidance for this function, not facts that override source or executed-observation evidence.
5. Include import unittest, a unittest.TestCase, and test_ methods. Do not copy or redefine the production source. No pytest or top-level assert.
6. If executed-observation evidence is absent for a proposed path, omit that assertion rather than guessing.
7. Do not call a dependency directly merely to calculate an expected value or create unused setup. When dependency behavior must be controlled, patch it at the target module's use point.

The generated file will be rejected unless it passes structural, isolated execution, coverage, and mutation checks.`;
}

// ─────────────────────────────────────────────────────────────
// Tier 3：Mock Scaffold 策略（34–70B 中大模型）
// ─────────────────────────────────────────────────────────────

export function getTier3SystemPrompt(): string {
    return `You are an expert Python unit test engineer.
You will receive a pre-built test scaffold with @patch mock decorators already configured.
Your task: use the scaffold as setup guidance and return a COMPLETE runnable unittest file, including imports and a TestCase class.
- Set meaningful input values for the parameters.
- Call the target function.
- Write assertions using real return values provided.
- Check scaffold mock setup against the supplied target source and complete evidence; correct placeholders and mock shapes when needed.
- Use only isolated mock or in-memory resources. Never perform real external I/O.
- Preserve the exact target import, class binding, constructor requirements and verified assertions.
Output format:
\`\`\`python
(complete unittest file, with imports and class wrapper)
\`\`\``;
}

export function getTier3UserPrompt(
    funcName: string,
    scaffold: string,
    moduleName: string,
    traceExamples: Array<{args: string[], result?: string}> = [],
    verifiedConstructorCall?: string | null,
    targetSource?: string,
    semanticGuidance?: string,
    writerEvidence?: string
): string {
    let prompt = `Target function: ${funcName} (from module: ${moduleName})\n\n`;
    if (traceExamples.length > 0 && !writerEvidence) {
        prompt += `Verified real return values to use in assertions:\n`;
        for (const ex of traceExamples.slice(0, 3)) {
            prompt += `  - Input(${ex.args.join(', ')}) => ${ex.result}\n`;
        }
        prompt += `\n`;
    }
    if (verifiedConstructorCall) {
        prompt += `Verified constructor setup from a real call site:\n`;
        prompt += `  - Use exactly: instance = ${verifiedConstructorCall}\n`;
        prompt += `  - These are constructor arguments only. Do NOT pass them to ${funcName}(...).\n\n`;
    }
    if (targetSource && !writerEvidence) {
        prompt += `Target source (evidence; do not copy it into the test):\n\`\`\`python\n${targetSource.trim()}\n\`\`\`\n\n`;
    }
    if (semanticGuidance && !writerEvidence) {
        prompt += `Evidence-bound test-rule guidance (source and verified execution facts take precedence over model suggestions):\n${semanticGuidance.trim()}\n\n`;
    }
    if (writerEvidence) { prompt += `Complete Writer evidence (retain the same source, binding and verified observations):\n${writerEvidence}\n\n`; }
    prompt += `Test scaffold (setup guidance, not an assertion oracle):\n\`\`\`python\n${scaffold}\n\`\`\`\n\nReturn the complete unittest file now:`;
    return prompt;
}

export function getSystemPrompt(
    loopCount: number,
    strategy: 'small' | 'large',
    survivedMutants?: string,
    modelName: string = ''
): string {
    const thinking = false;
    void thinking;
    // A single code-fence contract is portable across providers. Model names
    // are not a reliable capability signal and thinking tags often leak prose
    // into generated Python, so every model receives the same output shape.

    if (strategy === 'small') {
        const formatBlock = `Output format:\n\`\`\`python\n(your unittest code)\n\`\`\``;

        let prompt = `You are a Python unit test writer. Write a unittest.TestCase for the given function.

${formatBlock}

Rules:
1. Start with import unittest. Import the target function using its actual module name (e.g. from my_module import target_func). NEVER write literal "from MODULE import FUNCTION".
2. Each test method starts with test_ and uses self.assert*().
3. Do NOT copy or redefine the source function. Write test methods only.
4. No pytest. No top-level assert.
5. CRITICAL: If an input Raises an Exception (e.g. ValueError), you MUST use \`with self.assertRaises(ExceptionType):\` block. Do NOT assign the result of a call that raises an exception.
   - WRONG: \`with self.assertRaises(ValueError, 'msg'):\` ← TypeError — NEVER pass a string as second arg to assertRaises!
6. ALWAYS use Verified Real Execution Results (if provided) to determine expected behavior. Do NOT guess return values or exception types.
7. Do NOT call a dependency directly merely to calculate an expected value or create unused setup. When dependency behavior must be controlled, patch it at the target module's use point.`;

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
\`\`\`python
(complete unittest code)
\`\`\`

Output only that single Python code fence. Do not include analysis, reasoning, headings, or other prose.

Guidelines:
- Use absolute import (e.g. from module_name import target_function).
- Use unittest.mock (patch, MagicMock) for external dependencies.
- Cover branches, boundaries, and exception paths that are supported by the source code, selected test-generation rule cards, or verified execution facts. Do not add None or empty-input tests merely by habit.
- Do NOT copy the source code into your output.
- assertRaises syntax: ONLY \`with self.assertRaises(ValueError):\` — NEVER pass a string: \`assertRaises(ValueError, 'msg')\` is a TypeError!
- ALWAYS use Verified Real Execution Results (if provided) to determine expected behavior. Do NOT guess return values.
- Do NOT call a dependency directly merely to calculate an expected value or create unused setup. When dependency behavior must be controlled, patch it at the target module's use point.
`;

    prompt += `\nFEW-SHOT EXAMPLES:\n${formatFewShotForPrompt(getBaseFewShotExamples(), false)}\n`;

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

/**
 * Keep semantic guidance useful for small-context models without cutting a
 * rule or code fence mid-sentence.  The formatter emits complete `=== ... ===`
 * sections, so selection can prefer execution facts and evidence-bound test-rule
 * cards before lower-confidence candidate suggestions.
 */
export function compactSemanticGuidanceForBudget(guidance: string, maxTokens: number): string | undefined {
    if (!guidance.trim() || maxTokens <= 0) {
        return undefined;
    }
    if (estimateTokens(guidance) <= maxTokens) {
        return guidance.trim();
    }

    const headings = [...guidance.matchAll(/^=== [^\n]+ ===\s*$/gm)];
    if (headings.length === 0) {
        return undefined;
    }
    const sections = headings.map((heading, index) => {
        const start = heading.index || 0;
        const end = headings[index + 1]?.index ?? guidance.length;
        const text = guidance.slice(start, end).trim();
        const title = heading[0].trim();
        const priority = title.includes('FUNCTION-SPECIFIC RULES') || title.includes('DETERMINISTIC TEST RULE BASELINE')
            ? 1
            : title.includes('SEMANTIC GUIDANCE') || title.includes('VERIFIED DEPENDENCY FACTS')
                ? 0
                : title.includes('TEST DATA STRATEGY')
                    ? 2
                    : title.includes('CANDIDATE PATH GUIDANCE')
                        ? 3
                        : 4;
        return { text, priority, originalIndex: index };
    });

    const selected: typeof sections = [];
    let usedTokens = 0;
    for (const section of [...sections].sort((a, b) => a.priority - b.priority || a.originalIndex - b.originalIndex)) {
        const sectionTokens = estimateTokens(section.text);
        if (usedTokens + sectionTokens <= maxTokens) {
            selected.push(section);
            usedTokens += sectionTokens;
        }
    }
    if (selected.length === 0) {
        return undefined;
    }

    const omitted = selected.length < sections.length;
    const output = selected
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .map(section => section.text)
        .join('\n\n');
    return omitted
        ? `${output}\n\n[Semantic guidance was budget-reduced; omitted sections are suggestions, not execution facts.]`
        : output;
}

function distillDependency(dep: any): string {
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
    modelName: string = '',
    semanticEvidence?: string | WriterEvidenceBundleV3
): string {
    const semanticGuidance = typeof semanticEvidence === 'string'
        ? semanticEvidence
        : semanticEvidence ? formatWriterEvidenceBundleForPrompt(semanticEvidence) : undefined;
    const moduleName = astContext?.target_import_module
        || fileName.replace(/\\/g, '/').split('/').pop()?.replace('.py', '') || 'module';

    if (strategy === 'small' && semanticEvidence && typeof semanticEvidence !== 'string') {
        return buildCompactWriterContext({ module: moduleName, name: funcName,
            source: astContext?.code || code, context: astContext, evidence: semanticEvidence,
            focus: focusContexts, budgetTokens });
    }

    let prompt = `Target file: ${fileName}\nTarget function: ${funcName}\n${formatTargetContract(moduleName, funcName, astContext?.args || [], astContext)}\n`;

    const comparisonOperators: Record<string, string> = {
        Eq: '==', NotEq: '!=', Lt: '<', LtE: '<=', Gt: '>', GtE: '>=',
        Is: 'is', IsNot: 'is not', In: 'in', NotIn: 'not in',
    };
    const formatConditionFact = (fact: any): string | null => {
        if (typeof fact?.parameter !== 'string') {
            return null;
        }
        const subject = fact.subject === 'length' ? `len(${fact.parameter})` : fact.parameter;
        const line = Number.isInteger(fact.line) ? `Source line ${fact.line}: ` : '';
        if (fact.kind === 'match') {
            if (!Array.isArray(fact.literals) || !fact.literals.every((literal: unknown) => typeof literal === 'string')) {
                return null;
            }
            return `${line}match ${subject} includes cases (${fact.literals.join(', ')})`;
        }
        if (fact.kind === 'truthiness') {
            const state = fact.polarity === 'falsy' ? 'falsy' : 'truthy';
            return `${line}${subject} is used as a ${state} branch condition`;
        }
        if (typeof fact.operator !== 'string') {return null;}
        const operator = comparisonOperators[fact.operator] || fact.operator;
        if (fact.kind === 'membership') {
            if (!Array.isArray(fact.literals) || !fact.literals.every((literal: unknown) => typeof literal === 'string')) {
                return null;
            }
            return `${line}${subject} ${operator} (${fact.literals.join(', ')})`;
        }
        if (fact.kind !== 'comparison' || typeof fact.literal !== 'string') {return null;}
        return `${line}${subject} ${operator} ${fact.literal}`;
    };

    if (astContext && !astContext.error) {
        prompt += `\nFunction info:\n`;
        prompt += `- Name: ${astContext.name}\n`;
        if (astContext.args && astContext.args.length > 0) {
            prompt += `- Parameters: ${astContext.args.join(', ')}\n`;
            const signature = Array.isArray(astContext.signature) ? astContext.signature : [];
            if (signature.length > 0) {
                const required = signature.filter((param: any) => param.required).map((param: any) => param.name);
                const optional = signature.filter((param: any) => !param.required).map((param: any) => param.default === null ? param.name : `${param.name}=${param.default}`);
                prompt += `- Required parameters: ${required.join(', ') || 'none'}; optional/variadic parameters: ${optional.join(', ') || 'none'}.\n`;
                const typedParameters = signature
                    .filter((param: any) => typeof param.annotation === 'string' && param.annotation.trim())
                    .map((param: any) => `${param.name}: ${param.annotation}${param.default === null ? '' : ` = ${param.default}`}`);
                if (typedParameters.length > 0) {
                    prompt += `- Source parameter type hints: ${typedParameters.join('; ')}. Treat these as input-shape guidance only, never as a return-value or exception oracle.\n`;
                }
                prompt += `- Call with every required parameter. Optional parameters may be omitted unless the test intentionally covers their default or override behavior.\n`;
            } else {
                prompt += `- EXACT signature: ${astContext.name}(${astContext.args.join(', ')}). Call with EXACTLY ${astContext.args.length} argument(s).\n`;
            }
        } else {
            prompt += `- Parameters: NONE. This function takes ZERO arguments.\n`;
            prompt += `- CRITICAL: ${astContext.name}() takes 0 arguments. ANY call like ${astContext.name}(x) WILL crash with TypeError. ONLY call as ${astContext.name}().\n`;
        }
        if (astContext.docstring) {
            prompt += `- Docstring: ${astContext.docstring.trim()}\n`;
        }
        // Class method hint
        if (astContext.class_name) {
            prompt += `- IMPORTANT: This is a METHOD of class \`${astContext.class_name}\`.\n`;
            prompt += `  - Import: from ${moduleName} import ${astContext.class_name}\n`;
            if (astContext.method_kind === 'property') {
                prompt += `  - Binding: property getter. Instantiate the class, then read it as: self._obj.${funcName} (NO parentheses).\n`;
                const property = astContext.property_context;
                if (property?.setter) {
                    prompt += `  - A setter exists. Test assignment only when the source behavior and constructor context make it safe; do not call the property like a function.\n`;
                }
            } else if (astContext.method_kind === 'static' || astContext.method_kind === 'class') {
                prompt += `  - Binding: ${astContext.method_kind} method. Do NOT instantiate the class.\n`;
                prompt += `  - Call method as: ${astContext.class_name}.${funcName}(...).\n`;
            } else {
                const constructorCalls = [...new Set<string>((astContext.callerContexts || [])
                    .map((caller: any) => buildVerifiedConstructorCall(astContext.class_name, [caller])).filter(Boolean))];
                if (constructorCalls.length) {
                    for (const constructorCall of constructorCalls) {
                        prompt += `  - Verified constructor setup from an actual call site: self._obj = ${constructorCall}\n`;
                    }
                    prompt += `  - Match each observation to its own constructor setup; do NOT pass these constructor values to ${funcName}().\n`;
                } else {
                    prompt += `  - Instantiate in setUp using source-supported constructor values; do not guess required dependencies.\n`;
                }
                prompt += `  - Call method as: self._obj.${funcName}(...)  NOT as a standalone function.\n`;
            }
            const init = astContext.class_context?.init;
            if (init) {
                prompt += `  - Constructor required parameters: ${init.required_params?.join(', ') || 'none'}; optional parameters: ${init.optional_params?.join(', ') || 'none'}; initialized attributes: ${init.assigns?.map((item: any) => item.name).join(', ') || 'none'}.\n`;
                const typedConstructorParameters = (init.signature || [])
                    .filter((param: any) => typeof param.annotation === 'string' && param.annotation.trim())
                    .map((param: any) => `${param.name}: ${param.annotation}`);
                if (typedConstructorParameters.length > 0) {
                    prompt += `  - Constructor type hints (input-shape guidance only): ${typedConstructorParameters.join('; ')}.\n`;
                }
            }
            const effectiveInit = astContext.class_context?.effective_init;
            if (effectiveInit?.defined_on && effectiveInit.defined_on !== astContext.class_name) {
                prompt += `  - Inherited constructor source: ${effectiveInit.defined_on}; required parameters: ${effectiveInit.required_params?.join(', ') || 'none'}; initialized attributes: ${effectiveInit.assigns?.map((item: any) => item.name).join(', ') || 'none'}. This is source setup context, not permission to guess constructor values.\n`;
            }
        }
        prompt += `- CRITICAL: Do NOT invent keyword arguments such as extra_option=... that are not in the function signature.\n`;

        if (astContext.calls && astContext.calls.length > 0) {
            prompt += `- Calls: ${astContext.calls.join(', ')}\n`;
        }
        if (astContext.file_imports?.length > 0) {
            prompt += `- Available module imports: ${astContext.file_imports.map((item: any) => item.kind === 'from' ? `from ${item.module} import ${item.name}` : `import ${item.module}`).join('; ')}\n`;
        }
        if (astContext.referenced_globals?.length > 0) {
            prompt += `- Referenced module constants (use exact values):\n`;
            for (const item of astContext.referenced_globals) {
                prompt += `  - ${item.code}\n`;
            }
        }
        const rawConditionFacts: Array<string | null> = Array.isArray(astContext.condition_facts)
            ? astContext.condition_facts.map(formatConditionFact)
            : [];
        const conditionFacts = rawConditionFacts.filter((fact: string | null): fact is string => fact !== null);
        if (conditionFacts.length > 0) {
            prompt += `- AST branch-condition facts (source-derived, not expected results):\n`;
            for (const fact of conditionFacts) {
                prompt += `  - ${fact}\n`;
            }
            prompt += `  - Choose independent inputs that exercise both sides where feasible. These facts do NOT prove a return value or exception; derive assertions from source or exact behavior observations.\n`;
        }

        // 動態執行追蹤結果（真實 input→output 範例，讓 LLM 不用猜 assert 值）
        const trace = astContext.traceResult;
        const ambientReads = [...new Set([...(trace?.examples || []), ...(trace?.errors || [])]
            .flatMap((item: any) => item.non_deterministic_operations || []))];
        if (ambientReads.length) {
            prompt += `\nUNCONTROLLED AMBIENT READS: ${ambientReads.join(', ')}. These observations cannot supply fixed values or exception facts. Control the dependency at its use point with an explicit mock or input before asserting.\n`;
        }
        if (trace && !trace.load_error && (trace.examples.length > 0 || trace.errors.length > 0)) {
            prompt += `\nVerified Real Execution Results (Use these EXACT values in your test assertions):\n`;
            for (const ex of trace.examples.filter((example: any) =>
                example.call_assertable !== false && example.result_assertable !== false
            ).slice(0, 5)) {
                prompt += `  - Input: (${ex.args.join(', ')}) => Returns: ${ex.result} (Use: self.assertEqual(...))\n`;
            }
            for (const er of trace.errors.filter((error: any) => error.call_assertable !== false).slice(0, 5)) {
                prompt += `  - Input: (${er.args.join(', ')}) => Raises: ${er.exception}("${er.message}") (MUST Use: with self.assertRaises(${er.exception}): ...)\n`;
            }

            prompt += `\nTRACE EVIDENCE LIMIT:\n`;
            prompt += `  - Every result above proves only that exact call. Do NOT generalize a threshold, return value, or exception to unobserved inputs.\n`;
            prompt += `  - Derive additional boundary cases only from source conditions and selected test-generation rule cards. Use assertRaises only for an explicit source raise or one of the exact verified error calls.\n\n`;
        }

        // Void/None 函式提示：當所有 trace 都回傳 None 且無 error 時
        if (trace && !trace.load_error) {
            const assertableExamples = trace.examples.filter((e: any) => e.call_assertable !== false && e.result_assertable !== false);
            const allNone = assertableExamples.length > 0 && assertableExamples.every((e: any) => e.result === 'None' || e.result === 'null');
            const noErrors = trace.errors.length === 0;
            if (allNone && noErrors) {
                prompt += `\nOBSERVED NONE RESULTS:\n`;
                prompt += `- All successful calls observed by controlled behavior probe returned None. For those exact calls, use self.assertIsNone(result).\n`;
                prompt += `- This does not prove unobserved inputs return None or cannot raise; use source evidence before adding another path.\n\n`;
            }
        }

        // Dependency contexts (budget-aware distillation)
        if (astContext.dependencyContexts && astContext.dependencyContexts.length > 0) {
        // ── Fix A: 禁用列表（args + return dict keys）──
            const ownArgSet = new Set<string>(astContext.args || []);
            const forbiddenKwargs: string[] = [];
            for (const dep of astContext.dependencyContexts) {
                // (A-1) dependency 的 parameter 名稱
                if (dep.args && Array.isArray(dep.args)) {
                    for (const depArg of dep.args) {
                        const cleanArg = depArg.replace(/[:\s].*/g, '').trim();
                        if (cleanArg && cleanArg !== 'self' && !ownArgSet.has(cleanArg)) {
                            forbiddenKwargs.push(cleanArg);
                        }
                    }
                }
                // (A-2) dependency return dict 的 key 名稱
                if (dep.code) {
                    const returnMatches = (dep.code as string).matchAll(/return\s*\{([^}]+)\}/g);
                    for (const match of returnMatches) {
                        const keyMatches = match[1].matchAll(/['"]([a-zA-Z_]\w*)['"]/g);
                        for (const km of keyMatches) {
                            const key = km[1];
                            if (key && !ownArgSet.has(key) && !['true','false','none'].includes(key.toLowerCase())) {
                                forbiddenKwargs.push(key);
                            }
                        }
                    }
                }
            }
            if (forbiddenKwargs.length > 0) {
                const fb = [...new Set(forbiddenKwargs)];
                prompt += `\n⚠️ FORBIDDEN KWARGS: The following names belong to DEPENDENCY functions (as params or return dict keys), NOT to ${funcName}:\n`;
                prompt += `  - Do NOT pass: ${fb.map(k => `${k}=...`).join(', ')} to ${funcName}(...)\n`;
                prompt += `  - Some of these are RETURN VALUE KEYS from a dependency, NOT parameters of ${funcName}.\n`;
                prompt += `  - ${funcName}() ONLY accepts: (${(astContext.args || []).join(', ')})\n\n`;
            }

            // ── Fix A-3: 目標函式 vs 相依函式回傳型別區分 ──
            prompt += `\n🎯 TARGET RETURN TYPE VS DEPENDENCY RETURN TYPE:\n`;
            prompt += `  - Target \`${funcName}()\` returns its OWN value (inspect return statements in source code), NOT the raw dependency dictionary.\n`;
            prompt += `  - If \`${funcName}()\` returns a string (e.g. "Welcome User ..."), assert a string, do NOT treat \`result\` as a dict.\n`;

            // ── Fix A-4: 未捕獲的相依函式例外提示 ──
            const targetHasTry = /^\s*try\s*:/m.test(astContext.code || code);
            for (const dep of astContext.dependencyContexts) {
                if (dep.code && /^\s*raise\s+/m.test(dep.code) && !targetHasTry) {
                    prompt += `\n⚠️ UNCAUGHT DEPENDENCY EXCEPTION WARNING:\n`;
                    prompt += `  - Dependency \`${dep.name}()\` raises exceptions for inputs that violate its own validation rule.\n`;
                    prompt += `  - This exception may propagate when the target reaches that dependency call; verify the exact source path or controlled behavior probe before writing an exception test.\n`;
                    prompt += `  - Do not infer a return value or exception contract solely from this dependency warning.\n`;
                }
            }

            prompt += `\nExternal dependencies:\n`;
            prompt += `- Unit isolation: call ${funcName}() as the behavior under test. Do NOT directly call a dependency merely to compute an expected value or assign unused setup. When a dependency controls a target path, patch it at ${moduleName}'s use point and configure the mock explicitly.\n`;
            for (const dep of astContext.dependencyContexts) {
                const dependencyTrace = dep.traceResult;
                if (dependencyTrace && !dependencyTrace.load_error
                    && ((dependencyTrace.examples?.length || 0) > 0 || (dependencyTrace.errors?.length || 0) > 0)) {
                    prompt += `Verified Python observations for dependency ${dep.name} (facts, not exhaustive):\n`;
                    for (const example of (dependencyTrace.examples || []).filter((item: any) =>
                        item.call_assertable !== false && item.result_assertable !== false
                    ).slice(0, 3)) {
                        const keywords = Object.entries(example.kwargs || {}).map(([name, value]) => `${name}=${value}`);
                        prompt += `  ${dep.name}(${[...(example.args || []), ...keywords].join(', ')}) => ${example.result}\n`;
                    }
                    for (const error of (dependencyTrace.errors || []).filter((item: any) => item.call_assertable !== false).slice(0, 3)) {
                        const keywords = Object.entries(error.kwargs || {}).map(([name, value]) => `${name}=${value}`);
                        prompt += `  ${dep.name}(${[...(error.args || []), ...keywords].join(', ')}) raises ${error.exception}\n`;
                    }
                }
                const remaining = budgetTokens - estimateTokens(prompt);
                const full = distillDependency(dep);
                prompt += remaining > estimateTokens(full) + estimateTokens(astContext.code || code) + 300
                    ? full : `Dependency: ${dep.name} (source omitted as a whole unit for budget; behavior unknown).\n`;

                // Caller contexts for this dependency
                if (dep.callerContexts && dep.callerContexts.length > 0 && (budgetTokens - estimateTokens(prompt)) > 150) {
                    prompt += `Call sites for ${dep.name} (these are how the DEPENDENCY is called internally, NOT parameters of ${funcName}):\n`;
                    for (const ctx of dep.callerContexts) {
                        const argsStr = ctx.args.join(', ');
                        const kwargsStr = Object.entries(ctx.kwargs).map(([k, v]) => `${k}=${v}`).join(', ');
                        const callSig = [argsStr, kwargsStr].filter(Boolean).join(', ');
                        prompt += `  ${ctx.caller_file} / ${ctx.caller_func}: ${dep.name}(${callSig})  \u2190 internal call, NOT an argument of ${funcName}\n`;
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
                    prompt += `\nExamples:\n${formatFewShotForPrompt(subset, false)}\n`;
                }
            }
        }
    }

    // ── 共用段：Fix B/C + Slicing + Trace 重申，Loop 1 和 Loop 2+ 都執行 ──
    {
        const src = (astContext && !astContext.error) ? (astContext.code || code) : code;
        const srcLines = src.split('\n');

        // 字串切片提示（防止 LLM 算錯 [:5] 和 [-5:]）
        const sliceMatches = Array.from(src.matchAll(/(\w+)\[(-?\d*):(-?\d*)\]/g));
        if (sliceMatches.length > 0) {
            const sliceHints: string[] = [];
            for (const sm of sliceMatches as RegExpMatchArray[]) {
                const varName = sm[1];
                const start = sm[2];
                const end = sm[3];
                if (!start && end) {
                    const n = parseInt(end, 10);
                    if (!isNaN(n) && n > 0) {
                        sliceHints.push(`\`${varName}[:${n}]\` takes the FIRST ${n} characters (e.g., '123456789012'[:${n}] == '${"123456789012".substring(0, n)}')`);
                    }
                } else if (start && start.startsWith('-') && !end) {
                    const n = Math.abs(parseInt(start, 10));
                    sliceHints.push(`\`${varName}[-${n}:]\` takes the LAST ${n} characters (e.g., '123456789012'[-${n}:] == '${"123456789012".slice(-n)}')`);
                }
            }
            if (sliceHints.length > 0) {
                prompt += `\n🔪 STRING SLICE CALCULATION HINTS (from source code):\n`;
                for (const sh of [...new Set(sliceHints)]) {
                    prompt += `  - ${sh}\n`;
                }
                prompt += `  → Compute slice values EXACTLY as specified in the source code.\n`;
            }
        }

        // Fix B：偵測 raise 行 vs try/except 攔截
        const raiseLines = srcLines.filter((l: string) => /^\s*raise\s+/.test(l));
        const exceptLines = srcLines.filter((l: string) => /^\s*except[\s:]/.test(l));
        if (raiseLines.length > 0) {
            prompt += `\n\n⚠️ RAISE DETECTION (from static analysis):\n`;
            for (const rl of raiseLines) {
                const m = rl.trim().match(/^raise\s+(\w+)\s*\(([^)]*)\)/);
                if (m) {
                    prompt += `  - This function can raise ${m[1]}("${m[2].trim().replace(/["']/g,'')}")\n`;
                    prompt += `    → Use assertRaises(${m[1]}) only after choosing an input that reaches this explicit source path or an exact verified behavior observation.\n`;
                    prompt += `    → Do NOT assert a normal result for an input that source or an executed observation proves reaches this raise.\n`;
                }
            }
        } else if (exceptLines.length > 0) {
            prompt += `\n\n⚠️ EXCEPTION HANDLING CAUTION (from static analysis):\n`;
            prompt += `  - ${funcName}() contains try/except, but that alone does not prove every path or every exception is caught.\n`;
            prompt += `  - Inspect the protected statements and exception handlers. Use assertRaises only for an explicit source raise or exact verified behavior observation.\n`;
        }

        // Return expressions are setup/shape hints, never a substitute for an
        // executed assertion oracle.  This applies in both initial and repair
        // loops so a reviewer cannot reintroduce source-derived guesses.
        const returnLines = srcLines.filter((l: string) => /^\s*return\s+/.test(l) && !/^\s*return\s*$/.test(l));
        if (returnLines.length > 0 && returnLines.length <= 8) {
            prompt += `\nℹ️ RETURN EXPRESSION SHAPES (from static analysis, NOT output facts):\n`;
            for (const rl of returnLines) {
                const cleaned = rl.trim().replace(/^return\s+/, '');
                prompt += `  - Possible expression shape: ${cleaned}\n`;
            }
            prompt += `  → Do NOT use these expressions as an exact expected value by themselves. Exact assertions require a verified controlled behavior probe, an explicit literal return reached by the selected input, or a mock side effect controlled in this test.\n`;
        }

        // Trace 重申：Loop 2+ 強制再次列出 Verified Real Execution Results，防止 AI 使用假輸入
        if (focusContexts && astContext) {
            // 重申 Forbidden Kwargs（在 mutant focus 模式下再強調一次）
            if (astContext.dependencyContexts && astContext.dependencyContexts.length > 0) {
                const ownArgs: string[] = astContext.args || [];
                const ownArgSet2 = new Set<string>(ownArgs);
                const fb2: string[] = [];
                for (const dep of astContext.dependencyContexts) {
                    if (dep.args && Array.isArray(dep.args)) {
                        for (const a of dep.args) {
                            const ca = a.replace(/[:\s].*/g, '').trim();
                            if (ca && ca !== 'self' && !ownArgSet2.has(ca)) { fb2.push(ca); }
                        }
                    }
                    if (dep.code) {
                        const rms = (dep.code as string).matchAll(/return\s*\{([^}]+)\}/g);
                        for (const rm of rms) {
                            const kms = rm[1].matchAll(/['"]([a-zA-Z_]\w*)['"]/g);
                            for (const km of kms) {
                                const k = km[1];
                                if (k && !ownArgSet2.has(k) && !['true','false','none'].includes(k.toLowerCase())) { fb2.push(k); }
                            }
                        }
                    }
                }
                const fbUniq2 = [...new Set(fb2)];
                if (fbUniq2.length > 0) {
                    prompt += `\n🚫 REMINDER — FORBIDDEN KWARGS (do NOT pass these to ${funcName}):\n`;
                    prompt += `  ${fbUniq2.map(k => `${k}=...`).join(', ')} are DEPENDENCY params/keys, NOT ${funcName}() params.\n`;
                    prompt += `  ${funcName}() ONLY accepts: (${ownArgs.join(', ')})\n`;
                }
            }
            // Trace data reminder
            const traceRemind = astContext.traceResult;
            if (traceRemind && !traceRemind.load_error &&
                ((traceRemind.examples && traceRemind.examples.length > 0) || (traceRemind.errors && traceRemind.errors.length > 0))) {
                prompt += `\n⚠️ REMINDER — Verified Real Execution Results (MUST use these EXACT values in ALL new assertions):\n`;
                for (const ex of ((traceRemind.examples || []) as any[]).filter(example =>
                    example.call_assertable !== false && example.result_assertable !== false
                ).slice(0, 5)) {
                    prompt += `  - Input: (${ex.args.join(', ')}) => Returns: ${ex.result}  ← use assertEqual\n`;
                }
                for (const er of ((traceRemind.errors || []) as any[]).filter(error => error.call_assertable !== false).slice(0, 5)) {
                    prompt += `  - Input: (${er.args.join(', ')}) => Raises: ${er.exception}  ← use assertRaises\n`;
                }
                prompt += `  ← Preserve these exact facts for observation-derived assertions. Additional inputs may cover source-derived conditions, but their assertions still need source or executed-observation evidence.\n`;
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

    if (semanticGuidance) {
        const remaining = budgetTokens - estimateTokens(prompt) - 500;
        const compactGuidance = compactSemanticGuidanceForBudget(semanticGuidance, remaining);
        if (compactGuidance) {
            prompt += `\n\n=== EVIDENCE-BOUND SEMANTIC GUIDANCE ===\n`;
            prompt += `${compactGuidance}\n`;
            prompt += `Treat model-authored candidates as suggestions only; source code and verified execution facts take precedence.\n`;
        }
    }


    if (strategy === 'small') {
        const className = astContext?.class_name as string | null | undefined;
        const directClassCall = astContext?.method_kind === 'static' || astContext?.method_kind === 'class';
        const propertyAccess = astContext?.method_kind === 'property';
        const importHint = className
            ? directClassCall
                ? `from ${moduleName} import ${className}  # call ${className}.${funcName}(...) directly`
                : propertyAccess
                    ? `from ${moduleName} import ${className}  # use self._obj = ${className}(); then read self._obj.${funcName} without parentheses`
                : `from ${moduleName} import ${className}  # instance method — use self._obj = ${className}(); self._obj.${funcName}(...)`
            : `from ${moduleName} import ${funcName}`;
        prompt += `\n\nImport from: ${importHint}\n\nWrite the test file now:\n\`\`\`python\n`;
    } else {
        prompt += `\n\nWrite the complete unittest test file now.\n`;
    }

    return prompt;
}
