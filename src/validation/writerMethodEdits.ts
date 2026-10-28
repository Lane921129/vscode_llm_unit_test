import { createHash } from 'node:crypto';
import { runSpawn } from '../utils/processRunner';
import { pythonToolPath } from '../pipeline/pythonTools';
import { extractPythonTestCode } from './generatedTestValidator';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { currentExecution } from '../pipeline/executionContext';

const PLAN = 'writer-method-edit-plan-v1';
const RESULT = 'writer-method-edit-result-v1';
const LIMIT = 1024 * 1024;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export interface WriterMethodEdit {
    id: string; className: string; name: string; line: number; endLine: number;
    startByte: number; endByte: number; code: string;
}
export interface WriterMethodEditPlan {
    schemaVersion: typeof PLAN; ok: true; baselineHash: string; planHash: string; methods: WriterMethodEdit[];
}
type RejectedEdit = { ok: false; reasonCode: string };
const invalid = (): never => { throw new AnalysisStageError('validation', 'writer-method-edit-tool',
    'The source-bound method edit tool could not complete.', { reasonCode: 'method-edit-tool-invalid' }); };

function validPlan(value: any, baseline: string, lineRefs: readonly number[]): value is WriterMethodEditPlan {
    const bytes = Buffer.from(baseline, 'utf8');
    if (value?.schemaVersion !== PLAN || value.ok !== true || value.baselineHash !== hash(baseline)
        || !Array.isArray(value.methods) || !value.methods.length || value.methods.length > 32) { return false; }
    let end = 0;
    const ids = new Set<string>();
    for (const method of value.methods) {
        if (!method || typeof method.className !== 'string' || typeof method.name !== 'string'
            || method.id !== `${method.className}.${method.name}` || ids.has(method.id)
            || !Number.isSafeInteger(method.startByte) || !Number.isSafeInteger(method.endByte)
            || method.startByte < end || method.endByte <= method.startByte || method.endByte > bytes.length
            || !Number.isSafeInteger(method.line) || !Number.isSafeInteger(method.endLine)
            || method.line < 1 || method.endLine < method.line || typeof method.code !== 'string'
            || bytes.subarray(method.startByte, method.endByte).toString('utf8') !== method.code
            || !lineRefs.some(line => method.line <= line && line <= method.endLine)) { return false; }
        ids.add(method.id); end = method.endByte;
    }
    return lineRefs.every(line => value.methods.some((method: WriterMethodEdit) => method.line <= line && line <= method.endLine))
        && value.planHash === hash(PLAN + '\0' + value.baselineHash + '\0' + value.methods.map((method: WriterMethodEdit) => method.id).join('\0'));
}

async function invoke(python: string, env: NodeJS.ProcessEnv | undefined, input: object, schema: string): Promise<any> {
    // Transport/timeout/cancellation failures remain tool failures, never model syntax.
    let run: Awaited<ReturnType<typeof runSpawn>>;
    try {
        run = await runSpawn(python, ['-B', pythonToolPath('methodEdit')], { input: JSON.stringify(input), env, timeout: 5000 });
    } catch (error) {
        currentExecution()?.throwIfCancelled();
        if (error instanceof AnalysisStageError || (error instanceof Error && error.name === 'AbortError')) { throw error; }
        return invalid();
    }
    if (run.code !== 0 || run.stdout.length > 8 * LIMIT) { return invalid(); }
    let result: any;
    try { result = JSON.parse(run.stdout); } catch { return invalid(); }
    if (result?.schemaVersion !== schema || typeof result.ok !== 'boolean'
        || result.ok === false && (typeof result.reasonCode !== 'string' || !/^[a-z][a-z-]{1,79}$/.test(result.reasonCode))) { return invalid(); }
    return result;
}

/** AST navigation only. The caller supplies current, validated finding lines. */
export async function planWriterMethodEdits(options: {
    baseline: string; lineRefs: readonly number[]; python: string; env?: NodeJS.ProcessEnv;
}): Promise<WriterMethodEditPlan | RejectedEdit> {
    if (Buffer.byteLength(options.baseline, 'utf8') > LIMIT || !options.lineRefs.length || options.lineRefs.length > 32
        || options.lineRefs.some(line => !Number.isSafeInteger(line) || line < 1)) { return { ok: false, reasonCode: 'invalid-edit-lines' }; }
    const value = await invoke(options.python, options.env, { mode: 'plan', baseline: options.baseline, lineRefs: options.lineRefs }, PLAN);
    if (value.ok === false) { return { ok: false, reasonCode: value.reasonCode }; }
    return validPlan(value, options.baseline, options.lineRefs) ? value : invalid();
}

/** Only a fresh Checker DTO can select a binding repair; prose never selects its owner. */
export async function planWriterNameBindingEdits(options: {
    baseline: string; validation: { reasonCode?: string; name?: string; method?: string; className?: string; line?: number };
    python: string; env?: NodeJS.ProcessEnv;
}): Promise<WriterMethodEditPlan | RejectedEdit> {
    const finding = options.validation;
    if (finding.reasonCode !== 'writer-undefined-name' || typeof finding.name !== 'string'
        || !/^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(finding.name) || !finding.method || !finding.className
        || !Number.isSafeInteger(finding.line) || finding.line! < 1) {
        return { ok: false, reasonCode: 'binding-edit-location-unresolved' };
    }
    const plan = await planWriterMethodEdits({ ...options, lineRefs: [finding.line!] });
    if (!plan.ok) { return plan; }
    if (plan.methods.length !== 1 || plan.methods[0].className !== finding.className
        || plan.methods[0].name !== finding.method) {
        return { ok: false, reasonCode: 'binding-edit-owner-mismatch' };
    }
    return plan;
}

/** Node independently recomposes the exact UTF-8 spans certified by the AST plan. */
export async function applyWriterMethodEdits(options: {
    baseline: string; lineRefs: readonly number[]; plan: WriterMethodEditPlan; response: string;
    python: string; env?: NodeJS.ProcessEnv;
}): Promise<{ ok: true; code: string; changedMethodIds: string[] } | RejectedEdit> {
    if (!validPlan(options.plan, options.baseline, options.lineRefs)) { return invalid(); }
    const replacement = extractPythonTestCode(options.response, 'addition');
    if (Buffer.byteLength(replacement, 'utf8') > LIMIT) { return { ok: false, reasonCode: 'edit-input-limit' }; }
    const value = await invoke(options.python, options.env, { mode: 'apply', baseline: options.baseline, lineRefs: options.lineRefs,
        baselineHash: options.plan.baselineHash, planHash: options.plan.planHash, replacement }, RESULT);
    if (value.ok === false) { return { ok: false, reasonCode: value.reasonCode }; }
    if (value.baselineHash !== options.plan.baselineHash || value.planHash !== options.plan.planHash
        || typeof value.mergedCode !== 'string' || Buffer.byteLength(value.mergedCode, 'utf8') > LIMIT
        || value.mergedHash !== hash(value.mergedCode) || !Array.isArray(value.edits)
        || value.edits.length !== options.plan.methods.length || !Array.isArray(value.changedMethodIds)
        || !value.changedMethodIds.length || new Set(value.changedMethodIds).size !== value.changedMethodIds.length
        || value.changedMethodIds.some((id: unknown) => !options.plan.methods.some(method => method.id === id))) { return invalid(); }
    let bytes = Buffer.from(options.baseline, 'utf8');
    for (let index = value.edits.length - 1; index >= 0; index--) {
        const edit = value.edits[index], method = options.plan.methods[index];
        if (!edit || edit.id !== method.id || edit.startByte !== method.startByte || edit.endByte !== method.endByte
            || typeof edit.replacement !== 'string') { return invalid(); }
        bytes = Buffer.concat([bytes.subarray(0, method.startByte), Buffer.from(edit.replacement, 'utf8'), bytes.subarray(method.endByte)]);
    }
    if (bytes.toString('utf8') !== value.mergedCode || !Buffer.from(value.mergedCode, 'utf8').equals(bytes)) { return invalid(); }
    return { ok: true, code: value.mergedCode, changedMethodIds: value.changedMethodIds };
}
