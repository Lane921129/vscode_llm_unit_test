import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

export interface ResourceSetupFailureIdentity {
    isolationFile: string; sourceFile: string; testFile: string;
    targetRunId: string; sourceHash: string; testHash: string;
    importFixturePlanId?: string; exitCode: number | null;
}

export interface ResourceSetupFailure {
    category: 'environment'; stage: 'resource-setup'; reasonCode: 'resource-schema-required';
    targetRunId: string; sourceHash: string; testHash: string; importFixturePlanId: string;
}

const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Classify only a completed, identity-bound host runner verdict, never traceback text. */
export function readResourceSetupFailure(expected: ResourceSetupFailureIdentity): ResourceSetupFailure | undefined {
    try {
        // 86 is runtime_policy.ISOLATION_EXIT_CODE. A missing/crashed runner is
        // unknown even if stale evidence contains the desired operation string.
        if (expected.exitCode !== 86 || !expected.targetRunId || !hash(expected.sourceHash)
            || !hash(expected.testHash) || !hash(expected.importFixturePlanId)
            || digest(expected.sourceFile) !== expected.sourceHash || digest(expected.testFile) !== expected.testHash) { return undefined; }
        const size = fs.statSync(expected.isolationFile).size;
        if (size <= 0 || size > 131072) { return undefined; }
        const lines = fs.readFileSync(expected.isolationFile, 'utf8').trim().split(/\r?\n/);
        if (lines.length !== 2) { return undefined; }
        const [started, completed]: unknown[] = lines.map(line => JSON.parse(line));
        if (!object(started) || !object(completed) || started.event !== 'started' || completed.event !== 'completed'
            || typeof started.runId !== 'string' || !/^[a-f0-9]{32}$/.test(started.runId) || completed.runId !== started.runId
            || completed.status !== 'isolation-blocked' || completed.operation !== 'resource-schema-required'
            || [started, completed].some(event => event.policyVersion !== 'python-execution-policy-v1'
                || event.targetRunId !== expected.targetRunId || event.sourceHash !== expected.sourceHash
                || event.testHash !== expected.testHash)) { return undefined; }
        const fixtures = completed.importFixtures, resources = fixtures?.resources;
        if (!object(fixtures) || fixtures.id !== expected.importFixturePlanId || !object(resources)
            || resources.planId !== expected.importFixturePlanId || resources.scope !== 'fresh-process'
            || !Number.isSafeInteger(resources.resourceCount) || resources.resourceCount <= 0) { return undefined; }
        return { category: 'environment', stage: 'resource-setup', reasonCode: 'resource-schema-required',
            targetRunId: expected.targetRunId, sourceHash: expected.sourceHash, testHash: expected.testHash,
            importFixturePlanId: expected.importFixturePlanId };
    } catch { return undefined; }
}
