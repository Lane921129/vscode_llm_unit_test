import * as fs from 'node:fs';
import * as path from 'node:path';
import { evidenceHash } from './analysisJournal';
import { containsCredential, redactCredentialStrings } from './artifactSafety';
import { IMPORT_FIXTURE_ENV, importFixtureEnvironment } from './importFixtures';
import { QualityExperimentInput, QualityExperimentContext } from './qualityExperiments';
import { validTraceValueSnapshot } from './traceValues';
import { TraceValueSnapshot } from './evidenceContracts';
import { pythonToolPath } from './pythonTools';
import { canonicalExistingPath, existingRealPath } from '../utils/fileIdentity';
import { runSpawn } from '../utils/processRunner';
import { AnalysisStageError } from '../utils/executionFailureCategory';

type Recipe = { kind: 'literal'; value: TraceValueSnapshot }
    | { kind: 'namespace'; attributes: Record<string, Recipe>; faults?: Record<string, string> }
    | { kind: 'callable'; mode: 'mock' | 'factory'; parameters?: string[]; returns: Recipe }
    | { kind: 'callable'; mode: 'identity'; parameters: string[]; argument: string };
interface FixtureInputs { args: Recipe[]; kwargs: Record<string, Recipe> }
interface FixtureEvidence {
    schemaVersion: 'parameter-fixture-evidence-v1'; sourceHash: string; target: string; seedHash: string;
    gapId: string; fingerprint: string; inputs: FixtureInputs; context: QualityExperimentContext;
    variation: { parameter: string; path: string[]; operation: 'remove' | 'false' | 'raise'; exception: string | null };
    assertionOracle: false; isolation: 'fresh-process-per-case';
    execution: { targetEntered: true; profileIntact: true };
    outcome: { status: 'returned'; result: TraceValueSnapshot }
        | { status: 'raised'; exception: string; exceptionArgs: TraceValueSnapshot };
}
export interface ParameterFixtureResult {
    schemaVersion: 'parameter-fixture-result-v1'; status: 'observed' | 'unsupported' | 'duplicate' | 'unavailable';
    sourceHash: string; target: string; seedHash: string; gapId: string; context?: QualityExperimentContext;
    assertionOracle: false; reason?: string;
    experiments: Array<{ fingerprint: string; status: 'observed' | 'unavailable'; reason?: string;
        evidence?: FixtureEvidence; evidenceHash?: string }>;
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join('|') === expected.slice().sort().join('|');
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const name = (v: unknown): v is string => typeof v === 'string' && /^[\p{ID_Start}][\p{ID_Continue}]*$/u.test(v) && !v.startsWith('_');
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(v);
const faultTypes = ['Exception', 'ValueError', 'TypeError', 'RuntimeError', 'KeyError', 'AttributeError'];
const reason = (v: unknown) => v === undefined || typeof v === 'string' && /^[a-z][a-z0-9-]{0,179}$/.test(v);
function invalid(): never { throw new AnalysisStageError('validation', 'parameter-fixture-experiment', 'Invalid parameter fixture experiment evidence.'); }
/** Python canonical JSON used only for byte identity, never semantic generation. */
function canonical(v: any): string {
    if (Array.isArray(v)) { return `[${v.map(canonical).join(',')}]`; }
    if (object(v)) { return `{${Object.keys(v).sort().map(k => `${canonical(k)}:${canonical(v[k])}`).join(',')}}`; }
    return JSON.stringify(v).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
const safe = (v: unknown, secrets: readonly string[] = []) => !containsCredential(JSON.stringify(v), secrets)
    && canonical(v) === canonical(redactCredentialStrings(v, secrets));
function snapshot(v: unknown): v is TraceValueSnapshot {
    if (!validTraceValueSnapshot(v) || !v.replayable
        || !keys(v as unknown as Record<string, unknown>, ['schema_version', 'replayable', 'value'])) { return false; }
    const exactValue = (node: any): boolean => ['dict', 'list', 'tuple', 'set', 'frozenset'].includes(node.type)
        ? keys(node, ['type', 'items']) && node.items.every((item: any) => node.type === 'dict'
            ? keys(item, ['key', 'value']) && exactValue(item.key) && exactValue(item.value) : exactValue(item))
        : keys(node, node.type === 'none' ? ['type'] : ['type', 'value']);
    return exactValue(v.value);
}
function recipes(inputs: unknown): inputs is FixtureInputs {
    let count = 0;
    const visit = (v: unknown, depth = 0): boolean => {
        if (++count > 128 || depth > 6 || !object(v)) { return false; }
        if (v.kind === 'literal') { return keys(v, ['kind', 'value']) && snapshot(v.value); }
        if (v.kind === 'namespace') {
            return keys(v, ['kind', 'attributes', ...(v.faults === undefined ? [] : ['faults'])])
                && object(v.attributes) && Object.keys(v.attributes).length <= 8
                && Object.entries(v.attributes).every(([k, value]) => name(k) && visit(value, depth + 1))
                && (v.faults === undefined || object(v.faults) && Object.keys(v.faults).length <= 8
                    && Object.entries(v.faults).every(([k, value]) => name(k) && typeof value === 'string' && faultTypes.includes(value)));
        }
        if (v.kind === 'callable' && v.mode === 'identity') {
            return keys(v, ['kind', 'mode', 'parameters', 'argument']) && Array.isArray(v.parameters) && v.parameters.length <= 6
                && v.parameters.every(identifier) && new Set(v.parameters).size === v.parameters.length
                && identifier(v.argument) && v.parameters.includes(v.argument);
        }
        return v.kind === 'callable' && ['mock', 'factory'].includes(v.mode)
            && keys(v, ['kind', 'mode', 'returns', ...(v.mode === 'factory' ? ['parameters'] : [])])
            && (v.mode !== 'factory' || Array.isArray(v.parameters) && v.parameters.length <= 6
                && v.parameters.every(identifier) && new Set(v.parameters).size === v.parameters.length)
            && visit(v.returns, depth + 1);
    };
    return object(inputs) && keys(inputs, ['args', 'kwargs']) && Array.isArray(inputs.args) && inputs.args.length <= 6
        && inputs.args.every(v => visit(v)) && object(inputs.kwargs) && Object.keys(inputs.kwargs).length <= 6
        && Object.entries(inputs.kwargs).every(([k, v]) => identifier(k) && visit(v));
}

export function validateParameterFixtureResult(value: unknown): asserts value is ParameterFixtureResult {
    if (!object(value) || !keys(value, ['schemaVersion', 'status', 'sourceHash', 'target', 'seedHash', 'gapId', 'experiments',
        'assertionOracle', ...(value.context === undefined ? [] : ['context']), ...(value.reason === undefined ? [] : ['reason'])])
        || value.schemaVersion !== 'parameter-fixture-result-v1' || !['observed', 'unsupported', 'duplicate', 'unavailable'].includes(value.status)
        || !hash(value.sourceHash) || !hash(value.seedHash) || !identifier(value.target) || typeof value.gapId !== 'string' || value.gapId.length > 512
        || value.assertionOracle !== false || !reason(value.reason) || !Array.isArray(value.experiments) || value.experiments.length > 4) { invalid(); }
    const context = value.context;
    if (context !== undefined && (!object(context) || !keys(context, ['sourceRoot', 'sourcePath', 'module', 'importFixturePlanHash'])
        || typeof context.sourceRoot !== 'string' || typeof context.sourcePath !== 'string' || typeof context.module !== 'string'
        || !context.module.split('.').every(identifier) || !hash(context.importFixturePlanHash))) { invalid(); }
    const seen = new Set<string>();
    for (const item of value.experiments) {
        if (!object(item) || !hash(item.fingerprint) || seen.has(item.fingerprint) || !reason(item.reason)
            || !['observed', 'unavailable'].includes(item.status) || !keys(item, item.status === 'observed'
                ? ['fingerprint', 'status', 'evidence', 'evidenceHash'] : ['fingerprint', 'status', ...(item.reason === undefined ? [] : ['reason'])])) { invalid(); }
        seen.add(item.fingerprint);
        if (item.status !== 'observed') { continue; }
        const e = item.evidence;
        if (!object(e) || !keys(e, ['schemaVersion', 'sourceHash', 'target', 'seedHash', 'gapId', 'fingerprint', 'inputs',
            'context', 'variation', 'assertionOracle', 'isolation', 'outcome', 'execution']) || e.schemaVersion !== 'parameter-fixture-evidence-v1'
            || e.sourceHash !== value.sourceHash || e.target !== value.target || e.seedHash !== value.seedHash || e.gapId !== value.gapId
            || e.fingerprint !== item.fingerprint || !context || canonical(e.context) !== canonical(context)
            || e.assertionOracle !== false || e.isolation !== 'fresh-process-per-case' || !recipes(e.inputs)
            || !object(e.execution) || !keys(e.execution, ['targetEntered', 'profileIntact'])
            || e.execution.targetEntered !== true || e.execution.profileIntact !== true
            || !object(e.variation) || !keys(e.variation, ['parameter', 'path', 'operation', 'exception']) || !identifier(e.variation.parameter)
            || !Array.isArray(e.variation.path) || e.variation.path.length < 1 || e.variation.path.length > 4
            || !e.variation.path.every((part: unknown) => part === '$return' || name(part))
            || !['remove', 'false', 'raise'].includes(e.variation.operation)
            || (e.variation.operation === 'raise' ? !faultTypes.includes(e.variation.exception) : e.variation.exception !== null)) { invalid(); }
        const outcome = e.outcome;
        if (!object(outcome) || (outcome.status === 'returned'
            ? !keys(outcome, ['status', 'result']) || !snapshot(outcome.result)
            : outcome.status !== 'raised' || !keys(outcome, ['status', 'exception', 'exceptionArgs'])
                || !faultTypes.includes(outcome.exception) || !snapshot(outcome.exceptionArgs) || outcome.exceptionArgs.value.type !== 'tuple')) { invalid(); }
        const fingerprint = evidenceHash(canonical({ schemaVersion: 'parameter-fixture-experiment-v1', sourceHash: e.sourceHash,
            target: e.target, inputs: e.inputs, context: e.context }));
        if (fingerprint !== item.fingerprint || item.evidenceHash !== evidenceHash(canonical(e))) { invalid(); }
    }
    if (value.experiments.some((item: any) => item.status === 'observed') !== (value.status === 'observed')) { invalid(); }
}

export async function prepareParameterFixtureExperiments(input: QualityExperimentInput): Promise<ParameterFixtureResult> {
    const env = importFixtureEnvironment(input.env ?? process.env);
    const run = await runSpawn(input.python, ['-B', pythonToolPath('parameterFixtureExperiments')], {
        input: JSON.stringify({ source: input.source, sourcePath: input.sourcePath, target: input.target, module: input.module,
            testCode: input.testCode, sourceHash: evidenceHash(input.source), focus: input.focus, triedFingerprints: input.triedFingerprints }),
        timeout: Math.min(input.timeoutMs ?? 20000, 20000), env: { ...env, PYTHONIOENCODING: 'utf-8' }
    });
    if (run.code !== 0 || !safe(run.stdout, input.knownSecrets)) { invalid(); }
    let result: unknown;
    try { result = JSON.parse(run.stdout); } catch { invalid(); }
    if (!safe(result, input.knownSecrets)) { invalid(); }
    validateParameterFixtureResult(result);
    if (result.sourceHash !== evidenceHash(input.source) || result.seedHash !== evidenceHash(input.testCode)
        || result.target !== input.target || result.gapId !== input.focus.id) { invalid(); }
    if (result.context) {
        const sourcePath = existingRealPath(input.sourcePath);
        let root = path.dirname(sourcePath);
        while (fs.existsSync(path.join(root, '__init__.py'))) { root = path.dirname(root); }
        if (canonicalExistingPath(result.context.sourceRoot) !== canonicalExistingPath(root)
            || canonicalExistingPath(result.context.sourcePath) !== canonicalExistingPath(sourcePath)
            || result.context.module !== input.module || result.context.importFixturePlanHash !== evidenceHash(env[IMPORT_FIXTURE_ENV] ?? '')) { invalid(); }
    }
    return result;
}

/** Complete cases only. Recipes are setup descriptions, never Python test code. */
export function parameterFixturePrompt(result: ParameterFixtureResult, maxChars = 8000, secrets: readonly string[] = [],
    onProjected?: (fingerprint: string) => void): string {
    validateParameterFixtureResult(result);
    if (!Number.isSafeInteger(maxChars) || maxChars < 0) { invalid(); }
    const included: unknown[] = [];
    const render = () => 'PARAMETER_FIXTURE_OBSERVATIONS_V1\n'
        + 'Each case was executed in a fresh process with the exact test-owned fixture recipe. namespace means attribute objects, '
        + 'factory means a fresh fixed return per call, mock means Mock(return_value=...). faults means an attribute read raises '
        + 'the named exception; identity means return the named supplied argument itself, preserving its identity. '
        + 'Fault exceptions are built-in classes with no arguments; missing attributes remain absent. Literal values use trace-value-v1. '
        + 'Write ONE new unittest for the FIRST included case; preserve passing tests. Reproduce its full setup and observed outcome. '
        + 'These observations describe implementation behavior, not independent requirements. No case is a test or quality approval.\n'
        + JSON.stringify({ sourceHash: result.sourceHash, target: result.target, gapId: result.gapId, context: result.context,
            assertionOracle: false, experiments: included });
    if (!safe(result, secrets)) { return ''; }
    for (const item of result.experiments.filter(item => item.status === 'observed')) {
        included.push({ fingerprint: item.fingerprint, inputs: item.evidence!.inputs, variation: item.evidence!.variation,
            outcome: item.evidence!.outcome });
        if (render().length > maxChars) { included.pop(); }
        else { onProjected?.(item.fingerprint); break; }
    }
    return included.length ? render() : '';
}

/** Attempted and actually handed-off observations are separate run-local facts. */
export class ParameterFixtureSession {
    private readonly attempts = new Set<string>();
    private readonly presented = new Set<string>();
    private readonly observations: ParameterFixtureResult[] = [];
    get triedFingerprints(): readonly string[] { return [...this.attempts]; }
    record(result: ParameterFixtureResult): void {
        validateParameterFixtureResult(result);
        result.experiments.forEach(item => this.attempts.add(item.fingerprint));
        if (result.status === 'observed') {
            this.observations.push(structuredClone(result));
            while (this.observations.length > 8 || JSON.stringify(this.observations).length > 1000000) { this.observations.shift(); }
        }
    }
    prompt(result: ParameterFixtureResult, maxChars: number, secrets: readonly string[]): string {
        validateParameterFixtureResult(result);
        if (!result.context) { return ''; }
        const available = this.observations.filter(item => item.sourceHash === result.sourceHash && item.target === result.target
            && canonical(item.context) === canonical(result.context));
        available.sort((a, b) => Number(b.gapId === result.gapId) - Number(a.gapId === result.gapId));
        for (const item of available) {
            const next = structuredClone(item);
            next.experiments = next.experiments.filter(e => e.status === 'observed' && !this.presented.has(e.fingerprint));
            if (!next.experiments.length) { continue; }
            const prompt = parameterFixturePrompt(next, maxChars, secrets, fingerprint => this.presented.add(fingerprint));
            if (prompt) { return prompt; }
        }
        return '';
    }
}
