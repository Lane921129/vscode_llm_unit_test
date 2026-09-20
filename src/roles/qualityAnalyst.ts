import { hasTemplatePlaceholder } from '../validation/templatePlaceholder';
import { createHash } from 'crypto';
import { TargetCoverageAssessment } from '../mutation/targetCoverage';
import { coverageGapIds } from '../pipeline/qualityRegression';

export interface QualityTask {
    evidence: string;
    hypothesis: string;
    scenario: string;
    verification: string;
}

export function getQualityAnalystSystemPrompt(): string {
    return `You are the Analyst after successful unittest execution. Plan the next quality improvement; do not write test code.
Use only the supplied target, tests and measured gaps. Distinguish test weaknesses from unproven product defects.
Return at most ONE task for the supplied FOCUS. Copy its evidence_id exactly; do not repeat the evidence text. Propose one input/mock scenario and state how execution should verify it.
An expected value is a hypothesis until verified with that same input and mock configuration. Do not claim equivalent mutants or remove them from scoring.
If evidence is insufficient return an empty tasks array; do not fill gaps by guessing.
Return only JSON: {"tasks":[{"evidence_id":"supplied ID","hypothesis":"suspected weakness","scenario":"one input or controlled dependency change","verification":"what to compare on original and mutant"}]}.`;
}

export interface QualityFocus { id: string; kind: 'coverage' | 'survivor'; evidence: string }

/** Rotate one deterministic measured gap per round; no model selects or invents evidence. */
export function selectQualityFocus(coverage: TargetCoverageAssessment, survivors: string[], round: number): QualityFocus | undefined {
    const items = [
        ...coverageGapIds(coverage).map(evidence => ({ kind: 'coverage' as const, evidence })),
        ...[...new Set(survivors)].filter(Boolean).map(evidence => ({ kind: 'survivor' as const, evidence }))
    ];
    const item = items[(Math.max(1, round) - 1) % items.length];
    return item ? { ...item, id: 'E' + createHash('sha256').update(item.kind + ':' + item.evidence).digest('hex').slice(0, 16) } : undefined;
}

export function parseFocusedQualityTask(raw: string, focus: QualityFocus): { tasks?: QualityTask[]; diagnostics: string[] } {
    let value: any;
    try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\s*```$/, '')); }
    catch { return { diagnostics: ['invalid-json'] }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => key !== 'tasks') || !Array.isArray(value.tasks)) {
        return { diagnostics: ['invalid-envelope'] };
    }
    if (value.tasks.length > 1) { return { diagnostics: ['too-many-tasks'] }; }
    for (const task of value.tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)
            || Object.keys(task).some(key => !['evidence_id', 'hypothesis', 'scenario', 'verification'].includes(key))) {
            return { diagnostics: ['invalid-task'] };
        }
        if (task.evidence_id !== focus.id) { return { diagnostics: ['unknown-evidence-id'] }; }
        if (!['hypothesis', 'scenario', 'verification'].every(key => typeof task[key] === 'string'
            && task[key].trim() && task[key].length <= 800 && !hasTemplatePlaceholder(task[key]))) {
            return { diagnostics: ['invalid-task-fields'] };
        }
    }
    return { tasks: value.tasks.map((task: any) => ({ evidence: focus.evidence,
        hypothesis: task.hypothesis, scenario: task.scenario, verification: task.verification })), diagnostics: [] };
}

/** One format repair at most, sharing the original deadline. Never echo a bad response. */
export async function requestFocusedQualityTask(input: {
    focus: QualityFocus; context: string; deadlineAt: number;
    request(prompt: string, deadlineAt: number): Promise<string>;
    checkCancelled(): void;
    event(status: string, detail: unknown): void;
    now?: () => number;
}): Promise<QualityTask[] | undefined> {
    const prompt = `QUALITY_TASK_V2\nFOCUS\n${JSON.stringify(input.focus)}\n${input.context}`;
    let correction = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        input.checkCancelled();
        if ((input.now || Date.now)() >= input.deadlineAt) {
            input.event('deadline-exhausted', { attempt, evidenceId: input.focus.id });
            return undefined;
        }
        const raw = await input.request(prompt + correction, input.deadlineAt);
        input.checkCancelled();
        const parsed = parseFocusedQualityTask(raw, input.focus);
        input.event(parsed.tasks ? 'parsed-hypotheses' : 'invalid-response', {
            attempt, contractVersion: 'quality-task-v2', focus: input.focus, raw, ...parsed
        });
        if (parsed.tasks) { return parsed.tasks; }
        correction = `\nFORMAT CORRECTION: ${parsed.diagnostics.join(', ')}. Return only {"tasks":[]} or one task with evidence_id="${input.focus.id}", hypothesis, scenario, verification. No other keys or prose.`;
    }
    return undefined;
}

/** Historical quality-task-v1 reader; new requests use ID-bound single-task parsing. */
export function parseQualityTasks(raw: string, measured: string): QualityTask[] | undefined {
    try {
        const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\s*```$/, ''));
        if (!value || !Array.isArray(value.tasks) || value.tasks.length > 3) { return undefined; }
        for (const task of value.tasks) {
            if (!task || !['evidence', 'hypothesis', 'scenario', 'verification'].every(key =>
                typeof task[key] === 'string' && task[key].trim() && task[key].length <= 800
                && !hasTemplatePlaceholder(task[key]))) { return undefined; }
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
