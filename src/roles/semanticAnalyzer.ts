/**
 * semantic_analyzer_prompt.ts
 * Role: Semantic Analyzer
 *
 * Triggered for ALL functions (not just cross-file dependencies).
 * Runs BEFORE test generation to:
 *   1. Integrate selected-function source, AST facts and bounded execution observations
 *   2. Propose dependency and input scenarios for deterministic verification
 *
 * The deterministic dispatcher owns test-rule selection after this role returns.
 */

import { BehaviorObservations } from '../pipeline/evidenceContracts';

// === Type Definitions ===

export interface DependencyBehavior {
    name: string;
    when_caller_passes: string;
    always_returns: string;
    can_raise: string[];
}

export interface UnreachablePath {
    condition: string;
    reason: string;
}

export interface TestInputHint {
    param_name: string;       // 參數名稱, e.g. "measurement"
    strategy: string;         // 策略說明, e.g. "numeric: cover all comparison thresholds"
    boundary_inputs: string[]; // 具體邊界值 repr, e.g. ["40", "55", "70", "85"]
    invalid_inputs: string[]; // 預期引發例外的值, e.g. ["0", "-1", "None", "'abc'"]
    notes: string;            // 額外推導說明, e.g. "division requires a non-zero denominator"
}

export interface TestStrategy {
    approach: string;          // 整體策略說明
    input_hints: TestInputHint[];
    assertion_style: 'assertEqual' | 'assertRaises' | 'mixed';
    mock_needed: boolean;
    key_rules: string[];       // 關鍵規則：LLM 必須遵守
}

export interface SemanticAnalysis {
    dependency_behaviors: DependencyBehavior[];
    unreachable_paths: UnreachablePath[];
    mock_required_for?: { path: string; mock_target: string; example: string }[];
    test_strategy: TestStrategy;     // AI-derived test data strategy for this specific function
}

export interface DependencyEvidenceForPrompt {
    name: string;
    code: string;
    sourceHash?: string;
    observations?: BehaviorObservations;
}

/** Static and executed evidence supplied to the Semantic Analyzer. */
export interface AnalysisEvidenceV2 {
    schemaVersion: 'analysis-evidence-v2';
    target: {
        moduleName: string;
        functionName: string;
        source: string;
        sourceHash: string;
    };
    astFacts?: SemanticAstSetupContext;
    callSites: Array<{ caller_func: string; call_expr: string }>;
    dependencies: DependencyEvidenceForPrompt[];
    initialTargetObservations?: BehaviorObservations;
}

/** A bounded AST setup view.  These are source facts, not execution oracles. */
export interface SemanticAstSetupContext {
    /** Selected callable parameters from AST, never dependency parameters. */
    args?: string[];
    file_imports?: Array<{ kind?: string; module?: string; level?: number; name?: string | null; alias?: string | null; bound_name?: string }>;
    referenced_globals?: Array<{ name?: string; code?: string }>;
    class_name?: string | null;
    method_kind?: 'module' | 'instance' | 'static' | 'class' | 'property';
    class_context?: {
        name?: string;
        bases?: string[];
        init?: {
            signature?: Array<{ name?: string; kind?: string; annotation?: string | null; default?: string | null; required?: boolean }>;
            assigns?: Array<{ name?: string; code?: string }>;
        };
        effective_init?: {
            defined_on?: string;
            signature?: Array<{ name?: string; kind?: string; annotation?: string | null; default?: string | null; required?: boolean }>;
            assigns?: Array<{ name?: string; code?: string }>;
        };
        inherited_context?: Array<{
            name?: string;
            class_attrs?: Array<{ name?: string; code?: string }>;
            init?: {
                signature?: Array<{ name?: string; kind?: string; annotation?: string | null; default?: string | null; required?: boolean }>;
                assigns?: Array<{ name?: string; code?: string }>;
            };
        }>;
    } | null;
}

function oneLine(value: unknown, limit = 240): string {
    return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, limit);
}

function formatCall(args: string[] | undefined, kwargs: Record<string, string> | undefined): string {
    const keywords = Object.entries(kwargs || {}).map(([name, value]) => `${name}=${oneLine(value)}`);
    return [...(args || []).map(value => oneLine(value)), ...keywords].join(', ');
}

export function formatVerifiedTargetObservations(
    targetName: string,
    observations?: BehaviorObservations
): string {
    if (!observations) {return '';}
    let out = '=== VERIFIED TARGET EXECUTION OBSERVATIONS ===\n';
    out += 'Python executed these exact calls under the controlled probe. They are evidence for the same call conditions, but are not exhaustive.\n';
    if (observations.load_error) {
        out += `  - Observation unavailable: ${oneLine(observations.load_error)}\n`;
    } else {
        for (const example of observations.examples.filter(example =>
            example.call_assertable !== false && example.result_assertable !== false
        ).slice(0, 4)) {
            out += `  - ${targetName}(${formatCall(example.args, example.kwargs)}) => ${oneLine(example.result)}${example.result_type ? ` [${oneLine(example.result_type, 60)}]` : ''}\n`;
        }
        for (const error of observations.errors.filter(error => error.call_assertable !== false).slice(0, 4)) {
            out += `  - ${targetName}(${formatCall(error.args, error.kwargs)}) raises ${oneLine(error.exception, 80)}${error.message ? `: ${oneLine(error.message)}` : ''}\n`;
        }
    }
    for (const blocked of (observations.blocked_operations || []).slice(0, 2)) {
        out += `  - Diagnostic only, blocked by safety policy: ${oneLine(blocked)}\n`;
    }
    out += 'Blocked operations and load errors are diagnostics only. Never turn them into target exceptions or assertions.\n\n';
    return out;
}

function formatVerifiedDependencyFacts(dependencies: DependencyEvidenceForPrompt[]): string {
    const traced = dependencies.filter(dependency => {
        const trace = dependency.observations;
        return trace && !trace.load_error && ((trace.examples?.length || 0) > 0 || (trace.errors?.length || 0) > 0);
    });
    if (traced.length === 0) {
        return '';
    }

    let out = '=== VERIFIED DEPENDENCY EXECUTION FACTS ===\n';
    out += 'These observations were executed by Python. They take precedence over model inference and are not exhaustive.\n';
    for (const dependency of traced.slice(0, 4)) {
        const trace = dependency.observations!;
        for (const example of (trace.examples || []).filter(example =>
            example.call_assertable !== false && example.result_assertable !== false
        ).slice(0, 3)) {
            out += `  - ${dependency.name}(${formatCall(example.args, example.kwargs)}) => ${oneLine(example.result)}\n`;
        }
        for (const error of (trace.errors || []).filter(error => error.call_assertable !== false).slice(0, 3)) {
            out += `  - ${dependency.name}(${formatCall(error.args, error.kwargs)}) raises ${oneLine(error.exception, 80)}${error.message ? `: ${oneLine(error.message)}` : ''}\n`;
        }
    }
    return out + '\n';
}

function formatAstSetupContext(context?: SemanticAstSetupContext): string {
    if (!context) {return '';}
    const lines: string[] = [];
    const targetParameters = (context.args || []).filter(name => typeof name === 'string' && /^[A-Za-z_]\w*$/.test(name));
    if (targetParameters.length > 0) {
        lines.push(`Target function parameters: ${targetParameters.join(', ')}.`);
    } else if (Array.isArray(context.args)) {
        lines.push('Target function parameters: none.');
    }
    const imports = (context.file_imports || []).slice(0, 12);
    if (imports.length > 0) {
        lines.push('Imports available in the target module:');
        for (const item of imports) {
            const dots = '.'.repeat(item.level || 0);
            if (item.kind === 'import') {
                lines.push(`  - import ${item.module || item.bound_name || '?'}${item.alias ? ` as ${item.alias}` : ''}`);
            } else {
                lines.push(`  - from ${dots}${item.module || ''} import ${item.name || '*'}${item.alias ? ` as ${item.alias}` : ''}`);
            }
        }
    }
    const globals = (context.referenced_globals || []).filter(item => item.name && item.code).slice(0, 8);
    if (globals.length > 0) {
        lines.push('Referenced module globals (source definitions):');
        for (const item of globals) {
            lines.push(`  - ${item.code}`);
        }
    }
    if (context.class_context) {
        const classInfo = context.class_context;
        lines.push(`Target binding: ${context.method_kind || 'unknown'} member of ${context.class_name || classInfo.name || 'class'}.`);
        if (classInfo.bases?.length) {
            lines.push(`Class bases: ${classInfo.bases.join(', ')}`);
        }
        const signature = (classInfo.init?.signature || []).slice(0, 12);
        if (signature.length > 0) {
            lines.push('Constructor parameters: ' + signature.map(param =>
                `${param.name || '?'}${param.annotation ? `: ${param.annotation}` : ''} (${param.required ? 'required' : `default ${param.default ?? 'unknown'}`})`
            ).join(', '));
        }
        const assigns = (classInfo.init?.assigns || []).filter(item => item.code).slice(0, 8);
        if (assigns.length > 0) {
            lines.push('Constructor assignments (source setup):');
            for (const item of assigns) {
                lines.push(`  - ${item.code}`);
            }
        }
        const effectiveInit = classInfo.effective_init;
        if (effectiveInit?.defined_on && effectiveInit.defined_on !== (context.class_name || classInfo.name)) {
            const inheritedSignature = (effectiveInit.signature || []).slice(0, 12);
            lines.push(`Inherited constructor source: ${effectiveInit.defined_on}.`);
            if (inheritedSignature.length > 0) {
                lines.push('Inherited constructor parameters: ' + inheritedSignature.map(param =>
                    `${param.name || '?'}${param.annotation ? `: ${param.annotation}` : ''} (${param.required ? 'required' : `default ${param.default ?? 'unknown'}`})`
                ).join(', '));
            }
            const inheritedAssigns = (effectiveInit.assigns || []).filter(item => item.code).slice(0, 8);
            if (inheritedAssigns.length > 0) {
                lines.push('Inherited constructor assignments (source setup):');
                for (const item of inheritedAssigns) {
                    lines.push(`  - ${item.code}`);
                }
            }
        }
    }
    return lines.length > 0
        ? `=== MODULE AND CLASS SETUP CONTEXT ===\n${lines.join('\n')}\nThis is source/setup context only. It does not prove a return value, exception, or external side effect.\n\n`
        : '';
}

// === System Prompt ===

export function getSemanticAnalyzerSystemPrompt(_legacyRuleSummary?: string): string {
    return `You are a Python code analyst with two responsibilities:
1. Analyze cross-function dependency behavior in a specific calling context
2. Propose evidence-bound input scenarios for the Unittest Writer; test-rule selection is handled by the runner

Your output must be a single valid JSON object with this exact schema:
{
  "dependency_behaviors": [
    {
      "name": "<dependency function name>",
      "when_caller_passes": "<description of fixed args the target passes>",
      "always_returns": "<exact return value or structure>",
      "can_raise": ["<ExceptionType> when <condition>"]
    }
  ],
  "unreachable_paths": [
    {
      "condition": "<branch condition that is always True/False>",
      "reason": "<why it cannot be False/True in normal calls>"
    }
  ],
  "mock_required_for": [
    {
      "path": "<description of unreachable path>",
      "mock_target": "<module.function patch path>",
      "example": "<one-line mock example>"
    }
  ],
  "test_strategy": {
    "approach": "<overall test strategy for this specific function>",
    "input_hints": [
      {
        "param_name": "<parameter name>",
        "strategy": "<how to choose inputs for this param>",
        "boundary_inputs": ["<repr value1>", "<repr value2>"],
        "invalid_inputs": ["<repr value that raises exception>"],
        "notes": "<any critical notes, e.g. 'value[-N:] takes the last N characters'>"
      }
    ],
    "assertion_style": "assertEqual | assertRaises | mixed",
    "mock_needed": false,
    "key_rules": [
      "<concise source-specific testing observation>"
    ]
  }
}

ANALYSIS RULES:
- MODULE AND CLASS SETUP CONTEXT is useful for choosing imports, constructor setup and possible dependency injection. It is not execution evidence: never infer an exact return value, exception, or external result from it.
- When TARGET FUNCTION PARAMETERS are supplied, every test_strategy.input_hints[].param_name must be exactly one of those target parameters. Dependency parameters and dependency return keys are never target inputs.
- TARGET CALL SITES show how other project code invokes the selected target. They are input candidates only: they do not prove target output, dependency behavior, or an exception.
- VERIFIED TARGET EXECUTION OBSERVATIONS are exact input/output samples produced by controlled Python execution. Use them to correct target-behavior hypotheses, but do not generalize them to unobserved inputs.
- When VERIFIED DEPENDENCY EXECUTION FACTS are provided, reproduce their Python repr values exactly. Never replace a Python dict/list/tuple with a JavaScript-style description such as "[object Object]".
- Without verified dependency execution facts, do not claim a dependency "always returns" a concrete value; leave dependency_behaviors empty and let the Writer rely on source code or mock.patch.
- For unreachable_paths: if dependency always returns X, which if-conditions are always True/False?
- For test_strategy.input_hints: derive boundary values from actual source code logic (thresholds, len checks, etc.)
- For test_strategy.input_hints: emit only scalar Python literals: None, True, False, a finite number, or a plain quoted string. Do not emit expressions, calls, collections, comprehensions, attributes, or variable names. Safe scalar candidates may be executed by the controlled behavior probe; they are never an output oracle by themselves.
- For test_strategy.key_rules: include only concise observations tied to this target; do not repeat generic unittest advice
- If no dependencies, return empty arrays for dependency_behaviors, unreachable_paths, and mock_required_for
- Do not predict, classify, or mention equivalent mutants. Equivalence is evaluated only after mutation execution from measured survivor evidence.
- Return ONLY the JSON object, no explanation text`;
}

// === User Prompt ===

export function getSemanticAnalyzerUserPrompt(
    evidence: AnalysisEvidenceV2
): string {
    const dependencies = evidence.dependencies || [];
    const callSites = evidence.callSites || [];
    let prompt = '=== ANALYSIS EVIDENCE V2 ===\n';
    prompt += `Target: ${evidence.target.moduleName}.${evidence.target.functionName}\n`;
    prompt += `Source hash: ${evidence.target.sourceHash}\n\n`;
    prompt += '=== TARGET FUNCTION SOURCE CODE ===\n```python\n' + evidence.target.source.trim() + '\n```\n\n';

    prompt += formatAstSetupContext(evidence.astFacts);
    prompt += formatVerifiedTargetObservations(
        evidence.target.functionName,
        evidence.initialTargetObservations
    );

    if (dependencies.length > 0) {
        prompt += '=== DEPENDENCY SOURCE CODE ===\n';
        for (const dep of dependencies.slice(0, 4)) {
            prompt += '```python\n# Dependency: ' + dep.name + '\n' + dep.code.trim() + '\n```\n';
        }
        prompt += '\n';
    }

    prompt += formatVerifiedDependencyFacts(dependencies);

    if (callSites.length > 0) {
        prompt += '=== TARGET CALL SITES (INPUT CANDIDATES ONLY) ===\n';
        for (const cs of callSites.slice(0, 6)) {
            prompt += '  In ' + cs.caller_func + ': ' + cs.call_expr + '\n';
        }
        prompt += '\n';
    }

    prompt += 'TASK:\n';
    prompt += '1. Analyze target dependency usage (if any) to identify fixed behaviors and candidate unreachable paths.\n';
    prompt += '2. Study the target function source code and derive a test_strategy:\n';
    prompt += '   - Use only selected target parameter names in input_hints; never name dependency parameters or dependency return keys.\n';
    prompt += '   - What are the valid/invalid input ranges for each parameter?\n';
    prompt += '   - What boundary values would cover all if/elif branches?\n';
    prompt += '   - What non-obvious behaviors might a test writer get wrong?\n';
    prompt += 'Return ONLY the JSON object.';

    return prompt;
}

// === Response Parser ===

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const semanticTopLevelFields = new Set([
    'dependency_behaviors',
    'unreachable_paths',
    'mock_required_for',
    'test_strategy'
]);

/**
 * A syntactically valid but unrelated JSON object is not an Analyzer result.
 * Reject it so orchestration retains its syntax-derived rule baseline instead
 * of treating a provider error envelope or chat metadata as empty guidance.
 */
function hasSemanticAnalysisShape(value: unknown): value is Record<string, unknown> {
    return isRecord(value) && Object.keys(value).some(key => semanticTopLevelFields.has(key));
}

function meaningfulText(value: unknown): string | undefined {
    if (typeof value !== 'string') {return undefined;}
    const text = value.trim();
    if (!text || text === '...' || /^<[^>]+>$/.test(text)) {return undefined;}
    return text;
}

function meaningfulTextList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map(meaningfulText).filter((item): item is string => Boolean(item))
        : [];
}

function normalizeSemanticAnalysis(value: unknown): SemanticAnalysis | null {
    if (!hasSemanticAnalysisShape(value)) {return null;}
    const dependency_behaviors = (Array.isArray(value.dependency_behaviors) ? value.dependency_behaviors : [])
        .map(item => {
            if (!isRecord(item)) {return undefined;}
            const name = meaningfulText(item.name);
            const when_caller_passes = meaningfulText(item.when_caller_passes);
            const always_returns = meaningfulText(item.always_returns);
            const can_raise = meaningfulTextList(item.can_raise);
            return name && when_caller_passes && always_returns
                ? { name, when_caller_passes, always_returns, can_raise }
                : undefined;
        }).filter((item): item is DependencyBehavior => Boolean(item));
    const unreachable_paths = (Array.isArray(value.unreachable_paths) ? value.unreachable_paths : [])
        .map(item => isRecord(item) ? {
            condition: meaningfulText(item.condition), reason: meaningfulText(item.reason)
        } : undefined)
        .filter((item): item is { condition: string; reason: string } => Boolean(item?.condition && item.reason));
    const mock_required_for = (Array.isArray(value.mock_required_for) ? value.mock_required_for : [])
        .map(item => isRecord(item) ? {
            path: meaningfulText(item.path), mock_target: meaningfulText(item.mock_target), example: meaningfulText(item.example)
        } : undefined)
        .filter((item): item is { path: string; mock_target: string; example: string } =>
            Boolean(item?.path && item.mock_target && item.example));
    const rawStrategy = isRecord(value.test_strategy) ? value.test_strategy : {};
    const input_hints = (Array.isArray(rawStrategy.input_hints) ? rawStrategy.input_hints : [])
        .map(item => {
            if (!isRecord(item)) {return undefined;}
            const param_name = meaningfulText(item.param_name);
            const strategy = meaningfulText(item.strategy);
            if (!param_name || !strategy) {return undefined;}
            return {
                param_name,
                strategy,
                boundary_inputs: meaningfulTextList(item.boundary_inputs),
                invalid_inputs: meaningfulTextList(item.invalid_inputs),
                notes: meaningfulText(item.notes) || ''
            };
        }).filter((item): item is TestInputHint => Boolean(item));
    const assertion_style = rawStrategy.assertion_style === 'assertEqual' || rawStrategy.assertion_style === 'assertRaises' || rawStrategy.assertion_style === 'mixed'
        ? rawStrategy.assertion_style
        : 'mixed';

    return {
        dependency_behaviors,
        unreachable_paths,
        mock_required_for,
        test_strategy: {
            approach: meaningfulText(rawStrategy.approach) || '',
            input_hints,
            assertion_style,
            mock_needed: rawStrategy.mock_needed === true,
            key_rules: meaningfulTextList(rawStrategy.key_rules)
        }
    };
}

export function parseSemanticAnalysis(llmResponse: string): SemanticAnalysis | null {
    const trimmed = llmResponse.trim();
    if (trimmed.startsWith('{')) {
        try {
            return normalizeSemanticAnalysis(JSON.parse(trimmed));
        } catch {
            // trimmed parse failed; proceed to code block or regex match
        }
    }
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
        try {
            return normalizeSemanticAnalysis(JSON.parse(codeBlockMatch[1].trim()));
        } catch {
            // proceed to json match
        }
    }
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            return normalizeSemanticAnalysis(JSON.parse(jsonMatch[0]));
        } catch {
            // all parse attempts failed
        }
    }
    return null;
}

/**
 * Semantic input hints are model suggestions, while the selected target
 * signature is an AST fact. Keep only hints whose names can actually be
 * supplied to the target; this prevents dependency arguments from reaching
 * Writer prompts as misleading candidate kwargs.
 */
export function restrictSemanticInputHintsToTargetParameters(
    analysis: SemanticAnalysis,
    targetParameters: readonly string[] | undefined
): SemanticAnalysis {
    if (!targetParameters) {
        return analysis;
    }
    const allowed = new Set(targetParameters.filter(name => typeof name === 'string'));
    return {
        ...analysis,
        test_strategy: {
            ...analysis.test_strategy,
            input_hints: analysis.test_strategy.input_hints.filter(hint => allowed.has(hint.param_name))
        }
    };
}

export function formatSemanticContextForPrompt(
    analysis: SemanticAnalysis,
    dependencies: DependencyEvidenceForPrompt[] = []
): string {
    let out = '=== SEMANTIC GUIDANCE ===\n';
    out += 'Use verified execution facts and source code as evidence. Model-generated strategies are guidance, not proof.\n';
    out += formatVerifiedDependencyFacts(dependencies);

    if (analysis.dependency_behaviors.length > 0) {
        out += '\nUnverified dependency-return claims were omitted. Use dependency source, verified facts, or mock.patch instead.\n';
    }

    out += '\n=== CANDIDATE PATH GUIDANCE ===\n';
    if (analysis.unreachable_paths.length > 0) {
        out += '\nCandidate unreachable paths (verify against source or executed observations; do not omit a test solely because of this suggestion):\n';
        for (const up of analysis.unreachable_paths) {
            out += '  X "' + up.condition + '" -- ' + up.reason + '\n';
        }
    }

    if (analysis.mock_required_for && analysis.mock_required_for.length > 0) {
        out += '\nCandidate paths that may require mock.patch (verify target and use point):\n';
        for (const mrf of analysis.mock_required_for) {
            out += '  [mock] Path: ' + mrf.path + '\n';
            out += '         Patch target: ' + mrf.mock_target + '\n';
            out += '         Example: ' + mrf.example + '\n';
        }
    }

    // === AI 推導的測資策略 ===
    const ts = analysis.test_strategy;
    if (ts) {
        out += '\n=== TEST DATA STRATEGY (AI-derived, validate against source before use) ===\n';
        out += 'Overall approach: ' + ts.approach + '\n';

        if (ts.key_rules && ts.key_rules.length > 0) {
            const meaningfulRules = ts.key_rules.filter(r => r && !r.startsWith('<'));
            if (meaningfulRules.length > 0) {
                out += '\nAdditional Rules:\n';
                for (const rule of meaningfulRules) {
                    out += '  ! ' + rule + '\n';
                }
            }
        }

        if (ts.input_hints && ts.input_hints.length > 0) {
            out += '\nInput Boundary Candidates (use only when supported by source or verified execution):\n';
            for (const hint of ts.input_hints) {
                out += '  Param "' + hint.param_name + '": ' + hint.strategy + '\n';
                if (hint.boundary_inputs.length > 0) {
                    out += '    Candidate normal inputs: [' + hint.boundary_inputs.join(', ') + ']\n';
                }
                if (hint.invalid_inputs.length > 0) {
                    out += '    Candidate exception inputs (assertRaises requires an explicit source raise or verified error): [' + hint.invalid_inputs.join(', ') + ']\n';
                }
                if (hint.notes) {
                    out += '    Note: ' + hint.notes + '\n';
                }
            }
        }

        out += '\nAssertion style: ' + ts.assertion_style + '\n';
        if (ts.mock_needed) {
            out += 'Mock required: YES — use unittest.mock.patch for external dependencies\n';
        }
    }

    return out + '\n';
}

/**
 * 建立只負責函式分析與測試情境的提示詞
 * 測試生成規則由 pipeline/testRuleDispatcher 決定，不向模型提供規則目錄
 */
export function buildSemanticAnalyzerSystemPrompt(): string {
    return getSemanticAnalyzerSystemPrompt();
}
