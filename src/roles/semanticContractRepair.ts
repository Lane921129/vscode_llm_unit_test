import { createHash } from 'node:crypto';
import { currentTargetBudget } from '../pipeline/targetBudget';
import { estimatePromptTokens } from '../prompts/promptBudget';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { ROLE_CONTRACT_VERSIONS } from './roleContracts';
import { hasMeaningfulSemanticStrategy, parseSemanticAnalysis, restrictSemanticInputHintsToTargetParameters, SemanticAnalysis } from './semanticAnalyzer';

export const SEMANTIC_CONTRACT_REPAIR_SUFFIX = '\n\nSEMANTIC_CONTRACT_REPAIR_V1\n'
    + 'The previous reply was not a valid analysis plan. Reassess the same complete evidence; return the role-contract JSON with a concrete test_strategy. '
    + 'Unsupported claims use empty arrays. No tests, Markdown or explanations. This is the only format correction; all hypotheses still require verification.';

/** Reserve the complete fixed correction before the first request. The final
 * transport gate must also count its own system/output/resource envelopes. */
export const SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE = estimatePromptTokens(SEMANTIC_CONTRACT_REPAIR_SUFFIX);

interface SemanticContractOptions {
    prompt: string;
    deadlineAt: number;
    targetParameters?: readonly string[];
    request(prompt: string, deadlineAt: number, reservedInputTokens: number): Promise<string>;
    checkCurrent(): void;
    event(status: 'parsed' | 'invalid-response' | 'repair-requested', detail: unknown): void;
    now?: () => number;
}

/** Repair only a returned format failure, keeping the same evidence and absolute deadline. */
export async function semanticWithContractRepair(options: SemanticContractOptions): Promise<SemanticAnalysis | undefined> {
    if (!Number.isFinite(options.deadlineAt)) { throw new TypeError('Semantic deadline must be finite'); }
    const deadlineAt = Math.min(options.deadlineAt, currentTargetBudget()?.deadlineAt ?? Infinity);
    const now = options.now || Date.now;
    const check = () => {
        options.checkCurrent();
        currentTargetBudget()?.assertRemaining();
        if (now() >= deadlineAt) {
            throw new AnalysisStageError('timeout', 'analyst-planning', 'Analyst planning deadline expired.');
        }
    };
    let prompt = options.prompt;
    for (let attempt = 0; attempt < 2; attempt++) {
        check();
        // Transport, cancellation and prompt-budget errors propagate; no repair request follows them.
        const raw = await options.request(prompt, deadlineAt, attempt === 0 ? SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE : 0);
        check();
        const normalized = parseSemanticAnalysis(raw);
        const scoped = normalized && restrictSemanticInputHintsToTargetParameters(normalized, options.targetParameters);
        const parsed = scoped && hasMeaningfulSemanticStrategy(scoped) ? scoped : null;
        options.event(parsed ? 'parsed' : 'invalid-response', {
            contractVersion: ROLE_CONTRACT_VERSIONS.semanticPlan, attempt,
            responseHash: createHash('sha256').update(raw).digest('hex'), responseCharacters: raw.length
        });
        if (parsed) { return parsed; }
        if (attempt === 0) {
            options.event('repair-requested', { contractVersion: ROLE_CONTRACT_VERSIONS.semanticPlan, attempt: 1 });
            prompt = options.prompt + SEMANTIC_CONTRACT_REPAIR_SUFFIX;
        }
    }
    return undefined;
}
