import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { preflightTargetModule } from '../pipeline/modulePreflight';
import { planTraceStartupBudget, traceTimingPreferences } from '../pipeline/traceStartupBudget';

test('configured Trace time increases execution allowances while preserving cleanup and the target deadline', () => {
    const defaults = traceTimingPreferences(undefined, undefined, undefined);
    assert.deepEqual(defaults, { totalTimeoutSeconds: 60, planningTimeoutSeconds: 15, caseTimeoutSeconds: 5 });
    const timing = planTraceStartupBudget(1000, 200000, defaults);
    assert.equal(timing.outerTimeoutMs, 60000);
    assert.equal(timing.planningTimeoutSeconds, 15);
    assert.equal(timing.caseTimeoutSeconds, 5);
    assert.equal(timing.totalTimeoutSeconds, 58);
    const later = planTraceStartupBudget(1000, 4000, defaults);
    assert.equal(later.outerTimeoutMs, 4000);
    assert.equal(later.totalTimeoutSeconds, 3.6);
    assert.ok(later.caseTimeoutSeconds <= later.totalTimeoutSeconds);
    assert.equal(planTraceStartupBudget(0, 400000, traceTimingPreferences(300, 40, 30)).outerTimeoutMs, 300000);
    for (const invalid of [0, -1, 301, NaN, Infinity, true, '120', 1.5]) {
        assert.equal(traceTimingPreferences(invalid, invalid, invalid).totalTimeoutSeconds, 60);
    }
});

test('unknown preflight keeps the prior Trace allowances without inventing startup evidence', () => {
    for (const unknown of [undefined, null, false, '5000', -1, NaN, Infinity, {}]) {
        assert.deepEqual(planTraceStartupBudget(unknown, 100_000), {
            version: 'trace-startup-budget-v1', calibrationReason: 'preflight-unavailable',
            planningTimeoutSeconds: 5, totalTimeoutSeconds: 12, caseTimeoutSeconds: 2, outerTimeoutMs: 20_000
        });
    }
});

test('successful slow preflight preallocates planning and another fresh import before the first case', () => {
    const timing = planTraceStartupBudget(6000, 100_000);
    assert.equal(timing.calibrationReason, 'successful-module-preflight');
    assert.equal(timing.observedPreflightElapsedMs, 6000);
    assert.equal(timing.planningTimeoutSeconds, 13);
    assert.equal(timing.totalTimeoutSeconds, 21);
    assert.equal(timing.outerTimeoutMs, 23_000);
    assert.equal(timing.caseTimeoutSeconds, 2);
    assert.ok(timing.totalTimeoutSeconds >= timing.planningTimeoutSeconds + 6 + timing.caseTimeoutSeconds);
});

test('large measured startup cannot allocate beyond the outer cap or the unchanged caller deadline', () => {
    for (const remaining of [100_000, 30_000, 12_000, 2_000, 0.25]) {
        const timing = planTraceStartupBudget(100_000, remaining);
        assert.ok(timing.outerTimeoutMs <= Math.min(60_000, remaining));
        assert.ok(timing.totalTimeoutSeconds * 1000 < timing.outerTimeoutMs);
        assert.ok(timing.planningTimeoutSeconds <= timing.totalTimeoutSeconds);
        assert.ok(timing.totalTimeoutSeconds <= 60);
        assert.equal(timing.caseTimeoutSeconds, 2);
    }
});

test('repeated planning uses diminishing time remaining and cannot renew a fixed target deadline', () => {
    const deadline = 20_000;
    const first = planTraceStartupBudget(6000, deadline - 0);
    const later = planTraceStartupBudget(6000, deadline - 15_000);
    assert.equal(first.outerTimeoutMs, 20_000);
    assert.equal(later.outerTimeoutMs, 5000);
    assert.equal(later.totalTimeoutSeconds, 4.5);
    for (const exhausted of [0, -1, NaN, Infinity]) {
        assert.throws(() => planTraceStartupBudget(6000, exhausted), /original deadline/);
    }
});

test('successful preflight measures its own worker lifetime rather than trusting a supplied elapsedMs', async () => {
    const prefix = path.join(os.tmpdir(), 'trace-startup-preflight-');
    const directory = fs.mkdtempSync(prefix);
    const file = path.join(directory, 'sample.py'), source = 'def target(): return 1\n';
    fs.writeFileSync(file, source);
    const runner = require('../utils/processRunner'), originalSpawn = runner.runSpawn;
    const wire = { ok: true, module: 'sample', importPaths: [directory], elapsedMs: 999_999,
        sourceVersionsVersion: 'loaded-project-sources-v1',
        sourceVersions: [{ file, hash: createHash('sha256').update(source).digest('hex') }] };
    runner.runSpawn = async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        return { code: 0, stdout: JSON.stringify(wire), stderr: '' };
    };
    try {
        const result = await preflightTargetModule('python', file, 'sample', [directory], directory);
        assert.equal(result.ok, true);
        assert.ok(result.elapsedMs >= 15);
        assert.notEqual(result.elapsedMs, wire.elapsedMs);
        assert.equal(planTraceStartupBudget(result.elapsedMs, 60_000).calibrationReason, 'successful-module-preflight');
    } finally {
        runner.runSpawn = originalSpawn;
        assert.ok(directory.startsWith(prefix));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
