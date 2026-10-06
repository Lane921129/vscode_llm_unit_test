import { CandidatePipelineHooks, validateTestCandidate } from './testCandidatePipeline';
import { AnalysisStageError } from '../utils/executionFailureCategory';

/** Model tests must stand alone before runner-owned evidence is appended. */
export async function validateSeedThenCandidate(input: {
    code: string;
    seed: boolean;
    hooks: CandidatePipelineHooks;
    augment(code: string): Promise<string>;
    seedAccepted?(code: string): void;
    baseline?: { code: string; output: string };
}) {
    let code = input.code;
    let baseline = input.baseline;
    if (input.seed) {
        input.hooks.event('writer-seed', 'started', { traceMerged: false });
        const accepted = await validateTestCandidate(code, {
            ...input.hooks,
            reviewRequired: false,
            execute: async candidate => {
                const result = await input.hooks.execute(candidate);
                if (result.ok && result.coverage?.targetExecuted !== true) {
                    throw new AnalysisStageError('validation', 'writer-seed',
                        'The model seed has no verified execution of the selected target.');
                }
                return result;
            }
        }, 2);
        input.hooks.checkCancelled();
        code = accepted.code;
        // The augmented candidate may fail structure before it can execute. Seed
        // passing IDs must already protect every later repair from dropping them.
        baseline = { code: accepted.code, output: accepted.execution.out };
        input.seedAccepted?.(code);
        input.hooks.event('writer-seed', 'accepted', {
            traceMerged: false, reviewStatus: 'incomplete', mutationStatus: 'not-measured'
        });
    }
    input.hooks.checkCancelled();
    code = await input.augment(code);
    input.hooks.checkCancelled();
    return validateTestCandidate(code, input.hooks, 2, baseline);
}
