/**
 * v2 case-table pipeline entry (llmUnitTest.pipelineVersion = "v2-case-table").
 *
 * PR #6 scope: AST facts -> Analyst-scenario rows -> per-line format correction
 * -> Python row validation -> case_table.json. Capture, tests and spec oracle
 * are added by later PRs. The orchestrator only routes here; all v2 logic lives
 * in this module and its siblings, and v1 is untouched.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAnalysisDirectory } from '../analysisOutput';
import { pythonToolPath } from '../pythonTools';
import { runSpawn } from '../../utils/processRunner';
import { AnalysisStageError, classifyExecutionFailure, ExecutionFailureCategory } from '../../utils/executionFailureCategory';
import { CASE_TABLE_VERSION, CaseRow, caseRowId, needsSetup, nextCaseRowIndex } from './caseTable';
import { RejectedCaseLine } from './caseRowParser';
import { applyCaseRowValidation, buildCaseRowValidationRequest } from './caseRowValidation';
import { CaseTableFacts, readCaseTableFacts } from './caseTableFacts';
import { writeCaseTable } from './caseTableStore';
import { RequirementEntry, parseRequirements } from './requirements';
import { CASE_SCENARIO_ROW_LIMIT, getCaseRowCorrectionPrompt, getCaseScenarioPrompt, parseCaseRows } from '../../roles/semanticAnalyzer';
import { RowStageResult, RowStageOptions, rowTestContext, runRowStage } from './runRowStage';
import { collectSpecSources, hasSpecSource } from './specSources';
import { createSpecDecider } from './oracleDecision';
import { SpecMismatchSummary, writeSpecMismatchArtifacts } from './specMismatchReport';
import { TestFocus } from '../testFocus';
import { createHash, randomUUID } from 'node:crypto';

export type PipelineVersion = 'v1' | 'v2-case-table';
export type SpecOracleSetting = 'auto' | 'off';
export type QualityAnalystSetting = 'auto' | 'off';
export const CASE_TABLE_REJECTIONS_FILE = 'case_table_rejections.json';
export const CASE_TABLE_RESULT_FILE = 'v2_result.json';

export function readPipelineVersion(value: unknown): PipelineVersion {
    return value === 'v2-case-table' ? 'v2-case-table' : 'v1';
}

export function readSpecOracleSetting(value: unknown): SpecOracleSetting {
    return value === 'off' ? 'off' : 'auto';
}

export function readQualityAnalystSetting(value: unknown): QualityAnalystSetting {
    return value === 'off' ? 'off' : 'auto';
}

/** Per-request options; only the spec oracle sets a temperature (user-approved 0.7). */
export interface ModelRequestOptions {
    temperature?: number;
    /** Transport telemetry for role_events (same RequestTelemetry objects v1 records). */
    onTiming?: (timing: object) => void;
}

/** v2 role names recorded in role_events.jsonl (v1's event format is unchanged). */
export type CaseTableRole = 'analyst-scenario' | 'analyst-scenario-correction' | 'writer-row-setup' | 'bug-fixer-row'
    | 'analyst-spec' | 'analyst-spec-correction' | 'quality-analyst';

export interface RoleAskOptions {
    role: CaseTableRole;
    temperature?: number;
}

export interface PythonToolResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

export interface CaseTablePipelineOptions {
    filePath: string;
    funcName: string;
    projectRoot: string;
    outputPath: string;
    sessionDate: string;
    projectName?: string;
    /** Existing batch directory; the target folder is reserved inside it. */
    batchDirectory?: string;
    /** Called once the target folder exists (batch journal attachment). */
    onTargetDirectory?: (directory: string) => void;
    pythonExecutable: string;
    /** Path of the requirements file, absolute or relative to projectRoot; empty means none. */
    requirementsFile?: string;
    specOracle: SpecOracleSetting;
    requestModel: (system: string, user: string, options?: ModelRequestOptions) => Promise<string>;
    log: (text: string) => void;
    /** Test seam; defaults to running an extension-owned script through runSpawn. */
    runPythonTool?: (script: string, args: string[], input?: string) => Promise<PythonToolResult>;
    /** Mutation settings shared with v1 (engine, workers, stage seconds). */
    mutation?: { engine: unknown; workers: unknown; stageSeconds: number };
    /** Run capture, tests and mutation after the case table (default true). */
    runRows?: boolean;
    /** PR #10 Quality Analyst survivor loop (default 'auto'; 'off' disables). */
    qualityAnalyst?: QualityAnalystSetting | boolean;
    /** PR #8 hook passed to the row stage. */
    decideExpected?: RowStageOptions['decideExpected'];
    /** Sidebar result card updates (updateCoverage / updateOutcome with a caseTable summary). */
    postMessage?: (message: Record<string, unknown>) => void;
    /** PR #13b: test focus (full | boundary | coverage | mutation). */
    testFocus?: TestFocus;
}

export interface CaseTableCardSummary {
    tier: 'usable' | 'failed';
    usableRows: number;
    totalRows: number;
    specMismatch: number;
    specMismatchDetails?: {
        mismatches: Array<{ id: string; input: string; expected: string; actual: string; basis: string }>;
        needsReview: Array<{ id: string; input: string; predicted: string; actual: string; basis: string }>;
    };
}

export interface RecordedRejection extends RejectedCaseLine {
    source: 'scenario' | 'correction';
    /** For scenario lines: whether the single correction produced a usable row. */
    corrected?: boolean;
}

export interface CaseTablePipelineResult {
    directory: string;
    rows: CaseRow[];
    rejected: RecordedRejection[];
    overLimit: { line: number; reason: 'row-limit' }[];
    decorated: boolean;
    modelRequests: number;
    /** Present when the row stage ran. */
    stage?: RowStageResult;
    /** Whether spec prediction ran (specOracle auto and a docstring or requirement exists). */
    specOracleUsed: boolean;
    specMismatch?: SpecMismatchSummary;
}

interface CaseTableExecutionState {
    roleEvents: { stage: string; status: string; detail: Record<string, unknown> }[];
    rows: CaseRow[];
    modelRequests: number;
    specOracleUsed: boolean;
}

/** A v2 failure must leave the same terminal/provenance artifacts the batch verifies. */
export async function runCaseTablePipeline(options: CaseTablePipelineOptions): Promise<CaseTablePipelineResult> {
    const directory = createAnalysisDirectory(options.outputPath || path.dirname(options.filePath), options.sessionDate,
        options.filePath, options.funcName, options.projectName, options.projectRoot, options.batchDirectory);
    const state: CaseTableExecutionState = { roleEvents: [], rows: [], modelRequests: 0, specOracleUsed: false };
    try {
        options.onTargetDirectory?.(directory);
        return await runCaseTableStages(options, directory, state);
    } catch (error) {
        const category = error instanceof AnalysisStageError ? error.category
            : classifyExecutionFailure(error instanceof Error ? error.message : String(error));
        const failureStage = error instanceof AnalysisStageError ? error.stage : 'case-table';
        const diagnostic = error instanceof AnalysisStageError ? error.diagnostic : undefined;
        const reason = (diagnostic as { reasonCode?: unknown } | undefined)?.reasonCode;
        const reasonCode = typeof reason === 'string' ? reason : 'v2-pipeline-error';
        const stage: RowStageResult = { terminal: 'failed', reasonCode, rows: state.rows,
            passingMethods: 0, setups: new Map() };
        const specMismatch = { specMismatchCount: state.rows.filter(row => row.oracleStatus === 'spec-mismatch').length,
            needsReviewCount: state.rows.filter(row => row.oracleStatus === 'needs-review').length, testFile: null };
        const failureTestFocus = options.testFocus ?? 'full';
        writeCaseTable(directory, { version: CASE_TABLE_VERSION, target: options.funcName, rows: state.rows, testFocus: failureTestFocus });
        writeStageResult(directory, options.funcName, state.rows, stage, state.modelRequests, state.specOracleUsed, specMismatch, failureTestFocus);
        fs.appendFileSync(path.join(directory, 'final_report.md'),
            `\n- Failure stage: ${failureStage}\n- Failure category: ${category}\n`
                + `- Failure: ${(error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ")}\n`, 'utf8');
        writeBatchRecords(directory, options.filePath, options.funcName, state.roleEvents, {
            terminal: 'failed', reasonCode, specMismatchCount: specMismatch.specMismatchCount,
            failure: { category, stage: failureStage, message: error instanceof Error ? error.message : String(error), diagnostic },
            caseTableResult: { mutationScore: null, lineCoveragePercent: null, coverageReasonCode: null,
                testPassedRows: 0, totalRows: state.rows.length, needsReviewCount: specMismatch.needsReviewCount }
        });
        postResultCard(options, directory, state.rows, stage, specMismatch.specMismatchCount);
        throw error;
    }
}

async function runCaseTableStages(options: CaseTablePipelineOptions, directory: string,
    state: CaseTableExecutionState): Promise<CaseTablePipelineResult> {
    const runTool = options.runPythonTool ?? ((script, args, input) => defaultRunPythonTool(options.pythonExecutable, script, args, input));
    const source = fs.readFileSync(options.filePath, 'utf8');
    const requirements = readRequirementsFile(options.requirementsFile, options.projectRoot);
    const facts = await extractFacts(runTool, options.filePath, options.funcName);
    options.log(`[v2] case table for ${options.funcName}: ${facts.branches.length} branch conditions, `
        + `${facts.dependencies.length} mockable dependencies, ${requirements.length} requirements.`);

    let modelRequests = 0;
    // Every request is journaled like v1: requested, transport timing (tokens, completionReason), completed/error.
    const roleEvents = state.roleEvents;
    const ask = async (system: string, user: string, request: RoleAskOptions) => {
        modelRequests += 1;
        state.modelRequests = modelRequests;
        const started = Date.now();
        roleEvents.push({ stage: 'model-request', status: 'requested', detail: { role: request.role, pipeline: 'v2-case-table' } });
        try {
            const response = await options.requestModel(system, user, {
                ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
                onTiming: timing => { roleEvents.push({ stage: 'model-request', status: 'timing', detail: { role: request.role, ...timing } }); }
            });
            roleEvents.push({ stage: 'model-request', status: 'completed', detail: { role: request.role, elapsedMs: Date.now() - started } });
            return response;
        } catch (error) {
            const reasonCode = (error as { diagnostic?: { reasonCode?: unknown } })?.diagnostic?.reasonCode;
            roleEvents.push({ stage: 'model-request', status: 'error', detail: { role: request.role, elapsedMs: Date.now() - started,
                ...(typeof reasonCode === 'string' ? { reasonCode } : {}) } });
            throw error;
        }
    };
    const testFocus: TestFocus = options.testFocus ?? 'full';
    const scenarioPrompt = getCaseScenarioPrompt(facts, requirements, { testFocus });
    const response = await ask(scenarioPrompt.system, scenarioPrompt.user, { role: 'analyst-scenario' });
    const requirementIds = requirements.map(entry => entry.id);
    const parsed = parseCaseRows(response, { origin: 'analyst', requirementIds });
    let rows = [...parsed.rows];
    if (testFocus === 'boundary') {
        const boundaryOrError = rows.filter(r => r.category === 'boundary' || r.category === 'error');
        const others = rows.filter(r => r.category !== 'boundary' && r.category !== 'error');
        rows = [...boundaryOrError, ...others].map((row, i) => ({ ...row, id: caseRowId(i + 1) }));
    }
    const rejected: RecordedRejection[] = [];
    const responseLines = response.split(/\r?\n/);
    for (const rejection of parsed.rejected) {
        const original = (responseLines[rejection.line - 1] ?? '').trim();
        // Only lines that attempted a row get the single correction; prose and full rows are just recorded.
        if (!original.startsWith('{') || rows.length >= CASE_SCENARIO_ROW_LIMIT) {
            rejected.push({ ...rejection, source: 'scenario', corrected: false });
            continue;
        }
        const correction = getCaseRowCorrectionPrompt(original, rejection.reason, rejection.field, facts, requirements);
        const corrected = parseCaseRows(await ask(correction.system, correction.user, { role: 'analyst-scenario-correction' }),
            { origin: 'analyst', requirementIds, firstIndex: nextCaseRowIndex(rows), limit: 1 });
        if (corrected.rows.length) {
            rows.push(corrected.rows[0]);
            rejected.push({ ...rejection, source: 'scenario', corrected: true });
        } else {
            rejected.push({ ...rejection, source: 'scenario', corrected: false });
            const reason = corrected.rejected[0]?.reason ?? 'invalid-json';
            rejected.push({ line: rejection.line, reason, ...(corrected.rejected[0]?.field ? { field: corrected.rejected[0].field } : {}),
                source: 'correction' });
        }
    }

    const request = buildCaseRowValidationRequest(rows, { source, target: options.funcName,
        dependencies: facts.dependencies.map(dependency => dependency.name) });
    const validated = await runTool(pythonToolPath('caseRowValidator'), [], JSON.stringify(request));
    let report: unknown;
    try { report = JSON.parse(validated.stdout); } catch {
        throw new AnalysisStageError('tool', 'case-row-validation', 'Case row validator returned malformed output.');
    }
    const outcome = (() => {
        try { return applyCaseRowValidation(rows, report); } catch (error) {
            throw new AnalysisStageError('tool', 'case-row-validation', (error as Error).message);
        }
    })();

    let finalRows = outcome.rows;
    state.rows = finalRows;
    let stage: RowStageResult | undefined;
    const validBeforeRows = outcome.rows.filter(row => row.status === 'proposed').length;
    const spec = collectSpecSources(facts, requirements);
    const specOracleUsed = options.specOracle === 'auto' && hasSpecSource(spec);
    state.specOracleUsed = specOracleUsed;
    let specMismatch: SpecMismatchSummary | undefined;
    if (options.runRows !== false && validBeforeRows > 0) {
        const runtime = { python: options.pythonExecutable, sourceFile: path.resolve(options.filePath), target: options.funcName,
            importPaths: [...new Set([path.dirname(path.resolve(options.filePath)), path.resolve(options.projectRoot)])],
            artifacts: path.join(directory, 'v2_runs') };
        const decideExpected = options.decideExpected
            ?? (specOracleUsed ? createSpecDecider({ spec, functionName: options.funcName, ask, python: options.pythonExecutable }) : undefined);
        const qualityAnalystEnabled = typeof options.qualityAnalyst === 'boolean'
            ? options.qualityAnalyst
            : readQualityAnalystSetting(options.qualityAnalyst) !== 'off';
        stage = await runRowStage({
            runtime, facts, rows: outcome.rows, ask, log: options.log,
            mutation: options.mutation ?? { engine: 'builtin', workers: 2, stageSeconds: 120 },
            qualityAnalyst: qualityAnalystEnabled,
            testFocus,
            ...(decideExpected ? { decideExpected } : {})
        });
        finalRows = stage.rows;
        state.rows = finalRows;

        if (testFocus === 'coverage' && stage && stage.terminal === 'usable' && stage.coverage?.available
            && stage.coverage.missingBranches && stage.coverage.missingBranches.length > 0
            && finalRows.length < CASE_SCENARIO_ROW_LIMIT) {
            const missingBranchLines = new Set(stage.coverage.missingBranches.map(b => parseInt(b.split('->')[0], 10)).filter(n => !isNaN(n)));
            const uncovered = facts.branches.filter(b => missingBranchLines.has(b.line));
            if (uncovered.length > 0) {
                const uncoveredStr = uncovered.map(b => `line ${b.line} (${b.condition})`).join(', ');
                const remainingLimit = CASE_SCENARIO_ROW_LIMIT - finalRows.length;
                options.log(`[v2] coverage-first: proposing supplementary scenarios for uncovered branches: ${uncoveredStr}`);
                const suppPrompt = getCaseScenarioPrompt(facts, requirements, {
                    testFocus: 'coverage',
                    uncoveredBranches: uncoveredStr,
                    rowLimit: remainingLimit
                });
                const suppResponse = await ask(suppPrompt.system, suppPrompt.user, { role: 'analyst-scenario' });
                const suppParsed = parseCaseRows(suppResponse, {
                    origin: 'analyst',
                    requirementIds,
                    firstIndex: nextCaseRowIndex(finalRows),
                    limit: remainingLimit
                });
                if (suppParsed.rows.length > 0) {
                    const suppValidationRequest = buildCaseRowValidationRequest(suppParsed.rows, {
                        source, target: options.funcName,
                        dependencies: facts.dependencies.map(dependency => dependency.name)
                    });
                    const suppValidated = await runTool(pythonToolPath('caseRowValidator'), [], JSON.stringify(suppValidationRequest));
                    let suppReport: unknown;
                    try { suppReport = JSON.parse(suppValidated.stdout); } catch { suppReport = null; }
                    if (suppReport) {
                        const suppOutcome = applyCaseRowValidation(suppParsed.rows, suppReport);
                        const validSuppRows = suppOutcome.rows.filter(r => r.status === 'proposed');
                        if (validSuppRows.length > 0) {
                            const combinedRows = [...finalRows, ...suppOutcome.rows];
                            stage = await runRowStage({
                                runtime, facts, rows: combinedRows, ask, log: options.log,
                                mutation: options.mutation ?? { engine: 'builtin', workers: 2, stageSeconds: 120 },
                                qualityAnalyst: qualityAnalystEnabled,
                                testFocus,
                                fileSuffix: '_followup',
                                initialPassing: stage.passing,
                                initialSetups: stage.setups,
                                ...(decideExpected ? { decideExpected } : {})
                            });
                            finalRows = stage.rows;
                            state.rows = finalRows;
                        } else {
                            finalRows = [...finalRows, ...suppOutcome.rows];
                            state.rows = finalRows;
                        }
                    }
                }
            }
        }
        specMismatch = writeSpecMismatchArtifacts(directory, options.funcName, finalRows, rowTestContext(runtime, facts), stage.setups);
        options.log(`[v2] spec oracle ${specOracleUsed ? 'on' : 'off'}: ${specMismatch.specMismatchCount} spec mismatches, `
            + `${specMismatch.needsReviewCount} rows need manual review.`);
    }
    writeCaseTable(directory, { version: CASE_TABLE_VERSION, target: options.funcName, rows: finalRows, testFocus });
    fs.writeFileSync(path.join(directory, CASE_TABLE_REJECTIONS_FILE), JSON.stringify({
        version: 'case-table-rejections-v1', target: options.funcName, rejected, overLimit: parsed.overLimit,
        decorated: outcome.decorated, modelRequests, specOracle: options.specOracle
    }, null, 2) + '\n', 'utf8');
    if (stage) {
        postResultCard(options, directory, finalRows, stage, specMismatch!.specMismatchCount);
        writeStageResult(directory, options.funcName, finalRows, stage, modelRequests, specOracleUsed, specMismatch!, testFocus);
        writeBatchRecords(directory, options.filePath, options.funcName, roleEvents, { terminal: stage.terminal, reasonCode: stage.reasonCode,
            specMismatchCount: specMismatch!.specMismatchCount, caseTableResult: {
                mutationScore: stage.mutation?.score ?? null, lineCoveragePercent: stage.coverage?.available ? stage.coverage.linePercent : null,
                coverageReasonCode: stage.coverage?.reasonCode ?? null, testPassedRows: finalRows.filter(row => row.status === 'test-passed').length,
                totalRows: finalRows.length, needsReviewCount: specMismatch!.needsReviewCount } });
    }
    const valid = validBeforeRows;
    options.log(`[v2] case_table.json: ${valid} valid rows, ${outcome.rows.length - valid} invalid rows, `
        + `${rejected.filter(item => item.source === 'scenario' && !item.corrected).length} rejected lines, `
        + `${parsed.overLimit.length} over the row limit.`);
    if (valid === 0) {
        writeBatchRecords(directory, options.filePath, options.funcName, roleEvents, { terminal: 'failed', reasonCode: 'no-valid-case-rows',
            specMismatchCount: 0, caseTableResult: { mutationScore: null, lineCoveragePercent: null, coverageReasonCode: null,
                testPassedRows: 0, totalRows: outcome.rows.length, needsReviewCount: 0 } });
        throw new AnalysisStageError('model-format', 'case-scenario', 'No usable case row was produced.',
            { reasonCode: 'no-valid-case-rows', directory });
    }
    return { directory, rows: finalRows, rejected, overLimit: parsed.overLimit, decorated: outcome.decorated, modelRequests,
        specOracleUsed, ...(stage ? { stage } : {}), ...(specMismatch ? { specMismatch } : {}) };
}

function postResultCard(options: CaseTablePipelineOptions, directory: string, rows: CaseRow[], stage: RowStageResult, specMismatch: number): void {
    if (!options.postMessage) { return; }
    const file = options.projectName ? path.relative(options.projectRoot, options.filePath).replace(/\\/g, '/') : path.basename(options.filePath);
    const identity = { fileName: `${file}:${options.funcName}`, file, func: options.funcName };
    const score = stage.mutation?.score;
    options.postMessage({ command: 'updateCoverage', ...identity, score: typeof score === 'number' ? `${Math.round(score * 10) / 10}%` : 'N/A',
        coverage: stage.coverage?.available ? `${stage.coverage.linePercent}%` : null });
    const mismatches = rows.filter(row => row.oracleStatus === 'spec-mismatch').map(r => ({
        id: r.id,
        input: needsSetup(r.call) ? `<needs-setup: ${r.call.needsSetup}>` : `${r.call.args} ${r.call.kwargs}`,
        expected: r.expected ? `${r.expected.kind} ${r.expected.value}` : '-',
        actual: r.actual ? `${r.actual.kind} ${r.actual.value}` : '-',
        basis: `${r.predictions?.[0]?.basis ?? '-'}${r.predictions?.length && r.predictions.every(p => p.basisVerified) ? '' : ' (unverified)'}`
    }));
    const needsReview = rows.filter(row => row.oracleStatus === 'needs-review').map(r => ({
        id: r.id,
        input: needsSetup(r.call) ? `<needs-setup: ${r.call.needsSetup}>` : `${r.call.args} ${r.call.kwargs}`,
        predicted: r.predictions?.[0] ? `${r.predictions[0].kind} ${r.predictions[0].value}` : '-',
        actual: r.actual ? `${r.actual.kind} ${r.actual.value}` : '-',
        basis: r.predictions?.[0]?.basis ?? '-'
    }));
    const caseTable: CaseTableCardSummary = { tier: stage.terminal, usableRows: rows.filter(row => row.status === 'test-passed').length,
        totalRows: rows.length, specMismatch,
        ...(mismatches.length || needsReview.length ? { specMismatchDetails: { mismatches, needsReview } } : {}) };
    options.postMessage({ command: 'updateOutcome', ...identity, reportPath: path.join(directory, 'final_report.md'),
        outcome: { label: stage.terminal === 'usable' ? 'v2 usable' : 'v2 failed', kind: stage.terminal === 'usable' ? 'executed' : 'failed' }, caseTable });
}

/** Minimal records the batch journal reads (function_knowledge, run_manifest, role_events) for a v2 target. */
interface BatchRecord {
    terminal: 'usable' | 'failed';
    reasonCode: string;
    specMismatchCount: number;
    failure?: { category: ExecutionFailureCategory; stage: string; message: string; diagnostic?: unknown };
    /** Nested so the batch tier classifier keeps treating v2 knowledge as a terminal-status-only record. */
    caseTableResult: { mutationScore: number | null; lineCoveragePercent: number | null; coverageReasonCode: string | null;
        testPassedRows: number; totalRows: number; needsReviewCount: number };
}

/** Records the batch journal and eval_aggregate read: function_knowledge, run_manifest and v1-format role_events. */
function writeBatchRecords(directory: string, file: string, target: string,
    roleEvents: { stage: string; status: string; detail: Record<string, unknown> }[], record: BatchRecord): void {
    const runId = randomUUID();
    const sourceHash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const base = { runId, sourceHash, target, validationMode: 'full', pipelineVersion: 'v2-case-table' };
    fs.writeFileSync(path.join(directory, 'run_manifest.json'), JSON.stringify(base, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(directory, 'function_knowledge.json'), JSON.stringify({ ...base, schemaVersion: 2,
        terminalStatus: record.terminal, ...(record.terminal === 'failed' ? {
            failureCategory: record.failure?.category ?? 'validation', failureStage: record.failure?.stage ?? 'case-table',
            reasonCode: record.reasonCode, ...(record.failure ? { failure: record.failure.message, diagnostic: record.failure.diagnostic } : {}) } : {}),
        specMismatchCount: record.specMismatchCount, caseTableResult: record.caseTableResult }, null, 2) + '\n', 'utf8');
    const time = new Date().toISOString();
    const events = [...roleEvents, { stage: 'v2-case-table', status: record.terminal, detail: { reasonCode: record.reasonCode } }]
        .map((event, index) => ({ sequence: index + 1, runId, sourceHash, time, loop: 1, ...event }));
    fs.writeFileSync(path.join(directory, 'role_events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');
}

function writeStageResult(directory: string, target: string, rows: CaseRow[], stage: RowStageResult, modelRequests: number,
    specOracleUsed: boolean, specMismatch: SpecMismatchSummary, testFocus: TestFocus = 'full'): void {
    const count = (status: string) => rows.filter(row => row.status === status).length;
    const run = stage.mutation?.run;
    const summary = {
        version: 'case-table-result-v1', target, terminal: stage.terminal, reasonCode: stage.reasonCode,
        testFocus,
        rows: { total: rows.length, invalid: count('invalid'), captureFailed: count('capture-failed'),
            testPassed: count('test-passed'), testFailed: count('test-failed') },
        testFile: stage.testFile ? path.relative(directory, stage.testFile).replace(/\\/g, '/') : null,
        mutation: run ? { engine: run.engine, score: stage.mutation?.score ?? null, killed: run.counts.killed,
            survived: run.counts.survived, executed: run.counts.executed } : { score: null, failure: stage.mutation?.failure ?? null },
        coverage: stage.coverage ?? null,
        specOracle: { used: specOracleUsed, specMismatchCount: specMismatch.specMismatchCount, needsReviewCount: specMismatch.needsReviewCount,
            mismatchTestFile: specMismatch.testFile ? path.basename(specMismatch.testFile) : null },
        modelRequests
    };
    fs.writeFileSync(path.join(directory, CASE_TABLE_RESULT_FILE), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    const lines = [
        `# v2 case table: ${target}`, '',
        `- Terminal: **${stage.terminal}** (${stage.reasonCode})`,
        `- Rows: ${summary.rows.total} total, ${summary.rows.testPassed} passing tests, ${summary.rows.testFailed} failing, `
            + `${summary.rows.captureFailed} capture-failed, ${summary.rows.invalid} invalid`,
        `- Mutation score: ${summary.mutation.score ?? 'unavailable'}`,
        `- Coverage: ${stage.coverage?.available ? `${stage.coverage.linePercent}% of target lines; branches ${stage.coverage.branchesCovered === null ? 'unknown'
            : stage.coverage.branchesCovered ? 'all covered' : `missing ${stage.coverage.missingBranches.join(', ')}`}`
            : `unavailable (${stage.coverage?.reasonCode ?? 'not-measured'})`}`,
        `- Spec oracle: ${specOracleUsed ? 'on' : 'off'}; spec mismatches: ${specMismatch.specMismatchCount} (see spec_mismatch.md); `
            + `needs manual review: ${specMismatch.needsReviewCount}`, '',
        '| Row | Category | Status | Expected from | Scenario |', '| --- | --- | --- | --- | --- |',
        ...rows.map(row => `| ${row.id} | ${row.category} | ${row.status}${row.reason ? ` (${row.reason})` : ''} | ${row.oracleStatus ?? '-'} | `
            + `${row.scenario.replace(/\|/g, '\\|')} |`)
    ];
    fs.writeFileSync(path.join(directory, 'final_report.md'), lines.join('\n') + '\n', 'utf8');
}

function readRequirementsFile(file: string | undefined, projectRoot: string): RequirementEntry[] {
    const configured = file?.trim();
    if (!configured) { return []; }
    const resolved = path.isAbsolute(configured) ? configured : path.join(projectRoot, configured);
    let text: string;
    try { text = fs.readFileSync(resolved, 'utf8'); } catch {
        throw new AnalysisStageError('environment', 'requirements-file', 'The configured requirements file cannot be read.',
            { reasonCode: 'requirements-file-unreadable' });
    }
    try { return parseRequirements(text); } catch (error) {
        throw new AnalysisStageError('environment', 'requirements-file', (error as Error).message,
            { reasonCode: 'requirements-file-invalid' });
    }
}

async function extractFacts(runTool: NonNullable<CaseTablePipelineOptions['runPythonTool']>, file: string, target: string): Promise<CaseTableFacts> {
    const result = await runTool(pythonToolPath('caseTableFacts'), [file, target]);
    try { return readCaseTableFacts(result.stdout); } catch (error) {
        throw new AnalysisStageError('tool', 'case-table-facts', (error as Error).message);
    }
}

async function defaultRunPythonTool(python: string, script: string, args: string[], input?: string): Promise<PythonToolResult> {
    const result = await runSpawn(python, [script, ...args], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        ...(input === undefined ? {} : { input }) });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}
