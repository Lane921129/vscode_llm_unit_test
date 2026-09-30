import { localize } from '../i18n/core';
import { MutationRun } from '../mutation/mutationResult';
import { BehaviorObservations } from './evidenceContracts';
import { evidenceHash } from './analysisJournal';
import { pythonToolPath } from './pythonTools';
import { runSpawn } from '../utils/processRunner';
import { SupplementalProbeInput } from '../tier/supplementalProbeInputs';

export interface MutationProbePlan {
    version: 'mutation-input-plan-v1';
    inputs: Array<SupplementalProbeInput & { mutantId: string }>;
    diagnostics: Array<{ mutantId?: string; status: string; reasonCode: string; excludedFromScore: false }>;
    assertionOracle: false;
}

/** Planning never runs the target and cannot declare a mutant equivalent. */
export async function planMutationProbes(source: string, target: string, mutation: MutationRun,
    observations: BehaviorObservations | undefined, python: string): Promise<MutationProbePlan> {
    const empty: MutationProbePlan = { version: 'mutation-input-plan-v1', inputs: [], diagnostics: [], assertionOracle: false };
    if (mutation.engine !== 'builtin' || mutation.status !== 'complete'
        || mutation.sourceHash !== evidenceHash(source) || mutation.targetScope.qualifiedName !== target) { return empty; }
    const survivors = mutation.mutants.filter(item => item.status === 'SURVIVED');
    if (!survivors.length) { return empty; }
    const run = await runSpawn(python, ['-B', pythonToolPath('mutationInputs')], {
        input: JSON.stringify({ source, target, mutants: survivors, observations: observations?.examples || [] }),
        timeout: 5000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    if (run.code !== 0) { throw new Error(localize("突變輸入規劃未完成；未產生斷言。")); }
    const plan = JSON.parse(run.stdout) as MutationProbePlan;
    const ids = new Set(survivors.map(item => item.id));
    if (plan.version !== empty.version || plan.assertionOracle !== false || !Array.isArray(plan.inputs)
        || plan.inputs.length > 12 || !Array.isArray(plan.diagnostics)
        || plan.inputs.some(item => !ids.has(item.mutantId) || !Array.isArray(item.args) || item.args.length > 6
            || !item.args.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)
            || !item.kwargs || Object.keys(item.kwargs).length !== 0)
        || plan.diagnostics.some(item => item.excludedFromScore !== false || item.mutantId && !ids.has(item.mutantId))) {
        throw new Error(localize("突變輸入規劃契約無效；未使用候選。"));
    }
    return plan;
}
