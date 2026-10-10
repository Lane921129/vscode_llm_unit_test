import { createHash } from 'node:crypto';
import { currentTargetBudget } from '../pipeline/targetBudget';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { ROLE_CONTRACT_VERSIONS } from './roleContracts';
import { parseSemanticAnalysis, SemanticAnalysis } from './semanticAnalyzer';

interface SemanticContractOptions {
    prompt: string;
    deadlineAt: number;
    request(prompt: string, deadlineAt: number): Promise<string>;
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
        const raw = await options.request(prompt, deadlineAt);
        check();
        const parsed = parseSemanticAnalysis(raw);
        options.event(parsed ? 'parsed' : 'invalid-response', {
            contractVersion: ROLE_CONTRACT_VERSIONS.semanticPlan, attempt,
            responseHash: createHash('sha256').update(raw).digest('hex'), responseCharacters: raw.length
        });
        if (parsed) { return parsed; }
        if (attempt === 0) {
            options.event('repair-requested', { contractVersion: ROLE_CONTRACT_VERSIONS.semanticPlan, attempt: 1 });
            prompt = options.prompt + '\n\nSEMANTIC_CONTRACT_REPAIR_V1\n'
                + 'The previous reply did not satisfy the analysis JSON contract. Reassess the same complete evidence. '
                + 'Return one JSON object containing dependency_behaviors, unreachable_paths, mock_required_for, and test_strategy. '
                + 'Use empty arrays for unsupported claims. test_strategy contains approach, input_hints, assertion_style, mock_needed, key_rules. '
                + 'Use selected target parameter names only. Do not output Python tests, Markdown or explanations. '
                + 'This is the only format correction attempt; hypotheses still require tool verification.';
        }
    }
    return undefined;
}
