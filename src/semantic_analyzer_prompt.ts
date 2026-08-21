/**
 * semantic_analyzer_prompt.ts
 * Role: Semantic Analyzer
 *
 * Triggered when the target function has cross-file dependencies.
 * Runs BEFORE test generation to compute fixed dependency behaviors,
 * unreachable paths, and equivalent mutant candidates.
 */

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

export interface SemanticAnalysis {
    dependency_behaviors: DependencyBehavior[];
    unreachable_paths: UnreachablePath[];
    equivalent_mutant_candidates: EquivalentMutantCandidate[];
    mock_required_for?: { path: string; mock_target: string; example: string }[];
}

// === System Prompt ===

export function getSemanticAnalyzerSystemPrompt(): string {
    return `You are a Python static code analyzer specializing in cross-function dependency analysis.

Your task is to analyze how a TARGET FUNCTION uses its DEPENDENCY FUNCTIONS in its specific calling context, then identify:
1. What each dependency always returns when called by this specific target function
2. Which branches in the target function are unreachable through normal calls
3. Which mutation types would be logically equivalent (unkillable without mocking)

ANALYSIS RULES:
- Focus on the EXACT arguments the target function passes to each dependency (e.g. provider="jwt")
- Trace through the dependency source code with those fixed arguments to determine the fixed return value
- A path is "unreachable" if the dependency fixed return value makes a condition always True or always False
- An equivalent mutant is one that produces the same observable behavior in ALL reachable paths

OUTPUT: Return ONLY a valid JSON object with this exact schema:
{
  "dependency_behaviors": [
    {
      "name": "<function_name>",
      "when_caller_passes": "<description of fixed args passed by target>",
      "always_returns": "<exact return value or structure>",
      "can_raise": ["<exception> when <condition>"]
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
      "description": "<mutation type, e.g. If_Statement to If_True on result[valid]>",
      "reason": "<why this mutation has no observable effect>"
    }
  ],
  "mock_required_for": [
    {
      "path": "<description of unreachable path>",
      "mock_target": "<module.function patch path>",
      "example": "<one-line mock example>"
    }
  ]
}`;
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

    prompt += 'TASK: Analyze the target function dependency usage and return the JSON analysis as specified.\n';
    prompt += 'Focus on: What does each dependency ALWAYS return when called by this specific target? Which if-conditions are therefore always True/False?';

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

    return out + '\n';
}