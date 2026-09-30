import { createResultLayout, roundDirectory, preserveCandidate } from './pipeline/resultLayout';
import { localize, withLanguage } from './i18n/core';
import { initI18n } from './i18n';
import * as vscode from 'vscode';
import { MutationViewProvider } from './ui/SidebarProvider';
import {
    getSystemPrompt, getUserPrompt, getTier1EvidenceBoundSystemPrompt, getTier3SystemPrompt, getTier3UserPrompt,
    getBugFixerSystemPrompt, getBugFixerUserPrompt, getReviewEvidence, mergeBugFixReplacementDetailed, canRepairTestMethod,
    fitReviewPrompt, getTestReviewerSystemPrompt, parseTestReviewDetailed,
    buildSemanticAnalyzerSystemPrompt, getSemanticAnalyzerUserPrompt, parseSemanticAnalysis, restrictSemanticInputHintsToTargetParameters, formatSemanticContextForPrompt, SemanticAnalysis,
    getQualityAnalystSystemPrompt, selectQualityFocus, QualityAnalystSession, qualityStrategyHints,
    buildWriterRevisionRequest, ROLE_CONTRACT_VERSIONS
} from './roles';
import { validateTestCandidate } from './pipeline/testCandidatePipeline';
import { repairWithNumericSkill } from './pipeline/numericTestSkill';
import { verificationMode, VerificationMode } from './pipeline/verificationMode';
import { runExecutionVerification } from './pipeline/executionVerification';
import { getExecutionWriterSystemPrompt, getExecutionWriterPrompt } from './roles/unittestWriter';
import { compareCoverageQuality, coverageGapIds } from './pipeline/qualityRegression';
import { AnalysisJournal, evidenceHash, QualityProgress } from './pipeline/analysisJournal';
import { CandidateCheckpointStore, CandidateCoverage } from './pipeline/candidateCheckpoint';
import { TargetBudget, TargetBudgetLimits, currentTargetBudget, runWithTargetBudget } from './pipeline/targetBudget';
import { parseBehaviorObservations, recoverBehaviorProgress, mergeBehaviorObservations } from './pipeline/behaviorObservations';
import { buildProbeInputs, TypedProbeInputsV1 } from './pipeline/probeInputs';
import { createDefaultQualityPolicy } from './pipeline/qualityPolicy';
import { normalizeExecutionSettings } from './pipeline/executionSettings';
import { createAnalysisDirectory, createBatchDirectory } from './pipeline/analysisOutput';
import { reserveArtifactFiles } from './pipeline/artifactPaths';
import { BatchJournal } from './pipeline/batchJournal';
import { presentOutcome, presentSummaryOutcome, describeStageEvent, withOutcomeHeader } from './pipeline/resultPresentation';
import { TierHistory } from './pipeline/tierHistory';
import { ReportIdentity, writeTargetReports } from './pipeline/targetReport';
import { planMutationProbes } from './pipeline/mutationProbePlan';
import { preflightTargetModule, PreflightResult, ResolvedDependency } from './pipeline/modulePreflight';
import { createImportFixturePlan, currentImportFixtures, withImportFixtures } from './pipeline/importFixtures';
import {
    BehaviorObservation,
    BehaviorObservations,
    SemanticPlanV2,
    summarizeObservationPhase,
    WriterEvidenceBundleV3
} from './pipeline/evidenceContracts';
import { normalizeScenarioOutput, reconcileScenarios, ScenarioIdentity } from './validation/scenarioIdentity';
import { dispatchTestRules } from './pipeline/testRuleDispatcher';
import { pythonToolPath } from './pipeline/pythonTools';
import { extractFunctionsWithAst, findPythonFilesInDir, detectMutationEngine } from './utils/utils';
import { mergeTestSnippets } from './validation/testMerger';
import { buildGoogleGenerateContentRequest, getGoogleGeneratedText, GoogleGenerateContentRequest, googleThinkingSession, resolveGoogleApiKey } from './llm/cloudApi';
import { addOutputContract, buildCustomChatCompletionBody, CustomOutputFormat, getCustomChatCompletionText, isStructuredResponseUsable, responseSchemaForOutputFormat, shouldRetryStructuredOutputAsText } from './llm/customApi';
import { SerialRequestQueue } from './llm/serialRequestQueue';
import { extractPythonTestCode, unwrapGeneratedCodeEnvelope, validateUnittestStructure } from './validation/generatedTestValidator';
import { buildVerifiedConstructorCall } from './tier/tier1TestBuilder';
import { buildTier1TestFile } from './tier/tier1TestFileBuilder';
import { restoreVerifiedTraceTestFile, shouldPreserveVerifiedTrace } from './tier/traceTestAugmenter';
import { findModelProfile, qualificationForSelectedProfile, restoreModelProfiles, StoredModelProfile, upsertModelProfile } from './llm/modelProfileRegistry';
import { selectAnalysisResponseFormat, selectTestGenerationResponseFormat, qualificationEndpointKey, QUALIFICATION_VERSION } from './llm/modelQualification';
import { RoleQualificationProfile, qualifiedRole } from './llm/roleQualification';
import { ReviewSession, ReviewStatus } from './roles/reviewSession';
import { canUseDeterministicTierOne, canUseModelAuthoredRepair, canUseTierOneLlmGeneration, resolveTier, resolveTier1GenerationMode } from './tier/tierRouter';
import { resolveTierTwoSubtaskGate } from './tier/subtaskResponseGate';
import { formatPythonImport, inferTargetImportModule } from './utils/dependencyResolver';
import { shouldRetryTraceWithoutCallerInputs } from './tier/traceRecovery';
import { assessTargetCoverageEvidence, TargetCoverageAssessment } from './mutation/targetCoverage';
import { formatReportProvenance, ReportProvenance } from './utils/reportProvenance';
import { buildStubSmokeAssertion } from './tier/stubSmokeAssertion';
import { hasDummyFunctionNameMarker, isStructurallyInertStub } from './tier/stubClassifier';
import { buildStubTestPlan } from './tier/stubTestPlan';
import { buildGeneratedTestEnvironment, coverageRequiredMessage, generatedUnittestArguments, normalizePythonExecutable } from './utils/pythonTestEnvironment';
import { configuredPythonForResource, PythonEnvironmentController } from './environment/pythonEnvironmentController';
import { ImportSetupController } from './environment/importSetupController';
import { inspectProjectImports, ImportCheckTarget } from './environment/projectImportCheck';
import { ImportFixtureRule } from './pipeline/importFixtures';
import { pythonEnvironmentActivity } from './environment/pythonEnvironmentSetup';
import { buildExternalMutationExecution, externalIsolationVerified } from './mutation/mutationExecution';
import { MutationRun, MutationContext, parseBuiltinMutationRun, parseExternalMutationRun,
    mutationScore as measuredMutationScore } from './mutation/mutationResult';
import { exceptionNamesFromEvidence } from './validation/exceptionEvidence';
import { validateTraceEvidence } from './validation/traceAssertionEvidence';
import { selectPromptDetail } from './prompts/promptDetailStrategy';
import { contextInputBudget, estimatePromptTokens, promptFits, runtimeContextWindow } from './prompts/promptBudget';
import { COMPACT_WRITER_VERSION } from './prompts/compactWriterContext';
import { AnalysisStageError, classifyExecutionFailure } from './utils/executionFailureCategory';
import { RepairResponseError, REPAIR_REASON_LABELS, repairReasonCode, formatRepairRouting } from './pipeline/repairDiagnostics';
import { deadlineAtFromTimeoutSeconds, GENERATION_RETRY_MAX_ATTEMPTS, remainingDeadlineMs, retryTransientProviderRequest } from './llm/connectionTimeout';
import { buildSupplementalProbeInputs, SupplementalProbeInput } from './tier/supplementalProbeInputs';
import { traceSubsetForCaller } from './tier/callerTracePartition';
import { planCallerPartitions } from './tier/callerPartitionPlan';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { runSpawn } from './utils/processRunner';
import { ExecutionManager, currentExecution, runInExecution, isExecutionCancelled, throwIfExecutionCancelled } from './pipeline/executionContext';


// ─────────────────────────────────────────────────────────────
// Tier 系統：複雜度評估 + 路由
// ─────────────────────────────────────────────────────────────

interface ComplexityResult {
    score: number;
    level: string;
    reasons: string[];
}

/** 呼叫 complexity_assessor.py，回傳複雜度分數 */
async function assessFunctionComplexity(
    filePath: string,
    funcName: string,
    pythonExecutable: string
): Promise<ComplexityResult> {
    const script = pythonToolPath('complexity');
    try {
        const { stdout } = await runSpawn(pythonExecutable, [script, filePath, funcName], {
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        return JSON.parse(stdout.trim()) as ComplexityResult;
    } catch {
        return { score: 30, level: 'Moderate', reasons: ['parse error, defaulting to Moderate'] };
    }
}

/**
 * 小模型一次只處理一個函式，避免多個角色請求互相搶占記憶體與注意力。
 * Small models process one function at a time to avoid competing role requests.
 */
async function runSequentially<T>(
    tasks: (() => Promise<T>)[],
    onError: (message: string) => void
): Promise<(T | undefined)[]> {
    const results: (T | undefined)[] = [];
    for (let index = 0; index < tasks.length; index++) {
        throwIfExecutionCancelled();
        try {
            results.push(await tasks[index]());
        } catch (err: any) {
            if (!isExecutionCancelled()) {
                onError(localize("[順序執行] 任務 {0} 執行失敗: {1}", index + 1, err?.message ?? err));
            }
            results.push(undefined);
        }
    }
    return results;
}

/**
 * 判斷函式是否為 Stub/Dummy（無實際業務邏輯），可走快速通道。
 * 接受真正沒有可觀察運算的函式本體（pass 或安全 literal 回傳），
 * 或使用者明確以 dummy token 標記的雜訊／佔位函式；不使用複雜度分數。
 */
function isStubFunction(astContext: AstContext | null): boolean {
    if (!astContext || astContext.error) {
        return false;
    }
    return isStructurallyInertStub(astContext.code);
}


/** 呼叫 mock_scaffold_generator.py，回傳 mock 骨架 */
async function runMockScaffold(
    filePath: string,
    funcName: string,
    traceResult: any,
    targetModule?: string,
    pythonExecutable: string = 'python'
): Promise<{ scaffold: string; patches: string[]; mock_names: string[]; class_name?: string | null; is_async?: boolean } | null> {
    const script = pythonToolPath('scaffold');
    const scriptArgs = [script, filePath, funcName];
    if (traceResult || targetModule) {
        scriptArgs.push(JSON.stringify(traceResult || {}));
    }
    if (targetModule) {
        scriptArgs.push(targetModule);
    }
    try {
        const { stdout } = await runSpawn(pythonExecutable, scriptArgs,
            { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }
        );
        const parsed = JSON.parse(stdout.trim());
        return parsed.scaffold ? parsed : null;
    } catch {
        return null;
    }
}

interface ModelProfile {
    paramSize: string;      // e.g. "2.0B", "13.0B", "Cloud (Gemini)"
    contextLength: number;  // max context tokens from model
    budgetTokens: number;   // calculated usable budget
    envType?: 'local' | 'cloud' | 'custom';
    modelName?: string;
    testGenerationReady?: boolean;
    testGenerationReason?: string;
    testGenerationMode?: string;
    qualificationVersion?: string;
    endpointKey?: string;
    roleQualification?: RoleQualificationProfile;
}

function defaultModelProfile(): ModelProfile {
    return {
        paramSize: 'unknown',
        contextLength: 4096,
        budgetTokens: 2000
    };
}

let currentModelProfile: ModelProfile = defaultModelProfile();
let storedModelProfiles: StoredModelProfile[] = [];
interface ModelSnapshot {
    current: ModelProfile;
    stored: StoredModelProfile[];
}
const analysisRuns = new ExecutionManager<ModelSnapshot>();
interface AnalysisView { webview?: Pick<vscode.Webview, 'postMessage'> }

async function runAnalysisSession<T extends object>(
    params: T,
    sidebar: MutationViewProvider,
    operation: (params: T & { sessionDate: string }, log: (text: string) => void, view: AnalysisView) => Promise<void>
): Promise<void> {
    const releasePython = pythonEnvironmentActivity.acquire('use');
    if (!releasePython) {
        await vscode.window.showInformationMessage(localize("Python 環境準備中，請等待完成後再開始測試。"));
        void sidebar.webview?.postMessage({ command: 'analysisFinished' });
        return;
    }
    const execution = analysisRuns.begin({ current: currentModelProfile, stored: storedModelProfiles });
    if (!execution) {
        releasePython();
        await vscode.window.showInformationMessage(localize("已有分析執行中，請等待完成或先中止。"));
        return;
    }
    const view: AnalysisView = { webview: { postMessage: message => {
        if (!analysisRuns.canPublish(execution)) { return Promise.resolve(false); }
        return sidebar.webview?.postMessage(message) ?? Promise.resolve(false);
    } } };
    const log = (text: string) => { void view.webview?.postMessage({ command: 'appendLog', text }); };
    sidebar.beginAnalysis(execution.id);
    // Group this run's results under its local date and minute.
    const runParams = { ...params, sessionDate: formatSessionDate() };
    await withLanguage(() => runInExecution(execution, async () => {
        try { await operation(runParams, log, view); }
        catch (error: any) {
            if (!execution.cancelled) { log(localize("[錯誤] 測試執行發生異常: {0}", error?.message ?? error)); }
        } finally {
            releasePython();
            if (analysisRuns.finish(execution)) {
                void sidebar.webview?.postMessage({ command: 'analysisFinished' });
            }
        }
    }));
    sidebar.endAnalysis(execution.id);
}

let extensionBuildIdentity: Pick<ReportProvenance, 'extensionId' | 'extensionVersion' | 'buildTimestamp' | 'extensionMode'> = {
    extensionId: 'unknown',
    extensionVersion: 'unknown',
    buildTimestamp: 'unknown',
    extensionMode: 'unknown'
};

const MODEL_PROFILE_STORE_KEY = 'llmUnitTest.modelProfiles.v1';

function withBudget(profile: StoredModelProfile): ModelProfile {
    return {
        ...profile,
        budgetTokens: getContextBudget({ ...profile, budgetTokens: 0 })
    };
}

function estimateTokens(text: string): number {
    return estimatePromptTokens(text);
}

function getContextBudget(profile: ModelProfile): number {
    return contextInputBudget(profile.paramSize, profile.contextLength);
}

interface AnalysisParams {
    validationMode?: VerificationMode;
    envType: 'local' | 'cloud' | 'custom';
    modelName: string;
    filePath: string;
    funcName: string;
    promptStrategy?: string;
    ollamaUrl?: string;
    maxLoops: number;
    mutpyTimeout?: number;
    timeoutSeconds: number;
    outputPath: string;
    customUrl?: string;
    customKey?: string;
    cloudKey?: string;
    projectName?: string;
    sessionDate?: string;
    /** Optional venv or laboratory interpreter; empty values fall back to PATH python. */
    pythonExecutable?: string;
    /** Runner-owned context setting; not a new user/provider configuration. */
    requestContextTokens?: number;
    /** Internal batch inventory; never serialized with provider credentials. */
    batchJournal?: BatchJournal;
    batchTargetId?: number;
}

interface CallerContext {
    caller_file: string;
    caller_func: string;
    line: number;
    args: string[];
    kwargs: Record<string, string>;
    call_expr?: string;
    trace_input?: import('./pipeline/evidenceContracts').TraceValueSnapshot;
    trace_args?: unknown[] | null;
    trace_kwargs?: Record<string, unknown> | null;
    trace_constructor_args?: unknown[] | null;
    trace_constructor_kwargs?: Record<string, unknown> | null;
    constructor_args?: string[] | null;
    constructor_kwargs?: Record<string, string> | null;
}

interface AstContext {
    name: string;
    /** Python AST uses null for module-level functions without an owning class. */
    class_name?: string | null;
    target_import_module?: string;
    args: string[];
    signature?: Array<{ name: string; kind: 'positional_only' | 'positional_or_keyword' | 'keyword_only' | 'var_positional' | 'var_keyword'; annotation: string | null; default: string | null; required: boolean }>;
    required_args?: string[];
    docstring: string;
    calls: string[];
    dependencies?: { name: string, module: string, level?: number }[];
    file_imports?: { kind: string, module: string, level?: number, name: string | null, alias: string | null, bound_name: string }[];
    referenced_globals?: { name: string, code: string }[];
    class_context?: { name: string, bases: string[], class_attrs: { name: string, code: string }[], init: { params: string[], required_params?: string[], optional_params?: string[], signature?: Array<{ name: string; kind: string; annotation: string | null; default: string | null; required: boolean }>, assigns: { name: string, code: string }[] }, effective_init?: { defined_on: string, params: string[], required_params?: string[], optional_params?: string[], signature?: Array<{ name: string; kind: string; annotation: string | null; default: string | null; required: boolean }>, assigns: { name: string, code: string }[] }, inherited_context?: Array<{ name: string, bases: string[], class_attrs: { name: string, code: string }[], init: { params: string[], required_params?: string[], optional_params?: string[], signature?: Array<{ name: string; kind: string; annotation: string | null; default: string | null; required: boolean }>, assigns: { name: string, code: string }[] } }> } | null;
    method_kind?: 'module' | 'instance' | 'static' | 'class' | 'property';
    property_context?: { name: string, getter?: unknown, setter?: unknown, deleter?: unknown } | null;
    is_async?: boolean;
    is_generator?: boolean;
    executable_lines?: number[];
    raised_exceptions?: string[];
    condition_facts?: Array<{ kind: 'comparison' | 'membership' | 'match'; parameter: string; subject: 'value' | 'length'; operator?: string; literal?: string | null; literals?: string[]; line: number }>;
    traceResult?: BehaviorProbeResult;
    dependencyContexts?: AstContext[];
    dependencyResolution?: ResolvedDependency[];
    localDependencyContexts?: AstContext[];
    retrieval?: { version: string; selected: number; omitted: string[] };
    sourceVersions?: Array<{ file: string; hash: string }>;
    callerContexts?: CallerContext[];
    code: string;
    sourceHash?: string;
    error?: string;
}

/** 產生可用於檔名的 session 日期時間字串（格式：YYYY_MM_DD_HH_MM，使用本機時間） */
function formatSessionDate(now: Date = new Date()): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${year}_${month}_${day}_${hours}_${minutes}`;
}

export function activate(context: vscode.ExtensionContext) {
    if (typeof vscode.workspace?.getConfiguration === 'function') { initI18n(); }
    let buildTimestamp = 'unknown';
    try {
        buildTimestamp = fs.statSync(__filename).mtime.toISOString();
    } catch {
        // Keep reports portable even when a host cannot expose bundle metadata.
    }
    extensionBuildIdentity = {
        extensionId: context.extension.id,
        extensionVersion: String(context.extension.packageJSON.version || 'unknown'),
        buildTimestamp,
        extensionMode: context.extensionMode === vscode.ExtensionMode.Development
            ? 'development'
            : context.extensionMode === vscode.ExtensionMode.Test ? 'test' : 'production'
    };
    storedModelProfiles = restoreModelProfiles(
        context.globalState.get<unknown>(MODEL_PROFILE_STORE_KEY)
    );
    const sidebarProvider = new MutationViewProvider(context.secrets, context.globalState);
    const languageSubscription = vscode.workspace?.onDidChangeConfiguration?.(event => {
        if (event.affectsConfiguration('llmUnitTest.language')) { sidebarProvider.refreshLanguage(); }
    });
    if (languageSubscription) { context.subscriptions.push(languageSubscription); }
    const environmentController = new PythonEnvironmentController(context.globalState,
        message => { void sidebarProvider.webview?.postMessage(message); });
    const importSetup = new ImportSetupController(message => { void sidebarProvider.webview?.postMessage(message); });
    context.subscriptions.push(importSetup, vscode.commands.registerCommand('llm-unit-test.prepareImportSetup',
        (params?: { projectRoot?: string; outputPath?: string }) => importSetup.prepare(params?.projectRoot, params?.outputPath)));
    context.subscriptions.push(environmentController, vscode.commands.registerCommand(
        'llm-unit-test.preparePythonEnvironment', (params?: { filePath?: string; projectRoot?: string }) =>
            environmentController.prepare(params?.filePath, params?.projectRoot)));
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MutationViewProvider.viewType, sidebarProvider)
    );

    const runTestCmd = vscode.commands.registerCommand(
        'llm-unit-test.runCaptureAndTest',
        async (params?: AnalysisParams) => {
            if (!params) {
                await vscode.commands.executeCommand('mutation-test-view.focus');
                return;
            }
            const paramsWithPython = { ...params, pythonExecutable: configuredPythonForResource(params.filePath),
                validationMode: verificationMode(params.validationMode ?? vscode.workspace.getConfiguration('llmUnitTest').get('validationMode', 'full')) };
            await runAnalysisSession(paramsWithPython, sidebarProvider, async (runParams, log, view) => {
                if (runParams.funcName) {
                    await executeSingleFileAnalysis(runParams, log, view);
                    return;
                }
                const funcs = await extractFunctionsWithAst(runParams.filePath, runParams.pythonExecutable);
                throwIfExecutionCancelled();
                if (funcs.length === 0) {
                    log(localize("[系統] 檔案 {0} 中無可測試函式。", path.basename(runParams.filePath)));
                    return;
                }
                log(localize("[系統] 全檔案掃描：{0} 個函式，將逐一分析與測試。", funcs.length));
                const processed = await runSequentially(funcs.map(func => async () => {
                    throwIfExecutionCancelled();
                    await executeSingleFileAnalysis({ ...runParams, funcName: func.fullName }, log, view);
                    return true;
                }), log);
                throwIfExecutionCancelled();
                const blocked = processed.filter(result => result === undefined).length;
                log(localize("[系統] 全檔案流程結束：{0} 個目標，{1} 個流程錯誤／受阻。各函式是否通過以結果卡與報告為準。", funcs.length, blocked));
            });
        }
    );

    interface BatchAnalysisParams extends Omit<AnalysisParams, 'filePath' | 'funcName'> {
        batchPath: string;
    }

    const runBatchCmd = vscode.commands.registerCommand(
        'llm-unit-test.runBatchAnalysis',
        async (params?: BatchAnalysisParams) => {
            if (!params) {
                await vscode.commands.executeCommand('mutation-test-view.focus');
                return;
            }
            const paramsWithPython = { ...params, pythonExecutable: configuredPythonForResource(params.batchPath, params.batchPath),
                validationMode: verificationMode(params.validationMode ?? vscode.workspace.getConfiguration('llmUnitTest').get('validationMode', 'full')) };
            await runAnalysisSession(paramsWithPython, sidebarProvider, async (runParams, log, view) => {
                const projectName = path.basename(runParams.batchPath);
                const batchDirectory = createBatchDirectory(runParams.outputPath || runParams.batchPath,
                    runParams.sessionDate || formatSessionDate(), projectName);
                const batch = new BatchJournal(batchDirectory, runParams.batchPath, {
                    model: runParams.modelName, buildTimestamp: extensionBuildIdentity.buildTimestamp,
                    python: runParams.pythonExecutable, validationMode: runParams.validationMode
                });
                let outcome: 'completed' | 'cancelled' | 'failed' = 'failed';
                try {
                    const output = path.resolve(runParams.outputPath || batchDirectory);
                    const excluded = path.relative(runParams.batchPath, output) === '' ? [batchDirectory] : [output];
                    let files: string[];
                    try { files = await findPythonFilesInDir(runParams.batchPath, true, excluded, true); }
                    catch {
                        throwIfExecutionCancelled();
                        batch.discoveryFailed(runParams.batchPath, 'source-discovery');
                        throw new Error(localize("批次來源掃描未完成，請檢查資料夾是否存在及讀取權限。"));
                    }
                    const tasks: Array<() => Promise<void>> = [];
                    const importTargets: ImportCheckTarget[] = [];
                    for (const file of files) {
                        throwIfExecutionCancelled();
                        let funcs;
                        try { funcs = await extractFunctionsWithAst(file, runParams.pythonExecutable, true); }
                        catch {
                            throwIfExecutionCancelled();
                            batch.discoveryFailed(file, 'ast-discovery');
                            log(localize("[系統] 無法解析 {0}，批次摘要將保留掃描未完成狀態。", path.relative(runParams.batchPath, file)));
                            continue;
                        }
                        batch.discover(file, funcs.map(func => func.fullName));
                        const importTarget = funcs.find(func => !hasDummyFunctionNameMarker(func.fullName));
                        if (importTarget) { importTargets.push({ file, target: importTarget.fullName }); }
                        for (const func of funcs) {
                            const id = tasks.length;
                            tasks.push(async () => {
                                throwIfExecutionCancelled();
                                batch.begin(id);
                                log(localize("[系統] 批次目標：{0}:{1}", path.basename(file), func.fullName));
                                try { await executeSingleFileAnalysis({
                                    ...runParams, filePath: file, funcName: func.fullName,
                                    projectName, batchJournal: batch, batchTargetId: id
                                }, log, view); }
                                finally { batch.refresh(id); }
                            });
                        }
                    }
                    batch.start();
                    const config = vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri.file(runParams.batchPath));
                    const importCheck = await inspectProjectImports(runParams.batchPath, runParams.pythonExecutable, importTargets,
                        path.join(batchDirectory, 'preflight'), config.get<ImportFixtureRule[]>('importFixtures', []), log,
                        config.get<string>('importFixtureRoot', ''));
                    const blockedModules = importCheck.rows.filter(row => row.status === 'blocked').length;
                    batch.preflight(blockedModules);
                    if (blockedModules) {
                        const report = path.join(importCheck.directory, 'import_check.md');
                        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(report), { preview: true });
                        const choice = await vscode.window.showWarningMessage(
                            localize("{0} 個模組載入受阻；尚未呼叫模型。可先用「檢查模組載入／初始化設定」處理，或繼續並保留受阻目標的失敗。", blockedModules),
                            { modal: true }, localize("繼續測試並記錄失敗"));
                        throwIfExecutionCancelled();
                        if (choice !== localize("繼續測試並記錄失敗")) { log(localize("[系統] 已在模型請求前停止；修復環境後請重新開始。")); return; }
                    }
                    log(localize("[系統] 批次掃描完成：{0} 個函式，將逐一分析與測試。", tasks.length));
                    await runSequentially(tasks, log);
                    outcome = 'completed';
                } finally {
                    batch.finish(isExecutionCancelled() ? 'cancelled' : outcome);
                    log(localize("[批次結果] {0}", batch.summary()));
                    log(localize("[系統] 批次狀態與環境問題摘要：{0}（執行結束不代表全部通過）", path.join(batchDirectory, 'batch_summary.md')));
                    if (!isExecutionCancelled()) {
                        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(batchDirectory, 'batch_summary.md')), { preview: true });
                    }
                }
            });
        }
    );

    const abortTestCmd = vscode.commands.registerCommand('llm-unit-test.abortTest', () => {
        if (analysisRuns.cancel()) {
            sidebarProvider.webview?.postMessage({ command: 'appendLog', text: localize("\n[系統] 已中止本次分析，可重新開始。") });
            sidebarProvider.webview?.postMessage({ command: 'analysisFinished' });
        }
    });

    const updateModelProfileCmd = vscode.commands.registerCommand('llm-unit-test.updateModelProfile', (profile: {
        paramSize: string;
        contextLength: number;
        envType?: 'local' | 'cloud' | 'custom';
        modelName?: string;
        testGenerationReady?: boolean;
        testGenerationReason?: string;
        testGenerationMode?: string;
        qualificationVersion?: string;
        endpointKey?: string;
        roleQualification?: RoleQualificationProfile;
    }) => {
        const updatedProfile: ModelProfile = {
            paramSize: profile.paramSize,
            contextLength: profile.contextLength,
            budgetTokens: getContextBudget({ paramSize: profile.paramSize, contextLength: profile.contextLength, budgetTokens: 0 }),
            envType: profile.envType,
            modelName: profile.modelName,
            testGenerationReady: profile.testGenerationReady,
            testGenerationReason: profile.testGenerationReason,
            qualificationVersion: profile.qualificationVersion,
            endpointKey: profile.endpointKey,
            testGenerationMode: profile.testGenerationMode,
            roleQualification: profile.roleQualification
        };
        currentModelProfile = updatedProfile;
        if (updatedProfile.envType && updatedProfile.modelName) {
            storedModelProfiles = upsertModelProfile(storedModelProfiles, {
                envType: updatedProfile.envType,
                modelName: updatedProfile.modelName,
                paramSize: updatedProfile.paramSize,
                contextLength: updatedProfile.contextLength,
                testGenerationReady: updatedProfile.testGenerationReady,
                testGenerationReason: updatedProfile.testGenerationReason,
                qualificationVersion: updatedProfile.qualificationVersion,
                endpointKey: updatedProfile.endpointKey,
                testGenerationMode: updatedProfile.testGenerationMode,
                roleQualification: updatedProfile.roleQualification
            });
            void context.globalState.update(MODEL_PROFILE_STORE_KEY, storedModelProfiles);
        }
    });

    context.subscriptions.push(runTestCmd, runBatchCmd, abortTestCmd, updateModelProfileCmd,
        { dispose: () => { analysisRuns.cancel(); } });
}


async function extractAstContext(
    targetPath: string,
    funcName: string,
    pythonExecutable: string
): Promise<AstContext | null> {
    const pythonScript = pythonToolPath('ast');
    try {
        const { stdout, stderr, code } = await runSpawn(pythonExecutable, [pythonScript, targetPath, funcName], {
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        if (code !== 0) {
            return { error: stdout || stderr, name: '', args: [], docstring: '', calls: [], code: '' };
        }
        return JSON.parse(stdout);
    } catch {
        return null;
    }
}

async function findCallerContexts(
    funcName: string,
    projectRoot: string,
    targetPath?: string,
    pythonExecutable: string = 'python'
): Promise<CallerContext[]> {
    const pythonScript = pythonToolPath('callers');
    try {
        const args = [pythonScript, funcName, projectRoot];
        if (targetPath) {
            args.push(targetPath);
        }
        const { stdout, code } = await runSpawn(pythonExecutable, args, {
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        if (code !== 0) { return []; }
        const parsed = JSON.parse(stdout);
        return Array.isArray(parsed) ? parsed.filter((value): value is CallerContext => value && typeof value === 'object'
            && typeof value.caller_file === 'string' && typeof value.caller_func === 'string'
            && Number.isSafeInteger(value.line) && value.line > 0
            && Array.isArray(value.args) && value.args.every((arg: unknown) => typeof arg === 'string')
            && value.kwargs && typeof value.kwargs === 'object' && !Array.isArray(value.kwargs)
            && Object.values(value.kwargs).every(arg => typeof arg === 'string')) : [];
    } catch {
        return [];
    }
}

type BehaviorProbeResult = BehaviorObservations;

/**
 * 執行受控行為探測：呼叫既有 Python 探測器取得有界的 input→output 觀測
 * callerArgs: 從呼叫站語境中提取的已知真實參數（可選）
 */
async function runBehaviorProbe(
    filePath: string,
    funcName: string,
    callerArgs?: CallerContext[],
    pythonExecutable: string = 'python',
    supplementalInputs: SupplementalProbeInput[] = [],
    progressDirectory?: string,
    skillInputs?: TypedProbeInputsV1
): Promise<BehaviorProbeResult | null> {
    const pythonScript = pythonToolPath('trace');
    const baseArgs = [pythonScript, filePath, funcName];
    const suppliedInputs = skillInputs || buildProbeInputs(callerArgs || [], supplementalInputs);
    try {
        const runProbe = async (inputs: TypedProbeInputsV1 | null = null): Promise<BehaviorProbeResult> => {
            const [progressPath] = reserveArtifactFiles(progressDirectory || os.tmpdir(), ['trace'], 'jsonl');
            const args = [...baseArgs, JSON.stringify(inputs), JSON.stringify({
                total_timeout_seconds: 12, case_timeout_seconds: 2, progress_path: progressPath
            })];
            try {
                const run = await runSpawn(pythonExecutable, args, {
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 20000
                });
                if (run.code !== 0) { throw new Error('Trace worker process failed'); }
                return parseBehaviorObservations(run.stdout.trim(), funcName);
            } catch (error) {
                const recovered = fs.existsSync(progressPath) ? recoverBehaviorProgress(fs.readFileSync(progressPath, 'utf8'),
                    funcName, error instanceof Error ? error.message : 'Trace interrupted') : undefined;
                if (recovered) { return recovered; }
                throw error;
            } finally {
                if (!progressDirectory && fs.existsSync(progressPath)) { fs.unlinkSync(progressPath); }
            }
        };
        const initial = await runProbe(suppliedInputs);
        if (shouldRetryTraceWithoutCallerInputs(initial, suppliedInputs?.cases.length || 0)) {
            const retry = await runProbe();
            return { ...mergeBehaviorObservations(initial, retry), input_source: 'source_guided_retry' };
        }
        return {
            ...initial,
            input_source: skillInputs || supplementalInputs.length > 0
                ? 'semantic_guided'
                : suppliedInputs?.cases.length ? 'caller_literals' : 'source_guided'
        };
    } catch (e: any) {
        console.error(`[Behavior Probe ERROR] ${e.message || e}`);
        return { func_name: funcName, args: [], examples: [], errors: [], load_error: `spawn failed: ${e.message || 'unknown'}` } as BehaviorProbeResult;
    }
}

/** Retain initial observations when analyst-proposed inputs add more executions. */
function mergeBehaviorProbeResults(
    initial: BehaviorProbeResult | undefined,
    additional: BehaviorProbeResult
): BehaviorProbeResult {
    return mergeBehaviorObservations(initial, additional);
}

// 所有角色共用同一條請求佇列；即使呼叫端誤觸並行，小模型仍只處理一個提示詞。
// Every role shares one request queue so a small model receives one prompt at a time.
const llmRequestQueue = new SerialRequestQueue();

async function requestLlmApi(
    params: AnalysisParams,
    systemPrompt: string,
    userPrompt: string,
    log: (text: string) => void,
    outputFormat: CustomOutputFormat = 'text',
    sharedDeadlineAt?: number
): Promise<string> {
    return llmRequestQueue.run(() => requestLlmApiUnlocked(
            params, systemPrompt, userPrompt, log, outputFormat,
            sharedDeadlineAt ?? deadlineAtFromTimeoutSeconds(params.timeoutSeconds)
        ));
}

async function requestLlmApiUnlocked(
    params: AnalysisParams,
    systemPrompt: string,
    userPrompt: string,
    log: (text: string) => void,
    outputFormat: CustomOutputFormat = 'text',
    /** Structured-output fallback must consume the original request allowance. */
    deadlineAt = deadlineAtFromTimeoutSeconds(params.timeoutSeconds)
): Promise<string> {
    const remainingTimeoutMs = remainingDeadlineMs(deadlineAt);
    if (remainingTimeoutMs <= 0) {
        throw new Error(localize("API 請求已超過 {0} 秒總時限。", params.timeoutSeconds));
    }
    let apiUrl = "";
    let bodyData = {};
    let cloudRequest: GoogleGenerateContentRequest | undefined;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const contractedSystemPrompt = addOutputContract(systemPrompt, outputFormat);
    const expectsJsonObject = outputFormat === 'json'
        || outputFormat === 'test-method-json'
        || outputFormat === 'semantic-json'
        || outputFormat === 'review-json'
        || outputFormat === 'quality-json'
        || outputFormat === 'mutant-triage-json';

    if (params.envType === 'local') {
        const baseUrl = params.ollamaUrl || 'http://127.0.0.1:11434';
        apiUrl = `${baseUrl.replace(/\/$/, '')}/api/generate`;
        bodyData = {
            model: params.modelName,
            system: contractedSystemPrompt,
            prompt: userPrompt,
            stream: false,
            ...(params.requestContextTokens ? { options: { num_ctx: params.requestContextTokens } } : {}),
            ...(expectsJsonObject ? { format: ['review-json', 'quality-json'].includes(outputFormat) ? responseSchemaForOutputFormat(outputFormat) : 'json' } : {})
        };
    } else if (params.envType === 'custom') {
        apiUrl = params.customUrl || 'https://api.openai.com/v1/chat/completions';
        bodyData = buildCustomChatCompletionBody(params.modelName, contractedSystemPrompt, userPrompt, outputFormat);
        if (params.customKey) {
            headers['Authorization'] = `Bearer ${params.customKey}`;
        }
    } else {
        const actualKey = resolveGoogleApiKey(params.cloudKey);
        if (!actualKey) {
            throw new Error(localize("找不到 Google AI Studio API Key。請在側邊欄儲存對應模型的 key，或設定 LLM_UNIT_TEST_GOOGLE_API_KEY。"));
        }
        const responseSchema = responseSchemaForOutputFormat(outputFormat);
        const googleRequest = buildGoogleGenerateContentRequest(
            params.modelName,
            actualKey,
            contractedSystemPrompt + "\n\n" + userPrompt,
            { ...(outputFormat === 'text' ? {} : { responseMimeType: 'application/json', responseSchema }),
                thinkingMode: vscode.workspace.getConfiguration('llmUnitTest').get('cloudThinkingMode', 'minimal') === 'minimal'
                    ? 'minimal' : 'provider-default' }
        );
        apiUrl = googleRequest.url;
        headers = googleRequest.headers;
        bodyData = googleRequest.body;
        cloudRequest = googleRequest;
    }

    throwIfExecutionCancelled();
    const controller = new AbortController();
    let deadlineExpired = false;
    const release = currentExecution()?.onCancel(() => controller.abort());
    const timeoutId = setTimeout(() => {
        deadlineExpired = true;
        controller.abort();
        log(localize("[警告] API 請求超時 (超過 {0} 秒)", params.timeoutSeconds));
    }, remainingTimeoutMs);
    try {
        const send = (request?: GoogleGenerateContentRequest) => retryTransientProviderRequest(
            () => {
                currentTargetBudget()?.consumeTransportAttempt(estimateTokens(contractedSystemPrompt + '\n' + userPrompt));
                return fetch(request?.url || apiUrl, {
                method: 'POST', headers: request?.headers || headers,
                body: JSON.stringify(request?.body || bodyData), signal: controller.signal
                });
            },
            {
                maxAttempts: GENERATION_RETRY_MAX_ATTEMPTS,
                isCancelled: () => controller.signal.aborted
                    || isExecutionCancelled()
                    || remainingDeadlineMs(deadlineAt) <= 0,
                onRetry: event => log(
                    localize("[供應商重試] {0}；等待 {1}ms 後重試 ", event.reason, event.delayMs)
                    + `(${event.retryAttempt}/${event.maxAttempts})。`
                )
            }
        );
        const response = cloudRequest ? await googleThinkingSession.send(cloudRequest, send,
            () => log(localize("[思考量回退] 供應商明確不支援低思考量，沿原時限使用服務預設。"))) : await send();
        throwIfExecutionCancelled();
        if (!response.ok) {
            await response.body?.cancel();
            if (shouldRetryStructuredOutputAsText(response.status, outputFormat)) {
                log(localize("[格式回退] 供應商拒絕結構化輸出（HTTP {0}），沿原時限改用一般文字輸出。", response.status));
                return requestLlmApiUnlocked(params, systemPrompt, userPrompt, log, 'text', deadlineAt);
            }
            throw new AnalysisStageError('model-api', 'model-request',
                localize("API 伺服器錯誤 (HTTP {0})；未記錄供應商回應內容。", response.status), { httpStatus: response.status });
        }

        const resJson = await response.json() as Record<string, unknown>;

        let responseText: string;
        if (params.envType === 'local') {
            responseText = (resJson as { response?: string }).response || "";
        } else if (params.envType === 'custom') {
            const customText = getCustomChatCompletionText(resJson);
            if (customText) {
                responseText = customText;
            } else if ((resJson as any).error) {
                throw new AnalysisStageError('model-api', 'model-request', localize("自訂 API 回傳錯誤物件；未記錄供應商回應內容。"));
            } else {
                throw new AnalysisStageError('model-format', 'model-response', localize("無法解析的 API 回傳格式；內容可能未完成或缺少可用文字。"));
            }
        } else {
            const cloudText = getGoogleGeneratedText(resJson);
            if (cloudText) {
                responseText = cloudText;
            } else if ((resJson as any).error) {
                throw new AnalysisStageError('model-api', 'model-request', localize("雲端 API 回傳錯誤物件；未記錄供應商回應內容。"));
            } else {
                throw new AnalysisStageError('model-format', 'model-response', localize("無法解析的 API 回傳格式；內容可能未完成或缺少可用文字。"));
            }
        }

        // Reviewer contract failures belong to the bounded review session.
        // Repeating the same invalid assessment in text mode doubles its cost.
        if (!['review-json', 'quality-json'].includes(outputFormat) && !isStructuredResponseUsable(responseText, outputFormat)) {
            log(localize("[格式回退] 模型回傳了不完整的結構化內容，改用一般文字輸出重試。"));
            return requestLlmApiUnlocked(params, systemPrompt, userPrompt, log, 'text', deadlineAt);
        }
        throwIfExecutionCancelled();
        return responseText;
    } catch (error) {
        throwIfExecutionCancelled();
        if (deadlineExpired || remainingDeadlineMs(deadlineAt) <= 0) {
            throw new AnalysisStageError('timeout', 'model-request', localize("API 請求超時 (超過 {0} 秒總時限)", params.timeoutSeconds),
                { cause: 'deadline', outputFormat, deadlineAt });
        }
        if (error instanceof AnalysisStageError) { throw error; }
        throw new AnalysisStageError('model-api', 'model-request', localize("API 連線或回應讀取失敗；未記錄供應商回應內容。"));
    } finally {
        clearTimeout(timeoutId);
        release?.();
    }
}

function cleanCodeBlock(code: string): string {
    let clean = stripUniformIndent(code);
    clean = clean.replace(/\[\/?\s*PYTHON\s*\]/gi, '');
    clean = clean.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/g, '').trim();

    // 截斷 unittest.main() 之後的文字說明 (Explanation/Note)
    const mainMatch = clean.match(/if\s+__name__\s*==\s*['"]__main__['"]\s*:\s*\n?\s*unittest\.main\(\)/);
    if (mainMatch && mainMatch.index !== undefined) {
        const endIdx = mainMatch.index + mainMatch[0].length;
        clean = clean.substring(0, endIdx);
    }
    return clean.trim();
}

function sanitizeLlmResponse(rawCode: string): string {
    let cleanCode = unwrapGeneratedCodeEnvelope(rawCode).trim();

    // 偵測無限 thinking 迴圈（小模型常見問題）
    const thinkingCount = (cleanCode.match(/<thinking>/g) || []).length;
    if (thinkingCount >= 3) { return ''; }
    const emojiLoopMatch = cleanCode.match(/([\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF])\1{7,}/u);
    if (emojiLoopMatch) { return ''; }

    return cleanCodeBlock(extractPythonTestCode(cleanCode));
}

/** Require both a unittest shape and a real Python AST before writing a test file. */
async function validateGeneratedTestCode(
    code: string,
    targetCallable?: string,
    targetModule?: string,
    targetUsage: 'call' | 'property' = 'call',
    targetSignature?: unknown[],
    allowedExceptionNames?: string[],
    targetClassName?: string | null,
    pythonExecutable: string = 'python',
    bindingContext?: { module: string; target: string; className?: string | null; source?: string; dependencies: Record<string, string> }
): Promise<{ valid: boolean; reason?: string }> {
    const structure = validateUnittestStructure(
        code, targetCallable, targetModule, targetUsage, allowedExceptionNames, targetClassName, Boolean(bindingContext)
    );
    if (!structure.valid) {
        return structure;
    }

    try {
        const parsed = await runSpawn(
            pythonExecutable,
            bindingContext
                ? [pythonToolPath('bindings'), '--payload']
                : ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'],
            { env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
                input: bindingContext ? JSON.stringify({ code, context: {
                    ...bindingContext, requireMockBehavior: structure.requiresMockBehaviorEvidence,
                    requireTargetBehavior: structure.requiresTargetBehaviorEvidence, targetUsage
                } }) : code, timeout: 5000 }
        );
        if (parsed.code !== 0) {
            return { valid: false, reason: localize("Python AST 無法解析：{0}", (parsed.stderr || parsed.stdout).trim().slice(0, 300)) };
        }
        if (bindingContext) {
            const bindings = JSON.parse(parsed.stdout) as { valid: boolean; reason?: string };
            if (!bindings.valid) { return bindings; }
        }
        if (targetCallable && targetUsage === 'call' && Array.isArray(targetSignature)) {
            const validatorScript = pythonToolPath('calls');
            const compatibility = await runSpawn(
                pythonExecutable,
                [validatorScript, targetCallable, JSON.stringify(targetSignature)],
                { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, input: code, timeout: 5000 }
            );
            if (compatibility.code !== 0) {
                return {
                    valid: false,
                    reason: localize("目標函式簽名驗證無法執行：{0}", (compatibility.stderr || compatibility.stdout).trim().slice(0, 300))
                };
            }
            try {
                const callValidation = JSON.parse(compatibility.stdout) as { valid?: boolean; reason?: string };
                if (!callValidation.valid) {
                    return { valid: false, reason: callValidation.reason || localize("呼叫不符合被測函式簽名") };
                }
            } catch {
                return { valid: false, reason: localize("目標函式簽名驗證回傳了無法解析的內容") };
            }
        }
        return { valid: true };
    } catch (error: any) {
        return { valid: false, reason: localize("Python AST 驗證無法執行：{0}", error.message || error) };
    }
}

/**
 * 移除所有行共有的前導空格（統一縮排）
 * 例：所有行都以 4 個空格開頭 → 全部去掉 4 格
 */
function stripUniformIndent(code: string): string {
    const lines = code.split('\n');
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);
    if (nonEmptyLines.length === 0) {return code;}

    // 計算所有非空行最小的前導空格數
    let minIndent = Infinity;
    for (const line of nonEmptyLines) {
        const leadingSpaces = line.match(/^( *)/)?.[1].length || 0;
        if (leadingSpaces < minIndent) {minIndent = leadingSpaces;}
    }

    // 只有大於 0 才有意義
    if (minIndent > 0 && minIndent < Infinity) {
        return lines.map(l => l.substring(minIndent)).join('\n');
    }
    return code;
}

/** Parse bare asserts with Python AST; the normal validation gates still apply. */
async function rescueToUnittest(rawCode: string, srcFilePath: string, funcName: string, importModule?: string, pythonExecutable: string = 'python'): Promise<string> {
    const moduleName = importModule || path.basename(srcFilePath, '.py');
    const script = pythonToolPath('rescue');
    const result = await runSpawn(pythonExecutable, [script], {
        input: JSON.stringify({ code: rawCode, module: moduleName }),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        timeout: 5000
    });
    if (result.code !== 0) { return ''; }
    return (JSON.parse(result.stdout) as { code: string }).code;
}

type RetainedCoverage = CandidateCoverage;

function extractCoverage(assessment: TargetCoverageAssessment, qualifiedName: string): RetainedCoverage {
    return { assessment, coverageText: assessment.coverageText, missingLines: assessment.missingLines,
        ...(assessment.missingTargetLines && assessment.targetBranchesCovered !== undefined ? {
            selectedTarget: { qualifiedName, executableLines: assessment.executableTargetLines || [],
                missingLines: assessment.missingTargetLines, branchesCovered: assessment.targetBranchesCovered }
        } : {}) };
}

function parseMutatestSurvived(mutatestResult: string): string {
    const lines = mutatestResult.split('\n');
    let isSurvivedSection = false;
    const survivedList: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        // 移除 ANSI 色碼（如 [91m, [0m）
        line = line.replace(/\x1B\[\d+m/g, '');
        // 移除有些情況下沒有 \x1B 但只有 [0m 的殘留字元（這是在日誌中常見的亂碼）
        line = line.replace(/\[\d+m/g, '');

        if (line === 'SURVIVED' && lines[i+1]?.replace(/\x1B\[\d+m/g, '').replace(/\[\d+m/g, '').trim() === '--------') {
            isSurvivedSection = true;
            i++; continue;
        }
        if (isSurvivedSection) {
            if (line === '' || line.startsWith('2026-') || line.match(/^\d{4}-\d{2}-\d{2}/)) {break;}
            if (line.startsWith('- ')) {survivedList.push(line);}
        }
    }
    return survivedList.join('\n');
}

function parseMutmutSurvived(mutatestResult: string): string {
    const lines = mutatestResult.split('\n');
    const survivedList: string[] = [];
    let capture = false;
    for (const line of lines) {
        if (line.includes('FAILED:') || line.includes('Survived:') || line.includes('survived')) {capture = true;}
        if (capture && line.trim() !== '') {survivedList.push(line.trim());}
    }
    return survivedList.join('\n');
}

function buildAstMarkdownReport(astContext: AstContext): string {
    let astReport = localize("### AST 靜態解析結果\n");
    astReport += localize("- 函式名稱: `{0}`\n", astContext.name);
    astReport += localize("- 參數列表: `{0}`\n", astContext.args.join(', ') || localize("無"));
    astReport += localize("- 相依呼叫: `{0}`\n", astContext.calls.join(', ') || localize("無"));
    if (astContext.docstring) {
        astReport += localize("- 文件註解: `{0}`\n", astContext.docstring.trim().replace(/\n/g, ' '));
    }
    if (astContext.dependencies && astContext.dependencies.length > 0) {
        astReport += localize("- 跨檔案依賴: {0}\n", astContext.dependencies.map((d: any) => `\`${formatPythonImport(d)}.${d.name}\``).join(', '));
    }
    if (astContext.file_imports && astContext.file_imports.length > 0) {
        astReport += localize("- 模組 Imports: {0}\n", astContext.file_imports.map(item => item.kind === 'from' ? `\`from ${'.'.repeat(item.level || 0)}${item.module} import ${item.name}\`` : `\`import ${item.module}\``).join(', '));
    }
    if (astContext.referenced_globals && astContext.referenced_globals.length > 0) {
        astReport += localize("- 引用模組常數: {0}\n", astContext.referenced_globals.map(item => `\`${item.name}\``).join(', '));
    }
    if (astContext.class_context) {
        const init = astContext.class_context.init;
        const effectiveInit = astContext.class_context.effective_init;
        const inherited = effectiveInit && effectiveInit.defined_on !== astContext.class_context.name
            ? localize("；繼承建構子：`{0}({1})`", effectiveInit.defined_on, effectiveInit.params.join(', ') || localize("無"))
            : '';
        astReport += localize("- 類別語境: `{0}`，__init__ 參數：`{1}`，初始化屬性：`{2}`{3}\n", astContext.class_context.name, init.params.join(', ') || localize("無"), init.assigns.map(item => item.name).join(', ') || localize("無"), inherited);
    }
    if (astContext.callerContexts && astContext.callerContexts.length > 0) {
        astReport += localize("- 呼叫站語境 ({0} 個):\n", astContext.callerContexts.length);
        for (const ctx of astContext.callerContexts) {
            const argsStr = ctx.args.join(', ');
            const kwargsStr = Object.entries(ctx.kwargs as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(', ');
            const callSig = [argsStr, kwargsStr].filter(Boolean).join(', ');
            astReport += `  - \`${ctx.caller_file}\` / \`${ctx.caller_func}()\`: \`${astContext.name}(${callSig})\`\n`;
        }
    }
    if (astContext.dependencyContexts && astContext.dependencyContexts.length > 0) {
        for (const dep of astContext.dependencyContexts) {
            if (dep.callerContexts && dep.callerContexts.length > 0) {
                astReport += localize("- `{0}` 的呼叫站語境 ({1} 個):\n", dep.name, dep.callerContexts.length);
                for (const ctx of dep.callerContexts) {
                    const argsStr = ctx.args.join(', ');
                    const kwargsStr = Object.entries(ctx.kwargs as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(', ');
                    const callSig = [argsStr, kwargsStr].filter(Boolean).join(', ');
                    astReport += `  - \`${ctx.caller_file}\` / \`${ctx.caller_func}()\`: \`${dep.name}(${callSig})\`\n`;
                }
            }
        }
    }
    astReport += `\n`;
    return astReport;
}

async function resolveAstAndDependencies(
    filePath: string,
    funcName: string,
    projectRoot: string,
    pythonExecutable: string,
    log: (text: string) => void,
    beforeBehavior: (context: AstContext) => Promise<PreflightResult>,
    progressDirectory?: string,
    probeBehavior = true
): Promise<AstContext | null> {
    log(localize("[AST] 正在解析函式 `{0}` 的結構與依賴...", funcName));
    const astContext = await extractAstContext(filePath, funcName, pythonExecutable);
    if (!astContext || astContext.error) {
        return astContext;
    }
    log(localize("[AST] 解析完成！已擷取函式特徵與依賴。"));
    const environment = await beforeBehavior(astContext);
    astContext.dependencyResolution = environment.dependencies || [];
    astContext.dependencyContexts = [...(astContext.localDependencyContexts || [])];
    astContext.sourceVersions = [];
    if (astContext.retrieval?.selected) {
        log(localize("[AST] 已檢索 {0} 個同模組 helper，僅作來源語境，不新增執行觀測。", astContext.retrieval.selected));
    }

    if (astContext.dependencies && astContext.dependencies.length > 0) {
        log(localize("[AST] 發現跨檔案依賴！正在深度擷取相依模組原始碼..."));

        for (const dep of astContext.dependencies) {
            const resolved = environment.dependencies?.find(item => item.module === dep.module
                && item.name === dep.name && (item.level || 0) === (dep.level || 0));
            const depFilePath = resolved?.file;
            if (depFilePath && fs.existsSync(depFilePath)) {
                astContext.sourceVersions.push({ file: depFilePath, hash: evidenceHash(fs.readFileSync(depFilePath, 'utf8')) });
                const depAst = await extractAstContext(depFilePath, dep.name, pythonExecutable);
                if (depAst && !depAst.error) {
                    depAst.sourceHash = evidenceHash(depAst.code);
                    log(localize("[AST] 掃描 {0} 的呼叫站語境...", dep.name));
                    const callers = await findCallerContexts(dep.name, projectRoot, depFilePath, pythonExecutable);
                    if (callers.length > 0) {
                        depAst.callerContexts = callers;
                        log(localize("[AST] 找到 {0} 個呼叫點：{1}", callers.length, callers.map(c => `${c.caller_file}:${c.caller_func}`).join(', ')));
                    }
                    const dependencyTrace = probeBehavior
                        ? await runBehaviorProbe(depFilePath, dep.name, callers, pythonExecutable, [], progressDirectory) : undefined;
                    if (dependencyTrace && !dependencyTrace.load_error) {
                        depAst.traceResult = dependencyTrace;
                        log(localize("[行為探測] 相依 {0}：取得 {1} 個成功範例、{2} 個例外範例。", dep.name, dependencyTrace.examples.length, dependencyTrace.errors.length));
                    } else if (dependencyTrace?.load_error) {
                        log(localize("[行為探測] 相依 {0} 無法安全取得事實：{1}（保留原始碼語境，不中止分析）。", dep.name, dependencyTrace.load_error));
                    }
                    astContext.dependencyContexts.push(depAst);
                    log(localize("[AST] 成功擷取外部依賴: {0}.{1}", formatPythonImport(dep), dep.name));
                }
            } else {
                log(localize("[AST] 相依 {0}.{1} 未提供來源：{2}。", formatPythonImport(dep), dep.name, resolved?.reason || 'not-resolved-by-preflight'));
            }
        }
    }

    const selfCallers = await findCallerContexts(funcName, projectRoot, filePath, pythonExecutable);
    if (selfCallers.length > 0) {
        astContext.callerContexts = selfCallers;
        log(localize("[AST] 目標函式被呼叫 {0} 次，已收集所有呼叫語境。", selfCallers.length));
    }

    if (!probeBehavior) { return astContext; }
    log(localize("[行為探測] 正在受控執行函式以取得輸入輸出觀測..."));
    const traceResult = await runBehaviorProbe(filePath, funcName, astContext.callerContexts, pythonExecutable, [], progressDirectory);
    if (traceResult) { astContext.traceResult = traceResult; }
    if (traceResult && !traceResult.load_error) {
        astContext.traceResult = traceResult;
        const exCount = traceResult.examples.length;
        const errCount = traceResult.errors.length;
        const sourceLabel = traceResult.input_source === 'source_guided_retry'
            ? localize("（caller 字面值無效，已改用原始碼導向輸入）")
            : traceResult.input_source === 'caller_literals' ? localize("（含 caller 字面值）") : '';
        log(localize("[行為探測] 完成！取得 {0} 個成功範例、{1} 個例外觀測。{2}", exCount, errCount, sourceLabel));
    } else if (traceResult?.load_error) {
        log(localize("[行為探測] 受控執行失敗: {0}（將繼續使用靜態分析）", traceResult.load_error));
    }

    return astContext;
}

async function executeSingleFileAnalysis(params: AnalysisParams, log: (text: string) => void, sidebarProvider: AnalysisView) {
    const configured = vscode.workspace.getConfiguration('llmUnitTest').get<unknown>('targetBudget', {});
    const limits = configured && typeof configured === 'object' && !Array.isArray(configured)
        ? configured as Partial<TargetBudgetLimits> : {};
    const config = vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri?.file?.(params.filePath));
    const requestedRoot = (params as AnalysisParams & { batchPath?: string }).batchPath
        || config.get<string>('projectPath', '') || path.dirname(params.filePath);
    const relative = path.relative(requestedRoot, params.filePath);
    const root = relative.startsWith('..') || path.isAbsolute(relative) ? path.dirname(params.filePath) : requestedRoot;
    const fixtures = createImportFixturePlan(root, config.get<unknown>('importFixtures', []), config.get<string>('importFixtureRoot', ''));
    if (!fixtures && config.get<ImportFixtureRule[]>('importFixtures', []).length) {
        log(localize("[初始化設定] 本次未套用其他專案的設定；仍使用隔離預檢。"));
    }
    return withImportFixtures(fixtures, () => runWithTargetBudget(new TargetBudget(limits),
        () => executeSingleFileAnalysisWithBudget(params, log, sidebarProvider)));
}

async function executeSingleFileAnalysisWithBudget(params: AnalysisParams, log: (text: string) => void, sidebarProvider: AnalysisView) {
    params = { ...params, ...normalizeExecutionSettings(params) };
    const mode = verificationMode(params.validationMode);
    const gateDescription = mode === 'full' ? localize("結構、執行、覆蓋率與突變驗證") : localize("結構、真實目標呼叫與隔離執行驗證");
    throwIfExecutionCancelled();
    const modelSnapshot = currentExecution<ModelSnapshot>()?.snapshot
        ?? { current: currentModelProfile, stored: storedModelProfiles };
    let currentLoop = 1;
    let mutationScore = 0;
    let qualityToolsSatisfied = false;
    let bestMutation: MutationRun | undefined;
    // Rollback 保底：記錄歷史最高分的測試檔，防止後輪 LLM 改壞舊測試
    let bestScore = -1;
    let bestCode = '';
    let bestSurvivors = '';
    let bestExecution = '';
    let bestScenarios: ScenarioIdentity[] = [];
    let acceptedScenarios: ScenarioIdentity[] = [];
    let measuredQualityGaps: string[] = [];
    let bestMeasuredGaps: string[] = [];
    let bestGaps: string[] = [];
    let bestReviewWarnings: string[] = [];
    let bestReviewStatus: ReviewStatus = 'incomplete';
    let bestCoverage: RetainedCoverage | null = null;
    let bestTier: number | undefined;
    let qualityGaps: string[] = [];
    let reviewWarnings: string[] = [];
    let reviewStatus: ReviewStatus = 'incomplete';
    const reviewSession = new ReviewSession();
    let analystTasks = '';
    const qualityProgress = new QualityProgress(3);
    // Keep the qualified selection for reports and output paths, while using
    // the AST-confirmed leaf name when building Python calls and assertions.
    let targetFuncName = params.funcName;
    const pythonExecutable = normalizePythonExecutable(params.pythonExecutable);

    // ─── Tier 路由：依使用者設定或自動路由 ───
    const userTierSetting = params.promptStrategy || 'auto';
    // 複雜度評估（對無選擇函式時用預設分數）
    const dummyNameMarked = hasDummyFunctionNameMarker(params.funcName);
    let complexityScore = 30;
    if (params.funcName && !dummyNameMarked) {
        const comp = await assessFunctionComplexity(params.filePath, params.funcName, pythonExecutable);
        complexityScore = comp.score;
        log(localize("[Tier] 複雜度評估: {0}/100 ({1}){2}", comp.score, comp.level, comp.reasons.length > 0 ? ' - ' + comp.reasons.slice(0,2).join('; ') : ''));
    } else if (dummyNameMarked) {
        log(localize("[快速通道] 偵測到 dummy 名稱標記，跳過複雜度評估與後續 AST 分析。"));
    }
    const selectedEndpointKey = qualificationEndpointKey(params.envType, params.envType === 'local' ? params.ollamaUrl : params.envType === 'custom' ? params.customUrl : undefined);
    const selectedStoredProfile = findModelProfile(modelSnapshot.stored, {
        envType: params.envType,
        modelName: params.modelName, endpointKey: selectedEndpointKey
    });
    const activeModelProfile = selectedStoredProfile
        ? withBudget(selectedStoredProfile)
        : (modelSnapshot.current.envType === params.envType && modelSnapshot.current.modelName === params.modelName
            && (modelSnapshot.current.endpointKey || qualificationEndpointKey(params.envType)) === selectedEndpointKey
            ? modelSnapshot.current
            : defaultModelProfile());
    const modelParamBillion = parseFloat(activeModelProfile.paramSize);
    // When another model has already been probed in this session but the
    // selected one has no saved entry, retain the conservative Tier-1 gate.
    // A fresh extension with no probe data stays neutral for compatibility.
    const qualifiedForSelectedModel = qualificationForSelectedProfile(
        modelSnapshot.stored,
        { envType: params.envType, modelName: params.modelName, endpointKey: selectedEndpointKey },
        modelSnapshot.current.testGenerationReady !== undefined
    );
    const roleQualification = activeModelProfile.roleQualification;
    const currentQualification = activeModelProfile.qualificationVersion === QUALIFICATION_VERSION;
    const writerReady = qualifiedRole('writer', roleQualification, currentQualification, qualifiedForSelectedModel);
    const reviewerReady = qualifiedRole('reviewer', roleQualification, currentQualification);
    const fixerReady = qualifiedRole('bugFixer', roleQualification, currentQualification);
    const tier1GenerationMode = resolveTier1GenerationMode(writerReady, userTierSetting);
    const mayUseModelAuthoredTests = tier1GenerationMode === 'llm-evidence-bound';
    const mayUseModelAuthoredReview = canUseTierOneLlmGeneration(reviewerReady, userTierSetting);
    const mayUseModelAuthoredRepair = canUseModelAuthoredRepair(fixerReady, userTierSetting);
    const testGenerationResponseFormat = selectTestGenerationResponseFormat(activeModelProfile);
    const analysisResponseFormat = selectAnalysisResponseFormat(activeModelProfile);
    if (testGenerationResponseFormat === 'text') {
        log(localize("[模型能力] 此模型已驗證純 Python unittest 輸出；正式測試、語意分析與突變分流將不強制供應商 JSON schema。"));
    }
    if (qualifiedForSelectedModel === undefined) {
        log(userTierSetting === 'auto'
            ? mode === 'execution'
                ? localize("[模型能力] 此供應商／模型尚未完成 Writer 探測；執行驗證的 Auto 需要先透過「測試連線」確認生成能力。")
                : localize("[模型能力] 此供應商／模型尚未透過「測試連線」驗證 unittest 生成能力；Auto 會保守使用 Tier 1。測試連線以無副作用 fixture 實測可執行 unittest，並讀取供應商可提供的參數量／Context。")
            : localize("[模型能力] 此供應商／模型尚未完成 unittest 探測；依你的手動 Tier {0} 選擇繼續執行。輸出仍須通過{1}。", userTierSetting.replace('tier', ''), gateDescription));
    }
    const resolvedTier = resolveTier(
        modelParamBillion,
        complexityScore,
        userTierSetting,
        qualifiedForSelectedModel
    );
    // Tier 2 uses this for divide-and-conquer; it must derive from measured
    // capability, never from a finite list of vendor/model name fragments.
    let evalStrategy = selectPromptDetail(
        activeModelProfile.paramSize,
        activeModelProfile.contextLength,
        resolvedTier
    );
    if (qualifiedForSelectedModel === false && userTierSetting !== 'auto') {
        log(localize("[模型能力] 此模型尚未通過 unittest 探測；保留你的手動 Tier 選擇，並以{0}檢查每次輸出。", gateDescription));
    }
    log(mode === 'execution' ? localize("[系統] 執行驗證：使用來源與明確 Mock 生成測試，延後完整品質流程。")
        : localize("[系統] 策略路由: {0} → Tier {1}", userTierSetting === 'auto' ? localize("Auto 自動") : localize("使用者指定"), resolvedTier));

    if (!params.filePath || !fs.existsSync(params.filePath)) {
        log(localize("[錯誤] 找不到目標檔案路徑"));
        return;
    }

    let survivedMutants = "";
    let tier1GenerationModeRecorded = false;
    const reportDateStr = new Date().toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let currentTier = resolvedTier;
    let finalReportMarkdown = localize("# {0}\n\n- **目標檔案**: {1}\n- **測試函式**: {2}\n- **起始生成方式**: {3}\n- **日期**: {4}\n\n", mode === 'execution' ? localize("執行驗證與修復報告") : localize("突變測試與修復分析報告"), params.filePath, params.funcName || localize("全檔案"), mode === 'execution' ? localize("來源與明確 Mock 測試假設；採執行驗證流程") : 'Tier ' + currentTier, reportDateStr);
    finalReportMarkdown += formatReportProvenance({
        ...extensionBuildIdentity,
        modelProvider: params.envType,
        modelName: params.modelName,
        requestedTier: userTierSetting,
        resolvedTier,
        qualified: qualifiedForSelectedModel,
        roleQualification,
        qualificationReason: activeModelProfile.testGenerationReason,
        qualificationMode: activeModelProfile.testGenerationMode,
    });

    const initialSource = fs.readFileSync(params.filePath, 'utf8');
    const baseDir = params.outputPath || path.dirname(params.filePath);
    
    // 建立本次測試的專屬資料夾
    const dateStr = params.sessionDate || formatSessionDate();
    const safeFuncName = params.funcName || 'file';
    const projectRoot = (params as any).batchPath
        || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(params.filePath);
    const displayFile = params.projectName ? path.relative(projectRoot, params.filePath) : path.basename(params.filePath);
    const displayName = params.funcName ? `${displayFile}:${params.funcName}` : displayFile;
    throwIfExecutionCancelled();
    const reportRoot = createAnalysisDirectory(baseDir, dateStr, params.filePath, safeFuncName, params.projectName, projectRoot,
        params.batchJournal?.directory);
    if (params.batchJournal && params.batchTargetId !== undefined) { params.batchJournal.attach(params.batchTargetId, reportRoot); }
    const sessionDir = createResultLayout(reportRoot);
    let existingReport = path.join(reportRoot, 'final_report.md');
    const reportIdentity: ReportIdentity = { schemaVersion: 'target-report-v1', sourcePath: params.filePath,
        sourceFile: path.relative(projectRoot, params.filePath).replace(/\\/g, '/'),
        target: params.funcName || 'file', modelIdentity: `${params.envType}/${params.modelName}`, requestedTier: userTierSetting };

    // dummy 是使用者明確標記的雜訊／佔位函式。名稱判定可在 AST 前完成，
    // 讓大量 dummy 函式不會逐一觸發 AST、Trace、LLM 或突變測試。
    if (dummyNameMarked) {
        finalReportMarkdown += localize("## 🚀 Dummy 標記快速通道\n\n");
        finalReportMarkdown += localize("> [!NOTE]\n> 函式名稱包含明確 `dummy` token，已依使用者標記略過 AST、受控行為探測、LLM 與突變測試。\n\n");
        finalReportMarkdown += localize("- **測試狀態**: 已略過（Dummy／雜訊函式）\n");
        finalReportMarkdown += localize("- **突變分數**: N/A（使用者標記為 Dummy／雜訊函式）\n");
        throwIfExecutionCancelled();
        existingReport = path.join(sessionDir, 'workflow_report.md');
        fs.writeFileSync(existingReport, withOutcomeHeader(finalReportMarkdown, { terminalStatus: 'dummy-skipped' }), 'utf-8');
        sidebarProvider.webview?.postMessage({ command: 'updateOutcome', fileName: displayName, file: displayFile,
            func: params.funcName || '', reportPath: existingReport, outcome: presentOutcome({ terminalStatus: 'dummy-skipped' }) });
        if (params.batchJournal && params.batchTargetId !== undefined) { params.batchJournal.dummy(params.batchTargetId); }
        log(localize("[快速通道] ✅ Dummy 函式 {0} 已略過；結果已寫入 {1}", params.funcName, existingReport));
        return;
    }

    const qualityPolicy = createDefaultQualityPolicy();
    const journal = new AnalysisJournal(sessionDir, initialSource, params.funcName || 'file', params.modelName,
        mode === 'full' ? qualityPolicy : undefined, mode, reportIdentity);
    finalReportMarkdown += localize("- **驗證目標**: {0}\n", mode === 'execution' ? localize("執行驗證（Trace、覆蓋率、突變與品質審查延後）") : localize("完整品質驗證"));
    const tierHistory: TierHistory = { requested: userTierSetting, initial: resolvedTier, rounds: [], transitions: [] };
    if (mode === 'full') { journal.knowledge({ tierHistory }); }
    const qualityAnalystSession = new QualityAnalystSession();
    const writeReport = (body = finalReportMarkdown) => {
        existingReport = writeTargetReports(sessionDir, reportIdentity, journal.sourceHash, journal.runId, journal.snapshot(), body);
    };
    const importFixtures = currentImportFixtures();
    if (importFixtures) {
        fs.writeFileSync(path.join(sessionDir, 'import_fixtures.json'), JSON.stringify(importFixtures, null, 2), 'utf8');
        journal.knowledge({ importFixtureId: importFixtures.id, importFixtureContract: 'import-fixtures-v1' });
        finalReportMarkdown += localize("\n- **匯入測試設定**: {0}（import_fixtures.json）。初始化外部操作使用明確 mock；未驗證真實目錄建立、設定檔或介面啟動。\n", importFixtures.id);
    }
    const checkpoints = new CandidateCheckpointStore(sessionDir, journal.sourceHash, params.funcName || 'file', {
        policy: qualityPolicy, sourcePath: params.filePath,
        targetScope: { kind: params.funcName ? 'function' : 'module', qualifiedName: params.funcName || 'module' }
    });
    const recordRole = (stage: string, status: string, detail: unknown) => {
        const diagnosticReport = journal.record(currentLoop, stage, status, detail);
        const description = describeStageEvent(stage, status, detail, mode);
        log(`[${stage}] ${description}`);
        finalReportMarkdown += localize("- **角色事件**: {0} / {1}：{2}（完整證據：role_events.jsonl）\n", stage, status, description);
        finalReportMarkdown += diagnosticReport + (stage === 'repair-routing' ? formatRepairRouting(detail) : '');
        writeReport();
    };
    const requestBudgeted = async (
        requestParams: AnalysisParams, system: string, prompt: string,
        requestLog: (text: string) => void, format: CustomOutputFormat = 'text',
        role: 'writer' | 'writer-revision' | 'reviewer' | 'bug-fixer' | 'analyst-planning' | 'analyst-quality' = 'writer',
        sharedDeadlineAt?: number
    ): Promise<string> => {
        if (importFixtures) {
            prompt += '\n\n[Import test setup] The original module runs under the saved import-fixtures-v1 contract. '
                + 'Declared module-level external initialization is mocked. Observations apply only under that setup; '
                + 'do not claim real filesystem, configuration-file, or GUI startup behavior was tested. '
                + 'Function execution retains the normal isolation policy and requires its own explicit dependency mocks.';
        }
        const contractedSystem = addOutputContract(system, format);
        const contextWindow = runtimeContextWindow(activeModelProfile.paramSize, activeModelProfile.contextLength);
        const metrics = { role, format, estimatedInputTokens: estimateTokens(contractedSystem + '\n' + prompt),
            inputBudget: activeModelProfile.budgetTokens,
            contextWindow,
            writerContext: prompt.startsWith(COMPACT_WRITER_VERSION) ? COMPACT_WRITER_VERSION : undefined };
        if (!promptFits(contractedSystem, prompt, activeModelProfile.budgetTokens)) {
            recordRole('model-request', 'budget-exceeded', metrics);
            throw new AnalysisStageError('validation', 'prompt-budget',
                localize("完整角色提示超過模型輸入預算；保留來源與執行證據，未發送或截斷提示。"), metrics);
        }
        const started = Date.now();
        currentTargetBudget()?.consumeModelRequest();
        recordRole('model-request', 'requested', metrics);
        try {
            const deadline = Math.min(sharedDeadlineAt ?? deadlineAtFromTimeoutSeconds(requestParams.timeoutSeconds),
                currentTargetBudget()?.deadlineAt ?? Infinity);
            const response = await requestLlmApi({ ...requestParams, requestContextTokens: contextWindow }, system, prompt, requestLog, format, deadline);
            recordRole('model-request', 'completed', { ...metrics, elapsedMs: Date.now() - started });
            return response;
        } catch (error) {
            recordRole('model-request', 'error', { ...metrics, elapsedMs: Date.now() - started,
                category: error instanceof AnalysisStageError ? error.category : 'unknown',
                reason: error instanceof AnalysisStageError ? `${error.stage}: ${error.category}` : 'model request failed' });
            throw error;
        }
    };
    finalReportMarkdown += localize("- **執行識別**: {0}\n- **來源版本**: {1}\n\n", journal.runId, journal.sourceHash);
    recordRole('pipeline', 'running', { target: params.funcName });
    try {
    let astContext: AstContext | null = null;
    const targetDir = path.dirname(params.filePath);
    let preflight: Awaited<ReturnType<typeof preflightTargetModule>> | undefined;
    const checkEnvironment = async (context: AstContext | null) => {
        const module = inferTargetImportModule(params.filePath, context?.file_imports || []);
        journal.knowledge({ sourceStructure: context?.code || null, sourceContext: context,
            initialTargetObservations: null, roleQualification: roleQualification || null });
        preflight = await preflightTargetModule(pythonExecutable, params.filePath, module,
            [targetDir, path.dirname(targetDir), path.dirname(path.dirname(targetDir)), projectRoot, sessionDir], sessionDir,
            context?.dependencies || [], projectRoot);
        recordRole('environment', 'passed', { module: preflight.module, importFixtures: preflight.importFixtures });
        return preflight;
    };
    if (params.funcName) {
        const projectRoot = (params as any).batchPath
            ? (params as any).batchPath
            : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(params.filePath);
        astContext = await resolveAstAndDependencies(
            params.filePath,
            params.funcName,
            projectRoot,
            pythonExecutable,
            log,
            checkEnvironment,
            sessionDir,
            mode === 'full'
        );
        if (astContext && !astContext.error) {
            targetFuncName = astContext.name || targetFuncName;
            finalReportMarkdown += buildAstMarkdownReport(astContext);
        } else {
            throw new AnalysisStageError('ast-trace', 'static-analysis', astContext?.error || localize("無法解析選取的目標函式；未退回其他目標。"));
        }
    }
    const targetImportModule = inferTargetImportModule(params.filePath, astContext?.file_imports || []);
    const testBindingContext = {
        module: targetImportModule,
        target: targetFuncName,
        className: astContext?.class_name,
        source: astContext?.code,
        dependencies: Object.fromEntries((astContext?.file_imports || [])
            .filter((item: any) => item.kind === 'from' && item.name && item.name !== '*'
                && (astContext?.calls || []).includes(item.alias || item.bound_name || item.name))
            .map((item: any) => [item.alias || item.bound_name || item.name, `${item.module}.${item.name}`])) as Record<string, string>
    };
    if (astContext && !astContext.error) {
        astContext.target_import_module = targetImportModule;
    }
    journal.knowledge({ sourceStructure: astContext?.code || null, sourceContext: astContext,
        initialTargetObservations: astContext?.traceResult || null, importContract: testBindingContext,
        roleQualification: roleQualification || null });
    if (!preflight) { await checkEnvironment(astContext); }
    const testExecutionEnv = buildGeneratedTestEnvironment(process.env, preflight!.importPaths);

    if (mode === 'execution') {
        if (!astContext || !params.funcName) {
            throw new AnalysisStageError('ast-trace', 'static-analysis', localize("執行驗證需要明確的函式目標。"));
        }
        journal.knowledge({ traceStatus: 'deferred', coverage: null, mutationScore: null,
            mutationStatus: 'deferred', reviewStatus: 'deferred', qualityAssessment: null });
        if (!mayUseModelAuthoredTests) {
            throw new AnalysisStageError('validation', 'writer-qualification',
                localize("Auto 的 Writer 尚未通過此模型的生成探測。請先執行「測試連線」，或明確選擇手動 Tier；執行驗證模式不會改用 Trace 代替生成。"));
        }
        const evidence = getReviewEvidence('', '', targetFuncName, astContext.args, astContext.code,
            astContext, targetImportModule, undefined,
            Object.keys(testBindingContext.dependencies).map(name => `${targetImportModule}.${name}`))
            + '\nCaller setup context (source literals are input hints, not output facts):\n'
            + JSON.stringify(astContext.callerContexts || []);
        const accepted = await runExecutionVerification({ directory: sessionDir, artifactDirectory: roundDirectory(sessionDir, 1), file: params.filePath,
            target: params.funcName, python: pythonExecutable, env: testExecutionEnv,
            targetModule: targetImportModule,
            dependencies: astContext.sourceVersions || [], journal,
            generate: async () => sanitizeLlmResponse(await requestBudgeted(params,
                getExecutionWriterSystemPrompt(), getExecutionWriterPrompt(evidence), log, testGenerationResponseFormat)),
            hooks: {
                event: recordRole,
                validate: async code => {
                    const result = await validateGeneratedTestCode(code, targetFuncName, targetImportModule,
                        astContext.method_kind === 'property' ? 'property' : 'call', astContext.signature,
                        exceptionNamesFromEvidence(astContext), astContext.class_name, pythonExecutable, testBindingContext);
                    return result.valid ? undefined : result.reason || 'Structure validation failed';
                },
                repairRole: (code, failure) => canRepairTestMethod(code, failure) ? 'bug-fixer' : 'writer',
                revise: async (code, failure, role, attempt) => {
                    if (role === 'bug-fixer' && !mayUseModelAuthoredRepair) {
                        throw new AnalysisStageError('validation', 'fixer-qualification', localize("Auto 的 Bug Fixer 尚未通過資格探測；已保存失敗測試。"));
                    }
                    const system = role === 'bug-fixer' ? getBugFixerSystemPrompt() : getExecutionWriterSystemPrompt();
                    const prompt = role === 'bug-fixer'
                        ? getBugFixerUserPrompt(code, failure, targetFuncName, astContext.args, astContext.code,
                            astContext, targetImportModule, undefined,
                            Object.keys(testBindingContext.dependencies).map(name => `${targetImportModule}.${name}`))
                        : getExecutionWriterPrompt(evidence, code, failure);
                    const raw = await requestBudgeted(params, system, prompt, log,
                        role === 'bug-fixer' ? 'text' : testGenerationResponseFormat,
                        role === 'bug-fixer' ? 'bug-fixer' : 'writer-revision');
                    if (role !== 'bug-fixer') { return sanitizeLlmResponse(raw); }
                    const merged = mergeBugFixReplacementDetailed(raw, code, failure);
                    if (merged.diagnostic) {
                        recordRole('bug-fixer', 'format-rejected', { attempt, category: 'model-format', diagnostic: merged.diagnostic });
                        throw new RepairResponseError(merged.diagnostic);
                    }
                    if (merged.normalization) { recordRole('bug-fixer', 'format-normalized', { attempt, ...merged.normalization }); }
                    return merged.code!;
                },
                validateRevision: async (previous, candidate, failure, role) => {
                    if (role !== 'bug-fixer') { return undefined; }
                    const result = await runSpawn(pythonExecutable, ['-B', pythonToolPath('repairScope')], {
                        input: JSON.stringify({ contractVersion: ROLE_CONTRACT_VERSIONS.bugFix, previous, candidate, failure }),
                        timeout: 5000, env: testExecutionEnv
                    });
                    if (result.code !== 0) { return { reason: localize(REPAIR_REASON_LABELS['scope-tool-error']), reasonCode: 'scope-tool-error' }; }
                    try {
                        const value = JSON.parse(result.stdout);
                        const reasonCode = repairReasonCode(value.reasonCode);
                        return value.valid === true ? undefined : { reason: localize(REPAIR_REASON_LABELS[reasonCode]), reasonCode };
                    } catch {
                        return { reason: localize(REPAIR_REASON_LABELS['scope-result-invalid']), reasonCode: 'scope-result-invalid' };
                    }
                }
            }
        });
        finalReportMarkdown += localize("\n### 執行驗證結果\n\n- 已執行測試：[{0}]({1})\n", accepted.testFile, accepted.testFile)
            + localize("- 已驗證真實目標呼叫、有效案例與隔離完成；結果綁定本次來源及測試版本。\n")
            + localize("- Trace、覆蓋率、突變及品質審查：未執行；完整品質尚未驗證。\n")
            + localize("- 這份結果只涵蓋已執行案例與明確 mock 設定，不代表整個應用程式或所有需求正確。\n")
            + `\n\`\`\`text\n${journal.snapshot().execution}\n\`\`\`\n`;
        const expectationRepair = journal.snapshot().expectationRepair as { file: string; candidateTestHash: string } | undefined;
        if (expectationRepair) {
            const applied = expectationRepair.candidateTestHash === accepted.testHash;
            finalReportMarkdown += localize("\n- **預期值修正**：{0}計算依據：[{1}]({2})。這只驗證與來源行為一致，不代表獨立需求正確性。\n", applied ? localize("依原始碼與案例輸入進行有界算術計算，修正失敗案例的預期常數後重新執行通過。") : localize("曾提出來源算術修正；最後採用另一次修訂，該提案不代表最終測試。"), expectationRepair.file, expectationRepair.file);
        }
        writeReport();
        sidebarProvider.webview?.postMessage({ command: 'updateCoverage', fileName: displayName, file: displayFile,
            func: params.funcName, score: 'N/A', coverage: null, reason: localize("執行驗證通過；完整品質尚未驗證"), reportPath: existingReport });
        if (!params.batchJournal) {
            const document = await vscode.workspace.openTextDocument(existingReport);
            throwIfExecutionCancelled();
            await vscode.window.showTextDocument(document, { preview: false });
        }
        return;
    }

    // ─── 優化一：Stub/Dummy 函式快速通道 ───
    // 若函式為純 Stub（pass/return None/return <literal>），跳過 LLM + 突變測試
    if (params.funcName && isStubFunction(astContext)) {
        log(localize("[快速通道] 🚀 偵測到 Stub/Dummy 函式（複雜度 {0}/100），直接生成最小 Smoke Test，跳過 LLM 呼叫與突變測試。", complexityScore));
        const moduleName = targetImportModule;
        const className = astContext?.class_context?.name as string | undefined;
        const args: string[] = astContext?.args || [];
        const methodKind = (astContext?.method_kind || 'module') as
            'module' | 'instance' | 'static' | 'class' | 'property';
        const requiredConstructorParams = (astContext?.class_context?.effective_init?.required_params
            || astContext?.class_context?.init?.required_params
            || []) as string[];
        const stubPlan = buildStubTestPlan(
            moduleName,
            targetFuncName,
            args,
            className,
            methodKind,
            requiredConstructorParams,
            astContext?.callerContexts
        );
        if (!stubPlan) {
            const reason = localize("類別 {0} 的建構子需要 {1}，但找不到可驗證的 caller literal 設定。", className, requiredConstructorParams.join(', '));
            finalReportMarkdown += localize("## 🚀 快速通道結果\n\n> [!WARNING]\n> 此函式為 Stub/Dummy，但無法安全建立實例：{0} 未產生測試，也未呼叫 LLM。\n", reason);
            throwIfExecutionCancelled();
            journal.knowledge({ terminalStatus: 'stub-skipped', reason });
            writeReport();
            log(localize("[快速通道] ⏭️ {0} 已安全略過。", reason));
            return;
        }
        const smokeAssertion = buildStubSmokeAssertion(astContext?.code || '');
        const smokeBody = smokeAssertion
            ? [
                `        ${stubPlan.callLine}`,
                `        ${smokeAssertion}`,
            ]
            : [
                `        try:`,
                `            ${stubPlan.callLine}`,
                `        except Exception as e:`,
                `            self.fail(f"Stub function raised an exception: {e}")`,
            ];

        const smokeTest = [
            `import unittest`,
            stubPlan.importLine,
            ``,
            `class TestStub${targetFuncName}(unittest.TestCase):`,
            stubPlan.setupBlock,
            `    def test_smoke_no_exception(self):`,
            `        """Smoke test with an exact assertion when the stub body is static."""`,
            ...smokeBody,
            ``,
            `if __name__ == '__main__':`,
            `    unittest.main()`,
        ].join('\n');

        const testPath = path.join(roundDirectory(sessionDir, 1), 'loop1_test.py');
        fs.mkdirSync(path.dirname(testPath), { recursive: true });
        throwIfExecutionCancelled();
        fs.writeFileSync(testPath, smokeTest, 'utf-8');

        finalReportMarkdown += localize("## 🚀 快速通道結果\n\n");
        finalReportMarkdown += localize("> [!NOTE]\n> 此函式為 Stub/Dummy 函式（複雜度 {0}/100），已跳過 LLM 生成與突變測試，直接產出最小 Smoke Test。\n\n", complexityScore);
        finalReportMarkdown += localize("- **突變分數**: N/A（函式無可突變的業務邏輯）\n");
        finalReportMarkdown += localize("- **生成測試**: `{0}`\n\n", testPath);
        finalReportMarkdown += `\`\`\`python\n${smokeTest}\n\`\`\`\n`;

        throwIfExecutionCancelled();
        journal.knowledge({ terminalStatus: 'stub-smoke-generated', executionVerified: false });
        writeReport();
        log(localize("[快速通道] ✅ Stub 函式 {0} 處理完成！Smoke Test 已寫入 {1}", params.funcName, testPath));
        // 依需求：Stub/Dummy 函式不顯示在 UI 測試列表中，避免洗版
        return;
    }

    // 發送開始測試狀態給 Webview
    sidebarProvider.webview?.postMessage({
        command: 'updateCoverage',
        fileName: displayName,
        file: displayFile,
        func: params.funcName || '',
        score: '測試中',
        coverage: null,
        reason: localize("分析中..."),
        reportPath: ''
    });

    // ─── 語意分析師（Semantic Analyzer）───────────────────────────
    // 對所有函式啟動（不限有跨檔案相依的函式）：
    //   1. 計算各相依函式在此呼叫情境的固定行為（原有功能）
    //   2. 推導此函式的最佳測資策略（新功能）—— AI 決定邊界值，不再硬編碼
    const coverageProbe = await runSpawn(pythonExecutable, ['-c', 'import coverage'], { env: testExecutionEnv, timeout: 5000 });
    if (coverageProbe.code !== 0) {
        throw new AnalysisStageError('environment', 'coverage-preflight', coverageRequiredMessage(pythonExecutable));
    }
    const evidenceStillCurrent = () => {
        try {
            return evidenceHash(fs.readFileSync(params.filePath, 'utf8')) === journal.sourceHash
                && (astContext?.sourceVersions || []).every(version => fs.existsSync(version.file)
                    && evidenceHash(fs.readFileSync(version.file, 'utf8')) === version.hash);
        } catch { return false; }
    };
    const invalidateSourceEvidence = () => {
        const retained = checkpoints.quality || checkpoints.executable;
        journal.knowledge({ terminalStatus: 'source-changed', evidenceValid: false,
            mutationScore: null, mutationStatus: 'invalidated', coverage: null, retainedScore: null, qualityAssessment: null,
            historicalBaseline: retained ? { codeHash: retained.codeHash,
                sourceHash: retained.sourceHash, artifactOnly: true } : null });
        finalReportMarkdown += localize("\n> 來源或相依版本已改變；保留檔案僅供歷史查看，舊覆蓋與突變結果不適用於目前來源。\n");
    };
    const targetSourceHash = evidenceHash(astContext?.code || initialSource);
    let semanticPlan: SemanticAnalysis | undefined;
    let semanticPlanContract: SemanticPlanV2 | undefined;
    let supplementalTargetObservations: BehaviorProbeResult | undefined;
    const initialTargetObservations = astContext?.traceResult;
    const semDeps = ((astContext?.dependencyContexts || []) as any[])
        .filter((dependency: any) => dependency.code)
        .map((dependency: any) => ({
            name: dependency.name as string,
            code: dependency.code as string,
            sourceHash: evidenceHash(dependency.code as string),
            observations: dependency.traceResult as BehaviorProbeResult | undefined
        }));
    const semCallSites = ((astContext?.callerContexts) as any[] | undefined)
        ?.map((caller: any) => ({
            caller_func: caller.caller_func as string || '',
            call_expr: caller.call_expr as string || ''
        })) || [];
    recordRole('evidence-collection', 'static-ready', {
        contractVersion: ROLE_CONTRACT_VERSIONS.analystEvidence,
        targetSourceHash,
        targetParameters: astContext?.args || [],
        callSiteCount: semCallSites.length,
        dependencyCount: semDeps.length,
        retrieval: astContext?.retrieval
    });
    recordRole('behavior-probe', initialTargetObservations && !initialTargetObservations.load_error
        ? 'initial-ready' : 'initial-unavailable', {
        phase: 'initial',
        summary: summarizeObservationPhase(initialTargetObservations),
        observations: initialTargetObservations || null
    });
    if (astContext && !astContext.error && mayUseModelAuthoredTests) {
        log(localize("[語意分析師] 啟動語意前置分析（分析依賴行為 + 推導測資策略）..."));
        try {
            const semSys = buildSemanticAnalyzerSystemPrompt();
            const semUsr = getSemanticAnalyzerUserPrompt(
                {
                    schemaVersion: 'analysis-evidence-v2',
                    target: {
                        moduleName: targetImportModule,
                        functionName: targetFuncName,
                        source: astContext.code || '',
                        sourceHash: targetSourceHash
                    },
                    astFacts: astContext,
                    callSites: semCallSites,
                    dependencies: semDeps,
                    initialTargetObservations
                }
            );
            const semRaw = await requestBudgeted(
                params, semSys, semUsr, log,
                analysisResponseFormat === 'text' ? 'text' : 'semantic-json', 'analyst-planning'
            );
            const parsedSemResult = parseSemanticAnalysis(semRaw);
            if (parsedSemResult) {
                const semResult = restrictSemanticInputHintsToTargetParameters(
                    parsedSemResult,
                    Array.isArray(astContext.args) ? astContext.args : undefined
                );
                semanticPlan = semResult;
                semanticPlanContract = {
                    schemaVersion: 'semantic-plan-v2',
                    sourceHash: targetSourceHash,
                    hypotheses: semResult,
                    provenance: 'model-hypothesis'
                };
                recordRole('analyst-planning', 'parsed-hypotheses', {
                    inputContractVersion: ROLE_CONTRACT_VERSIONS.analystEvidence,
                    outputContractVersion: ROLE_CONTRACT_VERSIONS.semanticPlan,
                    raw: semRaw,
                    result: semanticPlanContract
                });
                const hasStrategy = semResult.test_strategy?.input_hints?.length > 0;
                log(localize("[語意分析師] ✅ 分析完成！相依行為: {0} 個、候選不可達路徑: {1} 個、測資策略參數提示: {2} 個。", semResult.dependency_behaviors.length, semResult.unreachable_paths.length, hasStrategy ? semResult.test_strategy.input_hints.length : 0));
            } else {
                recordRole('analyst-planning', 'invalid-response', {
                    inputContractVersion: ROLE_CONTRACT_VERSIONS.analystEvidence,
                    outputContractVersion: ROLE_CONTRACT_VERSIONS.semanticPlan,
                    raw: semRaw,
                    result: null
                });
                log(localize("[語意分析師] ⚠️ 回應未符合語意分析 schema，改用程式碼特徵規則基線（不影響主流程）。"));
            }
        } catch (semErr: any) {
            recordRole('analyst-planning', 'failed', { reason: semErr.message });
            log(localize("[語意分析師] ⚠️ 語意分析呼叫失敗: {0}，繼續主流程。", semErr.message));
        }
    } else {
        recordRole('analyst-planning', 'skipped', {
            reason: astContext?.error ? 'AST unavailable' : 'model-authored tests unavailable'
        });
    }

    // The Analyst plans scenarios first. The deterministic dispatcher then
    // selects only source/AST-supported rules for Writer.
    const ruleSelection = dispatchTestRules(
        astContext?.code || '',
        astContext || undefined,
        semanticPlan
    );
    const deterministicRuleIds = ruleSelection.ids;
    recordRole('rule-dispatcher', 'deterministic', ruleSelection);

    if (semanticPlan && astContext && !astContext.error) {
        const supplementalInputs = buildSupplementalProbeInputs(
            semanticPlan,
            astContext.signature
        );
        if (supplementalInputs.length > 0) {
            log(localize("[補充行為探測] 正在以 {0} 組安全純量輸入取得真實 I/O...", supplementalInputs.length));
            const supplementalObservations = await runBehaviorProbe(
                params.filePath,
                params.funcName,
                astContext.callerContexts,
                pythonExecutable,
                supplementalInputs,
                sessionDir
            );
            if (supplementalObservations) {
                supplementalTargetObservations = supplementalObservations;
                if (!supplementalObservations.load_error) {
                    const mergedObservations = mergeBehaviorProbeResults(
                        astContext.traceResult,
                        supplementalObservations
                    );
                    astContext.traceResult = mergedObservations;
                    log(localize("[補充行為探測] 完成！新增輸入已實測；目前共 {0} 個成功範例、{1} 個例外範例。", mergedObservations.examples.length, mergedObservations.errors.length));
                } else {
                    log(localize("[補充行為探測] 無法安全執行：{0}（保留原有行為觀測）。", supplementalObservations.load_error));
                }
            }
            recordRole('behavior-probe', supplementalTargetObservations && !supplementalTargetObservations.load_error
                ? 'supplemental-ready' : 'supplemental-unavailable', {
                phase: 'supplemental',
                inputCount: supplementalInputs.length,
                summary: summarizeObservationPhase(supplementalTargetObservations),
                observations: supplementalTargetObservations || null
            });
        } else {
            recordRole('behavior-probe', 'supplemental-skipped', {
                phase: 'supplemental',
                reason: localize("分析師未提出可安全解析且能滿足函式簽章的純量輸入。")
            });
        }
    }
    const analystGuidance = semanticPlan
        ? formatSemanticContextForPrompt(semanticPlan, semDeps)
        : '=== ANALYST PLAN UNAVAILABLE ===\nUse only source, AST, and verified controlled-execution observations.\n';
    const semanticContext = `${analystGuidance}\n${ruleSelection.guidance}`;
    const writerEvidenceBundle: WriterEvidenceBundleV3 = {
        schemaVersion: 'writer-evidence-v3',
        sourceHash: targetSourceHash,
        semanticGuidance: semanticContext,
        semanticPlan: semanticPlanContract,
        ruleSelection,
        initialTargetObservations,
        supplementalTargetObservations,
        mergedTargetObservations: astContext?.traceResult,
        evidencePriority: [
            'executed-observations',
            'explicit-source-paths',
            'ast-structure',
            'analyst-hypotheses-and-rule-guidance'
        ]
    };
    recordRole('writer-handoff', 'ready', {
        contractVersion: ROLE_CONTRACT_VERSIONS.writerEvidence,
        sourceHash: writerEvidenceBundle.sourceHash,
        initialObservationSummary: summarizeObservationPhase(initialTargetObservations),
        supplementalObservationSummary: summarizeObservationPhase(supplementalTargetObservations),
        mergedObservationSummary: summarizeObservationPhase(astContext?.traceResult),
        selectedRuleIds: deterministicRuleIds
    });
    journal.knowledge({
        planningHypotheses: semanticPlanContract || null,
        initialTargetObservations: initialTargetObservations || null,
        supplementalTargetObservations: supplementalTargetObservations || null,
        verifiedObservations: astContext?.traceResult || null,
        dependencies: astContext?.dependencyContexts,
        selectedRules: ruleSelection
    });
    if (semanticPlan) {
        finalReportMarkdown += localize("\n### 🧠 語意分析師報告\n\n```\n{0}\n```\n\n", analystGuidance);
    }
    finalReportMarkdown += localize("\n### 測試生成規則\n\n{0}\n\n", deterministicRuleIds.map(id => `- ${id}`).join('\n') || localize("- 無"));
    log(mayUseModelAuthoredTests
        ? localize("[測試生成規則] 分析完成後選取：{0}。", deterministicRuleIds.join(', ') || localize("無"))
        : localize("[測試生成規則] 模型尚未驗證；使用 AST 確定性規則：{0}。", deterministicRuleIds.join(', ') || localize("無")));

    while (currentLoop <= params.maxLoops && !qualityToolsSatisfied) {

        if (isExecutionCancelled()) {
            log(localize("[系統] ⚠️ 測試已由使用者強制中止。"));
            break;
        }

        log(localize("\n--- 🔄 第 {0} 輪開始 ---", currentLoop));
        currentTier = resolvedTier;
        tierHistory.rounds.push({ loop: currentLoop, start: currentTier });
        journal.knowledge({ tierHistory });
        recordRole('tier', 'started', { tier: currentTier, requested: userTierSetting });
        finalReportMarkdown += localize("## 第 {0} 輪測試\n", currentLoop);

        let targetCode: string;
        try {
            targetCode = fs.readFileSync(params.filePath, 'utf-8');
            if (!evidenceStillCurrent()) {
                recordRole('source', 'changed', { reason: localize("來源版本已改變；停止沿用舊行為觀測與品質證據。") });
                invalidateSourceEvidence();
                sidebarProvider.webview?.postMessage({ command: 'updateCoverage', fileName: displayName,
                    file: displayFile, func: params.funcName || '', score: 'N/A', coverage: null,
                    reason: localize("來源已變更；舊成果僅供歷史查看，需重新分析") });
                break;
            }
        } catch {
            log(localize("[錯誤] 讀取檔案失敗"));
            invalidateSourceEvidence();
            sidebarProvider.webview?.postMessage({ command: 'updateCoverage', fileName: displayName,
                file: displayFile, func: params.funcName || '', score: 'N/A', coverage: null,
                reason: localize("無法核對來源；舊成果僅供歷史查看，需重新分析") });
            break;
        }

        // 每輪結果獨立保存；跨輪證據留在 sessionDir。
        const loopDir = roundDirectory(sessionDir, currentLoop);
        fs.mkdirSync(loopDir, { recursive: true });
        const testPath = path.join(loopDir, `loop${currentLoop}_test.py`);
        const testDir = path.dirname(testPath);
        const reportDir = path.join(loopDir, `loop${currentLoop}_report`);

        let systemPrompt = getSystemPrompt(currentLoop, evalStrategy as 'small' | 'large', survivedMutants, params.modelName);
        let focusContext = "";
        if (currentLoop > 1 && (survivedMutants || qualityGaps.length)) {
            focusContext = extractFocusContext(survivedMutants, targetCode);
            if (focusContext) {
                log(localize("[動態焦點] 已擷取 {0} 個突變體焦點區塊，準備進行精準修復。", focusContext.split(localize("【目標變異體】")).length - 1));
            }
            // 最優解錨定：將歷史最高分的測試嵌入到 focusContext，明確禁止 LLM 刪除修改
            if (bestCode) {
                const bestBlock = `=== EXISTING VERIFIED TESTS (DO NOT DELETE OR MODIFY THESE METHODS) ===\n${bestCode}\n=== END OF EXISTING TESTS ===\n\n`;
                focusContext = bestBlock + focusContext;
                log(localize("[最優解錨定] 已將歷史最優測試集（{0}%）嵌入到 Prompt，防止 LLM 改壞舊斷言。", bestScore));
            }
        }

        if (qualityGaps.length || analystTasks) {
            focusContext += '\n=== NEXT QUALITY TASKS (hypotheses; validate before acceptance) ===\n'
                + qualityGaps.slice(0, 5).join('\n') + '\n' + analystTasks;
        }
        const userPrompt = getUserPrompt(
            params.filePath,
            targetFuncName,
            targetCode,
            evalStrategy as 'small' | 'large',
            astContext,
            focusContext,
            activeModelProfile.budgetTokens,
            params.modelName,
            writerEvidenceBundle
        );
        const estimatedTokens = estimateTokens(systemPrompt + userPrompt);
        log(localize("[Budget] Prompt 估算：{0} / {1} tokens (模型: {2}, Context: {3})", estimatedTokens.toLocaleString(), activeModelProfile.budgetTokens.toLocaleString(), activeModelProfile.paramSize, activeModelProfile.contextLength.toLocaleString()));


        let rawCode = ""; // 宣告在外層 try 前面，讓 catch 也能存取
        let sanitizedCode = "";
        let loopCoverage: RetainedCoverage | null = null;
        let loopAssessment: TargetCoverageAssessment = { available: false, coverageText: 'N/A', missingLines: localize("未知") };
        let loopExecution = '';
        qualityGaps = [];
        try {
            // ─── Tier 降階修復迴圈 ───
            let tierSuccess = false;
            while (currentTier >= 1 && !tierSuccess && !isExecutionCancelled()) {
                try {
                log(localize("[Tier 執行] 目前使用策略：Tier {0}", currentTier));
                sanitizedCode = "";
                rawCode = "";

                const callerPlan = planCallerPartitions(astContext?.callerContexts || []);
                const callerContextsCount = callerPlan.callers.length;
                const useDivideAndConquer = (currentTier === 2) && (evalStrategy === 'small')
                    && callerPlan.mode === 'partitioned' && (!survivedMutants);
                if (currentTier === 2 && evalStrategy === 'small' && !survivedMutants) {
                    const { callers: _callers, ...detail } = callerPlan;
                    recordRole('caller-partition', 'planned', detail);
                    log(localize("[分治規劃] {0} 個呼叫站、{1} 組已知輸入：{2}。", callerPlan.totalCallers, callerPlan.distinctInputs, useDivideAndConquer ? localize("按不同輸入分組") : localize("使用單次生成，保留完整語境")));
                }

                // ─── Tier 1：LLM 證據導向生成；未驗證 Auto 才使用確定性備援 ───
                if (currentTier === 1 && !survivedMutants) {
                const traceResult = astContext?.traceResult;
                if (!tier1GenerationModeRecorded) {
                    const modeLabel = tier1GenerationMode === 'llm-evidence-bound'
                        ? localize("LLM 證據導向生成（來源碼 + AST + 已驗證行為觀測 + 測試生成規則）")
                        : localize("確定性備援（模型尚未通過 Auto 的 unittest 資格探測）");
                    finalReportMarkdown += localize("- **Tier 1 實際產生模式**: {0}\n\n", modeLabel);
                    // Stable, machine-readable provenance for fixture scorecards.
                    // Keep this separate from the localized explanation above.
                    finalReportMarkdown += `- **Tier 1 generation mode**: ${tier1GenerationMode}\n\n`;
                    tier1GenerationModeRecorded = true;
                }
                if (tier1GenerationMode === 'llm-evidence-bound') {
                    systemPrompt = getTier1EvidenceBoundSystemPrompt();
                    log(localize("[Tier 1] 以 LLM 證據導向生成：模型將根據來源碼、AST、已驗證行為觀測與測試生成規則撰寫測試；後續閘門驗證產物。"));
                } else {
                    if (!traceResult || !canUseDeterministicTierOne(traceResult)) {
                        throw new Error(
                            localize("Tier 1 確定性備援無法取得可驗證的行為觀測；Auto 模式下選定模型尚未通過 unittest 生成探測，")
                            + localize("因此不會改用 LLM 猜測測試。請先執行「測試連線」，或明確選擇 Tier 1–4 後以既有驗證閘門使用 LLM 生成。")
                        );
                    }
                    log(localize("[Tier 1 備援] 模型未驗證，使用已驗證行為觀測機械式生成 {0} 個成功範例與 {1} 個例外範例。", traceResult.examples.length, traceResult.errors.length));
                    const className = astContext?.class_name as string | null | undefined;
                    const constructorParams = (astContext?.class_context?.effective_init?.required_params
                        || astContext?.class_context?.effective_init?.params
                        || astContext?.class_context?.init?.required_params
                        || astContext?.class_context?.init?.params) as string[] | undefined;
                    const tier1File = buildTier1TestFile({
                        moduleName: targetImportModule,
                        functionName: targetFuncName,
                        examples: traceResult.examples,
                        errors: traceResult.errors,
                        className,
                        methodKind: astContext?.method_kind,
                        constructorParams,
                        callerContexts: astContext?.callerContexts,
                        isAsync: Boolean(astContext?.is_async),
                    });
                    if (tier1File.missingConstructorFacts) {
                        throw new Error(
                            localize("Tier 1 確定性備援無法安全建立 {0}：建構子需要 {1}，", className, tier1File.missingConstructorFacts.join(', '))
                            + localize("但沒有可驗證的 caller literal。請先執行「測試連線」後改用 LLM 證據導向生成。")
                        );
                    } else if (tier1File.code) {
                        sanitizedCode = tier1File.code;
                        rawCode = `[Tier 1 deterministic fallback] Generated ${tier1File.methodCount} observation-derived test methods`;
                        log(localize("[Tier 1 備援] 完成！共產出 {0} 個行為觀測衍生測試方法。{1}", tier1File.methodCount, className ? ` (Class method: ${className}.${targetFuncName})` : ''));
                    } else {
                        throw new Error(localize("Tier 1 確定性備援未能從已驗證行為觀測產生測試。"));
                    }
                }
            }

                // ─── Tier 3：Mock Scaffold（34–70B 模型） ───
                if (currentTier === 3 && !sanitizedCode && !survivedMutants) {
                log(localize("[Tier 3] 開啟 Mock Scaffold 策略，正在產生 @patch 骨架…"));
                const traceResult = astContext?.traceResult;
                const scaffoldResult = await runMockScaffold(params.filePath, params.funcName, traceResult, targetImportModule, pythonExecutable);
                if (scaffoldResult && scaffoldResult.scaffold) {
                    log(localize("[Tier 3] 骨架產生完成！patches: {0}", scaffoldResult.patches.join(', ') || localize("(無外部依賴)")));
                    const moduleName = targetImportModule;
                    const traceExamples = traceResult?.examples || [];
                    const sysP = getTier3SystemPrompt();
                    const verifiedConstructorCall = scaffoldResult.class_name
                        ? buildVerifiedConstructorCall(scaffoldResult.class_name, astContext?.callerContexts)
                        : null;
                    const usrP = getTier3UserPrompt(
                        targetFuncName,
                        scaffoldResult.scaffold,
                        moduleName,
                        traceExamples,
                        verifiedConstructorCall,
                        astContext?.code || targetCode,
                        semanticContext,
                        userPrompt
                    );
                    try {
                        const raw = await requestBudgeted(params, sysP, usrP, log, testGenerationResponseFormat);
                        rawCode = raw;
                        const extracted = sanitizeLlmResponse(raw);
                        if (extracted) {
                            sanitizedCode = extracted;
                            log(localize("[Tier 3] 模型補充完成！"));
                        }
                    } catch (e: any) {
                        throwIfExecutionCancelled();
                        if (e instanceof AnalysisStageError) { throw e; }
                        log(localize("[Tier 3] 模型詢問失敗: {0}，退回標準流程", e.message));
                    }
                } else {
                    log(localize("[Tier 3] Mock 骨架產生失敗，退回標準 Tier 2/4 流程"));
                }
            }

                // ─── Tier 4：全自主（由下方標準流程處理，Bug Fixer 僅在執行驗證失敗後觸發）
                if (currentTier === 4 && !sanitizedCode) {
                evalStrategy = 'large'; // 強制使用 large 模型 prompt
            }


            if (useDivideAndConquer && astContext && astContext.callerContexts) {
                log(localize("[分治合流] 💡 偵測到 {0} 個呼叫站，開啟分治合流模式（單一小 Task 多次請求，避免失焦與失憶）...", callerContextsCount));
                const subSnippets: string[] = [];

                for (let cIdx = 0; cIdx < callerPlan.callers.length; cIdx++) {
                    const ctx = callerPlan.callers[cIdx];
                    log(localize("[分治合流] 正在生成第 {0}/{1} 個呼叫點測試: `{2}` -> `{3}()`", cIdx + 1, callerContextsCount, ctx.caller_file, ctx.caller_func));

                    // 打造微型 AST／行為觀測 context：子任務只能看到本 caller
                    // 可精確對應的實測 I/O，不能借用其他 caller 的 oracle。
                    const subTraceResult = traceSubsetForCaller(
                        astContext.traceResult,
                        ctx
                    );
                    const subAstContext = {
                        ...astContext,
                        callerContexts: [ctx],
                        traceResult: subTraceResult
                    };
                    const subUserPrompt = getUserPrompt(
                        params.filePath,
                        targetFuncName,
                        targetCode,
                        'small',
                        subAstContext,
                        focusContext,
                        activeModelProfile.budgetTokens,
                        params.modelName,
                        writerEvidenceBundle
                    );

                    let subRaw = "";
                    let subGenerationPrompt = subUserPrompt;
                    for (let retry = 0; retry < 2; retry++) {
                        try {
                            subRaw = await requestBudgeted(params, systemPrompt, subGenerationPrompt, log, testGenerationResponseFormat);
                            const subClean = sanitizeLlmResponse(subRaw);
                            if (subClean) {
                                const subValidation = await validateGeneratedTestCode(
                                    subClean,
                                    targetFuncName,
                                    path.basename(params.filePath, '.py'),
                                    astContext?.method_kind === 'property' ? 'property' : 'call',
                                    astContext?.signature,
                                    exceptionNamesFromEvidence(astContext),
                                    astContext?.class_name,
                                    pythonExecutable,
                                    testBindingContext
                                );
                                const subTraceEvidence = subValidation.valid ? await validateTraceEvidence(
                                    subClean,
                                    targetFuncName,
                                    subTraceResult, targetImportModule, pythonExecutable, astContext?.class_name) : subValidation;
                                const subGate = resolveTierTwoSubtaskGate(subValidation, subTraceEvidence);
                                if (subGate.accepted) {
                                    subSnippets.push(subClean);
                                    break;
                                }
                                const subReason = subGate.reason || localize("不明驗證錯誤");
                                if (retry === 0) {
                                    log(localize("[分治合流] 呼叫點 {0} 子回覆未通過格式／行為觀測證據驗證：{1}；將重試此子任務。", cIdx + 1, subReason));
                                    subGenerationPrompt = `${subUserPrompt}\n\nEVIDENCE AND FORMAT REPAIR REQUIRED: ${subReason}\nReturn ONLY one complete Python unittest file inside a single \`\`\`python code block. Preserve exact verified behavior observations.`;
                                } else {
                                    log(localize("[警告] 呼叫點 {0} 子回覆連續未通過格式／行為觀測證據驗證：{1}", cIdx + 1, subReason));
                                }
                            } else if (retry === 0) {
                                log(localize("[分治合流] 呼叫點 {0} 子回覆為空或不可擷取，將重試此子任務。", cIdx + 1));
                            }
                        } catch (err: any) {
                            throwIfExecutionCancelled();
                            if (err instanceof AnalysisStageError) { throw err; }
                            if (retry === 1) {log(localize("[警告] 呼叫點 {0} 生成失敗: {1}", cIdx + 1, err.message));}
                        }
                    }
                    rawCode += `\n--- [Call Site ${cIdx + 1}: ${ctx.caller_func}] ---\n` + subRaw;
                }

                if (subSnippets.length > 0) {
                    log(localize("[分治合流] 成功取得 {0} 個單一呼叫點測試，正在進行 AST/正則機械式合併...", subSnippets.length));
                    const mergeRes = mergeTestSnippets(subSnippets, `Test${targetFuncName || 'Merged'}`);
                    sanitizedCode = mergeRes.mergedCode;
                    log(localize("[分治合流] 🎉 成功重組為單一類別，共包含 {0} 個獨立測試方法！", mergeRes.totalMethodsCount));
                }
            }

            // 若非分治合流模式，或分治合流未取得結果，走標準 Single-Pass 流程
            if (!sanitizedCode) {
                let generationPrompt = userPrompt;
                for (let llmRetry = 0; llmRetry < 2; llmRetry++) {
                    if (llmRetry === 0) {log(localize("[LLM] 正在呼叫模型推論中... (模型: {0})", params.modelName));}
                    try {
                        rawCode = await requestBudgeted(params, systemPrompt, generationPrompt, log, testGenerationResponseFormat);
                    } catch (err: any) {
                        if (err instanceof AnalysisStageError) { throw err; }
                        if (llmRetry === 0) {
                            log(localize("[警告] 網路或 API 請求失敗: {0}，嘗試自動重試 (1/1)...", err.message));
                            continue;
                        } else {
                            throw err;
                        }
                    }

                    sanitizedCode = sanitizeLlmResponse(rawCode);

                    if (!sanitizedCode) {
                        if (llmRetry === 0) {
                            log(localize("[警告] 模型回傳程式碼為空或包含無效標籤，嘗試自動重試..."));
                            continue;
                        } else {
                            throw new Error(localize("模型產生的程式碼內容為空 (已重試失敗)"));
                        }
                    }

                    // 🚨 偵測 AI 是否在複製原始碼（小模型常見的注意力崩潰）
                    const hasTestMethods = sanitizedCode.includes('def test_') || sanitizedCode.includes('self.assert');
                    const looksLikeSourceCopy = !hasTestMethods && targetFuncName && sanitizedCode.includes(`def ${targetFuncName}`);
                    if (looksLikeSourceCopy) {
                        if (llmRetry === 0) {
                            log(localize("[警告] ⚠️ AI 輸出的是原始碼而不是測試碼（偵測到複製行為），嘗試重試..."));
                            continue;
                        } else {
                            throw new Error(localize("AI 連續兩次輸出了原始碼而非測試碼，無法產生有效測試"));
                        }
                    }

                    // 驗證 AI 產出的程式碼格式是否符合要求，若不合規則嘗試自動救援
                    if (!sanitizedCode.includes('unittest.TestCase') && !sanitizedCode.includes('import unittest')) {
                        log(localize("[警告] AI 未按格式輸出 unittest.TestCase，嘗試自動救援轉換..."));
                        const rescued = await rescueToUnittest(sanitizedCode, params.filePath, targetFuncName, targetImportModule, pythonExecutable);
                        if (!rescued) {
                            if (llmRetry === 0) {
                                log(localize("[警告] AI 回傳格式無法解析出有效的測試案例，嘗試重新請求..."));
                                continue;
                            } else {
                                throw new Error(localize("AI 輸出格式連續兩次無法解析為有效測試（無任何 assert 或可用語句）"));
                            }
                        }
                        log(localize("[救援] 自動轉換成功！已將 AI 輸出包裝為 unittest.TestCase 格式。"));
                        sanitizedCode = rescued;
                    }

                    const candidateValidation = await validateGeneratedTestCode(
                        sanitizedCode,
                        targetFuncName,
                        path.basename(params.filePath, '.py'),
                        astContext?.method_kind === 'property' ? 'property' : 'call',
                        astContext?.signature,
                        exceptionNamesFromEvidence(astContext),
                        astContext?.class_name,
                        pythonExecutable,
                        testBindingContext
                    );
                    const traceEvidenceValidation = candidateValidation.valid ? await validateTraceEvidence(
                        sanitizedCode,
                        targetFuncName,
                        astContext?.traceResult, targetImportModule, pythonExecutable, astContext?.class_name) : candidateValidation;
                    if (!candidateValidation.valid || !traceEvidenceValidation.valid) {
                        const validationReason = traceEvidenceValidation.reason || candidateValidation.reason;
                        if (llmRetry === 0) {
                            log(localize("[警告] 模型輸出未通過證據／Python unittest 驗證：{0}；將以嚴格格式要求重試。", validationReason));
                            generationPrompt = `${userPrompt}\n\nEVIDENCE AND FORMAT REPAIR REQUIRED: ${validationReason}\nReturn ONLY one complete Python unittest file inside a single \`\`\`python code block. Do not include analysis, Markdown bullets, or prose outside the code block. Keep every assertion for an exact verified call equal to its behavior observation.`;
                            sanitizedCode = '';
                            continue;
                        }
                        throw new Error(localize("模型連續兩次未通過證據／Python unittest 驗證：{0}", validationReason));
                    }

                    break; // 成功跳出 retry
                }
            }

            // Reports retain validated test artifacts and diagnostic events, never full provider replies.

            let finalCode = sanitizedCode;
            
            // 強制檢查並補齊 import，同時移除 LLM 可能寫的假 placeholder
            const baseName = path.basename(params.filePath, '.py');
            finalCode = finalCode
                .split('\n')
                .filter(line => {
                    const t = line.trim();
                    if (!t.startsWith('from ') && !t.startsWith('import ')) {return true;}
                    // 移除 placeholder imports
                    if (t.includes('module_name') || t.includes('MODULE_NAME') ||
                        t.includes('<module>') || t.includes('your_module') ||
                        t.includes('FUNCTION_NAME')) {return false;}
                    // 移除相對 import（from .. import, from .x import）
                    if (/^from\s+\./.test(t)) {return false;}
                    return true;
                })
                .join('\n');

            if (!finalCode.includes(`from ${targetImportModule} import`)
                && !finalCode.includes(`import ${targetImportModule}`)) {
                log(localize("[警告] AI 遺漏了 import 目標模組的語句，系統自動補齊..."));
                if (finalCode.includes('import unittest')) {
                    finalCode = finalCode.replace('import unittest', `import unittest\nfrom ${targetImportModule} import *`);
                } else {
                    finalCode = `import unittest\nfrom ${targetImportModule} import *\n\n` + finalCode;
                }
            }

            // 🚨 自動補齊 mock / patch import (小模型常見遺漏)
            if ((finalCode.includes('patch(') || finalCode.includes('MagicMock')) && !finalCode.includes('unittest.mock')) {
                log(localize("[警告] 偵測到程式碼使用 patch/MagicMock 但遺漏 import，系統自動補齊 unittest.mock..."));
                finalCode = finalCode.replace('import unittest', 'import unittest\nfrom unittest.mock import patch, MagicMock');
            }

            // All real Trace cases run in their own runner-owned class, including functions.
            const traceForAugmentation = astContext?.traceResult;
            const verifiedTrace = shouldPreserveVerifiedTrace(currentTier, tier1GenerationMode)
                && canUseDeterministicTierOne(traceForAugmentation)
                ? buildTier1TestFile({
                    moduleName: targetImportModule,
                    functionName: targetFuncName,
                    examples: traceForAugmentation!.examples,
                    errors: traceForAugmentation!.errors,
                    className: astContext?.class_name,
                    methodKind: astContext?.method_kind,
                    constructorParams: astContext?.class_context?.effective_init?.required_params
                        || astContext?.class_context?.effective_init?.params
                        || astContext?.class_context?.init?.required_params
                        || astContext?.class_context?.init?.params,
                    callerContexts: astContext?.callerContexts,
                    isAsync: Boolean(astContext?.is_async),
            }) : undefined;
            if (verifiedTrace?.code) {
                const traceStructure = await validateGeneratedTestCode(verifiedTrace.code, targetFuncName, baseName,
                    astContext?.method_kind === 'property' ? 'property' : 'call', astContext?.signature,
                    exceptionNamesFromEvidence(astContext), astContext?.class_name || undefined, pythonExecutable, testBindingContext);
                if (!traceStructure.valid) {
                    recordRole('trace-baseline', 'failed', { category: 'validation', reason: traceStructure.reason });
                    throw new AnalysisStageError('validation', 'trace-baseline',
                        localize("系統 Trace 基線未通過結構／安全檢查，停止模型修訂：") + traceStructure.reason);
                }
                const traceTestPath = path.join(loopDir, `loop${currentLoop}_trace_test.py`);
                fs.writeFileSync(traceTestPath, verifiedTrace.code, 'utf8');
                const traceRun = await runSpawn(pythonExecutable,
                    generatedUnittestArguments(path.basename(traceTestPath, '.py'), targetDir, false, true),
                    { cwd: testDir, env: testExecutionEnv, timeout: 30000 });
                recordRole('trace-baseline', traceRun.code === 0 ? 'passed' : 'failed', {
                    testPath: traceTestPath, output: traceRun.stdout + traceRun.stderr
                });
                if (traceRun.code !== 0 || !/Ran ([1-9]\d*) tests?/.test(traceRun.stdout + traceRun.stderr)) {
                    throw new AnalysisStageError('validation', 'trace-baseline',
                        localize("已驗證行為觀測的獨立 unittest 基線未通過，停止合併 Trace 與模型測試。"),
                        { output: traceRun.stdout + traceRun.stderr, traceTestPath });
                }
            }
            const preserveTrace = async (candidate: string): Promise<string> => {
                if (!verifiedTrace?.code) { return candidate; }
                const restored = restoreVerifiedTraceTestFile(candidate, verifiedTrace.code, verifiedTrace.methodCount, targetFuncName).code;
                const result = await runSpawn(pythonExecutable, ['-B', pythonToolPath('traceDeduplication')], {
                    input: JSON.stringify({ code: restored, target: targetFuncName.replace(/\W+/g, '_') }),
                    timeout: 5000, env: testExecutionEnv
                });
                if (result.code !== 0) { throw new Error(localize("Trace 重複案例檢查未完成；未採用修改。")); }
                const cleaned = JSON.parse(result.stdout) as { code: string; removed: number };
                if (cleaned.removed > 0) { recordRole('trace-deduplication', 'normalized', { removed: cleaned.removed, baselinePreserved: true }); }
                return cleaned.code;
            };
            finalCode = await preserveTrace(finalCode);
            if (verifiedTrace?.code) {
                log(localize("[行為觀測保底] 已保留 {0} 個已驗證 I/O 測試於獨立類別；每次修復後也會還原。", verifiedTrace.methodCount));
            }

            recordRole('writer', 'candidate', { tier: currentTier, responseHash: evidenceHash(rawCode),
                responseCharacters: rawCode.length, code: finalCode });
            const repairContext = (code: string, failure: string) => getBugFixerUserPrompt(
                code, failure, targetFuncName, astContext?.args || [], astContext?.code || targetCode,
                astContext, targetImportModule, undefined,
                Object.keys(testBindingContext.dependencies).map(name => `${targetImportModule}.${name}`)
            );
            const roleEvidence = getReviewEvidence('', '', targetFuncName, astContext?.args || [],
                astContext?.code || targetCode, astContext, targetImportModule, undefined,
                Object.keys(testBindingContext.dependencies).map(name => `${targetImportModule}.${name}`));
            const inventories = new Map<string, ScenarioIdentity[]>();
            const inventory = async (code: string): Promise<ScenarioIdentity[]> => {
                const hash = evidenceHash(code);
                if (!inventories.has(hash)) {
                    const result = await runSpawn(pythonExecutable,
                        ['-B', pythonToolPath('scenarios')],
                        { input: code, timeout: 5000, env: testExecutionEnv });
                    if (result.code !== 0) { throw new Error(localize("無法建立測試情境識別：") + result.stderr); }
                    inventories.set(hash, JSON.parse(result.stdout));
                }
                return inventories.get(hash)!;
            };
            let baselineScenarios = bestScenarios.length ? bestScenarios : bestCode ? await inventory(bestCode) : [];
            const checkpointExecutable = (code: string, execution: string, gaps: string[],
                status: ReviewStatus, warnings: string[], assessment: TargetCoverageAssessment) => {
                if (!evidenceStillCurrent()) {
                    throw new AnalysisStageError('validation', 'source-changed', localize("來源或相依版本改變，停止保存舊執行證據。"));
                }
                const snapshot = checkpoints.saveExecutable({ code, execution,
                    coverage: extractCoverage(assessment, params.funcName || targetFuncName),
                    scenarios: acceptedScenarios, qualityGaps: gaps, measuredQualityGaps: gaps,
                    reviewStatus: status, reviewWarnings: warnings, tier: currentTier,
                    generationMode: currentTier === 1 ? tier1GenerationMode : undefined,
                    dependencyVersions: astContext?.sourceVersions?.map(item => ({ module: path.basename(item.file), hash: item.hash })) || [] });
                journal.knowledge({ executableBaseline: { path: 'executable_baseline.json', testFile: snapshot.testFile,
                    codeHash: snapshot.codeHash, tier: snapshot.tier, reviewStatus: snapshot.reviewStatus, mutationStatus: snapshot.mutationStatus } });
                recordRole('executable-baseline', 'checkpointed', { codeHash: snapshot.codeHash,
                    testFile: snapshot.testFile, reviewStatus: snapshot.reviewStatus, mutationScore: null });
                writeReport(finalReportMarkdown
                    + localize("\n### 已保存可執行測試\n\n- 測試：{0}\n- 審查狀態：{1}\n- 本候選突變：尚未測量\n", snapshot.testFile, status));
            };
            const accepted = await validateTestCandidate(finalCode, {
                reviewRequired: mayUseModelAuthoredTests,
                checkCancelled: throwIfExecutionCancelled,
                event: recordRole,
                repairExpectations: ruleSelection.ids.includes('numeric_calculation') ? (code, failure) => repairWithNumericSkill({
                    code, failure, source: initialSource, target: params.funcName || targetFuncName, module: targetImportModule,
                    python: pythonExecutable, env: testExecutionEnv, directory: loopDir,
                    runId: journal.runId, sourceHash: journal.sourceHash,
                    checkCurrent: () => {
                        throwIfExecutionCancelled();
                        if (!evidenceStillCurrent()) {
                            throw new AnalysisStageError('validation', 'source-changed', localize("來源版本已改變，停止使用舊證據。"));
                        }
                    },
                    observe: calls => runBehaviorProbe(params.filePath, params.funcName || targetFuncName,
                        [], pythonExecutable, [], loopDir, { schema_version: 'probe-inputs-v1', cases: calls.map(call => ({
                            input: call.trace_input, source: { kind: 'semantic_guided', detail: 'numeric-calculation' }
                        })) }),
                    event: recordRole
                }) : undefined,
                executable: (code, execution) => checkpointExecutable(code, execution.out, execution.qualityGaps,
                    mayUseModelAuthoredTests ? 'incomplete' : 'not-required', [], execution.coverage || loopAssessment),
                validate: async (code) => {
                    const structural = await validateGeneratedTestCode(code, targetFuncName, baseName,
                        astContext?.method_kind === 'property' ? 'property' : 'call', astContext?.signature,
                        exceptionNamesFromEvidence(astContext), astContext?.class_name || undefined, pythonExecutable, testBindingContext);
                    if (!structural.valid) { return structural.reason || 'Structure validation failed'; }
                    const trace = await validateTraceEvidence(code, targetFuncName, astContext?.traceResult, targetImportModule, pythonExecutable, astContext?.class_name);
                    return !structural.valid || !trace.valid ? trace.reason || structural.reason || 'Validation failed' : undefined;
                },
                review: async (code) => {
                    if (!mayUseModelAuthoredReview) {
                        recordRole('reviewer', 'unqualified', {});
                        return undefined;
                    }
                    const sys = getTestReviewerSystemPrompt();
                    const prompt = fitReviewPrompt({ tests: code, evidence: roleEvidence, executionVerified: true },
                        Number.MAX_SAFE_INTEGER);
                    if (!prompt || !promptFits(addOutputContract(sys, 'review-json'), prompt, activeModelProfile.budgetTokens)) {
                        recordRole('reviewer', 'budget-exceeded', { reason: localize("完整證據超過預算；未截斷程式碼，交工具驗證並標記審查未完成。") });
                        return undefined;
                    }
                    return reviewSession.review(evidenceHash(sys + '\n' + prompt), async () => {
                        try {
                            const raw = await requestBudgeted(params, sys, prompt, log, 'review-json', 'reviewer');
                            const { review: result, diagnostics } = parseTestReviewDetailed(raw, code, true, {
                                target: params.funcName || targetFuncName,
                                methodKind: astContext?.method_kind || (astContext?.class_name ? 'instance' : 'module'),
                                module: targetImportModule,
                                dependencyUsePoints: (astContext?.calls || []).map((name: string) => `${targetImportModule}.${name}`)
                            });
                            recordRole('reviewer', result ? 'parsed' : 'invalid-response', {
                                contractVersion: ROLE_CONTRACT_VERSIONS.reviewer, raw, result, diagnostics
                            });
                            return result;
                        } catch (error: any) {
                            throwIfExecutionCancelled();
                            recordRole('reviewer', 'failed', { reason: error.message,
                                category: error instanceof AnalysisStageError ? error.category : classifyExecutionFailure(error.message) });
                            return undefined;
                        }
                    }, (status, detail) => recordRole('reviewer', status, detail));
                },
                repairRole: (code, failure) => canRepairTestMethod(code, failure) ? 'bug-fixer' : 'writer',
                revise: async (code, failure, role, attempt) => {
                    if (role === 'writer' ? !mayUseModelAuthoredTests : !mayUseModelAuthoredRepair) {
                        throw new Error(localize("Auto 未驗證 {0} 角色不可呼叫該角色修訂。", role));
                    }
                    const sys = role === 'bug-fixer' ? getBugFixerSystemPrompt()
                        : 'You are the test Writer. Revise the current tests for the supplied concrete review or structure findings. Preserve passing cases and verified assertions. Do not invent requirements. Output the complete test file in one python code fence.';
                    const prompt = role === 'bug-fixer' ? repairContext(code, failure)
                        : buildWriterRevisionRequest({
                            code,
                            findings: failure,
                            moduleName: targetImportModule,
                            functionName: targetFuncName,
                            evidence: roleEvidence
                        });
                    if (estimateTokens(sys + prompt) > activeModelProfile.budgetTokens) {
                        throw new Error(role === 'bug-fixer'
                            ? localize("Bug Fixer 的單方法修復內容仍超過模型預算，停止本次修復。")
                            : localize("Writer 修訂所需完整證據超過模型預算；未截斷待保留的測試。"));
                    }
                    const repairStarted = Date.now();
                    const raw = await requestBudgeted(
                        params, sys, prompt, log,
                        role === 'bug-fixer' ? 'text' : testGenerationResponseFormat,
                        role === 'bug-fixer' ? 'bug-fixer' : 'writer-revision'
                    );
                    if (role === 'bug-fixer') {
                        const merged = mergeBugFixReplacementDetailed(raw, code, failure);
                        if (merged.diagnostic) {
                            const error = new RepairResponseError(merged.diagnostic);
                            recordRole('bug-fixer', 'format-rejected', { attempt, category: 'model-format',
                                contractVersion: ROLE_CONTRACT_VERSIONS.bugFix, elapsedMs: Date.now() - repairStarted,
                                reason: error.message, diagnostic: merged.diagnostic });
                            throw error;
                        }
                        if (merged.normalization) { recordRole('bug-fixer', 'format-normalized', { attempt, ...merged.normalization }); }
                        return preserveTrace(merged.code!);
                    }
                    return preserveTrace(sanitizeLlmResponse(raw));
                },
                validateRevision: async (previousCode, candidateCode, failure, role) => {
                    if (role !== 'bug-fixer') { return undefined; }
                    const scope = await runSpawn(pythonExecutable,
                        ['-B', pythonToolPath('repairScope')], {
                            input: JSON.stringify({
                                contractVersion: ROLE_CONTRACT_VERSIONS.bugFix,
                                previous: previousCode,
                                candidate: candidateCode,
                                failure
                            }),
                            timeout: 5000,
                            env: testExecutionEnv
                        });
                    if (scope.code !== 0) {
                        return { reason: localize(REPAIR_REASON_LABELS['scope-tool-error']), reasonCode: 'scope-tool-error' };
                    }
                    try {
                        const result = JSON.parse(scope.stdout) as { valid?: boolean; reasonCode?: string };
                        const reasonCode = repairReasonCode(result.reasonCode);
                        return result.valid === true ? undefined : { reason: localize(REPAIR_REASON_LABELS[reasonCode]), reasonCode };
                    } catch {
                        return { reason: localize(REPAIR_REASON_LABELS['scope-result-invalid']), reasonCode: 'scope-result-invalid' };
                    }
                },
                execute: async (code) => {
                    throwIfExecutionCancelled();
                    if (!evidenceStillCurrent()) {
                        throw new AnalysisStageError('validation', 'source-changed', localize("來源版本已改變，停止使用舊證據。"));
                    }
                    preserveCandidate(testPath);
                    fs.writeFileSync(testPath, code, 'utf8');
                    preserveCandidate(testPath);
                    const testRunId = randomUUID();
                    const testHash = evidenceHash(code);
                    const [invocationFile, coverageFile] = reserveArtifactFiles(testDir, ['invocation', 'coverage'], 'json');
                    const executionArguments = [...generatedUnittestArguments(path.basename(testPath, '.py'), targetDir, true, true),
                        '--target-file', params.filePath, '--target-name', params.funcName || targetFuncName,
                        '--target-evidence', invocationFile, '--target-run-id', testRunId, '--target-test-file', testPath];
                    const run = await runSpawn(pythonExecutable,
                        executionArguments,
                        { cwd: testDir, env: testExecutionEnv, timeout: 30000 });
                    const scenarios = await inventory(code);
                    let out = normalizeScenarioOutput(`${run.stdout}${run.stderr}`.trim(), scenarios, baselineScenarios);
                    acceptedScenarios = reconcileScenarios(scenarios, baselineScenarios);
                    if (!baselineScenarios.length) { baselineScenarios = acceptedScenarios; }
                    recordRole('scenarios', 'observed', { codeHash: evidenceHash(code), scenarios, rawExecution: run.stdout + run.stderr });
                    if (run.code !== 0 || !/Ran ([1-9]\d*) tests?/.test(out)) {
                        return { ok: false, out: out || 'No executable unittest cases', qualityGaps: [] };
                    }
                    const coverage = await runSpawn(pythonExecutable, ['-m', 'coverage', 'report', '-m'],
                        { cwd: testDir, env: testExecutionEnv, timeout: 30000 });
                    out += '\n' + coverage.stdout + coverage.stderr;
                    if (coverage.code !== 0) { throw new Error(localize("Coverage 工具執行失敗：") + out); }
                    const nativeCoverage = await runSpawn(pythonExecutable, ['-B', pythonToolPath('coverage'),
                        params.filePath, params.funcName || targetFuncName, '--invocation-evidence', invocationFile,
                        '--expected-run-id', testRunId, '--expected-test-hash', testHash],
                    { cwd: testDir, env: testExecutionEnv, timeout: 10000 });
                    const assessment = assessTargetCoverageEvidence(nativeCoverage.stdout, params.filePath,
                        params.funcName || targetFuncName, journal.sourceHash, { testRunId, testHash });
                    fs.writeFileSync(coverageFile, nativeCoverage.stdout, 'utf8');
                    const gaps: string[] = [];
                    if (!assessment.available) { gaps.push(localize("Coverage 無法辨識目標模組；目標覆蓋狀態未知。")); }
                    if (assessment.targetFullyCovered === undefined) { gaps.push(localize("目標行覆蓋狀態未知。")); }
                    if (assessment.targetBranchesCovered === undefined) { gaps.push(localize("目標分支覆蓋狀態未知。")); }
                    if (assessment.targetExecuted === false) { gaps.push(localize("目標函式未執行。")); }
                    if (assessment.missingTargetLines?.length) { gaps.push(localize("目標未覆蓋行：") + assessment.missingTargetLines.join(', ')); }
                    if (assessment.missingTargetBranches?.length) { gaps.push(localize("目標未覆蓋分支：") + assessment.missingTargetBranches.join(', ')); }
                    recordRole('coverage', 'measured', assessment);
                    return { ok: true, out, qualityGaps: gaps, coverage: assessment };
                }
            }, 2, bestCode ? { code: bestCode, output: bestExecution } : undefined);
            finalCode = accepted.code;
            loopExecution = accepted.execution.out;
            loopAssessment = accepted.execution.coverage || loopAssessment;
            loopCoverage = extractCoverage(loopAssessment, params.funcName || targetFuncName);
            qualityGaps = accepted.qualityIssues;
            reviewWarnings = accepted.reviewWarnings;
            reviewStatus = accepted.reviewStatus;
            measuredQualityGaps = accepted.execution.qualityGaps;
            checkpointExecutable(finalCode, loopExecution, measuredQualityGaps, reviewStatus, reviewWarnings, loopAssessment);
            recordRole('validation', 'accepted', {
                codeHash: evidenceHash(finalCode), qualityGaps, reviewWarnings, reviewStatus
            });
            finalReportMarkdown += localize("\n### 執行驗證\n\n```text\n{0}\n```\n", loopExecution);
            if (qualityGaps.length) {
                finalReportMarkdown += localize("\n### 品質待補強（交分析師與 Writer）\n\n{0}\n", qualityGaps.map(gap => '- ' + gap).join('\n'));
            }
            if (reviewWarnings.length) {
                finalReportMarkdown += localize("\n### Reviewer 警告（不啟動額外修復輪）\n\n{0}\n", reviewWarnings.map(warning => '- ' + warning).join('\n'));
            }

            tierSuccess = true;
            break; // 預先驗證成功，跳出 Tier 降階迴圈
        } catch (tierErr: any) {
            throwIfExecutionCancelled();
            if (tierErr instanceof AnalysisStageError) { throw tierErr; }
            if (tierErr instanceof RepairResponseError) {
                recordRole('bug-fixer', 'tier-failed', { tier: currentTier, category: 'model-format',
                    reason: tierErr.message, reasonCodes: tierErr.diagnostic.reasonCodes });
                recordRole('repair-routing', 'selected', { action: currentTier > 1 ? 'tier-fallback' : 'stop-tier-fallback',
                    fromTier: currentTier, toTier: currentTier > 1 ? currentTier - 1 : currentTier });
            } else {
                recordRole('writer', 'tier-failed', { tier: currentTier, reason: tierErr.message,
                    responseHash: evidenceHash(rawCode), responseCharacters: rawCode.length });
            }
            if (currentTier > 1) {
                const prevTier = currentTier;
                currentTier--;
                const transition = { loop: currentLoop, from: prevTier, to: currentTier,
                    reason: tierErr instanceof RepairResponseError ? localize("局部修復回覆不符合契約") : localize("候選生成或驗證失敗") };
                tierHistory.transitions.push(transition);
                journal.knowledge({ tierHistory });
                recordRole('tier', 'fallback', transition);
                log(localize("[Tier 降階] ⚠️ Tier {0} 驗證失敗，自動觸發策略降階：Tier {1} → Tier {2} 重試...", prevTier, prevTier, currentTier));
                finalReportMarkdown += localize("\n> [!WARNING]\n> ⚠️ **策略自動降階**: Tier {0} 驗證失敗，系統已自動切換降階至 **Tier {1}** 思考模式重試。\n\n", prevTier, currentTier);
            } else {
                // Tier 1 也失敗，向上拋出錯誤
                throw tierErr;
            }
        }
    } // end while (currentTier >= 1)


            // 動態偵測 mutation engine；無外部工具時使用安全的 AST 後備引擎。
            let engine: 'mutatest' | 'mutmut' | 'builtin' = params.funcName || importFixtures ? 'builtin' : 'mutatest';
            let pyVer = '';
            // Native adapters currently certify module scope only. Selected functions
            // must use the engine that can prove the exact qualified scope.
            if (!params.funcName && !importFixtures) {
            try {
                // 取得 Python 版本
                const { stdout: pyVerRaw } = await runSpawn(pythonExecutable, ['--version'], {
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
                });
                pyVer = pyVerRaw.trim().replace('Python ', '');
                const preferredEngine = detectMutationEngine(pyVer);
                if (!preferredEngine) {
                    engine = 'builtin';
                    log(localize("[系統] Python {0} 的原生環境沒有相容的外部突變工具，使用內建 AST 基本突變引擎。建議在 WSL 或 Python 3.11 安裝完整引擎以取得更廣的突變覆蓋。", pyVer));
                } else if (preferredEngine === 'mutmut') {
                    log(localize("[系統] 偵測到 Python {0}，建議引擎：{1}", pyVer, preferredEngine));
                    // Python 3.12+ uses mutmut because mutatest requires coverage < 6.
                    const mutmutCheck = await runSpawn(pythonExecutable, ['-m', 'mutmut', '--version'], {});
                    if (mutmutCheck.code === 0) {
                        engine = 'mutmut';
                        log(localize("[系統] mutmut 可用，使用 mutmut 進行突變測試。"));
                    } else {
                        engine = 'mutatest';
                        log(localize("[系統] mutmut 不可用，退回使用 mutatest。"));
                    }
                } else {
                    log(localize("[系統] 偵測到 Python {0}，建議引擎：{1}", pyVer, preferredEngine));
                    // Windows 或 Python < 3.12 優先使用 mutatest
                    const mutatestCheck = await runSpawn(pythonExecutable, ['-c', 'from mutatest.cli import cli_main'], {});
                    if (mutatestCheck.code === 0) {
                        engine = 'mutatest';
                        log(localize("[系統] mutatest 可用，使用 mutatest 進行突變測試。"));
                    } else {
                        const mutmutCheck = await runSpawn(pythonExecutable, ['-m', 'mutmut', '--version'], {});
                        if (mutmutCheck.code === 0) {
                            engine = 'mutmut';
                            log(localize("[系統] mutatest 不可用，改用 mutmut。"));
                        } else {
                            log(localize("[系統] mutatest/mutmut 均不可用，使用內建 AST 基本突變引擎。"));
                            engine = 'builtin';
                        }
                    }
                }
            } catch (e) {
                engine = 'builtin';
                log(localize("[系統] 無法取得 Python 版本或外部突變工具狀態，使用內建 AST 基本突變引擎。"));
            }
            }

            log(localize("[{0}] 正在建構突變測試指令...", engine));
            const mutationTimeoutSeconds = normalizeExecutionSettings(params).mutpyTimeout;
            log(localize("[{0}] 正式啟動分析 (突變階段超時限制: {1}秒) ... 這可能會花費數十秒，請稍候！", engine, mutationTimeoutSeconds));

            if (isExecutionCancelled()) {throw new Error(localize("使用者強制中止"));}

            let mutationRun: MutationRun;
            let noMutationCandidates = false;
            let mutpyResult: string;
            const measuredCandidate = checkpoints.executable;
            if (!measuredCandidate || evidenceHash(fs.readFileSync(testPath, 'utf8')) !== measuredCandidate.codeHash) {
                throw new AnalysisStageError('validation', 'candidate-changed', localize("測試檔已改變，不能沿用先前執行結果進行突變測量。"));
            }
            const mutationContext: MutationContext = { sourcePath: params.filePath,
                sourceHash: journal.sourceHash, testHash: measuredCandidate.codeHash,
                targetScope: { kind: params.funcName ? 'function' : 'module', qualifiedName: params.funcName || 'module' },
                stageTimeoutSeconds: mutationTimeoutSeconds };
            if (engine === 'builtin') {
                const fallbackScript = pythonToolPath('mutation');
                const perMutationTimeout = Math.min(5, mutationTimeoutSeconds);
                const selectedClassName = (astContext?.class_name as string | undefined);
                log(localize("[builtin] 正在隔離執行原始基線與完整突變集合；本階段預算 {0} 秒，完成後回報殺死／存活／逾時／錯誤數。", mutationTimeoutSeconds));
                const fallbackRun = await runSpawn(
                    pythonExecutable,
                    [
                        fallbackScript,
                        params.filePath,
                        testPath,
                        '0',
                        String(perMutationTimeout),
                        targetFuncName || '',
                        selectedClassName || '',
                        String(mutationTimeoutSeconds)
                    ],
                    { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: (mutationTimeoutSeconds + 5) * 1000 }
                );
                if (fallbackRun.code !== 0) {
                    throw new Error(localize("內建 AST 突變引擎執行失敗：{0}", (fallbackRun.stderr || fallbackRun.stdout).slice(0, 500)));
                }
                mutationRun = parseBuiltinMutationRun(fallbackRun.stdout, mutationContext);
                mutpyResult = JSON.stringify(mutationRun, null, 2);
            } else {
                const targetDir = path.dirname(params.filePath);
                const parentDir = path.dirname(targetDir);
                const grandParentDir = path.dirname(parentDir);
                const testDir = path.dirname(testPath);
                const testModule = path.basename(testPath, '.py');
                const isolationReport = path.join(testDir, `loop${currentLoop}_mutation_isolation.jsonl`);
                const mutationPlan = buildExternalMutationExecution(
                    engine,
                    params.filePath,
                    testModule,
                    reportDir,
                    undefined, // Engine multipliers are distinct from the UI's seconds budget.
                    pythonExecutable,
                    isolationReport
                );
                const mutationEnvironment = buildGeneratedTestEnvironment(process.env, [
                    targetDir, parentDir, grandParentDir, testDir
                ]);
                const externalRun = await runSpawn(mutationPlan.command, mutationPlan.args, {
                    cwd: testDir,
                    env: mutationEnvironment,
                    timeout: mutationTimeoutSeconds * 1000
                });
                if (isExecutionCancelled()) {
                    throw new Error(localize("使用者強制中止"));
                }
                if (!fs.existsSync(isolationReport) || !externalIsolationVerified(fs.readFileSync(isolationReport, 'utf8'))) {
                    throw new AnalysisStageError('mutation', 'mutation-isolation',
                        localize("突變測試缺少完整隔離執行證據，或觸發未隔離操作；不接受引擎分數。"));
                }
                if (externalRun.code !== 0) {
                    mutpyResult = localize("[{0} 系統錯誤訊息]\n結束碼: {1}\n[Stderr]\n{2}\n[Stdout]\n{3}", engine, externalRun.code ?? 'unknown', externalRun.stderr, externalRun.stdout);
                } else {
                    mutpyResult = externalRun.stdout || externalRun.stderr || localize("無輸出內容");
                }
                const nativeReport = `${reportDir}.rst`;
                mutationRun = parseExternalMutationRun(engine,
                    engine === 'mutatest' && fs.existsSync(nativeReport) ? fs.readFileSync(nativeReport, 'utf8') : mutpyResult,
                    externalRun.code, { ...mutationContext, baselinePassed: true, isolationVerified: true });
            }

            fs.writeFileSync(path.join(loopDir, `loop${currentLoop}_mutation.json`), JSON.stringify(mutationRun, null, 2), 'utf8');
            if (!['complete', 'no-candidates'].includes(mutationRun.status)) {
                journal.knowledge({ latestMutation: mutationRun });
                throw new AnalysisStageError('mutation', 'mutation-execution',
                    localize("突變測量尚未完整或結果無效（{0}）；不宣稱完整品質分數。", mutationRun.status), mutationRun);
            }

            log(localize("[{0}] 突變分析執行完畢！正在解析報告與分數...", engine));
            log(localize("--- 突變測試原生輸出 ---\n{0}\n------------------------", mutpyResult));
            
            // 擷取最後 1000 字元，避免錯誤訊息被截斷
            const displayLog = mutpyResult.length > 1000 ? '...' + mutpyResult.substring(mutpyResult.length - 1000) : mutpyResult;
            finalReportMarkdown += localize("### 執行日誌摘要\n\n```text\n{0}\n```\n\n", displayLog);
            
            if (loopCoverage) {
                finalReportMarkdown += localize("- **覆蓋率**: {0} (未覆蓋行號: {1})\n", loopCoverage.coverageText, loopCoverage.missingLines);
                const selected = loopCoverage.selectedTarget;
                if (selected?.executableLines.length) {
                    const percent = 100 * (selected.executableLines.length - selected.missingLines.length) / selected.executableLines.length;
                    finalReportMarkdown += localize("- **目標行覆蓋率**: {0}%（{1}；模組整體覆蓋率另列於上方）\n", percent, selected.qualifiedName);
                }
            }
            
            noMutationCandidates = mutationRun.status === "no-candidates";
            mutationScore = measuredMutationScore(mutationRun) ?? 0;
            const counts = mutationRun.counts;
            const scopeLabel = mutationRun.targetScope.qualifiedName;
            finalReportMarkdown += localize("- **突變範圍**: {0}（{1}）\n", scopeLabel, engine)
                + localize("- **突變集合**: 已選 {0}／可用 {1}；已測 {2}；未測 {3}\n", counts.selected, counts.available ?? localize("未知"), counts.executed, counts.notRun)
                + localize("- **突變結果**: killed {0}、survived {1}、timeout {2}、error {3}\n", counts.killed, counts.survived, counts.timeout, counts.error)
                + localize("- **突變分數**: {0}\n", noMutationCandidates ? localize("N/A（沒有可用候選）") : mutationScore + "%");
            survivedMutants = mutationRun.mutants.filter(mutant => mutant.status === "SURVIVED")
                .map(mutant => `- id ${mutant.id}, line ${mutant.line}, column ${mutant.column}, position ${mutant.position}, kind ${mutant.kind}: mutation from ${mutant.from} to ${mutant.to}`)
                .join("\n");
            if (survivedMutants) {
                log(localize("[弱點分析] 本輪存活變異體資訊已擷取，將於下一輪優化進行 Assert 強化：\n{0}", survivedMutants));
                finalReportMarkdown += localize("#### 存活的變異體\n```text\n{0}\n```\n", survivedMutants);
            } else {
                log(localize("[分析] 本輪無存活變異體，或分析結果已達最優。"));
                finalReportMarkdown += localize("- **存活變異體**: 無\n");
            }

            // Bind code, execution, gaps and survivors to the same accepted version.
            const survivorIds = survivedMutants.split('\n').filter(Boolean);
            const oldSurvivorIds = bestSurvivors.split('\n').filter(Boolean);
            const reintroduced = Boolean(bestCode) && survivorIds.some(id => !oldSurvivorIds.includes(id));
            const measuredCoverage = loopAssessment;
            const coverageComparison = bestCode ? compareCoverageQuality(
                bestCoverage!.assessment!, measuredCoverage) : undefined;
            const lostQuality = coverageComparison?.regressed === true;
            if (bestMutation && (mutationRun.sourceHash !== bestMutation.sourceHash
                || mutationRun.operatorSetVersion !== bestMutation.operatorSetVersion
                || mutationRun.scopeVersion !== bestMutation.scopeVersion
                || mutationRun.candidateSetId !== bestMutation.candidateSetId)) {
                throw new AnalysisStageError('mutation', 'mutation-candidate-set',
                    localize("突變候選集合或範圍版本改變，不能與既有品質基線直接比較。"));
            }
            if (!evidenceStillCurrent()) { throw new AnalysisStageError('validation', 'source-changed', localize("來源或相依版本改變，捨棄本輪品質證據。")); }
            if (evidenceHash(fs.readFileSync(testPath, 'utf8')) !== measuredCandidate.codeHash) {
                throw new AnalysisStageError('validation', 'candidate-changed', localize("測試檔在突變期間改變；保留先前已驗證快照。"));
            }
            recordRole('mutation', 'measured', { code: measuredCandidate.code,
                score: noMutationCandidates ? null : mutationScore, survivors: survivorIds, qualityGaps });
            if (!reintroduced && !lostQuality && mutationScore >= bestScore) {
                // Validate identities and persist the full snapshot before publishing any best* state.
                const qualitySnapshot = checkpoints.saveQuality(measuredCandidate, mutationRun);
                bestScore = mutationScore;
                bestCode = qualitySnapshot.code;
                bestSurvivors = survivedMutants;
                bestExecution = loopExecution;
                bestScenarios = acceptedScenarios;
                bestMeasuredGaps = [...measuredQualityGaps];
                bestGaps = [...qualityGaps];
                bestReviewWarnings = [...reviewWarnings];
                bestReviewStatus = reviewStatus;
                bestCoverage = loopCoverage;
                bestTier = currentTier;
                bestMutation = mutationRun;
                recordRole('baseline', 'accepted', { codeHash: evidenceHash(bestCode), score: bestScore,
                    survivors: survivorIds, qualityGaps });
            } else if (bestCode) {
                recordRole('baseline', 'rollback', { rejectedScore: mutationScore, retainedScore: bestScore,
                    reintroduced, lostQuality, coverageComparison, retainedCodeHash: evidenceHash(bestCode) });
                throwIfExecutionCancelled();
                preserveCandidate(testPath);
                fs.writeFileSync(testPath, bestCode, 'utf8');
                mutationScore = bestScore;
                mutationRun = bestMutation!;
                noMutationCandidates = mutationRun.status === 'no-candidates';
                survivedMutants = bestSurvivors;
                loopExecution = bestExecution;
                loopCoverage = bestCoverage;
                loopAssessment = bestCoverage!.assessment!;
                qualityGaps = [...bestGaps];
                reviewWarnings = [...bestReviewWarnings];
                reviewStatus = bestReviewStatus;
                measuredQualityGaps = [...bestMeasuredGaps];
                acceptedScenarios = bestScenarios;
                finalReportMarkdown += localize("> 已還原歷史基線，測試、分數（{0}%）、覆蓋與存活變異體同步還原；原候選保留於 role_events.jsonl。\n\n", bestScore);
            }
            qualityToolsSatisfied = checkpoints.quality?.qualityAssessment?.toolsSatisfied === true;
            if (!checkpoints.quality?.qualityAssessment || (checkpoints.quality.qualityAssessment.policyStatus === 'unassessable'
                && !noMutationCandidates)) {
                throw new AnalysisStageError('validation', 'quality-policy',
                    localize("品質證據不符合本次政策契約；保留測試與診斷，不能宣稱通過。"),
                    { reasons: checkpoints.quality?.qualityAssessment?.reasons || ['missing-quality-assessment'] });
            }
            journal.knowledge({ target: params.funcName || targetFuncName, resolvedTier: bestTier ?? currentTier,
                initialTargetObservations: initialTargetObservations || null,
                supplementalTargetObservations: supplementalTargetObservations || null,
                verifiedObservations: astContext?.traceResult || null,
                sourceStructure: astContext?.code, dependencies: astContext?.dependencyContexts,
                planningHypotheses: semanticPlanContract || null,
                selectedRules: ruleSelection,
                acceptedTest: checkpoints.quality!.testFile,
                acceptedCodeHash: evidenceHash(fs.readFileSync(testPath, 'utf8')),
                dependencyVersions: astContext?.sourceVersions?.map(item => ({ module: path.basename(item.file), hash: item.hash })),
                scenarios: acceptedScenarios, execution: loopExecution, coverage: loopCoverage, mutationScore: noMutationCandidates ? null : mutationScore,
                survivors: survivedMutants.split('\n').filter(Boolean), qualityGaps,
                reviewWarnings, reviewStatus,
                mutation: mutationRun, qualityAssessment: checkpoints.quality?.qualityAssessment,
                generationMode: checkpoints.quality?.generationMode,
                qualityBaseline: { path: 'quality_baseline.json', codeHash: checkpoints.quality?.codeHash },
                nextTasks: qualityStrategyHints(survivedMutants), taskStatus: 'hypotheses-require-execution' });
            // 每次接受可執行基準後立刻保存報告，後續角色或品質步驟失敗也不會遺失成果。
            finalReportMarkdown += `\n- **Reviewer status**: ${reviewStatus}\n`;
            // Checkpoint every accepted executable baseline before any later quality work.
            writeReport();
            recordRole('report', 'checkpointed', {
                score: noMutationCandidates ? null : mutationScore,
                targetCoverageComplete: measuredQualityGaps.length === 0,
                path: existingReport
            });
            const assessment = checkpoints.quality!.qualityAssessment!;
            const finalReason = assessment.fullyPassed ? localize("品質政策達標；執行與審查完成")
                : assessment.toolsSatisfied ? localize("量測達標；審查未完成")
                    : noMutationCandidates ? localize("N/A - 選定範圍沒有可用突變候選")
                        : localize("執行通過；品質政策尚未達標");
            finalReportMarkdown += localize("- **品質政策**: {0}\n", qualityPolicy.policyId)
                + localize("- **品質判定**: {0}\n", finalReason);

            sidebarProvider.webview?.postMessage({
                command: 'updateCoverage',
                fileName: displayName,
                file: displayFile,
                func: params.funcName || '',
                score: noMutationCandidates ? 'N/A' : (typeof mutationScore === 'number' ? `${mutationScore}%` : 'N/A'),
                coverage: (loopCoverage as { coverageText: string; missingLines: string } | null)?.coverageText ?? null,
                reason: finalReason
            });

            if (fs.existsSync(path.join(reportDir, 'index.html'))) {
                throwIfExecutionCancelled();
                vscode.env.openExternal(vscode.Uri.file(path.join(reportDir, 'index.html')));
            }

            if (qualityProgress.observe(survivedMutants.split('\n').filter(Boolean), coverageGapIds(
                loopAssessment))) {
                recordRole('analyst-quality', 'stagnated', { reason: localize("連續 3 輪沒有減少已測量缺口；保留基線並停止。") });
                finalReportMarkdown += localize("> 品質尚未達標：連續 3 輪沒有進步，停止相同策略重試。\n");
                journal.knowledge({ terminalStatus: 'stagnated' });
                break;
            }
            if (noMutationCandidates && measuredQualityGaps.length === 0) {
                log(localize("[優化] 本輪沒有可評分的突變點，停止重複迴圈。"));
                journal.knowledge({ terminalStatus: 'no-mutation-candidates' });
                break;
            }
            if (checkpoints.quality?.qualityAssessment?.toolsSatisfied) {
                log(localize("[優化] 同一候選的完整量測已符合執行前固定的品質政策；已保存基準。"));
                journal.knowledge({ terminalStatus: checkpoints.quality.qualityAssessment.fullyPassed
                    ? 'passed' : 'execution-passed-review-incomplete' });
                break;
            }
            if ((survivedMutants || qualityGaps.length) && !mayUseModelAuthoredTests) {
                const note = localize("Auto 模式下目前模型尚未通過 unittest 生成探測；已保留 deterministic Tier 1 測試與存活變異體報告，停止 LLM 修補以避免猜測性測試。請先執行「測試連線」，或明確選擇 Tier 2–4 後再啟用受驗證閘門保護的自我修復。");
                log(localize("[優化] {0}", note));
                finalReportMarkdown += `> [!NOTE]\n> ${note}\n\n`;
                journal.knowledge({ terminalStatus: 'quality-incomplete' });
                break;
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const stack = error instanceof Error && error.stack ? error.stack : '';
            const executable = checkpoints.executable;
            const retainedBaseline = Boolean(bestCode || executable);
            const evidenceValid = evidenceStillCurrent();
            const retainedScore = bestMutation && evidenceValid ? measuredMutationScore(bestMutation) : null;
            const failureCategory = isExecutionCancelled() ? 'cancelled'
                : error instanceof RepairResponseError ? 'model-format'
                    : error instanceof AnalysisStageError ? error.category : classifyExecutionFailure(message);
            const failureStage = error instanceof RepairResponseError ? 'bug-fixer-response'
                : error instanceof AnalysisStageError ? error.stage : 'pipeline';
            recordRole('pipeline', retainedBaseline ? 'retained-baseline' : 'failed', {
                reason: message, category: failureCategory, retainedScore
            });
            journal.knowledge({
                terminalStatus: !evidenceValid ? 'source-changed' : failureCategory === 'cancelled' ? 'cancelled' : retainedBaseline ? 'retained-after-failure' : 'failed',
                failure: message, failureCategory, failureStage,
                evidenceValid,
                diagnostic: error instanceof AnalysisStageError || error instanceof RepairResponseError ? error.diagnostic : undefined,
                retainedScore
            });
            if (bestCode) {
                preserveCandidate(testPath);
                fs.writeFileSync(testPath, bestCode, 'utf8');
                mutationScore = bestScore;
                loopExecution = bestExecution;
                loopCoverage = bestCoverage;
                loopAssessment = bestCoverage!.assessment!;
                survivedMutants = bestSurvivors;
                qualityGaps = [...bestGaps];
                reviewWarnings = [...bestReviewWarnings];
                reviewStatus = bestReviewStatus;
            } else if (executable) {
                preserveCandidate(testPath);
                fs.writeFileSync(testPath, executable.code, 'utf8');
                loopExecution = executable.execution;
                loopCoverage = executable.coverage;
                loopAssessment = executable.coverage.assessment || loopAssessment;
                survivedMutants = '';
                qualityGaps = [...executable.qualityGaps];
                measuredQualityGaps = [...executable.measuredQualityGaps];
                reviewWarnings = [...executable.reviewWarnings];
                reviewStatus = executable.reviewStatus;
                acceptedScenarios = [...executable.scenarios];
                journal.knowledge({ acceptedTest: executable.testFile, acceptedCodeHash: executable.codeHash,
                    resolvedTier: executable.tier, scenarios: executable.scenarios, execution: executable.execution,
                    coverage: executable.coverage, qualityGaps, reviewWarnings, reviewStatus,
                    mutationScore: null, mutationStatus: 'incomplete', survivors: null });
            }
            if (!evidenceValid) {
                invalidateSourceEvidence();
            }
            if (message !== localize("使用者強制中止")) {log(localize("[錯誤] 執行中斷: {0}", message));}
            finalReportMarkdown += retainedBaseline
                ? localize("\n### 後續步驟中斷；已保留可執行基準（第 {0} 輪）\n\n", currentLoop)
                : localize("\n### ❌ 執行中斷（第 {0} 輪）\n\n", currentLoop);
            finalReportMarkdown += localize("- **失敗分類**: {0}\n\n", failureCategory);
            if (retainedBaseline && retainedScore === null) {
                const unavailableReason = !evidenceValid ? localize("來源已變更，舊證據失效")
                    : bestMutation?.status === 'no-candidates' ? localize("沒有可用候選") : localize("尚未完成有效測量");
                finalReportMarkdown += localize("- **突變分數**: N/A（{0}）\n", unavailableReason)
                    + localize("- **保留測試**: {0}\n- **Reviewer status**: {1}\n\n", (checkpoints.quality || executable)!.testFile, reviewStatus);
            }
            finalReportMarkdown += localize("**錯誤訊息**: {0}\n\n", message);
            if (stack && stack !== message) {
                finalReportMarkdown += localize("**錯誤堆疊**:\n```\n{0}\n```\n\n", stack);
            }
            writeReport();
            sidebarProvider.webview?.postMessage({
                command: 'updateCoverage',
                fileName: displayName,
                file: displayFile,
                func: params.funcName || '',
                score: retainedScore !== null ? `${retainedScore}%` : retainedBaseline ? 'N/A' : '失敗',
                coverage: retainedBaseline && evidenceValid ? loopCoverage?.coverageText ?? null : null,
                reason: !evidenceValid ? localize("來源已變更；舊成果僅供歷史查看，需重新分析") : retainedBaseline
                    ? retainedScore !== null ? localize("已保留 {0}% 基準；後續步驟失敗", retainedScore) : localize("已保留可執行測試；突變品質尚未完成")
                    : message.includes('CUDA') ? localize("VRAM 不足") : (message.length > 50 ? message.substring(0, 47) + '...' : message)
            });
            break;
        }

        // Analyst proposes bounded scenarios; Writer owns code. Do not spend a call after the last round.
        analystTasks = qualityStrategyHints(survivedMutants).join('\n');
        if (currentLoop < params.maxLoops && (survivedMutants || qualityGaps.length) && mayUseModelAuthoredTests) {
            try {
                // Measured comparison survivors can propose bounded numeric inputs
                // without another model call. Only isolated observations become oracles.
                let observedBoundary = false;
                if (bestMutation && astContext && evidenceStillCurrent()) {
                    const plan = await planMutationProbes(initialSource, params.funcName || targetFuncName,
                        bestMutation, astContext.traceResult, pythonExecutable);
                    if (plan.inputs.length || plan.diagnostics.length) {
                        fs.writeFileSync(path.join(loopDir, `loop${currentLoop}_mutation_input_plan.json`),
                            JSON.stringify({ ...plan, sourceHash: journal.sourceHash, candidateSetId: bestMutation.candidateSetId }, null, 2), 'utf8');
                        journal.knowledge({ mutationInputPlan: plan });
                        recordRole('mutation-inputs', 'planned', { inputCount: plan.inputs.length, diagnostics: plan.diagnostics });
                        if (plan.diagnostics.some(item => item.status === 'conditional-equivalence')) {
                            finalReportMarkdown += localize("\n> 存活突變包含「前置分支可能使下限重複」的條件式等價候選；尚未證明自訂型別等所有路徑等價，仍保留分母與未達標狀態。詳見本輪 mutation_input_plan.json。\n");
                        }
                    }
                    if (plan.inputs.length) {
                        const observations = await runBehaviorProbe(params.filePath, params.funcName || targetFuncName,
                            [], pythonExecutable, plan.inputs, loopDir);
                        if (!evidenceStillCurrent()) { throw new Error(localize("來源或相依已變更，未採用補測觀測。")); }
                        observedBoundary = Boolean(observations && !observations.load_error
                            && [...observations.examples, ...observations.errors].some(item => item.call_assertable !== false
                                && item.result_assertable !== false));
                        if (observedBoundary && observations) {
                            astContext.traceResult = mergeBehaviorProbeResults(astContext.traceResult, observations);
                            writerEvidenceBundle.mergedTargetObservations = astContext.traceResult;
                            journal.knowledge({ verifiedObservations: astContext.traceResult,
                                nextTasks: [{ origin: 'measured-mutation-inputs', inputs: plan.inputs,
                                    verification: localize("觀測僅支持相同輸入的斷言；下一輪仍須通過獨立基線、執行、審查與突變量測。") }],
                                taskStatus: 'observed-inputs-require-quality-measurement' });
                            analystTasks += '\nNew boundary inputs have isolated execution observations in TRACE evidence. '
                                + 'The host preserves these tests. Keep model cases; do not copy TestVerifiedTrace methods into model classes. '
                                + 'Do not invent output expectations.\n' + JSON.stringify(plan.inputs);
                        }
                        recordRole('mutation-inputs', observedBoundary ? 'observed' : 'unavailable', {
                            inputCount: plan.inputs.length, summary: summarizeObservationPhase(observations || undefined) });
                    }
                }
                const sys = getQualityAnalystSystemPrompt();
                const focus = selectQualityFocus(loopAssessment, survivedMutants.split('\n').filter(Boolean), currentLoop);
                if (focus && !observedBoundary) {
                    const tasks = await qualityAnalystSession.request({ focus,
                        context: `TARGET SOURCE\n${astContext?.code || ''}\nMODULE: ${targetImportModule}\n`
                            + `CURRENT TESTS\n${fs.readFileSync(testPath, 'utf8')}\n`
                            + `CONDITIONAL STRATEGIES (not output facts)\n${qualityStrategyHints(focus.evidence).join('\n')}`,
                        deadlineAt: deadlineAtFromTimeoutSeconds(params.timeoutSeconds),
                        checkCancelled: throwIfExecutionCancelled,
                        event: (status, detail) => recordRole('analyst-quality', status, detail),
                        request: (prompt, deadline) => requestBudgeted(params, sys, prompt, log,
                            analysisResponseFormat === 'text' ? 'text' : 'quality-json', 'analyst-quality', deadline)
                    });
                    if (tasks) {
                        analystTasks += '\n' + JSON.stringify(tasks);
                        journal.record(currentLoop, 'next-tasks', 'unverified', { tasks });
                        journal.knowledge({ nextTasks: tasks, taskStatus: 'hypotheses-require-execution' });
                    } else {
                        const fallback = { evidence: focus.evidence, origin: 'measured-gap-guidance',
                            guidance: qualityStrategyHints(focus.evidence), assertionOracle: false };
                        analystTasks += '\nMEASURED GAP (not an output oracle):\n' + JSON.stringify(fallback);
                        journal.knowledge({ nextTasks: [fallback], taskStatus: 'hypotheses-require-execution' });
                        recordRole('analyst-quality', 'measured-guidance', fallback);
                    }
                }
            } catch (error: any) {
                if (isExecutionCancelled()) {
                    recordRole('analyst-quality', 'cancelled', {});
                    break;
                }
                recordRole('analyst-quality', 'failed', { reason: error.message });
            }
        }

        if (currentLoop === params.maxLoops) { journal.knowledge({ terminalStatus: 'round-limit', qualityGaps }); }
        currentLoop++;
    }


    const finalReportPath = path.join(reportRoot, `final_report.md`);
    writeReport();
    sidebarProvider.webview?.postMessage({
        command: 'attachResultReport',
        fileName: displayName,
        reportPath: finalReportPath
    });
    log(localize("[系統] 分析結束！測試檔與最終報告已儲存至:\n{0}", sessionDir));
    
    if (!params.batchJournal) {
        const doc = await vscode.workspace.openTextDocument(finalReportPath);
        throwIfExecutionCancelled();
        await vscode.window.showTextDocument(doc, { preview: false });
    }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const category = isExecutionCancelled() ? 'cancelled'
            : error instanceof RepairResponseError ? 'model-format'
                : error instanceof AnalysisStageError ? error.category : classifyExecutionFailure(message);
        const stage = error instanceof RepairResponseError ? 'bug-fixer-response'
            : error instanceof AnalysisStageError ? error.stage : 'pipeline';
        journal.knowledge({ terminalStatus: category === 'cancelled' ? 'cancelled' : stage === 'source-changed' ? 'source-changed' : 'failed',
            failure: message, failureCategory: category, failureStage: stage,
            diagnostic: error instanceof AnalysisStageError || error instanceof RepairResponseError ? error.diagnostic : undefined });
        recordRole(stage, 'failed', { reason: message, category });
        finalReportMarkdown += localize("\n### 執行停止\n\n- **失敗分類**: {0}\n- **失敗階段**: {1}\n\n{2}\n", category, stage, message);
        if (!isExecutionCancelled()) {
            sidebarProvider.webview?.postMessage({ command: 'updateCoverage', fileName: displayName,
                file: displayFile, func: params.funcName || '', score: 'N/A',
                coverage: null, reason: message, reportPath: existingReport });
        }
        log(`[${stage}] ${message}`);
    } finally {
        if (journal.snapshot().terminalStatus === 'running') {
            journal.knowledge({ terminalStatus: isExecutionCancelled() ? 'cancelled' : 'incomplete' });
        }
        journal.knowledge({ targetBudget: currentTargetBudget()?.snapshot() });
        writeReport();
        sidebarProvider.webview?.postMessage({ command: 'updateOutcome', fileName: displayName, file: displayFile,
            func: params.funcName || '', reportPath: existingReport, outcome: presentSummaryOutcome(journal.snapshot()) });
    }
}


/**
 * 動態焦點上下文 (Dynamic Focus Context): 
 * 從存活突變體日誌中解析出行號，並提取該行前後的程式碼作為焦點切片。
 */
function extractFocusContext(survivedMutants: string, targetCode: string): string {
    if (!survivedMutants) {return "";}
    const lines = targetCode.split('\n');
    const focusSnippets: string[] = [];
    const mutantLines = survivedMutants.split('\n');
    
    let processedCount = 0;
    for (const mLine of mutantLines) {
        if (processedCount >= 3) {break;} // 最多只取前 3 個焦點，避免 Prompt 過載
        if (!mLine.trim() || !mLine.includes('mutation')) {continue;}
        
        let lineNum = -1;
        // 優先匹配 mutatest 格式: (l: 5, c: 11)
        const mutatestMatch = mLine.match(/\(l:\s*(\d+)/);
        if (mutatestMatch) {
            lineNum = parseInt(mutatestMatch[1], 10);
        } else {
            // fallback
            const otherMatch = mLine.match(/line\s+(\d+)/i) || mLine.match(/:(\d+)/);
            if (otherMatch) {
                lineNum = parseInt(otherMatch[1], 10);
            }
        }
        
        if (lineNum > 0 && lineNum <= lines.length) {
            const idx = lineNum - 1;
            const start = Math.max(0, idx - 2);
            const end = Math.min(lines.length - 1, idx + 2);
            
            let snippet = localize("【目標變異體】\n{0}\n【發生位置周遭程式碼 (第 {1}~{2} 行)】\n```python\n", mLine.trim(), start+1, end+1);
            for (let i = start; i <= end; i++) {
                const prefix = (i === idx) ? '>> ' : '   ';
                snippet += `${prefix}${i+1}: ${lines[i]}\n`;
            }
            snippet += `\`\`\``;
            focusSnippets.push(snippet);
            processedCount++;
        }
    }
    return focusSnippets.join('\n\n');
}

export function deactivate() {}
