import { createHash } from 'node:crypto';
import { currentTargetBudget } from '../pipeline/targetBudget';
import { estimatePromptTokens } from '../prompts/promptBudget';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { ROLE_CONTRACT_VERSIONS } from './roleContracts';
import { hasMeaningfulSemanticStrategy, parseSemanticAnalysisDetailed, restrictSemanticInputHintsToTargetParameters,
    SemanticAnalysis, SemanticAnalysisRejectionCode } from './semanticAnalyzer';

export const SEMANTIC_CONTRACT_REPAIR_SUFFIX = '\n\nSEMANTIC_CONTRACT_REPAIR_V1\n'
    + 'The previous reply was not a valid analysis plan. Reassess the same complete evidence; return the role-contract JSON with a concrete test_strategy. '
    + 'Unsupported claims use empty arrays. No tests, Markdown or explanations. This is the only format correction; all hypotheses still require verification.';

const correctionGuidance: Record<SemanticAnalysisRejectionCode, string> = {
    'empty-response': 'Return an analysis object; the previous response was empty.',
    'invalid-json': 'Return valid JSON without prose or code fences.',
    'invalid-envelope': 'Return a JSON object, not a scalar or list.',
    'unrelated-json': 'Use the named role fields and include test_strategy.',
    'schema-envelope': 'Return an analysis instance, not a JSON Schema definition.',
    'missing-test-strategy': 'Add test_strategy with a source-specific approach.',
    'invalid-test-strategy': 'Make test_strategy an object with the required fields.',
    'empty-test-strategy': 'Fill test_strategy with a concrete source-specific plan.',
    'template-only-strategy': 'Replace placeholder strategy text with a concrete plan for this target.',
    'no-usable-strategy': 'Provide a meaningful approach or valid target input hints/key_rules.',
    'target-parameter-mismatch': 'Use selected-target parameters; add a concrete approach if none apply.'
};

/** Only fixed diagnostic labels enter the correction; never echo provider values or unknown keys. */
export function buildSemanticContractRepairSuffix(reasonCode: SemanticAnalysisRejectionCode): string {
    return '\n\nSEMANTIC_CONTRACT_REPAIR_V1\nFailure: ' + reasonCode + '. ' + correctionGuidance[reasonCode]
        + ' Same complete evidence; JSON only, no tests/prose. Unsupported claims: empty arrays. '
        + 'Hypotheses need verification. Only one correction.';
}

/** Keep the previous reserve as a floor, covering every bounded correction before the first request. The final
 * transport gate must also count its own system/output/resource envelopes. */
export const SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE = Math.max(estimatePromptTokens(SEMANTIC_CONTRACT_REPAIR_SUFFIX),
    ...Object.keys(correctionGuidance).map(code => estimatePromptTokens(buildSemanticContractRepairSuffix(code as SemanticAnalysisRejectionCode))));

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
    let previousResponseHash: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
        check();
        // Transport, cancellation and prompt-budget errors propagate; no repair request follows them.
        const raw = await options.request(prompt, deadlineAt, attempt === 0 ? SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE : 0);
        check();
        const { analysis: normalized, diagnostic } = parseSemanticAnalysisDetailed(raw);
        const scoped = normalized && restrictSemanticInputHintsToTargetParameters(normalized, options.targetParameters);
        const parsed = scoped && hasMeaningfulSemanticStrategy(scoped) ? scoped : null;
        const reasonCode = normalized && !parsed ? 'target-parameter-mismatch' : diagnostic.reasonCode;
        const responseHash = createHash('sha256').update(raw).digest('hex');
        options.event(parsed ? 'parsed' : 'invalid-response', {
            contractVersion: ROLE_CONTRACT_VERSIONS.semanticPlan, attempt,
            responseHash, responseCharacters: raw.length,
            diagnosticVersion: diagnostic.version, reasonCode, responseShape: diagnostic.responseShape,
            sameResponseAsPrevious: responseHash === previousResponseHash,
            discardedInputHintCount: normalized && scoped
                ? normalized.test_strategy.input_hints.length - scoped.test_strategy.input_hints.length : 0
        });
        previousResponseHash = responseHash;
        if (parsed) { return parsed; }
        if (attempt === 0) {
            options.event('repair-requested', { contractVersion: ROLE_CONTRACT_VERSIONS.semanticPlan, attempt: 1, reasonCode });
            prompt = options.prompt + buildSemanticContractRepairSuffix(reasonCode as SemanticAnalysisRejectionCode);
        }
    }
    return undefined;
}
