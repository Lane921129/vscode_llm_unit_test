/**
 * mutant_triage_prompt.ts
 * Role: Mutant Triage Analyst
 *
 * Triggered from Loop 2 onwards when survived mutants exist.
 * Determines for each mutant:
 *   EQUIVALENT - unkillable without mocking/architecture changes
 *   KILLABLE   - can be killed with a specific test case
 * For KILLABLE mutants, provides exact kill_test Python code.
 */

// === Type Definitions ===

export type MutantVerdict = 'EQUIVALENT' | 'KILLABLE';

export interface MutantVerdictItem {
    mutant: string;
    verdict: MutantVerdict;
    reason: string;
    kill_test: string | null;
}

export interface MutantTriageResult {
    verdicts: MutantVerdictItem[];
    has_killable: boolean;
    equivalent_count: number;
}

// === System Prompt ===

export function getMutantTriageSystemPrompt(): string {
    return `You are a mutation testing expert and Python unit test specialist.

Your task is to analyze survived mutation testing results and triage each mutant:
- EQUIVALENT: The mutant is logically equivalent to the original in all reachable paths (unkillable without mocking)
- KILLABLE: A specific test case exists that can detect this mutation

For KILLABLE mutants, provide the EXACT Python test method code (starting with "def test_kill_...") that would make the mutant fail.

EQUIVALENT MUTANT DETECTION RULES:
1. If a condition is ALWAYS True/False due to fixed dependency return values -> likely EQUIVALENT
2. If the mutated path is unreachable through normal function calls -> likely EQUIVALENT
3. Consider mock.patch as a feasible option before declaring EQUIVALENT

KILLABLE MUTANT RULES:
1. If a branch condition is testable with direct inputs -> KILLABLE via direct test
2. If reachable with mock.patch of a dependency -> KILLABLE via mock
3. If it changes a comparison operator -> KILLABLE by testing boundary values

OUTPUT: Return ONLY a valid JSON object:
{
  "verdicts": [
    {
      "mutant": "<exact mutant description from report>",
      "verdict": "EQUIVALENT or KILLABLE",
      "reason": "<concise explanation>",
      "kill_test": "<complete Python def test_kill_xxx(self): method as string, or null>"
    }
  ],
  "has_killable": true,
  "equivalent_count": 0
}

For kill_test code:
- Use self.assert* methods only
- Include mock.patch usage if needed (assume from unittest.mock import patch is available)
- The method must be self-contained`;
}

// === User Prompt ===

export function getMutantTriageUserPrompt(
    survivedMutants: string,
    targetSource: string,
    currentTestCode: string,
    moduleName: string,
    funcName: string,
    semanticContext?: string
): string {
    let prompt = '=== SURVIVED MUTANTS TO TRIAGE ===\n' + survivedMutants + '\n\n';

    prompt += '=== TARGET FUNCTION SOURCE CODE ===\n```python\n' + targetSource.trim() + '\n```\n\n';

    if (semanticContext) {
        prompt += semanticContext + '\n';
    }

    prompt += '=== CURRENT TEST FILE (what has already been tried) ===\n```python\n' + currentTestCode.slice(0, 3000) + '\n```\n\n';

    prompt += '=== CONTEXT ===\n';
    prompt += 'Module name: ' + moduleName + '\n';
    prompt += 'Function under test: ' + funcName + '\n';
    prompt += 'Import to use: from ' + moduleName + ' import ' + funcName + '\n\n';

    prompt += 'TASK: For each survived mutant above, determine EQUIVALENT vs KILLABLE, and provide kill_test code for KILLABLE ones.';

    return prompt;
}

// === Response Parser ===

export function parseMutantTriageResult(llmResponse: string): MutantTriageResult | null {
    try {
        const trimmed = llmResponse.trim();
        if (trimmed.startsWith('{')) {
            return JSON.parse(trimmed) as MutantTriageResult;
        }
        const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
            return JSON.parse(codeBlockMatch[1].trim()) as MutantTriageResult;
        }
        const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as MutantTriageResult;
        }
    } catch {
        // Parse failed - caller handles null gracefully
    }
    return null;
}

export function extractKillTestMethods(result: MutantTriageResult): string {
    return result.verdicts
        .filter(v => v.verdict === 'KILLABLE' && v.kill_test)
        .map(v => v.kill_test as string)
        .join('\n\n');
}

export function formatEquivalentMutantsReport(result: MutantTriageResult): string {
    const eqs = result.verdicts.filter(v => v.verdict === 'EQUIVALENT');
    if (eqs.length === 0) { return ''; }
    let out = '\n### Equivalent Mutants (Logically unkillable - excluded from score denominator)\n\n';
    for (const eq of eqs) {
        out += '- `' + eq.mutant + '`\n  > ' + eq.reason + '\n';
    }
    return out + '\n';
}