/**
 * semantic_analyzer_prompt.ts
 * Role: Semantic Analyzer
 *
 * Triggered for ALL functions (not just cross-file dependencies).
 * Runs BEFORE test generation to:
 *   1. Compute fixed dependency behaviors, unreachable paths, equivalent mutant candidates
 *   2. Decide the optimal test data strategy for this specific function (AI-derived, not hardcoded)
 *
 * The test_strategy output replaces all hardcoded boundary rules in the unittest writer prompt.
 */

import { getSkillCards, formatSkillCardsForPrompt, getSkillLibrarySummaryForPrompt } from './prompt_skill_library';

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

export interface EquivalentMutantCandidate {
    description: string;
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
    equivalent_mutant_candidates: EquivalentMutantCandidate[];
    mock_required_for?: { path: string; mock_target: string; example: string }[];
    required_skills: string[];       // 技能 IDs，對應 prompt_skill_library.ts 中的 SkillCard.id
    test_strategy: TestStrategy;     // AI-derived test data strategy for this specific function
}

// === System Prompt ===

export function getSemanticAnalyzerSystemPrompt(skillLibrarySummary: string): string {
    return `You are a Python code analyst with two responsibilities:
1. Analyze cross-function dependency behavior in a specific calling context
2. Select the appropriate test skill cards for the Unittest Writer

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
  "equivalent_mutant_candidates": [
    {
      "description": "<mutation type, e.g. If_Statement to If_True>",
      "reason": "<why this mutation has no observable effect>"
    }
  ],
  "mock_required_for": [
    {
      "path": "<description of unreachable path>",
      "mock_target": "<module.function patch path>",
      "example": "<one-line mock example>"
    }
  ],
  "required_skills": ["<skill_id_1>", "<skill_id_2>"],
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
      "<any extra rule not covered by required_skills>"
    ]
  }
}

AVAILABLE SKILL IDs (for required_skills array):
${skillLibrarySummary}

ANALYSIS RULES:
- For dependency_behaviors: trace the dependency with the EXACT fixed args the target passes
- For unreachable_paths: if dependency always returns X, which if-conditions are always True/False?
- For required_skills: scan the source code and pick the IDs of ALL applicable skills:
    * Does it use len(x) < N? → add "string_length_boundary"
    * Does it use x[:N] or x[-N:]? → add "python_slicing"
    * Does it have if/elif on numeric thresholds? → add "branch_threshold_coverage"
    * Does it use round() or float math? → add "float_precision"
    * Does it return a tuple? → add "tuple_return"
    * Does it return a dict? → add "dict_return"
    * Does it check None or empty? → add "none_input_handling"
    * Does it have raise statements? → add "assert_raises_syntax"
    * Does it use try/except and return error strings? → add "try_except_returns_string"
    * Does it do division? → add "zero_division"
    * Is it a class method? → add "class_method_testing"
    * Does it call external modules/IO/DB? → add "mock_external_dependency"
    * ALWAYS add "import_module_name"
- For test_strategy.input_hints: derive boundary values from actual source code logic (thresholds, len checks, etc.)
- For test_strategy.key_rules: only add rules NOT already covered by the selected skill cards
- If no dependencies, return empty arrays for dependency_behaviors, unreachable_paths, equivalent_mutant_candidates, mock_required_for
- Return ONLY the JSON object, no explanation text`;
}

// === User Prompt ===

export function getSemanticAnalyzerUserPrompt(
    targetSource: string,
    dependencies: Array<{ name: string; code: string }>,
    callSites?: Array<{ caller_func: string; call_expr: string }>
): string {
    let prompt = '=== TARGET FUNCTION SOURCE CODE ===\n```python\n' + targetSource.trim() + '\n```\n\n';

    if (dependencies.length > 0) {
        prompt += '=== DEPENDENCY SOURCE CODE ===\n';
        for (const dep of dependencies.slice(0, 4)) {
            prompt += '```python\n# Dependency: ' + dep.name + '\n' + dep.code.trim() + '\n```\n';
        }
        prompt += '\n';
    }

    if (callSites && callSites.length > 0) {
        prompt += '=== HOW TARGET CALLS DEPENDENCIES ===\n';
        for (const cs of callSites.slice(0, 6)) {
            prompt += '  In ' + cs.caller_func + ': ' + cs.call_expr + '\n';
        }
        prompt += '\n';
    }

    prompt += 'TASK:\n';
    prompt += '1. Analyze dependency usage (if any) to identify fixed behaviors, unreachable paths, equivalent mutants.\n';
    prompt += '2. Study the target function source code and derive a test_strategy:\n';
    prompt += '   - What are the valid/invalid input ranges for each parameter?\n';
    prompt += '   - What boundary values would cover all if/elif branches?\n';
    prompt += '   - What non-obvious behaviors might a test writer get wrong?\n';
    prompt += 'Return ONLY the JSON object.';

    return prompt;
}

// === Response Parser ===

export function parseSemanticAnalysis(llmResponse: string): SemanticAnalysis | null {
    try {
        const trimmed = llmResponse.trim();
        if (trimmed.startsWith('{')) {
            return JSON.parse(trimmed) as SemanticAnalysis;
        }
        const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
            return JSON.parse(codeBlockMatch[1].trim()) as SemanticAnalysis;
        }
        const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as SemanticAnalysis;
        }
    } catch {
        // Parse failed - caller will handle null gracefully
    }
    return null;
}

export function formatSemanticContextForPrompt(analysis: SemanticAnalysis): string {
    let out = '=== SEMANTIC ANALYSIS (Pre-computed - do NOT guess, use these facts) ===\n';

    if (analysis.dependency_behaviors.length > 0) {
        out += '\nDependency Behaviors in This Caller Context:\n';
        for (const dep of analysis.dependency_behaviors) {
            out += '  * ' + dep.name + ' (called with ' + dep.when_caller_passes + '):\n';
            out += '    -> Always returns: ' + dep.always_returns + '\n';
            if (dep.can_raise.length > 0) {
                out += '    -> Can raise: ' + dep.can_raise.join('; ') + '\n';
            }
        }
    }

    if (analysis.unreachable_paths.length > 0) {
        out += '\nUnreachable Paths (Do NOT write tests expecting these):\n';
        for (const up of analysis.unreachable_paths) {
            out += '  X "' + up.condition + '" -- ' + up.reason + '\n';
        }
    }

    if (analysis.equivalent_mutant_candidates.length > 0) {
        out += '\nProbable Equivalent Mutants (These may be unkillable without mock.patch):\n';
        for (const em of analysis.equivalent_mutant_candidates) {
            out += '  ~ ' + em.description + ': ' + em.reason + '\n';
        }
    }

    if (analysis.mock_required_for && analysis.mock_required_for.length > 0) {
        out += '\nPaths Requiring mock.patch to Test:\n';
        for (const mrf of analysis.mock_required_for) {
            out += '  [mock] Path: ' + mrf.path + '\n';
            out += '         Patch target: ' + mrf.mock_target + '\n';
            out += '         Example: ' + mrf.example + '\n';
        }
    }

    // === 技能購物車：注入選取的技能卡 ===
    if (analysis.required_skills && analysis.required_skills.length > 0) {
        const cards = getSkillCards(analysis.required_skills);
        if (cards.length > 0) {
            out += '\n' + formatSkillCardsForPrompt(cards);
        }
    }

    // === AI 推導的測資策略 ===
    const ts = analysis.test_strategy;
    if (ts) {
        out += '\n=== TEST DATA STRATEGY (AI-derived for this specific function) ===\n';
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
            out += '\nInput Boundary Hints (use these exact values in test cases):\n';
            for (const hint of ts.input_hints) {
                out += '  Param "' + hint.param_name + '": ' + hint.strategy + '\n';
                if (hint.boundary_inputs.length > 0) {
                    out += '    Valid inputs (use assertEqual): [' + hint.boundary_inputs.join(', ') + ']\n';
                }
                if (hint.invalid_inputs.length > 0) {
                    out += '    Invalid inputs (use assertRaises): [' + hint.invalid_inputs.join(', ') + ']\n';
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
 * 建立語意分析師系統 prompt（含動態技能庫摘要）
 * 此為對外呼叫的工廠函式，自動注入技能庫說明
 */
export function buildSemanticAnalyzerSystemPrompt(): string {
    const summary = getSkillLibrarySummaryForPrompt();
    return getSemanticAnalyzerSystemPrompt(summary);
}
