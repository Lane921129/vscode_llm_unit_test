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

import { BehaviorObservations, observationsForPrompt } from '../pipeline/evidenceContracts';
import { isolatedResourceSystemRule } from '../prompts/isolatedResourceContext';
import { hasRoleTemplateEcho, hasTemplatePlaceholder } from '../validation/templatePlaceholder';

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
    property_context?: unknown;
    class_context?: {
        name?: string;
        bases?: string[];
        class_attrs?: Array<{ name?: string; code?: string }>;
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

export function formatVerifiedTargetObservations(
    _targetName: string,
    observations?: BehaviorObservations
): string {
    if (!observations) {return '';}
    return '=== VERIFIED TARGET EXECUTION OBSERVATIONS ===\n'
        + JSON.stringify(observationsForPrompt(observations))
        + '\nExact call/setup only. Blocked, load-error, truncated or unassertable records are diagnostics, never target exceptions or assertions.\n\n';
}

function formatVerifiedDependencyFacts(dependencies: DependencyEvidenceForPrompt[]): string {
    const traced = dependencies.filter(dependency => dependency.observations);
    if (traced.length === 0) {
        return '';
    }

    return '=== VERIFIED DEPENDENCY EXECUTION FACTS ===\n'
        + JSON.stringify(traced.map(dependency => ({ name: dependency.name, sourceHash: dependency.sourceHash,
            observations: observationsForPrompt(dependency.observations) })))
        + '\nExact call/setup only; diagnostics and unassertable records are not oracles. Dependency results are not target results.\n\n';
}

function formatAstSetupContext(context?: SemanticAstSetupContext): string {
    if (!context) {return '';}
    const lines: string[] = [];
    const targetParameters = (context.args || []).filter(name => typeof name === 'string');
    if (targetParameters.length > 0) {
        lines.push(`Target function parameters: ${targetParameters.join(', ')}.`);
    } else if (Array.isArray(context.args)) {
        lines.push('Target function parameters: none.');
    }
    const imports = context.file_imports || [];
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
    const globals = (context.referenced_globals || []).filter(item => item.name && item.code);
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
        if (classInfo.class_attrs?.length) {
            lines.push('Class attributes (source setup): ' + JSON.stringify(classInfo.class_attrs));
        }
        const signature = classInfo.init?.signature || [];
        if (signature.length > 0) {
            lines.push('Constructor parameters: ' + signature.map(param =>
                `${param.name || '?'}${param.annotation ? `: ${param.annotation}` : ''} (${param.required ? 'required' : `default ${param.default ?? 'unknown'}`})${param.kind ? ` [${param.kind}]` : ''}`
            ).join(', '));
        }
        const assigns = (classInfo.init?.assigns || []).filter(item => item.code);
        if (assigns.length > 0) {
            lines.push('Constructor assignments (source setup):');
            for (const item of assigns) {
                lines.push(`  - ${item.code}`);
            }
        }
        const effectiveInit = classInfo.effective_init;
        if (effectiveInit?.defined_on && effectiveInit.defined_on !== (context.class_name || classInfo.name)) {
            const inheritedSignature = effectiveInit.signature || [];
            lines.push(`Inherited constructor source: ${effectiveInit.defined_on}.`);
            if (inheritedSignature.length > 0) {
                lines.push('Inherited constructor parameters: ' + inheritedSignature.map(param =>
                    `${param.name || '?'}${param.annotation ? `: ${param.annotation}` : ''} (${param.required ? 'required' : `default ${param.default ?? 'unknown'}`})${param.kind ? ` [${param.kind}]` : ''}`
                ).join(', '));
            }
            const inheritedAssigns = (effectiveInit.assigns || []).filter(item => item.code);
            if (inheritedAssigns.length > 0) {
                lines.push('Inherited constructor assignments (source setup):');
                for (const item of inheritedAssigns) {
                    lines.push(`  - ${item.code}`);
                }
            }
        }
        if (classInfo.inherited_context?.length) {
            lines.push('Inherited setup (source only): ' + JSON.stringify(classInfo.inherited_context));
        }
    }
    if (context.property_context) {
        lines.push('Property setup (source only): ' + JSON.stringify(context.property_context));
    }
    return lines.length > 0
        ? `=== MODULE AND CLASS SETUP CONTEXT ===\n${lines.join('\n')}\nThis is source/setup context only. It does not prove a return value, exception, or external side effect.\n\n`
        : '';
}

// === System Prompt ===

export function getSemanticAnalyzerSystemPrompt(_legacyRuleSummary?: string): string {
    return `You are a Python code analyst. Propose source-specific unittest scenarios; the runner selects rules and executes probes. Do not write tests or classify equivalent mutants.
Return one JSON object with this shape; replace placeholders, keep unsupported arrays empty:
{"dependency_behaviors":[],"unreachable_paths":[],"mock_required_for":[],"test_strategy":{"approach":"<concrete plan for this target>","input_hints":[],"assertion_style":"mixed","mock_needed":false,"key_rules":[]}}
Array item shapes:
dependency_behaviors: {"name":"...","when_caller_passes":"...","always_returns":"<verified Python repr>","can_raise":[]}
unreachable_paths: {"condition":"...","reason":"..."}
mock_required_for: {"path":"...","mock_target":"<use-point>","example":"..."}
input_hints: {"param_name":"<target parameter>","strategy":"...","boundary_inputs":[],"invalid_inputs":[],"notes":"..."}
assertion_style is assertEqual, assertRaises or mixed. key_rules are source-specific strings. A meaningful test_strategy is required, including for zero-parameter functions.
Evidence rules:
- Source, annotations, setup and caller sites guide bindings and inputs, not output/exception proof. Input hints use only selected target parameters; never name dependency parameters or dependency return keys.
- Controlled observations support only their exact call and constructor/setup. Preserve Python repr. Blocked/load-error, mutated, truncated, incomplete or unassertable records are diagnostics, not target exceptions or expected values; snapshots stay artifact-only.
- Without verified dependency observations, leave dependency_behaviors empty. Dependency results are not target results. Unreachable paths and mock suggestions remain hypotheses; never omit tests on that basis or patch the target/class. With no dependencies, keep all three dependency/path arrays empty.
- Derive boundaries from source conditions; emit only scalar Python literals (None, bool, finite number, quoted string), never calls, expressions or collections. They are never an output oracle by themselves; invalid_inputs does not prove an exception.
- No direct network, file I/O, shell, dynamic execution or shared SQLite. External behavior needs explicit use-point mocks or host-declared isolated resources.${isolatedResourceSystemRule()}
Return JSON only, no Markdown or explanations.`;
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
    prompt += '=== TARGET FUNCTION SOURCE CODE ===\n```python\n' + evidence.target.source + '\n```\n\n';

    prompt += formatAstSetupContext(evidence.astFacts);
    prompt += formatVerifiedTargetObservations(
        evidence.target.functionName,
        evidence.initialTargetObservations
    );

    if (dependencies.length > 0) {
        prompt += '=== DEPENDENCY SOURCE CODE ===\n';
        for (const dep of dependencies) {
            prompt += '```python\n# Dependency: ' + dep.name + (dep.sourceHash ? '\n# Source hash: ' + dep.sourceHash : '')
                + '\n' + dep.code + '\n```\n';
        }
        prompt += '\n';
    }

    prompt += formatVerifiedDependencyFacts(dependencies);

    if (callSites.length > 0) {
        prompt += '=== TARGET CALL SITES (INPUT CANDIDATES ONLY) ===\n';
        for (const cs of callSites) {
            prompt += '  In ' + cs.caller_func + ': ' + cs.call_expr + '\n';
        }
        prompt += '\n';
    }

    prompt += 'Analyze this evidence using the role contract.';

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
 * Reject it instead of treating a provider error envelope or chat metadata
 * as a completed analysis plan.
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

function meaningfulStrategyText(value: unknown): string | undefined {
    const text = meaningfulText(value);
    // A strategy may discuss a quoted XML/HTML input. Check scaffolding outside
    // literals, keeping the original plan text and scalar spellings unchanged.
    const unquoted = text?.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '[literal]');
    return text && unquoted !== undefined && !hasTemplatePlaceholder(unquoted) && !hasRoleTemplateEcho(text) ? text : undefined;
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
            const strategy = meaningfulStrategyText(item.strategy);
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
    const approach = meaningfulStrategyText(rawStrategy.approach) || '';
    const key_rules = meaningfulTextList(rawStrategy.key_rules).filter(rule => Boolean(meaningfulStrategyText(rule)));
    // An HTTP-successful object or empty dependency list is not a plan. Keep
    // compatibility normalization only when some actual strategy survives it.
    if (!approach && input_hints.length === 0 && key_rules.length === 0) { return null; }

    return {
        dependency_behaviors,
        unreachable_paths,
        mock_required_for,
        test_strategy: {
            approach,
            input_hints,
            assertion_style,
            mock_needed: rawStrategy.mock_needed === true,
            key_rules
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

/** Check again after source-bound filtering, which may remove every model hint. */
export function hasMeaningfulSemanticStrategy(analysis: SemanticAnalysis): boolean {
    const strategy = analysis.test_strategy;
    return Boolean(meaningfulStrategyText(strategy.approach)
        || strategy.input_hints.some(hint => meaningfulText(hint.param_name) && meaningfulStrategyText(hint.strategy))
        || strategy.key_rules.some(rule => meaningfulStrategyText(rule)));
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
            out += isolatedResourceSystemRule() ? 'Analyst suggests mocks for external dependencies; verify each against host-declared isolated resources and the actual dependency use point.\n' : 'Mock required: YES — use unittest.mock.patch for external dependencies\n';
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
