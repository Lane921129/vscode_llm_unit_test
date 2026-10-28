import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { pythonToolPath } from '../pipeline/pythonTools';
import { buildWriterRevisionContext } from '../prompts/compactWriterContext';
import { formatDependencyMockContract } from '../prompts/dependencyMockContract';
import { getUserPrompt } from '../roles/unittestWriter';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));

/** Real extractor output, not model-authored setup metadata. */
function extracted(source: string): any {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-call-setup-'));
    try {
        const file = path.join(directory, 'sample.py');
        fs.writeFileSync(file, source);
        const result = spawnSync(python, ['-B', pythonToolPath('ast'), file, 'target'], {
            encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(result.status, 0, result.stderr);
        const context = JSON.parse(result.stdout);
        assert.ok(context.code, result.stdout);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
        return context;
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function prompts(context: any): string[] {
    const sourceHash = context.source_setup_call_contract.targetSourceHash;
    const evidence: WriterEvidenceBundleV3 = { schemaVersion: 'writer-evidence-v3', sourceHash, semanticGuidance: '',
        ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash, ids: [], selectedRules: [],
            guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
        evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance'] };
    return [...(['small', 'large'] as const).map(strategy =>
        getUserPrompt('sample.py', 'target', context.code, strategy, context, undefined, 2000, '', evidence)),
    buildWriterRevisionContext({ module: 'sample', name: 'target', source: context.code, context, evidence })];
}

test('AST optional owner and source-location facts remain required in both Writer sizes and revision', () => {
    const context = extracted('import sys as runtime\nfrom pathlib import Path\ndef target():\n'
        + '    if getattr(runtime, "packaged", False):\n        return Path(runtime.executable).resolve().parent\n'
        + '    return Path(__file__).resolve().parent\n');
    for (const prompt of prompts(context)) {
        assert.match(prompt, /SOURCE CALL SETUP \(AST-normalized spellings; read the complete source above; no output oracle or patch permission\)/);
        assert.match(prompt, /patch\.object\(sample\.runtime, "packaged", controlled_value, create=True\)/);
        assert.match(prompt, /Preserve the source default case and restore attribute existence\/value/);
        assert.match(prompt, /The source __file__ is sample\.__file__, never the generated test __file__/);
        assert.match(prompt, /do not call test-side resolve\(\) or invent os\.path operations/);
        assert.ok(prompt.includes(context.code));
        assert.match(prompt, /"assertionOracle":false,"patchAuthorization":false/);
        assert.doesNotMatch(prompt, /patch\.object\(sample, "packaged"/);
    }
});

test('AST dependency arguments retain the actual global binding after its source conversion', () => {
    const context = extracted('import sqlite3 as store\nfrom pathlib import Path\nRESOURCE = Path("neutral.db")\n'
        + 'RESOURCE_NAME = str(RESOURCE)\ndef target():\n    return store.connect(RESOURCE_NAME)\n');
    for (const prompt of prompts(context)) {
        assert.match(prompt, /"callee":"store\.connect","args":\[\{"source":"RESOURCE_NAME","scope":"module-global"\}\]/);
        assert.match(prompt, /Read each module-global spelling from sample\.<source spelling>/);
        assert.match(prompt, /do not replace it with its upstream input or imported origin/);
        assert.ok(prompt.includes('RESOURCE_NAME = str(RESOURCE)'));
        assert.match(prompt, /These call spellings do not choose expected target outputs/);
    }
});

test('module-initialized objects stay at the target lookup rather than a same-named test local', () => {
    const context = extracted('from provider import Sink, build_resource\nRESOURCE = build_resource()\nSINK = Sink()\n'
        + 'def target():\n    SINK.publish(resource=RESOURCE)\n');
    for (const prompt of prompts(context)) {
        assert.match(prompt, /A test-local assignment does not rebind a module global used by the real target/);
        assert.match(prompt, /Do not replay a module initializer to construct a second object/);
        assert.match(prompt, /Call setup SINK\.publish: resource: sample\.RESOURCE/);
        assert.match(prompt, /An assertIsNone alone does not verify those effects/);
        assert.match(prompt, /not authorize patching the target or inventing fixture values, runtime call counts or expected outputs/);
    }
});

test('stale, malformed and unsupported setup facts never render a partial concrete contract', () => {
    const context = extracted('import runtime\ndef target():\n    return getattr(runtime, "enabled", False)\n');
    const original = context.source_setup_call_contract;
    const invalid = [
        { ...original, targetSourceHash: '0'.repeat(64) },
        { ...original, target: 'other' },
        { ...original, status: 'unsupported' },
        { ...original, assertionOracle: true },
        { ...original, patchAuthorization: true },
        { ...original, optionalLookups: [{ ...original.optionalLookups[0], ownerScope: 'parameter' }] },
        { ...original, calls: [{ callee: 'runtime.open', args: [{ source: 'name', scope: 'invented' }], keywords: [], line: 3 }] },
        { ...original, optionalLookups: Array(65).fill(original.optionalLookups[0]) },
        { ...original, optionalLookups: [{ ...original.optionalLookups[0], defaultSource: 'x'.repeat(17000) }] }
    ];
    for (const facts of invalid) {
        const contract = formatDependencyMockContract('sample', { ...context, source_setup_call_contract: facts });
        assert.doesNotMatch(contract, /SOURCE CALL SETUP|patch\.object\(sample\.runtime/);
        assert.match(contract, /source setup only, never an output oracle/);
    }
});

test('return-flow metadata does not grant concrete global setup for pure functions or shadowed owners', () => {
    const pure = extracted('def target(value):\n    return value + 1\n');
    const pureContract = formatDependencyMockContract('sample', pure);
    assert.match(pureContract, /"returnFlow":\{"kind":"contains-value-return","discardedCalls":\[\]\}/);
    assert.doesNotMatch(pureContract, /Optional source lookup|Call setup |A test-local assignment|patch\.object\(sample/);
    const shadowed = extracted('import runtime\ndef target(runtime):\n    return getattr(runtime, "enabled", False)\n');
    assert.equal(shadowed.source_setup_call_contract.optionalLookups.length, 0);
    assert.doesNotMatch(formatDependencyMockContract('sample', shadowed), /Optional source lookup|Call setup |A test-local assignment|patch\.object\(sample\.runtime/);
});
