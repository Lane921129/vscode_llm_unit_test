import * as fs from 'node:fs';
import * as path from 'node:path';
import { evidenceHash } from './analysisJournal';
import { reserveArtifactFiles } from './artifactPaths';
import { parseBehaviorObservations } from './behaviorObservations';
import { BehaviorObservations, TraceValueSnapshot } from './evidenceContracts';
import { callerMatchesObservation, sameTraceValue, typedCallFields } from './probeInputs';
import { validTraceValueSnapshot } from './traceValues';
import { pythonToolPath } from './pythonTools';
import { currentTargetBudget } from './targetBudget';
import { runSpawn } from '../utils/processRunner';

interface Calculation { call: TraceValueSnapshot; result_snapshot: TraceValueSnapshot }
interface Correction { method: string; line: number; basis: Calculation }
interface Proposal { changed: true; code: string; basis: string; corrections: Correction[] }
interface Options {
    code: string; failure: string; source: string; target: string; module: string;
    python: string; env: NodeJS.ProcessEnv; directory: string; runId: string; sourceHash: string;
    checkCurrent(): void;
    observe(calls: Array<{ trace_input: TraceValueSnapshot }>): Promise<BehaviorObservations | null>;
    event(stage: string, status: string, detail: unknown): void;
}

/** A calculation is a hypothesis until the same typed call has completed in isolation. */
export function verifyNumericObservations(calculations: Calculation[], raw: unknown, target: string): boolean {
    try {
        const trace = parseBehaviorObservations(raw, target);
        if (!trace.complete || trace.load_error || trace.blocked_operations?.length) { return false; }
        return calculations.length > 0 && calculations.every(calculation => {
            if (!typedCallFields(calculation.call) || !validTraceValueSnapshot(calculation.result_snapshot)
                || !calculation.result_snapshot.replayable) { return false; }
            const matching = trace.cases!.filter(item => callerMatchesObservation({ trace_input: calculation.call }, item.input_before));
            if (matching.length !== 1) { return false; }
            const item = matching[0];
            const observed = trace.examples.find(example => example.case_id === item.case_id);
            const result = (item as unknown as { result_snapshot?: unknown }).result_snapshot;
            return item.status === 'returned' && item.call_assertable !== false && !item.inputs_mutated
                && callerMatchesObservation({ trace_input: calculation.call }, item.input_after || undefined)
                && !!observed && observed.call_assertable !== false && observed.result_assertable !== false
                && !observed.result_truncated && !observed.non_deterministic_operations?.length && !observed.oracle_reason
                && validTraceValueSnapshot(result) && result.replayable
                && sameTraceValue(calculation.result_snapshot.value, result.value);
        });
    } catch { return false; }
}

/** Host-owned skill: no model tool-calling support, arbitrary eval, or new provider request. */
export async function repairWithNumericSkill(options: Options): Promise<{ code: string; evidence: unknown } | undefined> {
    if (!/^FAIL: test_/m.test(options.failure)) { return undefined; }
    const check = () => { options.checkCurrent(); currentTargetBudget()?.assertRemaining(); };
    check();
    const [file] = reserveArtifactFiles(options.directory, ['numeric'], 'json');
    const identity = { schemaVersion: 'numeric-test-skill-v1', runId: options.runId, target: options.target,
        sourceHash: options.sourceHash, previousTestHash: evidenceHash(options.code), file: path.basename(file),
        limitation: 'Calculator and exact-input execution agree with current source; independent requirements are not proven.' };
    const save = (status: string, detail: Record<string, unknown> = {}) => {
        const evidence = { ...identity, status, ...detail };
        fs.writeFileSync(file, JSON.stringify(evidence, null, 2), 'utf8');
        options.event('numeric-skill', status, { file: identity.file, ...detail });
        return evidence;
    };
    save('planned');
    let proposal: Proposal | undefined;
    let trace: BehaviorObservations | null = null;
    try {
        const run = await runSpawn(options.python, ['-B', pythonToolPath('sourceExpectations')], {
            input: JSON.stringify({ code: options.code, failure: options.failure, source: options.source,
                target: options.target, module: options.module, numericSkill: true }), env: options.env, timeout: 5000
        });
        check();
        if (run.code !== 0) { save('unavailable', { reason: 'calculator-unavailable' }); return undefined; }
        const value = JSON.parse(run.stdout);
        if (value.changed !== true || typeof value.code !== 'string' || value.code === options.code
            || value.basis !== 'source-derived-arithmetic-v1' || !Array.isArray(value.corrections)
            || !value.corrections.length || value.corrections.length > 32
            || !value.corrections.every((item: Correction) => item?.basis && typedCallFields(item.basis.call)
                && validTraceValueSnapshot(item.basis.result_snapshot) && item.basis.result_snapshot.replayable)) {
            save('unsupported', { reason: 'unsupported-or-no-calculation' }); return undefined;
        }
        proposal = value;
        const calculations = value.corrections.map((item: Correction) => item.basis) as Calculation[];
        const calls = [...new Map(calculations.map(item => [JSON.stringify(item.call), { trace_input: item.call }])).values()];
        if (calls.length > 6) { save('unsupported', { reason: 'case-budget', count: calls.length }); return undefined; }
        trace = await options.observe(calls);
        check();
        if (!verifyNumericObservations(calculations, trace, options.target)) {
            save('unverified', { reason: 'exact-input-observation-missing-or-mismatched', corrections: value.corrections, trace });
            return undefined;
        }
        const evidence = save('verified', { candidateTestHash: evidenceHash(value.code), corrections: value.corrections, trace });
        return { code: value.code, evidence };
    } catch {
        // Cancellation, deadlines and source changes must not turn into fallback success.
        try { check(); }
        catch (error) {
            save('unavailable', { reason: 'evidence-invalidated-or-interrupted', corrections: proposal?.corrections });
            throw error;
        }
        save('unavailable', { reason: 'tool-or-contract-error', corrections: proposal?.corrections, trace });
        return undefined;
    }
}
