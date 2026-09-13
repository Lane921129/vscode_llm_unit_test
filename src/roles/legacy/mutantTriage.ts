/**
 * mutant_triage_prompt.ts
 * Role: Mutant Triage Analyst
 *
 * Triggered from Loop 2 onwards when survived mutants exist.
 * Determines for each mutant:
 *   EQUIVALENT - model hypothesis, never execution proof
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
- EQUIVALENT: A hypothesis that no supported direct input OR allowed dependency mock distinguishes the mutant
- KILLABLE: A specific test case exists that can detect this mutation

For KILLABLE mutants, provide the EXACT Python test method code (starting with "def test_kill_...") that would make the mutant fail.

EQUIVALENT MUTANT DETECTION RULES:
1. Fixed real dependency results do not establish equivalence: dependency mock.patch is allowed at the target use point.
2. For And/Or mutations, try mixed truth values (True/False and False/True), respecting short-circuit evaluation and required result fields.
3. Unreachable without mocking is not equivalent when a supported mock can expose the difference. If evidence is insufficient, omit the verdict instead of claiming equivalence.

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Preserve only actionable, schema-shaped triage facts.  The model's summary
 * counters are recomputed from validated verdicts so malformed provider JSON
 * cannot stop the mutation loop or falsely exclude surviving mutants.
 */
function normalizeMutantTriage(value: unknown): MutantTriageResult | null {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'verdicts') || !Array.isArray(value.verdicts)) {
        return null;
    }

    const verdicts = value.verdicts.map(item => {
        if (!isRecord(item)) {return undefined;}
        const mutant = text(item.mutant);
        const reason = text(item.reason);
        const verdict = item.verdict === 'EQUIVALENT' || item.verdict === 'KILLABLE'
            ? item.verdict
            : undefined;
        const kill_test = item.kill_test === null ? null : text(item.kill_test);
        if (!mutant || !reason || !verdict) {return undefined;}
        // A KILLABLE claim without an executable next-step is not safe to use
        // as a retry hint.  Keep it as no verdict rather than fabricating code.
        if (verdict === 'KILLABLE' && !kill_test) {return undefined;}
        return { mutant, reason, verdict, kill_test: verdict === 'EQUIVALENT' ? null : kill_test! };
    }).filter((item): item is MutantVerdictItem => Boolean(item));

    return {
        verdicts,
        has_killable: verdicts.some(item => item.verdict === 'KILLABLE'),
        equivalent_count: verdicts.filter(item => item.verdict === 'EQUIVALENT').length
    };
}

export function parseMutantTriageResult(llmResponse: string): MutantTriageResult | null {
    try {
        const trimmed = llmResponse.trim();
        if (trimmed.startsWith('{')) {
            return normalizeMutantTriage(JSON.parse(trimmed));
        }
        const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
            return normalizeMutantTriage(JSON.parse(codeBlockMatch[1].trim()));
        }
        const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return normalizeMutantTriage(JSON.parse(jsonMatch[0]));
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
    let out = '\n### Candidate Equivalent Mutants (model hypotheses; retained in score denominator)\n\n';
    for (const eq of eqs) {
        out += '- `' + eq.mutant + '`\n  > ' + eq.reason + '\n';
    }
    return out + '\n';
}
