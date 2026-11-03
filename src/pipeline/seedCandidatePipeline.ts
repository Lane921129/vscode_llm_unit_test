import { CandidatePipelineHooks, validateTestCandidate } from './testCandidatePipeline';
import { AnalysisStageError } from '../utils/executionFailureCategory';

/** The first model candidate executes, checkpoints, and then seeks Reviewer approval. */
export async function validateSeedThenCandidate(input: {
    code: string;
    seed: boolean;
    hooks: CandidatePipelineHooks;
    seedAccepted?(code: string): void;
    baseline?: { code: string; output: string };
}) {
    let seedCheckpointed = false;
    if (input.seed) { input.hooks.event('writer-seed', 'started', { traceMerged: false }); }
    return validateTestCandidate(input.code, {
        ...input.hooks,
        execute: async candidate => {
            const result = await input.hooks.execute(candidate);
            if (input.seed && result.ok && result.coverage?.targetExecuted !== true) {
                throw new AnalysisStageError('validation', 'writer-seed',
                    'The model seed has no verified execution of the selected target.');
            }
            return result;
        },
        executable: async (code, execution) => {
            await input.hooks.executable?.(code, execution);
            input.hooks.checkCancelled();
            if (input.seed && !seedCheckpointed) {
                seedCheckpointed = true;
                input.seedAccepted?.(code);
                input.hooks.event('writer-seed', 'accepted', {
                    traceMerged: false, reviewStatus: 'incomplete', mutationStatus: 'not-measured'
                });
            }
        }
    }, 2, input.baseline);
}
