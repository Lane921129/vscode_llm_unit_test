export interface QualityTask {
    evidence: string;
    hypothesis: string;
    scenario: string;
    verification: string;
}

export function getQualityAnalystSystemPrompt(): string {
    return `You are the Analyst after successful unittest execution. Plan the next quality improvement; do not write test code.
Use only the supplied target, tests and measured gaps. Distinguish test weaknesses from unproven product defects.
Return at most 3 focused tasks. For each task quote an exact measured gap or survivor as evidence, propose an input/mock scenario, and state how execution should verify it.
An expected value is a hypothesis until verified with that same input and mock configuration. Do not claim equivalent mutants or remove them from scoring.
If evidence is insufficient return an empty tasks array; do not fill gaps by guessing.
Return only JSON: {"tasks":[{"evidence":"exact measured gap","hypothesis":"suspected weakness","scenario":"input or controlled dependency change","verification":"what to compare on original and mutant"}]}.`;
}

export function parseQualityTasks(raw: string, measured: string): QualityTask[] | undefined {
    try {
        const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\s*```$/, ''));
        if (!value || !Array.isArray(value.tasks) || value.tasks.length > 3) { return undefined; }
        for (const task of value.tasks) {
            if (!task || !['evidence', 'hypothesis', 'scenario', 'verification'].every(key =>
                typeof task[key] === 'string' && task[key].trim() && task[key].length <= 800
                && !/<[^>]+>/.test(task[key]))) { return undefined; }
            if (!measured.includes(task.evidence)) { return undefined; }
        }
        return value.tasks.map((task: QualityTask) => ({ evidence: task.evidence,
            hypothesis: task.hypothesis, scenario: task.scenario, verification: task.verification }));
    } catch { return undefined; }
}

/** Small, conditional guidance. These are strategies, never asserted output facts. */
export function qualityStrategyHints(survivors: string): string[] {
    const hints: string[] = [];
    if (/mutation from (?:And to Or|Or to And)/.test(survivors)) {
        hints.push('Boolean operator survivor: try mixed truth values for the subconditions, including required mock fields; verify original and mutant under identical setup.');
    }
    if (/mutation from (?:return_value to None|(?:True|False) to (?:True|False))/.test(survivors)) {
        hints.push('Return-value survivor: check whether a truthiness assertion hides distinct values. Verify the original result for this exact input/mock before adding an exact assertion.');
    }
    return hints;
}
