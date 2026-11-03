import { pythonToolPath } from './pythonTools';
import { runSpawn } from '../utils/processRunner';

export interface PassingTestPreservation {
    schemaVersion: 'passing-test-preservation-v1';
    valid: boolean;
    reasonCode: string | null;
    reason: string;
    protectedMethods: string[];
}

/** Inspect AST only. The caller supplies identities from an actual execution. */
export async function validatePassingTestPreservation(options: {
    previousCode: string; candidateCode: string; protectedMethods: 'all' | readonly string[];
    python: string; env?: NodeJS.ProcessEnv;
}): Promise<PassingTestPreservation> {
    const run = await runSpawn(options.python, ['-B', pythonToolPath('passingPreservation')], {
        input: JSON.stringify({ previous: options.previousCode, candidate: options.candidateCode,
            protectedMethods: options.protectedMethods }), env: options.env, timeout: 5000
    });
    if (run.code === 0) {
        try {
            const value = JSON.parse(run.stdout) as PassingTestPreservation;
            if (value?.schemaVersion === 'passing-test-preservation-v1' && typeof value.valid === 'boolean'
                && typeof value.reason === 'string' && (value.reasonCode === null
                    || typeof value.reasonCode === 'string' && /^[a-z][a-z-]{1,79}$/.test(value.reasonCode))
                && Array.isArray(value.protectedMethods) && value.protectedMethods.every(name => typeof name === 'string')
                && (value.valid ? value.reasonCode === null : value.reasonCode !== null)) {
                return value;
            }
        } catch { /* Fail closed; never expose arbitrary Python output. */ }
    }
    return { schemaVersion: 'passing-test-preservation-v1', valid: false,
        reasonCode: 'preservation-tool-error', reason: 'The passed-scenario preservation check could not complete.', protectedMethods: [] };
}
