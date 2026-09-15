import * as vscode from 'vscode';
import { MutationViewProvider } from './ui/SidebarProvider';
import {
    getSystemPrompt, getUserPrompt, getTier1EvidenceBoundSystemPrompt, getTier3SystemPrompt, getTier3UserPrompt,
    getBugFixerSystemPrompt, getBugFixerUserPrompt, getReviewEvidence, mergeBugFixReplacement,
    fitReviewPrompt, getTestReviewerSystemPrompt, parseTestReview,
    buildSemanticAnalyzerSystemPrompt, getSemanticAnalyzerUserPrompt, parseSemanticAnalysis, restrictSemanticInputHintsToTargetParameters, formatSemanticContextForPrompt, SemanticAnalysis,
    getQualityAnalystSystemPrompt, parseQualityTasks, qualityStrategyHints,
    buildWriterRevisionRequest, ROLE_CONTRACT_VERSIONS
} from './roles';
import { validateTestCandidate } from './pipeline/testCandidatePipeline';
import { AnalysisJournal, evidenceHash, QualityProgress } from './pipeline/analysisJournal';
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
import { buildGoogleGenerateContentRequest, getGoogleGeneratedText, resolveGoogleApiKey } from './llm/cloudApi';
import { addOutputContract, buildCustomChatCompletionBody, CustomOutputFormat, getCustomChatCompletionText, isStructuredResponseUsable, responseSchemaForOutputFormat, shouldRetryStructuredOutputAsText } from './llm/customApi';
import { SerialRequestQueue } from './llm/serialRequestQueue';
import { extractPythonTestCode, unwrapGeneratedCodeEnvelope, validateUnittestStructure } from './validation/generatedTestValidator';
import { buildVerifiedConstructorCall } from './tier/tier1TestBuilder';
import { buildTier1TestFile } from './tier/tier1TestFileBuilder';
import { restoreVerifiedTraceTestFile, shouldPreserveVerifiedTrace } from './tier/traceTestAugmenter';
import { findModelProfile, qualificationForSelectedProfile, restoreModelProfiles, StoredModelProfile, upsertModelProfile } from './llm/modelProfileRegistry';
import { selectAnalysisResponseFormat, selectTestGenerationResponseFormat, qualificationEndpointKey } from './llm/modelQualification';
import { canUseDeterministicTierOne, canUseModelAuthoredRepair, resolveTier, resolveTier1GenerationMode } from './tier/tierRouter';
import { resolveTierTwoSubtaskGate } from './tier/subtaskResponseGate';
import { formatPythonImport, inferTargetImportModule, resolvePythonDependencyPath } from './utils/dependencyResolver';
import { shouldRetryTraceWithoutCallerInputs } from './tier/traceRecovery';
import { assessTargetCoverage } from './mutation/targetCoverage';
import { formatReportProvenance, ReportProvenance } from './utils/reportProvenance';
import { buildStubSmokeAssertion } from './tier/stubSmokeAssertion';
import { hasDummyFunctionNameMarker, isStructurallyInertStub } from './tier/stubClassifier';
import { buildStubTestPlan } from './tier/stubTestPlan';
import { buildGeneratedTestEnvironment, coverageRequiredMessage, generatedUnittestArguments, normalizePythonExecutable, resolvePythonExecutable } from './utils/pythonTestEnvironment';
import { buildExternalMutationExecution } from './mutation/mutationExecution';
import { exceptionNamesFromEvidence } from './validation/exceptionEvidence';
import { validateTraceEvidence } from './validation/traceAssertionEvidence';
import { selectPromptDetail } from './prompts/promptDetailStrategy';
import { classifyExecutionFailure } from './utils/executionFailureCategory';
import { deadlineAtFromTimeoutSeconds, GENERATION_RETRY_MAX_ATTEMPTS, remainingDeadlineMs, retryTransientProviderRequest } from './llm/connectionTimeout';
import { buildSupplementalProbeInputs, SupplementalProbeInput } from './tier/supplementalProbeInputs';
import { traceSubsetForCaller } from './tier/callerTracePartition';
import * as path from 'path';
import * as fs from 'fs';
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
                onError(`[順序執行] 任務 ${index + 1} 執行失敗: ${err?.message ?? err}`);
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
    const execution = analysisRuns.begin({ current: currentModelProfile, stored: storedModelProfiles });
    if (!execution) {
        await vscode.window.showInformationMessage('已有分析執行中，請等待完成或先中止。');
        return;
    }
    const view: AnalysisView = { webview: { postMessage: message => {
        if (!analysisRuns.canPublish(execution)) { return Promise.resolve(false); }
        return sidebar.webview?.postMessage(message) ?? Promise.resolve(false);
    } } };
    const log = (text: string) => { void view.webview?.postMessage({ command: 'appendLog', text }); };
    // Group this run's results under its local date and minute.
    const runParams = { ...params, sessionDate: formatSessionDate() };
    await runInExecution(execution, async () => {
        try { await operation(runParams, log, view); }
        catch (error: any) {
            if (!execution.cancelled) { log(`[錯誤] 測試執行發生異常: ${error?.message ?? error}`); }
        } finally {
            if (analysisRuns.finish(execution)) {
                void sidebar.webview?.postMessage({ command: 'analysisFinished' });
            }
        }
    });
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
    // 快速估算：平均 4 字元 ≈ 1 token（英文）；中文約 1.5 字元 ≈ 1 token
    return Math.ceil(text.length / 3.5);
}

function getContextBudget(profile: ModelProfile): number {
    const ctx = profile.contextLength;
    // 保留 30% 給模型回應輸出，70% 用於 prompt input
    const usable = Math.floor(ctx * 0.7);
    // 根據參數量再限制：小模型即使 ctx 大也不要塞太多
    const paramBillion = parseFloat(profile.paramSize);
    if (!isNaN(paramBillion)) {
        if (paramBillion <= 2)  {return Math.min(usable, 1800);}
        if (paramBillion <= 7)  {return Math.min(usable, 3500);}
        if (paramBillion <= 13) {return Math.min(usable, 6000);}
        return Math.min(usable, 12000);
    }
    // Cloud / unknown -> 充裕 budget
    return Math.min(usable, 20000);
}

interface AnalysisParams {
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
}

function configuredPythonExecutable(): string {
    const configured = vscode.workspace?.getConfiguration?.('llmUnitTest')?.get<string>('pythonPath', '');
    const workspaceRoot = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
    return resolvePythonExecutable(configured, workspaceRoot);
}

interface CallerContext {
    caller_file: string;
    caller_func: string;
    line: number;
    args: string[];
    kwargs: Record<string, string>;
    call_expr?: string;
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
    sourceVersions?: Array<{ file: string; hash: string }>;
    callerContexts?: CallerContext[];
    code: string;
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
    const sidebarProvider = new MutationViewProvider(context.secrets);
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
            const paramsWithPython = { ...params, pythonExecutable: configuredPythonExecutable() };
            await runAnalysisSession(paramsWithPython, sidebarProvider, async (runParams, log, view) => {
                if (runParams.funcName) {
                    await executeSingleFileAnalysis(runParams, log, view);
                    return;
                }
                const funcs = await extractFunctionsWithAst(runParams.filePath, runParams.pythonExecutable);
                throwIfExecutionCancelled();
                if (funcs.length === 0) {
                    log(`[系統] 檔案 ${path.basename(runParams.filePath)} 中無可測試函式。`);
                    return;
                }
                log(`[系統] 全檔案掃描：${funcs.length} 個函式，將逐一分析與測試。`);
                await runSequentially(funcs.map(func => async () => {
                    throwIfExecutionCancelled();
                    await executeSingleFileAnalysis({ ...runParams, funcName: func.fullName }, log, view);
                }), log);
                log('[系統] 全檔案掃描與測試執行完畢。');
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
            const paramsWithPython = { ...params, pythonExecutable: configuredPythonExecutable() };
            await runAnalysisSession(paramsWithPython, sidebarProvider, async (runParams, log, view) => {
                const files = await findPythonFilesInDir(runParams.batchPath);
                throwIfExecutionCancelled();
                const tasks: Array<() => Promise<void>> = [];
                for (const file of files) {
                    throwIfExecutionCancelled();
                    const funcs = await extractFunctionsWithAst(file, runParams.pythonExecutable);
                    for (const func of funcs) {
                        tasks.push(async () => {
                            throwIfExecutionCancelled();
                            log(`[系統] 批次目標：${path.basename(file)}:${func.fullName}`);
                            await executeSingleFileAnalysis({
                                ...runParams, filePath: file, funcName: func.fullName,
                                projectName: path.basename(runParams.batchPath)
                            }, log, view);
                        });
                    }
                }
                log(`[系統] 批次掃描完成：${tasks.length} 個函式，將逐一分析與測試。`);
                await runSequentially(tasks, log);
                log('[系統] 批次自動化測試執行完畢。');
            });
        }
    );

    const abortTestCmd = vscode.commands.registerCommand('llm-unit-test.abortTest', () => {
        if (analysisRuns.cancel()) {
            sidebarProvider.webview?.postMessage({ command: 'appendLog', text: '\n[系統] 已中止本次分析，可重新開始。' });
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
            testGenerationMode: profile.testGenerationMode
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
                testGenerationMode: updatedProfile.testGenerationMode
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
        const { stdout } = await runSpawn(pythonExecutable, args, {
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        const parsed = JSON.parse(stdout);
        return Array.isArray(parsed) ? (parsed as CallerContext[]) : [];
    } catch {
        return [];
    }
}

type ObservationExample = BehaviorObservation;
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
    supplementalInputs: SupplementalProbeInput[] = []
): Promise<BehaviorProbeResult | null> {
    const pythonScript = pythonToolPath('trace');
    const baseArgs = [pythonScript, filePath, funcName];
    let literalInputs: Array<{
        args: unknown[] | null | undefined;
        kwargs: Record<string, unknown>;
        constructor_args?: unknown[] | null;
        constructor_kwargs?: Record<string, unknown> | null;
    }> = [];
    if (callerArgs && callerArgs.length > 0) {
        literalInputs = callerArgs
            .filter(ctx => Array.isArray(ctx.trace_args) && ctx.trace_kwargs !== null)
            .map(ctx => ({
                args: ctx.trace_args,
                kwargs: ctx.trace_kwargs || {},
                constructor_args: ctx.trace_constructor_args,
                constructor_kwargs: ctx.trace_constructor_kwargs || {}
            }));
    }
    const suppliedInputs = [...literalInputs, ...supplementalInputs].filter(input =>
        Array.isArray(input.args) && input.kwargs !== null && typeof input.kwargs === 'object'
    );
    const uniqueInputs = suppliedInputs.filter((input, index) =>
        suppliedInputs.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(input)) === index
    );
    try {
        const runProbe = async (inputs?: typeof literalInputs): Promise<BehaviorProbeResult> => {
            const args = [...baseArgs];
            if (inputs && inputs.length > 0) {args.push(JSON.stringify(inputs));}
            const { stdout } = await runSpawn(pythonExecutable, args, {
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
                timeout: 15000
            });
            return JSON.parse(stdout.trim()) as BehaviorProbeResult;
        };
        const initial = await runProbe(uniqueInputs);
        if (shouldRetryTraceWithoutCallerInputs(initial, uniqueInputs.length)) {
            const retry = await runProbe();
            return { ...retry, input_source: 'source_guided_retry' };
        }
        return {
            ...initial,
            input_source: supplementalInputs.length > 0
                ? 'semantic_guided'
                : literalInputs.length > 0 ? 'caller_literals' : 'source_guided'
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
    if (!initial || initial.load_error) {return additional;}
    if (additional.load_error) {return initial;}
    const mergeItems = (left: ObservationExample[], right: ObservationExample[]) => {
        const seen = new Set<string>();
        return [...left, ...right].filter(item => {
            const key = JSON.stringify(item);
            if (seen.has(key)) {return false;}
            seen.add(key);
            return true;
        });
    };
    return {
        ...additional,
        examples: mergeItems(initial.examples, additional.examples),
        errors: mergeItems(initial.errors, additional.errors),
        input_source: 'semantic_guided'
    };
}

// 所有角色共用同一條請求佇列；即使呼叫端誤觸並行，小模型仍只處理一個提示詞。
// Every role shares one request queue so a small model receives one prompt at a time.
const llmRequestQueue = new SerialRequestQueue();

async function requestLlmApi(
    params: AnalysisParams,
    systemPrompt: string,
    userPrompt: string,
    log: (text: string) => void,
    outputFormat: CustomOutputFormat = 'text'
): Promise<string> {
    return llmRequestQueue.run(() => requestLlmApiUnlocked(
            params, systemPrompt, userPrompt, log, outputFormat,
            deadlineAtFromTimeoutSeconds(params.timeoutSeconds)
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
        throw new Error(`API 請求已超過 ${params.timeoutSeconds} 秒總時限。`);
    }
    let apiUrl = "";
    let bodyData = {};
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const contractedSystemPrompt = addOutputContract(systemPrompt, outputFormat);
    const expectsJsonObject = outputFormat === 'json'
        || outputFormat === 'test-method-json'
        || outputFormat === 'semantic-json'
        || outputFormat === 'review-json'
        || outputFormat === 'mutant-triage-json';

    if (params.envType === 'local') {
        const baseUrl = params.ollamaUrl || 'http://127.0.0.1:11434';
        apiUrl = `${baseUrl.replace(/\/$/, '')}/api/generate`;
        bodyData = {
            model: params.modelName,
            system: contractedSystemPrompt,
            prompt: userPrompt,
            stream: false,
            ...(expectsJsonObject ? { format: 'json' } : {})
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
            throw new Error('找不到 Google AI Studio API Key。請在側邊欄儲存對應模型的 key，或設定 LLM_UNIT_TEST_GOOGLE_API_KEY。');
        }
        const responseSchema = responseSchemaForOutputFormat(outputFormat);
        const googleRequest = buildGoogleGenerateContentRequest(
            params.modelName,
            actualKey,
            contractedSystemPrompt + "\n\n" + userPrompt,
            outputFormat === 'text' ? undefined : { responseMimeType: 'application/json', responseSchema }
        );
        apiUrl = googleRequest.url;
        headers = googleRequest.headers;
        bodyData = googleRequest.body;
    }

    throwIfExecutionCancelled();
    const controller = new AbortController();
    const release = currentExecution()?.onCancel(() => controller.abort());
    const timeoutId = setTimeout(() => {
        controller.abort();
        log(`[警告] API 請求超時 (超過 ${params.timeoutSeconds} 秒)`);
    }, remainingTimeoutMs);
    try {
        const response = await retryTransientProviderRequest(
            () => fetch(apiUrl, {
                method: 'POST', headers, body: JSON.stringify(bodyData), signal: controller.signal
            }),
            {
                maxAttempts: GENERATION_RETRY_MAX_ATTEMPTS,
                isCancelled: () => controller.signal.aborted
                    || isExecutionCancelled()
                    || remainingDeadlineMs(deadlineAt) <= 0,
                onRetry: event => log(
                    `[供應商重試] ${event.reason}；等待 ${event.delayMs}ms 後重試 `
                    + `(${event.retryAttempt}/${event.maxAttempts})。`
                )
            }
        );
        throwIfExecutionCancelled();
        if (!response.ok) {
            const errText = await response.text();
            if (shouldRetryStructuredOutputAsText(response.status, outputFormat)) {
                log(`[格式回退] 供應商拒絕結構化輸出（HTTP ${response.status}），改用一般文字輸出：${errText.substring(0, 180)}`);
                return requestLlmApiUnlocked(params, systemPrompt, userPrompt, log, 'text', deadlineAt);
            }
            throw new Error(`API 伺服器錯誤 (HTTP ${response.status}): ${errText}`);
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
                throw new Error((resJson as any).error.message || "自訂 API 呼叫失敗");
            } else {
                throw new Error("無法解析的 API 回傳格式: " + JSON.stringify(resJson));
            }
        } else {
            const cloudText = getGoogleGeneratedText(resJson);
            if (cloudText) {
                responseText = cloudText;
            } else if ((resJson as any).error) {
                throw new Error((resJson as any).error.message || "Gemini 呼叫失敗");
            } else {
                throw new Error("無法解析的 API 回傳格式: " + JSON.stringify(resJson));
            }
        }

        if (!isStructuredResponseUsable(responseText, outputFormat)) {
            log('[格式回退] 模型回傳了不完整的結構化內容，改用一般文字輸出重試。');
            return requestLlmApiUnlocked(params, systemPrompt, userPrompt, log, 'text', deadlineAt);
        }
        throwIfExecutionCancelled();
        return responseText;
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

interface BasicMutationResult {
    total: number;
    killed: number;
    survived: number;
    errors: number;
    mutants: Array<{ line: number; column: number; from: string; to: string; status: string }>;
    scope_found?: boolean;
    scope?: string;
    baseline_passed?: boolean;
    baseline_output?: string;
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
    bindingContext?: { module: string; target: string; className?: string | null; dependencies: Record<string, string> }
): Promise<{ valid: boolean; reason?: string }> {
    const structure = validateUnittestStructure(
        code, targetCallable, targetModule, targetUsage, allowedExceptionNames, targetClassName
    );
    if (!structure.valid) {
        return structure;
    }

    try {
        const parsed = await runSpawn(
            pythonExecutable,
            bindingContext
                ? [pythonToolPath('bindings'), JSON.stringify(bindingContext)]
                : ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'],
            { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, input: code, timeout: 5000 }
        );
        if (parsed.code !== 0) {
            return { valid: false, reason: `Python AST 無法解析：${(parsed.stderr || parsed.stdout).trim().slice(0, 300)}` };
        }
        if (bindingContext) {
            const bindings = JSON.parse(parsed.stdout) as { valid: boolean; reason?: string };
            if (!bindings.valid) { return bindings; }
        }
        if (targetCallable && targetUsage === 'call' && Array.isArray(targetSignature) && targetSignature.length > 0) {
            const validatorScript = pythonToolPath('calls');
            const compatibility = await runSpawn(
                pythonExecutable,
                [validatorScript, targetCallable, JSON.stringify(targetSignature)],
                { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, input: code, timeout: 5000 }
            );
            if (compatibility.code !== 0) {
                return {
                    valid: false,
                    reason: `目標函式簽名驗證無法執行：${(compatibility.stderr || compatibility.stdout).trim().slice(0, 300)}`
                };
            }
            try {
                const callValidation = JSON.parse(compatibility.stdout) as { valid?: boolean; reason?: string };
                if (!callValidation.valid) {
                    return { valid: false, reason: callValidation.reason || '呼叫不符合被測函式簽名' };
                }
            } catch {
                return { valid: false, reason: '目標函式簽名驗證回傳了無法解析的內容' };
            }
        }
        return { valid: true };
    } catch (error: any) {
        return { valid: false, reason: `Python AST 驗證無法執行：${error.message || error}` };
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

function extractCoverage(output: string, targetFile: string): { coverageText: string, missingLines: string } {
    const assessment = assessTargetCoverage(output, targetFile, []);
    return { coverageText: assessment.coverageText, missingLines: assessment.missingLines };
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
    let astReport = `### AST 靜態解析結果\n`;
    astReport += `- 函式名稱: \`${astContext.name}\`\n`;
    astReport += `- 參數列表: \`${astContext.args.join(', ') || '無'}\`\n`;
    astReport += `- 相依呼叫: \`${astContext.calls.join(', ') || '無'}\`\n`;
    if (astContext.docstring) {
        astReport += `- 文件註解: \`${astContext.docstring.trim().replace(/\n/g, ' ')}\`\n`;
    }
    if (astContext.dependencies && astContext.dependencies.length > 0) {
        astReport += `- 跨檔案依賴: ${astContext.dependencies.map((d: any) => `\`${formatPythonImport(d)}.${d.name}\``).join(', ')}\n`;
    }
    if (astContext.file_imports && astContext.file_imports.length > 0) {
        astReport += `- 模組 Imports: ${astContext.file_imports.map(item => item.kind === 'from' ? `\`from ${'.'.repeat(item.level || 0)}${item.module} import ${item.name}\`` : `\`import ${item.module}\``).join(', ')}\n`;
    }
    if (astContext.referenced_globals && astContext.referenced_globals.length > 0) {
        astReport += `- 引用模組常數: ${astContext.referenced_globals.map(item => `\`${item.name}\``).join(', ')}\n`;
    }
    if (astContext.class_context) {
        const init = astContext.class_context.init;
        const effectiveInit = astContext.class_context.effective_init;
        const inherited = effectiveInit && effectiveInit.defined_on !== astContext.class_context.name
            ? `；繼承建構子：\`${effectiveInit.defined_on}(${effectiveInit.params.join(', ') || '無'})\``
            : '';
        astReport += `- 類別語境: \`${astContext.class_context.name}\`，__init__ 參數：\`${init.params.join(', ') || '無'}\`，初始化屬性：\`${init.assigns.map(item => item.name).join(', ') || '無'}\`${inherited}\n`;
    }
    if (astContext.callerContexts && astContext.callerContexts.length > 0) {
        astReport += `- 呼叫站語境 (${astContext.callerContexts.length} 個):\n`;
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
                astReport += `- \`${dep.name}\` 的呼叫站語境 (${dep.callerContexts.length} 個):\n`;
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
    log: (text: string) => void
): Promise<AstContext | null> {
    log(`[AST] 正在解析函式 \`${funcName}\` 的結構與依賴...`);
    const astContext = await extractAstContext(filePath, funcName, pythonExecutable);
    if (!astContext || astContext.error) {
        return astContext;
    }
    log(`[AST] 解析完成！已擷取函式特徵與依賴。`);

    if (astContext.dependencies && astContext.dependencies.length > 0) {
        log(`[AST] 發現跨檔案依賴！正在深度擷取相依模組原始碼...`);
        astContext.dependencyContexts = [];
        astContext.sourceVersions = [];

        for (const dep of astContext.dependencies) {
            const depFilePath = resolvePythonDependencyPath(filePath, projectRoot, dep);
            if (fs.existsSync(depFilePath)) {
                astContext.sourceVersions.push({ file: depFilePath, hash: evidenceHash(fs.readFileSync(depFilePath, 'utf8')) });
                const depAst = await extractAstContext(depFilePath, dep.name, pythonExecutable);
                if (depAst && !depAst.error) {
                    log(`[AST] 掃描 ${dep.name} 的呼叫站語境...`);
                    const callers = await findCallerContexts(dep.name, projectRoot, depFilePath, pythonExecutable);
                    if (callers.length > 0) {
                        depAst.callerContexts = callers;
                        log(`[AST] 找到 ${callers.length} 個呼叫點：${callers.map(c => `${c.caller_file}:${c.caller_func}`).join(', ')}`);
                    }
                    const dependencyTrace = await runBehaviorProbe(depFilePath, dep.name, callers, pythonExecutable);
                    if (dependencyTrace && !dependencyTrace.load_error) {
                        depAst.traceResult = dependencyTrace;
                        log(`[行為探測] 相依 ${dep.name}：取得 ${dependencyTrace.examples.length} 個成功範例、${dependencyTrace.errors.length} 個例外範例。`);
                    } else if (dependencyTrace?.load_error) {
                        log(`[行為探測] 相依 ${dep.name} 無法安全取得事實：${dependencyTrace.load_error}（保留原始碼語境，不中止分析）。`);
                    }
                    astContext.dependencyContexts.push(depAst);
                    log(`[AST] 成功擷取外部依賴: ${formatPythonImport(dep)}.${dep.name}`);
                }
            }
        }
    }

    const selfCallers = await findCallerContexts(funcName, projectRoot, filePath, pythonExecutable);
    if (selfCallers.length > 0) {
        astContext.callerContexts = selfCallers;
        log(`[AST] 目標函式被呼叫 ${selfCallers.length} 次，已收集所有呼叫語境。`);
    }

    log(`[行為探測] 正在受控執行函式以取得輸入輸出觀測...`);
    const traceResult = await runBehaviorProbe(filePath, funcName, astContext.callerContexts, pythonExecutable);
    if (traceResult && !traceResult.load_error) {
        astContext.traceResult = traceResult;
        const exCount = traceResult.examples.length;
        const errCount = traceResult.errors.length;
        const sourceLabel = traceResult.input_source === 'source_guided_retry'
            ? '（caller 字面值無效，已改用原始碼導向輸入）'
            : traceResult.input_source === 'caller_literals' ? '（含 caller 字面值）' : '';
        log(`[行為探測] 完成！取得 ${exCount} 個成功範例、${errCount} 個例外觀測。${sourceLabel}`);
    } else if (traceResult?.load_error) {
        log(`[行為探測] 受控執行失敗: ${traceResult.load_error}（將繼續使用靜態分析）`);
    }

    return astContext;
}

async function executeSingleFileAnalysis(params: AnalysisParams, log: (text: string) => void, sidebarProvider: AnalysisView) {
    throwIfExecutionCancelled();
    const modelSnapshot = currentExecution<ModelSnapshot>()?.snapshot
        ?? { current: currentModelProfile, stored: storedModelProfiles };
    let currentLoop = 1;
    let mutationScore = 0;
    // Rollback 保底：記錄歷史最高分的測試檔，防止後輪 LLM 改壞舊測試
    let bestScore = -1;
    let bestCode = '';
    let bestTestPath = '';
    let bestSurvivors = '';
    let bestExecution = '';
    let bestScenarios: ScenarioIdentity[] = [];
    let acceptedScenarios: ScenarioIdentity[] = [];
    let measuredQualityGaps: string[] = [];
    let bestMeasuredGaps: string[] = [];
    let bestGaps: string[] = [];
    let bestReviewWarnings: string[] = [];
    let bestCoverage: { coverageText: string; missingLines: string } | null = null;
    let qualityGaps: string[] = [];
    let reviewWarnings: string[] = [];
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
        log(`[Tier] 複雜度評估: ${comp.score}/100 (${comp.level})${comp.reasons.length > 0 ? ' - ' + comp.reasons.slice(0,2).join('; ') : ''}`);
    } else if (dummyNameMarked) {
        log(`[快速通道] 偵測到 dummy 名稱標記，跳過複雜度評估與後續 AST 分析。`);
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
    const tier1GenerationMode = resolveTier1GenerationMode(qualifiedForSelectedModel, userTierSetting);
    const mayUseModelAuthoredTests = tier1GenerationMode === 'llm-evidence-bound';
    const mayUseModelAuthoredRepair = canUseModelAuthoredRepair(qualifiedForSelectedModel, userTierSetting);
    const testGenerationResponseFormat = selectTestGenerationResponseFormat(activeModelProfile);
    const analysisResponseFormat = selectAnalysisResponseFormat(activeModelProfile);
    if (testGenerationResponseFormat === 'text') {
        log('[模型能力] 此模型已驗證純 Python unittest 輸出；正式測試、語意分析與突變分流將不強制供應商 JSON schema。');
    }
    if (qualifiedForSelectedModel === undefined) {
        log(userTierSetting === 'auto'
            ? '[模型能力] 此供應商／模型尚未透過「測試連線」驗證 unittest 生成能力；Auto 會保守使用 Tier 1。測試連線以無副作用 fixture 實測可執行 unittest，並讀取供應商可提供的參數量／Context。'
            : `[模型能力] 此供應商／模型尚未完成 unittest 探測；依你的手動 Tier ${userTierSetting.replace('tier', '')} 選擇繼續執行。輸出仍須通過結構、執行、覆蓋率與突變驗證。`);
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
        log('[模型能力] 此模型尚未通過 unittest 探測；保留你的手動 Tier 選擇，並以既有結構、執行、覆蓋率與突變閘門驗證每次輸出。');
    }
    log(`[系統] 策略路由: ${userTierSetting === 'auto' ? 'Auto 自動' : '使用者指定'} → Tier ${resolvedTier}`);

    if (!params.filePath || !fs.existsSync(params.filePath)) {
        log('[錯誤] 找不到目標檔案路徑');
        return;
    }

    let survivedMutants = "";
    let tier1GenerationModeRecorded = false;
    const reportDateStr = new Date().toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let currentTier = resolvedTier;
    let finalReportMarkdown = `# 突變測試與修復分析報告\n\n- **目標檔案**: ${params.filePath}\n- **測試函式**: ${params.funcName || '全檔案'}\n- **使用的策略**: Tier ${currentTier} (${userTierSetting === 'auto' ? 'Auto 自動路由' : '使用者指定 Tier ' + currentTier})\n- **日期**: ${reportDateStr}\n\n`;
    finalReportMarkdown += formatReportProvenance({
        ...extensionBuildIdentity,
        modelProvider: params.envType,
        modelName: params.modelName,
        requestedTier: userTierSetting,
        resolvedTier,
        qualified: qualifiedForSelectedModel,
        qualificationReason: activeModelProfile.testGenerationReason,
        qualificationMode: activeModelProfile.testGenerationMode,
    });

    const initialSource = fs.readFileSync(params.filePath, 'utf8');
    const baseDir = params.outputPath || path.dirname(params.filePath);
    
    // 建立本次測試的專屬資料夾
    const dateStr = params.sessionDate || formatSessionDate();
    const safeFuncName = params.funcName || 'file';
    const baseName = path.basename(params.filePath, '.py');
    const displayName = params.funcName ? `${path.basename(params.filePath)}:${params.funcName}` : path.basename(params.filePath);
    
    let sessionDir = "";
    if (params.projectName) {
        // 批次測試： baseDir / ProjectName_Date / FileName / FunctionName
        sessionDir = path.join(baseDir, `${params.projectName}_${dateStr}`, baseName, safeFuncName);
    } else {
        // 單檔測試： baseDir / FileName_Date / FunctionName
        sessionDir = path.join(baseDir, `${baseName}_${dateStr}`, safeFuncName);
    }
    
    if (!fs.existsSync(sessionDir)) {
        throwIfExecutionCancelled();
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    // ─── 優化三：斷點續跑 - 若 final_report.md 已存在，直接跳過 ───
    const existingReport = path.join(sessionDir, 'final_report.md');
    if (fs.existsSync(existingReport)) {
        log(`[系統] ⏭️ 跳過 ${params.funcName}：已有完成的分析結果（${existingReport}）。`);
        try {
            const content = fs.readFileSync(existingReport, 'utf8');
            // 若為 Stub/Dummy 函式，依需求不在 UI 列表中顯示
            if (content.includes('此函式為 Stub/Dummy 函式') || content.includes('快速通道結果')) {
                return;
            }
            const scoreMatch = content.match(/\*\*突變分數\*\*:\s*([^\n]+)/);
            const covMatch = content.match(/\*\*覆蓋率\*\*:\s*([^\n]+)/);
            sidebarProvider.webview?.postMessage({
                command: 'updateCoverage',
                fileName: displayName,
                file: path.basename(params.filePath),
                func: params.funcName || '',
                score: scoreMatch ? scoreMatch[1].trim() : '已完成',
                coverage: covMatch ? covMatch[1].trim() : null,
                reason: '跳過 (已存在報告)',
                reportPath: existingReport
            });
        } catch {}
        return;
    }

    // dummy 是使用者明確標記的雜訊／佔位函式。名稱判定可在 AST 前完成，
    // 讓大量 dummy 函式不會逐一觸發 AST、Trace、LLM 或突變測試。
    if (dummyNameMarked) {
        finalReportMarkdown += `## 🚀 Dummy 標記快速通道\n\n`;
        finalReportMarkdown += `> [!NOTE]\n> 函式名稱包含明確 \`dummy\` token，已依使用者標記略過 AST、受控行為探測、LLM 與突變測試。\n\n`;
        finalReportMarkdown += `- **測試狀態**: 已略過（Dummy／雜訊函式）\n`;
        finalReportMarkdown += `- **突變分數**: N/A（使用者標記為 Dummy／雜訊函式）\n`;
        throwIfExecutionCancelled();
        fs.writeFileSync(existingReport, finalReportMarkdown, 'utf-8');
        log(`[快速通道] ✅ Dummy 函式 ${params.funcName} 已略過；結果已寫入 ${existingReport}`);
        return;
    }

    let astContext: AstContext | null = null;
    if (params.funcName) {
        const projectRoot = (params as any).batchPath
            ? (params as any).batchPath
            : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(params.filePath);
        astContext = await resolveAstAndDependencies(
            params.filePath,
            params.funcName,
            projectRoot,
            pythonExecutable,
            log
        );
        if (astContext && !astContext.error) {
            targetFuncName = astContext.name || targetFuncName;
            finalReportMarkdown += buildAstMarkdownReport(astContext);
        } else {
            log(`[AST] 解析遇到問題或找不到指定函式，將退回全域分析模式。`);
        }
    }
    const targetImportModule = inferTargetImportModule(params.filePath, astContext?.file_imports || []);
    const testBindingContext = {
        module: targetImportModule,
        target: targetFuncName,
        className: astContext?.class_name,
        dependencies: Object.fromEntries((astContext?.file_imports || [])
            .filter((item: any) => item.kind === 'from' && item.name && item.name !== '*'
                && (astContext?.calls || []).includes(item.alias || item.bound_name || item.name))
            .map((item: any) => [item.alias || item.bound_name || item.name, `${item.module}.${item.name}`])) as Record<string, string>
    };
    if (astContext && !astContext.error) {
        astContext.target_import_module = targetImportModule;
    }

    // ─── 優化一：Stub/Dummy 函式快速通道 ───
    // 若函式為純 Stub（pass/return None/return <literal>），跳過 LLM + 突變測試
    if (params.funcName && isStubFunction(astContext)) {
        log(`[快速通道] 🚀 偵測到 Stub/Dummy 函式（複雜度 ${complexityScore}/100），直接生成最小 Smoke Test，跳過 LLM 呼叫與突變測試。`);
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
            const reason = `類別 ${className} 的建構子需要 ${requiredConstructorParams.join(', ')}，但找不到可驗證的 caller literal 設定。`;
            finalReportMarkdown += `## 🚀 快速通道結果\n\n> [!WARNING]\n> 此函式為 Stub/Dummy，但無法安全建立實例：${reason} 未產生測試，也未呼叫 LLM。\n`;
            throwIfExecutionCancelled();
            fs.writeFileSync(path.join(sessionDir, 'final_report.md'), finalReportMarkdown, 'utf-8');
            log(`[快速通道] ⏭️ ${reason} 已安全略過。`);
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

        const testPath = path.join(sessionDir, 'loop1_test.py');
        throwIfExecutionCancelled();
        fs.writeFileSync(testPath, smokeTest, 'utf-8');

        finalReportMarkdown += `## 🚀 快速通道結果\n\n`;
        finalReportMarkdown += `> [!NOTE]\n> 此函式為 Stub/Dummy 函式（複雜度 ${complexityScore}/100），已跳過 LLM 生成與突變測試，直接產出最小 Smoke Test。\n\n`;
        finalReportMarkdown += `- **突變分數**: N/A（函式無可突變的業務邏輯）\n`;
        finalReportMarkdown += `- **生成測試**: \`${testPath}\`\n\n`;
        finalReportMarkdown += `\`\`\`python\n${smokeTest}\n\`\`\`\n`;

        throwIfExecutionCancelled();
        fs.writeFileSync(path.join(sessionDir, 'final_report.md'), finalReportMarkdown, 'utf-8');
        log(`[快速通道] ✅ Stub 函式 ${params.funcName} 處理完成！Smoke Test 已寫入 ${testPath}`);
        // 依需求：Stub/Dummy 函式不顯示在 UI 測試列表中，避免洗版
        return;
    }

    // 發送開始測試狀態給 Webview
    sidebarProvider.webview?.postMessage({
        command: 'updateCoverage',
        fileName: displayName,
        file: path.basename(params.filePath),
        func: params.funcName || '',
        score: '測試中',
        coverage: null,
        reason: '分析中...'
    });

    // ─── 語意分析師（Semantic Analyzer）───────────────────────────
    // 對所有函式啟動（不限有跨檔案相依的函式）：
    //   1. 計算各相依函式在此呼叫情境的固定行為（原有功能）
    //   2. 推導此函式的最佳測資策略（新功能）—— AI 決定邊界值，不再硬編碼
    const manifestPath = path.join(sessionDir, 'run_manifest.json');
    if (fs.existsSync(manifestPath)) {
        log('[系統] 同分鐘已有執行紀錄；保留現有候選與證據，請於下一分鐘建立新執行。');
        return;
    }
    const journal = new AnalysisJournal(sessionDir, initialSource,
        params.funcName || 'file', params.modelName);
    const evidenceStillCurrent = () => evidenceHash(fs.readFileSync(params.filePath, 'utf8')) === journal.sourceHash
        && (astContext?.sourceVersions || []).every(version => fs.existsSync(version.file)
            && evidenceHash(fs.readFileSync(version.file, 'utf8')) === version.hash);
    const recordRole = (stage: string, status: string, detail: unknown) => {
        journal.record(currentLoop, stage, status, detail);
        log(`[${stage}] ${status}`);
        finalReportMarkdown += `- **角色事件**: ${stage} / ${status}（完整證據：role_events.jsonl）\n`;
    };
    finalReportMarkdown += `- **執行識別**: ${journal.runId}\n- **來源版本**: ${journal.sourceHash}\n\n`;
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
        dependencyCount: semDeps.length
    });
    recordRole('behavior-probe', initialTargetObservations && !initialTargetObservations.load_error
        ? 'initial-ready' : 'initial-unavailable', {
        phase: 'initial',
        summary: summarizeObservationPhase(initialTargetObservations),
        observations: initialTargetObservations || null
    });
    if (astContext && !astContext.error && mayUseModelAuthoredTests) {
        log(`[語意分析師] 啟動語意前置分析（分析依賴行為 + 推導測資策略）...`);
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
            const semRaw = await requestLlmApi(
                params, semSys, semUsr, log,
                analysisResponseFormat === 'text' ? 'text' : 'semantic-json'
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
                log(`[語意分析師] ✅ 分析完成！相依行為: ${semResult.dependency_behaviors.length} 個、候選不可達路徑: ${semResult.unreachable_paths.length} 個、測資策略參數提示: ${hasStrategy ? semResult.test_strategy.input_hints.length : 0} 個。`);
            } else {
                recordRole('analyst-planning', 'invalid-response', {
                    inputContractVersion: ROLE_CONTRACT_VERSIONS.analystEvidence,
                    outputContractVersion: ROLE_CONTRACT_VERSIONS.semanticPlan,
                    raw: semRaw,
                    result: null
                });
                log(`[語意分析師] ⚠️ 回應未符合語意分析 schema，改用程式碼特徵規則基線（不影響主流程）。`);
            }
        } catch (semErr: any) {
            recordRole('analyst-planning', 'failed', { reason: semErr.message });
            log(`[語意分析師] ⚠️ 語意分析呼叫失敗: ${semErr.message}，繼續主流程。`);
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
            log(`[補充行為探測] 正在以 ${supplementalInputs.length} 組安全純量輸入取得真實 I/O...`);
            const supplementalObservations = await runBehaviorProbe(
                params.filePath,
                params.funcName,
                astContext.callerContexts,
                pythonExecutable,
                supplementalInputs
            );
            if (supplementalObservations) {
                supplementalTargetObservations = supplementalObservations;
                if (!supplementalObservations.load_error) {
                    const mergedObservations = mergeBehaviorProbeResults(
                        astContext.traceResult,
                        supplementalObservations
                    );
                    astContext.traceResult = mergedObservations;
                    log(`[補充行為探測] 完成！新增輸入已實測；目前共 ${mergedObservations.examples.length} 個成功範例、${mergedObservations.errors.length} 個例外範例。`);
                } else {
                    log(`[補充行為探測] 無法安全執行：${supplementalObservations.load_error}（保留原有行為觀測）。`);
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
                reason: '分析師未提出可安全解析且能滿足函式簽章的純量輸入。'
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
        finalReportMarkdown += `\n### 🧠 語意分析師報告\n\n\`\`\`\n${analystGuidance}\n\`\`\`\n\n`;
    }
    finalReportMarkdown += `\n### 測試生成規則\n\n${deterministicRuleIds.map(id => `- ${id}`).join('\n') || '- 無'}\n\n`;
    log(mayUseModelAuthoredTests
        ? `[測試生成規則] 分析完成後選取：${deterministicRuleIds.join(', ') || '無'}。`
        : `[測試生成規則] 模型尚未驗證；使用 AST 確定性規則：${deterministicRuleIds.join(', ') || '無'}。`);

    while (currentLoop <= params.maxLoops && (mutationScore < 100 || qualityGaps.length > 0)) {

        if (isExecutionCancelled()) {
            log(`[系統] ⚠️ 測試已由使用者強制中止。`);
            break;
        }

        log(`\n--- 🔄 第 ${currentLoop} 輪開始 ---`);
        currentTier = resolvedTier;
        finalReportMarkdown += `## 第 ${currentLoop} 輪測試\n`;

        let targetCode: string;
        try {
            targetCode = fs.readFileSync(params.filePath, 'utf-8');
            if (!evidenceStillCurrent()) {
                recordRole('source', 'changed', { reason: '來源版本已改變；停止沿用舊行為觀測與品質證據。' });
                journal.knowledge({ terminalStatus: 'source-changed', evidenceValid: false });
                break;
            }
        } catch {
            log('[錯誤] 讀取檔案失敗');
            return;
        }

        // 測試結果全部放入 sessionDir
        const testPath = path.join(sessionDir, `loop${currentLoop}_test.py`);
        const reportDir = path.join(sessionDir, `loop${currentLoop}_report`);

        let systemPrompt = getSystemPrompt(currentLoop, evalStrategy as 'small' | 'large', survivedMutants, params.modelName);
        let focusContext = "";
        if (currentLoop > 1 && (survivedMutants || qualityGaps.length)) {
            focusContext = extractFocusContext(survivedMutants, targetCode);
            if (focusContext) {
                log(`[動態焦點] 已擷取 ${focusContext.split('【目標變異體】').length - 1} 個突變體焦點區塊，準備進行精準修復。`);
            }
            // 最優解錨定：將歷史最高分的測試嵌入到 focusContext，明確禁止 LLM 刪除修改
            if (bestCode) {
                const bestBlock = `=== EXISTING VERIFIED TESTS (DO NOT DELETE OR MODIFY THESE METHODS) ===\n${bestCode}\n=== END OF EXISTING TESTS ===\n\n`;
                focusContext = bestBlock + focusContext;
                log(`[最優解錨定] 已將歷史最優測試集（${bestScore}%）嵌入到 Prompt，防止 LLM 改壞舊斷言。`);
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
        log(`[Budget] Prompt 估算：${estimatedTokens.toLocaleString()} / ${activeModelProfile.budgetTokens.toLocaleString()} tokens (模型: ${activeModelProfile.paramSize}, Context: ${activeModelProfile.contextLength.toLocaleString()})`);


        let rawCode = ""; // 宣告在外層 try 前面，讓 catch 也能存取
        let sanitizedCode = "";
        let loopCoverage: { coverageText: string, missingLines: string } | null = null;
        let loopExecution = '';
        qualityGaps = [];
        try {
            // ─── Tier 降階修復迴圈 ───
            let tierSuccess = false;
            while (currentTier >= 1 && !tierSuccess && !isExecutionCancelled()) {
                try {
                log(`[Tier 執行] 目前使用策略：Tier ${currentTier}`);
                sanitizedCode = "";
                rawCode = "";

                const callerContextsCount = astContext?.callerContexts?.length || 0;
                const useDivideAndConquer = (currentTier === 2) && (evalStrategy === 'small') && (callerContextsCount > 1) && (!survivedMutants);

                // ─── Tier 1：LLM 證據導向生成；未驗證 Auto 才使用確定性備援 ───
                if (currentTier === 1 && !survivedMutants) {
                const traceResult = astContext?.traceResult;
                if (!tier1GenerationModeRecorded) {
                    const modeLabel = tier1GenerationMode === 'llm-evidence-bound'
                        ? 'LLM 證據導向生成（來源碼 + AST + 已驗證行為觀測 + 測試生成規則）'
                        : '確定性備援（模型尚未通過 Auto 的 unittest 資格探測）';
                    finalReportMarkdown += `- **Tier 1 實際產生模式**: ${modeLabel}\n\n`;
                    // Stable, machine-readable provenance for fixture scorecards.
                    // Keep this separate from the localized explanation above.
                    finalReportMarkdown += `- **Tier 1 generation mode**: ${tier1GenerationMode}\n\n`;
                    tier1GenerationModeRecorded = true;
                }
                if (tier1GenerationMode === 'llm-evidence-bound') {
                    systemPrompt = getTier1EvidenceBoundSystemPrompt();
                    log('[Tier 1] 以 LLM 證據導向生成：模型將根據來源碼、AST、已驗證行為觀測與測試生成規則撰寫測試；後續閘門驗證產物。');
                } else {
                    if (!traceResult || !canUseDeterministicTierOne(traceResult)) {
                        throw new Error(
                            'Tier 1 確定性備援無法取得可驗證的行為觀測；Auto 模式下選定模型尚未通過 unittest 生成探測，'
                            + '因此不會改用 LLM 猜測測試。請先執行「測試連線」，或明確選擇 Tier 1–4 後以既有驗證閘門使用 LLM 生成。'
                        );
                    }
                    log(`[Tier 1 備援] 模型未驗證，使用已驗證行為觀測機械式生成 ${traceResult.examples.length} 個成功範例與 ${traceResult.errors.length} 個例外範例。`);
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
                            `Tier 1 確定性備援無法安全建立 ${className}：建構子需要 ${tier1File.missingConstructorFacts.join(', ')}，`
                            + '但沒有可驗證的 caller literal。請先執行「測試連線」後改用 LLM 證據導向生成。'
                        );
                    } else if (tier1File.code) {
                        sanitizedCode = tier1File.code;
                        rawCode = `[Tier 1 deterministic fallback] Generated ${tier1File.methodCount} observation-derived test methods`;
                        log(`[Tier 1 備援] 完成！共產出 ${tier1File.methodCount} 個行為觀測衍生測試方法。${className ? ` (Class method: ${className}.${targetFuncName})` : ''}`);
                    } else {
                        throw new Error('Tier 1 確定性備援未能從已驗證行為觀測產生測試。');
                    }
                }
            }

                // ─── Tier 3：Mock Scaffold（34–70B 模型） ───
                if (currentTier === 3 && !sanitizedCode && !survivedMutants) {
                log(`[Tier 3] 開啟 Mock Scaffold 策略，正在產生 @patch 骨架…`);
                const traceResult = astContext?.traceResult;
                const scaffoldResult = await runMockScaffold(params.filePath, params.funcName, traceResult, targetImportModule, pythonExecutable);
                if (scaffoldResult && scaffoldResult.scaffold) {
                    log(`[Tier 3] 骨架產生完成！patches: ${scaffoldResult.patches.join(', ') || '(無外部依賴)'}`);
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
                        semanticContext
                    );
                    try {
                        const raw = await requestLlmApi(params, sysP, usrP, log, testGenerationResponseFormat);
                        rawCode = raw;
                        const extracted = sanitizeLlmResponse(raw);
                        if (extracted) {
                            // 將 AI 補全的方法裹入完整類別
                            const className3 = astContext?.class_context?.name ?? null;
                            const importLine3 = className3 ? `from ${targetImportModule} import ${className3}` : `from ${targetImportModule} import *`;
                            const patchImport = scaffoldResult.patches.length > 0 ? `from unittest.mock import patch, MagicMock\n` : '';
                            const testBase3 = scaffoldResult.is_async ? 'unittest.IsolatedAsyncioTestCase' : 'unittest.TestCase';
                            sanitizedCode = [
                                `import unittest`,
                                importLine3,
                                patchImport.trim(),
                                ``,
                                `class TestTier3${targetFuncName || 'Auto'}(${testBase3}):`,
                                extracted.split('\n').map(l => '    ' + l).join('\n'),
                                ``,
                                `if __name__ == '__main__':`,
                                `    unittest.main()`,
                            ].filter(Boolean).join('\n');
                            log(`[Tier 3] 模型補充完成！`);
                        }
                    } catch (e: any) {
                        log(`[Tier 3] 模型詢問失敗: ${e.message}，退回標準流程`);
                    }
                } else {
                    log(`[Tier 3] Mock 骨架產生失敗，退回標準 Tier 2/4 流程`);
                }
            }

                // ─── Tier 4：全自主（由下方標準流程處理，Bug Fixer 僅在執行驗證失敗後觸發）
                if (currentTier === 4 && !sanitizedCode) {
                evalStrategy = 'large'; // 強制使用 large 模型 prompt
            }


            if (useDivideAndConquer && astContext && astContext.callerContexts) {
                log(`[分治合流] 💡 偵測到 ${callerContextsCount} 個呼叫站，開啟分治合流模式（單一小 Task 多次請求，避免失焦與失憶）...`);
                const subSnippets: string[] = [];

                for (let cIdx = 0; cIdx < astContext.callerContexts.length; cIdx++) {
                    const ctx = astContext.callerContexts[cIdx];
                    log(`[分治合流] 正在生成第 ${cIdx + 1}/${callerContextsCount} 個呼叫點測試: \`${ctx.caller_file}\` -> \`${ctx.caller_func}()\``);

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
                            subRaw = await requestLlmApi(params, systemPrompt, subGenerationPrompt, log, testGenerationResponseFormat);
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
                                const subTraceEvidence = await validateTraceEvidence(
                                    subClean,
                                    targetFuncName,
                                    subTraceResult, targetImportModule, pythonExecutable, astContext?.class_name);
                                const subGate = resolveTierTwoSubtaskGate(subValidation, subTraceEvidence);
                                if (subGate.accepted) {
                                    subSnippets.push(subClean);
                                    break;
                                }
                                const subReason = subGate.reason || '不明驗證錯誤';
                                if (retry === 0) {
                                    log(`[分治合流] 呼叫點 ${cIdx + 1} 子回覆未通過格式／行為觀測證據驗證：${subReason}；將重試此子任務。`);
                                    subGenerationPrompt = `${subUserPrompt}\n\nEVIDENCE AND FORMAT REPAIR REQUIRED: ${subReason}\nReturn ONLY one complete Python unittest file inside a single \`\`\`python code block. Preserve exact verified behavior observations.`;
                                } else {
                                    log(`[警告] 呼叫點 ${cIdx + 1} 子回覆連續未通過格式／行為觀測證據驗證：${subReason}`);
                                }
                            } else if (retry === 0) {
                                log(`[分治合流] 呼叫點 ${cIdx + 1} 子回覆為空或不可擷取，將重試此子任務。`);
                            }
                        } catch (err: any) {
                            if (retry === 1) {log(`[警告] 呼叫點 ${cIdx + 1} 生成失敗: ${err.message}`);}
                        }
                    }
                    rawCode += `\n--- [Call Site ${cIdx + 1}: ${ctx.caller_func}] ---\n` + subRaw;
                }

                if (subSnippets.length > 0) {
                    log(`[分治合流] 成功取得 ${subSnippets.length} 個單一呼叫點測試，正在進行 AST/正則機械式合併...`);
                    const mergeRes = mergeTestSnippets(subSnippets, `Test${targetFuncName || 'Merged'}`);
                    sanitizedCode = mergeRes.mergedCode;
                    log(`[分治合流] 🎉 成功重組為單一類別，共包含 ${mergeRes.totalMethodsCount} 個獨立測試方法！`);
                }
            }

            // 若非分治合流模式，或分治合流未取得結果，走標準 Single-Pass 流程
            if (!sanitizedCode) {
                let generationPrompt = userPrompt;
                for (let llmRetry = 0; llmRetry < 2; llmRetry++) {
                    if (llmRetry === 0) {log(`[LLM] 正在呼叫模型推論中... (模型: ${params.modelName})`);}
                    try {
                        rawCode = await requestLlmApi(params, systemPrompt, generationPrompt, log, testGenerationResponseFormat);
                    } catch (err: any) {
                        if (llmRetry === 0) {
                            log(`[警告] 網路或 API 請求失敗: ${err.message}，嘗試自動重試 (1/1)...`);
                            continue;
                        } else {
                            throw err;
                        }
                    }

                    sanitizedCode = sanitizeLlmResponse(rawCode);

                    if (!sanitizedCode) {
                        if (llmRetry === 0) {
                            log(`[警告] 模型回傳程式碼為空或包含無效標籤，嘗試自動重試...`);
                            continue;
                        } else {
                            throw new Error("模型產生的程式碼內容為空 (已重試失敗)");
                        }
                    }

                    // 🚨 偵測 AI 是否在複製原始碼（小模型常見的注意力崩潰）
                    const hasTestMethods = sanitizedCode.includes('def test_') || sanitizedCode.includes('self.assert');
                    const looksLikeSourceCopy = !hasTestMethods && targetFuncName && sanitizedCode.includes(`def ${targetFuncName}`);
                    if (looksLikeSourceCopy) {
                        if (llmRetry === 0) {
                            log(`[警告] ⚠️ AI 輸出的是原始碼而不是測試碼（偵測到複製行為），嘗試重試...`);
                            continue;
                        } else {
                            throw new Error("AI 連續兩次輸出了原始碼而非測試碼，無法產生有效測試");
                        }
                    }

                    // 驗證 AI 產出的程式碼格式是否符合要求，若不合規則嘗試自動救援
                    if (!sanitizedCode.includes('unittest.TestCase') && !sanitizedCode.includes('import unittest')) {
                        log(`[警告] AI 未按格式輸出 unittest.TestCase，嘗試自動救援轉換...`);
                        const rescued = await rescueToUnittest(sanitizedCode, params.filePath, targetFuncName, targetImportModule, pythonExecutable);
                        if (!rescued) {
                            if (llmRetry === 0) {
                                log(`[警告] AI 回傳格式無法解析出有效的測試案例，嘗試重新請求...`);
                                continue;
                            } else {
                                throw new Error("AI 輸出格式連續兩次無法解析為有效測試（無任何 assert 或可用語句）");
                            }
                        }
                        log(`[救援] 自動轉換成功！已將 AI 輸出包裝為 unittest.TestCase 格式。`);
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
                    const traceEvidenceValidation = await validateTraceEvidence(
                        sanitizedCode,
                        targetFuncName,
                        astContext?.traceResult, targetImportModule, pythonExecutable, astContext?.class_name);
                    if (!candidateValidation.valid || !traceEvidenceValidation.valid) {
                        const validationReason = traceEvidenceValidation.reason || candidateValidation.reason;
                        if (llmRetry === 0) {
                            log(`[警告] 模型輸出未通過證據／Python unittest 驗證：${validationReason}；將以嚴格格式要求重試。`);
                            generationPrompt = `${userPrompt}\n\nEVIDENCE AND FORMAT REPAIR REQUIRED: ${validationReason}\nReturn ONLY one complete Python unittest file inside a single \`\`\`python code block. Do not include analysis, Markdown bullets, or prose outside the code block. Keep every assertion for an exact verified call equal to its behavior observation.`;
                            sanitizedCode = '';
                            continue;
                        }
                        throw new Error(`模型連續兩次未通過證據／Python unittest 驗證：${validationReason}`);
                    }

                    break; // 成功跳出 retry
                }
            }

            const isDeterministicTier1Output = rawCode.startsWith('[Tier 1 deterministic fallback]');
            const generatedOutputTitle = isDeterministicTier1Output
                ? '### 🧩 Tier 1 確定性備援產物'
                : '### 🤖 LLM 原始輸出與思考過程';
            const generatedOutputSummary = isDeterministicTier1Output
                ? '點擊展開由已驗證行為觀測組裝的產物（非 LLM）'
                : '點擊展開 AI 完整回應';
            finalReportMarkdown += `${generatedOutputTitle}\n\n`;
            finalReportMarkdown += `<details>\n<summary>${generatedOutputSummary}</summary>\n\n\`\`\`text\n${rawCode}\n\`\`\`\n\n</details>\n\n`;

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
                log(`[警告] AI 遺漏了 import 目標模組的語句，系統自動補齊...`);
                if (finalCode.includes('import unittest')) {
                    finalCode = finalCode.replace('import unittest', `import unittest\nfrom ${targetImportModule} import *`);
                } else {
                    finalCode = `import unittest\nfrom ${targetImportModule} import *\n\n` + finalCode;
                }
            }

            // 🚨 自動補齊 mock / patch import (小模型常見遺漏)
            if ((finalCode.includes('patch(') || finalCode.includes('MagicMock')) && !finalCode.includes('unittest.mock')) {
                log(`[警告] 偵測到程式碼使用 patch/MagicMock 但遺漏 import，系統自動補齊 unittest.mock...`);
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
            const preserveTrace = (candidate: string): string => verifiedTrace?.code
                ? restoreVerifiedTraceTestFile(candidate, verifiedTrace.code, verifiedTrace.methodCount, targetFuncName).code
                : candidate;
            finalCode = preserveTrace(finalCode);
            if (verifiedTrace?.code) {
                log(`[行為觀測保底] 已保留 ${verifiedTrace.methodCount} 個已驗證 I/O 測試於獨立類別；每次修復後也會還原。`);
            }

            recordRole('writer', 'candidate', { tier: currentTier, raw: rawCode, code: finalCode });
            const testDir = path.dirname(testPath);
            const targetDir = path.dirname(params.filePath);
            const testExecutionEnv = buildGeneratedTestEnvironment(process.env, [
                targetDir, path.dirname(targetDir), path.dirname(path.dirname(targetDir)), testDir
            ]);
            const coverageProbe = await runSpawn(pythonExecutable, ['-c', 'import coverage'], {
                env: testExecutionEnv, timeout: 5000
            });
            if (coverageProbe.code !== 0) { throw new Error(coverageRequiredMessage(pythonExecutable)); }
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
                    if (result.code !== 0) { throw new Error('無法建立測試情境識別：' + result.stderr); }
                    inventories.set(hash, JSON.parse(result.stdout));
                }
                return inventories.get(hash)!;
            };
            let baselineScenarios = bestScenarios.length ? bestScenarios : bestCode ? await inventory(bestCode) : [];
            const accepted = await validateTestCandidate(finalCode, {
                checkCancelled: throwIfExecutionCancelled,
                event: recordRole,
                validate: async (code) => {
                    const structural = await validateGeneratedTestCode(code, targetFuncName, baseName,
                        astContext?.method_kind === 'property' ? 'property' : 'call', astContext?.signature,
                        exceptionNamesFromEvidence(astContext), astContext?.class_name || undefined, pythonExecutable, testBindingContext);
                    const trace = await validateTraceEvidence(code, targetFuncName, astContext?.traceResult, targetImportModule, pythonExecutable, astContext?.class_name);
                    return !structural.valid || !trace.valid ? trace.reason || structural.reason || 'Validation failed' : undefined;
                },
                review: async (code) => {
                    if (!mayUseModelAuthoredTests) {
                        recordRole('reviewer', 'skipped-deterministic', {});
                        return { issues: [] };
                    }
                    const sys = getTestReviewerSystemPrompt();
                    const prompt = fitReviewPrompt({ tests: code, evidence: roleEvidence },
                        Math.max(0, Math.floor(activeModelProfile.budgetTokens * 2) - sys.length));
                    if (!prompt) {
                        recordRole('reviewer', 'budget-exceeded', { reason: '完整證據超過預算；未截斷程式碼，交工具驗證並標記審查未完成。' });
                        return undefined;
                    }
                    try {
                        const raw = await requestLlmApi(params, sys, prompt, log, 'review-json');
                        const result = parseTestReview(raw, code);
                        recordRole('reviewer', result ? 'parsed' : 'invalid-response', {
                            contractVersion: ROLE_CONTRACT_VERSIONS.reviewer, raw, result
                        });
                        return result;
                    } catch (error: any) {
                        throwIfExecutionCancelled();
                        recordRole('reviewer', 'failed', { reason: error.message });
                        return undefined;
                    }
                },
                revise: async (code, failure, role) => {
                    if (!mayUseModelAuthoredRepair) { throw new Error('Auto 未驗證模型不可呼叫模型修復。'); }
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
                            ? 'Bug Fixer 的單方法修復內容仍超過模型預算，停止本次修復。'
                            : 'Writer 修訂所需完整證據超過模型預算；未截斷待保留的測試。');
                    }
                    const raw = await requestLlmApi(
                        params, sys, prompt, log,
                        role === 'bug-fixer' ? 'test-method-json' : testGenerationResponseFormat
                    );
                    if (role === 'bug-fixer') {
                        const merged = mergeBugFixReplacement(raw, code, failure);
                        if (!merged) {
                            throw new Error('Bug Fixer 回傳的局部修復介面無效，未修改測試檔。');
                        }
                        return preserveTrace(merged);
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
                        return 'Bug Fixer 修改範圍檢查無法執行：' + (scope.stderr || scope.stdout);
                    }
                    try {
                        const result = JSON.parse(scope.stdout) as { valid?: boolean; reason?: string };
                        return result.valid === true ? undefined : result.reason || 'Bug Fixer 修改超出允許範圍。';
                    } catch {
                        return 'Bug Fixer 修改範圍檢查回傳無效資料。';
                    }
                },
                execute: async (code) => {
                    throwIfExecutionCancelled();
                    if (!evidenceStillCurrent()) {
                        throw new Error('來源版本已改變，停止使用舊證據。');
                    }
                    fs.writeFileSync(testPath, code, 'utf8');
                    const run = await runSpawn(pythonExecutable,
                        generatedUnittestArguments(path.basename(testPath, '.py'), targetDir, true, true),
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
                    if (coverage.code !== 0) { throw new Error('Coverage 工具執行失敗：' + out); }
                    const assessment = assessTargetCoverage(out, params.filePath, astContext?.executable_lines || []);
                    const gaps: string[] = [];
                    if (!assessment.available) { gaps.push('Coverage 無法辨識目標模組；目標覆蓋狀態未知。'); }
                    if (assessment.targetFullyCovered === undefined) { gaps.push('目標行覆蓋狀態未知。'); }
                    if (assessment.targetBranchesCovered === undefined) { gaps.push('目標分支覆蓋狀態未知。'); }
                    if (assessment.targetExecuted === false) { gaps.push('目標函式未執行。'); }
                    if (assessment.missingTargetLines?.length) { gaps.push('目標未覆蓋行：' + assessment.missingTargetLines.join(', ')); }
                    if (assessment.missingTargetBranches?.length) { gaps.push('目標未覆蓋分支：' + assessment.missingTargetBranches.join(', ')); }
                    recordRole('coverage', 'measured', assessment);
                    return { ok: true, out, qualityGaps: gaps };
                }
            }, 2, bestCode ? { code: bestCode, output: bestExecution } : undefined);
            finalCode = accepted.code;
            loopExecution = accepted.execution.out;
            loopCoverage = extractCoverage(loopExecution, params.filePath);
            qualityGaps = accepted.qualityIssues;
            reviewWarnings = accepted.reviewWarnings;
            measuredQualityGaps = accepted.execution.qualityGaps;
            recordRole('validation', 'accepted', {
                codeHash: evidenceHash(finalCode), qualityGaps, reviewWarnings
            });
            finalReportMarkdown += `\n### 執行驗證\n\n\`\`\`text\n${loopExecution}\n\`\`\`\n`;
            if (qualityGaps.length) {
                finalReportMarkdown += `\n### 品質待補強（交分析師與 Writer）\n\n${qualityGaps.map(gap => '- ' + gap).join('\n')}\n`;
            }
            if (reviewWarnings.length) {
                finalReportMarkdown += `\n### Reviewer 警告（不啟動額外修復輪）\n\n${reviewWarnings.map(warning => '- ' + warning).join('\n')}\n`;
            }

            tierSuccess = true;
            break; // 預先驗證成功，跳出 Tier 降階迴圈
        } catch (tierErr: any) {
            throwIfExecutionCancelled();
            recordRole('writer', 'tier-failed', { tier: currentTier, reason: tierErr.message, raw: rawCode });
            if (currentTier > 1) {
                const prevTier = currentTier;
                currentTier--;
                log(`[Tier 降階] ⚠️ Tier ${prevTier} 驗證失敗，自動觸發策略降階：Tier ${prevTier} → Tier ${currentTier} 重試...`);
                finalReportMarkdown += `\n> [!WARNING]\n> ⚠️ **策略自動降階**: Tier ${prevTier} 驗證失敗，系統已自動切換降階至 **Tier ${currentTier}** 思考模式重試。\n\n`;
            } else {
                // Tier 1 也失敗，向上拋出錯誤
                throw tierErr;
            }
        }
    } // end while (currentTier >= 1)


            // 動態偵測 mutation engine；無外部工具時使用安全的 AST 後備引擎。
            let engine: 'mutatest' | 'mutmut' | 'builtin' = 'mutatest';
            let pyVer = '';
            try {
                // 取得 Python 版本
                const { stdout: pyVerRaw } = await runSpawn(pythonExecutable, ['--version'], {
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
                });
                pyVer = pyVerRaw.trim().replace('Python ', '');
                const preferredEngine = detectMutationEngine(pyVer);
                if (!preferredEngine) {
                    engine = 'builtin';
                    log(`[系統] Python ${pyVer} 的原生環境沒有相容的外部突變工具，使用內建 AST 基本突變引擎。建議在 WSL 或 Python 3.11 安裝完整引擎以取得更廣的突變覆蓋。`);
                } else if (preferredEngine === 'mutmut') {
                    log(`[系統] 偵測到 Python ${pyVer}，建議引擎：${preferredEngine}`);
                    // Python 3.12+ uses mutmut because mutatest requires coverage < 6.
                    const mutmutCheck = await runSpawn(pythonExecutable, ['-m', 'mutmut', '--version'], {});
                    if (mutmutCheck.code === 0) {
                        engine = 'mutmut';
                        log(`[系統] mutmut 可用，使用 mutmut 進行突變測試。`);
                    } else {
                        engine = 'mutatest';
                        log(`[系統] mutmut 不可用，退回使用 mutatest。`);
                    }
                } else {
                    log(`[系統] 偵測到 Python ${pyVer}，建議引擎：${preferredEngine}`);
                    // Windows 或 Python < 3.12 優先使用 mutatest
                    const mutatestCheck = await runSpawn(pythonExecutable, ['-c', 'from mutatest.cli import cli_main'], {});
                    if (mutatestCheck.code === 0) {
                        engine = 'mutatest';
                        log(`[系統] mutatest 可用，使用 mutatest 進行突變測試。`);
                    } else {
                        const mutmutCheck = await runSpawn(pythonExecutable, ['-m', 'mutmut', '--version'], {});
                        if (mutmutCheck.code === 0) {
                            engine = 'mutmut';
                            log(`[系統] mutatest 不可用，改用 mutmut。`);
                        } else {
                            log(`[系統] mutatest/mutmut 均不可用，使用內建 AST 基本突變引擎。`);
                            engine = 'builtin';
                        }
                    }
                }
            } catch (e) {
                engine = 'builtin';
                log(`[系統] 無法取得 Python 版本或外部突變工具狀態，使用內建 AST 基本突變引擎。`);
            }

            log(`[${engine}] 正在建構突變測試指令...`);
            log(`[${engine}] 正式啟動分析 (系統超時限制: ${params.timeoutSeconds}秒) ... 這可能會花費數十秒，請稍候！`);

            if (isExecutionCancelled()) {throw new Error("使用者強制中止");}

            let builtinMutation: BasicMutationResult | null = null;
            let noMutationCandidates = false;
            let mutpyResult: string;
            if (engine === 'builtin') {
                const fallbackScript = pythonToolPath('mutation');
                const perMutationTimeout = Math.max(1, Math.min(10, Math.floor(params.timeoutSeconds / 3)));
                const selectedClassName = (astContext?.class_name as string | undefined);
                const fallbackRun = await runSpawn(
                    pythonExecutable,
                    [
                        fallbackScript,
                        params.filePath,
                        testPath,
                        '30',
                        String(perMutationTimeout),
                        targetFuncName || '',
                        selectedClassName || ''
                    ],
                    { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: params.timeoutSeconds * 1000 }
                );
                if (fallbackRun.code !== 0) {
                    throw new Error(`內建 AST 突變引擎執行失敗：${(fallbackRun.stderr || fallbackRun.stdout).slice(0, 500)}`);
                }
                try {
                    builtinMutation = JSON.parse(fallbackRun.stdout) as BasicMutationResult;
                if (!builtinMutation || typeof builtinMutation.total !== 'number') {
                    throw new Error('輸出格式不完整');
                }
                } catch (error: any) {
                    throw new Error(`內建 AST 突變引擎輸出無法解析：${error.message || error}`);
                }
                if (builtinMutation.scope_found === false) {
                    throw new Error(`找不到選定的突變範圍：${builtinMutation.scope || params.funcName || '未知函式'}`);
                }
                if (builtinMutation.baseline_passed === false) {
                    throw new Error(
                        `內建 AST 突變引擎的隔離 baseline 測試失敗，拒絕產生不可信突變分數：${(builtinMutation.baseline_output || '').slice(0, 300)}`
                    );
                }
                mutpyResult = JSON.stringify(builtinMutation, null, 2);
            } else {
                const targetDir = path.dirname(params.filePath);
                const parentDir = path.dirname(targetDir);
                const grandParentDir = path.dirname(parentDir);
                const testDir = path.dirname(testPath);
                const testModule = path.basename(testPath, '.py');
                const mutationPlan = buildExternalMutationExecution(
                    engine,
                    params.filePath,
                    testModule,
                    reportDir,
                    params.mutpyTimeout,
                    pythonExecutable
                );
                const mutationEnvironment = buildGeneratedTestEnvironment(process.env, [
                    targetDir, parentDir, grandParentDir, testDir
                ]);
                const externalRun = await runSpawn(mutationPlan.command, mutationPlan.args, {
                    cwd: testDir,
                    env: mutationEnvironment,
                    timeout: params.timeoutSeconds * 1000
                });
                if (isExecutionCancelled()) {
                    throw new Error('使用者強制中止');
                }
                if (externalRun.code !== 0) {
                    mutpyResult = `[${engine} 系統錯誤訊息]\n結束碼: ${externalRun.code ?? 'unknown'}\n[Stderr]\n${externalRun.stderr}\n[Stdout]\n${externalRun.stdout}`;
                } else {
                    mutpyResult = externalRun.stdout || externalRun.stderr || '無輸出內容';
                }
            }

            log(`[${engine}] 突變分析執行完畢！正在解析報告與分數...`);
            log(`--- 突變測試原生輸出 ---\n${mutpyResult}\n------------------------`);
            
            // 擷取最後 1000 字元，避免錯誤訊息被截斷
            const displayLog = mutpyResult.length > 1000 ? '...' + mutpyResult.substring(mutpyResult.length - 1000) : mutpyResult;
            finalReportMarkdown += `### 執行日誌摘要\n\n\`\`\`text\n${displayLog}\n\`\`\`\n\n`;
            
            if (loopCoverage) {
                finalReportMarkdown += `- **覆蓋率**: ${loopCoverage.coverageText} (未覆蓋行號: ${loopCoverage.missingLines})\n`;
            }
            
            let reasonStr = "";
            if (engine === 'builtin' && builtinMutation) {
                const total = builtinMutation.total;
                const survived = builtinMutation.survived;
                noMutationCandidates = total === 0;
                mutationScore = noMutationCandidates ? 0 : Math.round((builtinMutation.killed / total) * 100);
                const scopeLabel = builtinMutation.scope || '選定範圍';
                const scopeStatus = builtinMutation.scope_found === false ? '未找到' : scopeLabel;
                if (noMutationCandidates) {
                    reasonStr = 'N/A - 選定範圍沒有此引擎可產生的突變點';
                    log(`[分析] 內建 AST 突變引擎在範圍 ${scopeStatus} 找不到可產生的突變點，分數標示為 N/A，不重複執行。`);
                    finalReportMarkdown += `- **突變分數**: N/A（內建 AST 基本引擎，範圍：${scopeStatus}，沒有可產生的突變點）\n`;
                } else {
                    log(`[分析] 內建 AST 突變分數：${mutationScore}% (Scope: ${scopeStatus}, Total: ${total}, Killed: ${builtinMutation.killed}, Survived: ${survived}, Errors: ${builtinMutation.errors})`);
                    finalReportMarkdown += `- **突變分數**: ${mutationScore}%（內建 AST 基本引擎，範圍：${scopeStatus}）\n`;
                }
            } else if (engine === 'mutmut') {
                const totalMatch = mutpyResult.match(/(\d+)\s+mutants/i);
                const survivedMatch = mutpyResult.match(/(\d+)\s+survived/i);
                if (totalMatch || mutpyResult.includes('mutmut')) {
                    const total = totalMatch ? parseInt(totalMatch[1]) : 0;
                    const survived = survivedMatch ? parseInt(survivedMatch[1]) : 0;
                    mutationScore = total === 0 ? 0 : Math.round(((total - survived) / total) * 100);
                    log(`[分析] 本輪突變分數：${mutationScore}% (Total: ${total}, Survived: ${survived})`);
                    finalReportMarkdown += `- **突變分數**: ${mutationScore}%\n`;
                } else {
                    log(`[錯誤] 無法解析突變分數！可能 mutmut 執行失敗。`);
                    reasonStr = "解析失敗";
                    finalReportMarkdown += `- **突變分數**: 解析失敗\n`;
                }
            } else {
                const totalMatch = mutpyResult.match(/TOTAL RUNS: (\d+)/);
                const survivedMatch = mutpyResult.match(/SURVIVED: (\d+)/);
                if (totalMatch) {
                    const total = parseInt(totalMatch[1]);
                    const survived = survivedMatch ? parseInt(survivedMatch[1]) : 0;
                    mutationScore = total === 0 ? 0 : Math.round(((total - survived) / total) * 100);
                    log(`[分析] 本輪突變分數：${mutationScore}% (Total: ${total}, Survived: ${survived})`);
                    finalReportMarkdown += `- **突變分數**: ${mutationScore}%\n`;
                } else {
                    log(`[錯誤] 無法解析突變分數！可能 mutatest 執行失敗。`);
                    reasonStr = "解析失敗";
                    finalReportMarkdown += `- **突變分數**: 解析失敗\n`;
                }
            }

            survivedMutants = engine === 'builtin' && builtinMutation
                ? builtinMutation.mutants
                    .filter(mutant => mutant.status === 'SURVIVED')
                    .map(mutant => `- line ${mutant.line}, column ${mutant.column}: mutation from ${mutant.from} to ${mutant.to}`)
                    .join('\n')
                : engine === 'mutmut' ? parseMutmutSurvived(mutpyResult) : parseMutatestSurvived(mutpyResult);
            if (survivedMutants) {
                log(`[弱點分析] 本輪存活變異體資訊已擷取，將於下一輪優化進行 Assert 強化：\n${survivedMutants}`);
                reasonStr = survivedMutants.split('\n')[0] + (survivedMutants.split('\n').length > 1 ? "..." : "");
                finalReportMarkdown += `#### 存活的變異體\n\`\`\`text\n${survivedMutants}\n\`\`\`\n`;
            } else {
                log(`[分析] 本輪無存活變異體，或分析結果已達最優。`);
                if (mutationScore >= 100) {reasonStr = "通過";}
                finalReportMarkdown += `- **存活變異體**: 無\n`;
            }

            // Bind code, execution, gaps and survivors to the same accepted version.
            const survivorIds = survivedMutants.split('\n').filter(Boolean);
            const oldSurvivorIds = bestSurvivors.split('\n').filter(Boolean);
            const reintroduced = Boolean(bestCode) && survivorIds.some(id => !oldSurvivorIds.includes(id));
            const lostQuality = Boolean(bestCode) && measuredQualityGaps.some(gap => !bestMeasuredGaps.includes(gap));
            if (!evidenceStillCurrent()) { throw new Error('來源或相依版本改變，捨棄本輪品質證據。'); }
            recordRole('mutation', 'measured', { code: fs.readFileSync(testPath, 'utf8'),
                score: noMutationCandidates ? null : mutationScore, survivors: survivorIds, qualityGaps });
            if (!noMutationCandidates && !reintroduced && !lostQuality && mutationScore >= bestScore) {
                bestScore = mutationScore;
                bestCode = fs.readFileSync(testPath, 'utf8');
                bestTestPath = testPath;
                bestSurvivors = survivedMutants;
                bestExecution = loopExecution;
                bestScenarios = acceptedScenarios;
                bestMeasuredGaps = [...measuredQualityGaps];
                bestGaps = [...qualityGaps];
                bestReviewWarnings = [...reviewWarnings];
                bestCoverage = loopCoverage;
                recordRole('baseline', 'accepted', { codeHash: evidenceHash(bestCode), score: bestScore,
                    survivors: survivorIds, qualityGaps });
            } else if (bestCode) {
                recordRole('baseline', 'rollback', { rejectedScore: mutationScore, retainedScore: bestScore,
                    reintroduced, lostQuality, retainedCodeHash: evidenceHash(bestCode) });
                throwIfExecutionCancelled();
                fs.writeFileSync(testPath, bestCode, 'utf8');
                mutationScore = bestScore;
                survivedMutants = bestSurvivors;
                loopExecution = bestExecution;
                loopCoverage = bestCoverage;
                qualityGaps = [...bestGaps];
                reviewWarnings = [...bestReviewWarnings];
                measuredQualityGaps = [...bestMeasuredGaps];
                acceptedScenarios = bestScenarios;
                finalReportMarkdown += `> 已還原歷史基線，測試、分數（${bestScore}%）、覆蓋與存活變異體同步還原；原候選保留於 role_events.jsonl。\n\n`;
            }
            journal.knowledge({ target: targetFuncName,
                initialTargetObservations: initialTargetObservations || null,
                supplementalTargetObservations: supplementalTargetObservations || null,
                verifiedObservations: astContext?.traceResult || null,
                sourceStructure: astContext?.code, dependencies: astContext?.dependencyContexts,
                planningHypotheses: semanticPlanContract || null,
                selectedRules: ruleSelection,
                acceptedTest: path.basename(bestTestPath || testPath),
                acceptedCodeHash: evidenceHash(fs.readFileSync(testPath, 'utf8')),
                dependencyVersions: astContext?.sourceVersions?.map(item => ({ module: path.basename(item.file), hash: item.hash })),
                scenarios: acceptedScenarios, execution: loopExecution, coverage: loopCoverage, mutationScore: noMutationCandidates ? null : mutationScore,
                survivors: survivedMutants.split('\n').filter(Boolean), qualityGaps,
                reviewWarnings,
                nextTasks: qualityStrategyHints(survivedMutants), taskStatus: 'hypotheses-require-execution' });
            // 每次接受可執行基準後立刻保存報告，後續角色或品質步驟失敗也不會遺失成果。
            // Checkpoint every accepted executable baseline before any later quality work.
            fs.writeFileSync(existingReport, finalReportMarkdown, 'utf8');
            recordRole('report', 'checkpointed', {
                score: noMutationCandidates ? null : mutationScore,
                targetCoverageComplete: measuredQualityGaps.length === 0,
                path: existingReport
            });
            if (qualityGaps.length) { reasonStr = '執行通過；品質仍有待補強項目'; }
            let finalReason = reasonStr;
            if (!finalReason) {
                if (typeof mutationScore === 'number') {
                    if (mutationScore >= 100) {
                        finalReason = '通過 (100%)';
                    } else if (mutationScore >= 80) {
                        finalReason = `高覆蓋 (${mutationScore}%)`;
                    } else if (mutationScore >= 50) {
                        finalReason = `部分通過 (${mutationScore}%)`;
                    } else if (mutationScore > 0) {
                        finalReason = `低分 (${mutationScore}%)`;
                    } else {
                        finalReason = '已完成 (無突變點/0%)';
                    }
                } else {
                    finalReason = '已完成';
                }
            }

            sidebarProvider.webview?.postMessage({
                command: 'updateCoverage',
                fileName: displayName,
                file: path.basename(params.filePath),
                func: params.funcName || '',
                score: noMutationCandidates ? 'N/A' : (typeof mutationScore === 'number' ? `${mutationScore}%` : 'N/A'),
                coverage: (loopCoverage as { coverageText: string; missingLines: string } | null)?.coverageText ?? null,
                reason: finalReason
            });

            if (fs.existsSync(path.join(reportDir, 'index.html'))) {
                throwIfExecutionCancelled();
                vscode.env.openExternal(vscode.Uri.file(path.join(reportDir, 'index.html')));
            }

            if (qualityProgress.observe(survivedMutants.split('\n').filter(Boolean), measuredQualityGaps)) {
                recordRole('analyst-quality', 'stagnated', { reason: '連續 3 輪沒有減少已測量缺口；保留基線並停止。' });
                finalReportMarkdown += '> 品質尚未達標：連續 3 輪沒有進步，停止相同策略重試。\n';
                journal.knowledge({ terminalStatus: 'stagnated' });
                break;
            }
            if (noMutationCandidates) {
                log(`[優化] 本輪沒有可評分的突變點，停止重複迴圈。`);
                journal.knowledge({ terminalStatus: 'no-mutation-candidates' });
                break;
            }
            if (mutationScore >= 100 && measuredQualityGaps.length === 0) {
                log(`[優化] 突變分數已達到 100%，且目標 Coverage 完整；已保存成功基準。`);
                journal.knowledge({ terminalStatus: 'passed' });
                break;
            }
            if ((survivedMutants || qualityGaps.length) && !mayUseModelAuthoredTests) {
                const note = 'Auto 模式下目前模型尚未通過 unittest 生成探測；已保留 deterministic Tier 1 測試與存活變異體報告，停止 LLM 修補以避免猜測性測試。請先執行「測試連線」，或明確選擇 Tier 2–4 後再啟用受驗證閘門保護的自我修復。';
                log(`[優化] ${note}`);
                finalReportMarkdown += `> [!NOTE]\n> ${note}\n\n`;
                break;
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const stack = error instanceof Error && error.stack ? error.stack : '';
            const retainedBaseline = Boolean(bestCode);
            recordRole('pipeline', retainedBaseline ? 'retained-baseline' : 'failed', {
                reason: message, retainedScore: retainedBaseline ? bestScore : undefined
            });
            journal.knowledge({
                terminalStatus: retainedBaseline ? 'retained-after-failure' : 'failed',
                failure: message,
                retainedScore: retainedBaseline ? bestScore : undefined
            });
            if (bestCode) {
                fs.writeFileSync(testPath, bestCode, 'utf8');
                mutationScore = bestScore;
                loopExecution = bestExecution;
                loopCoverage = bestCoverage;
                survivedMutants = bestSurvivors;
                qualityGaps = [...bestGaps];
                reviewWarnings = [...bestReviewWarnings];
            }
            const failureCategory = classifyExecutionFailure(message);
            if (message !== "使用者強制中止") {log(`[錯誤] 執行中斷: ${message}`);}
            finalReportMarkdown += retainedBaseline
                ? `\n### 後續步驟中斷；已保留成功基準（第 ${currentLoop} 輪）\n\n`
                : `\n### ❌ 執行中斷（第 ${currentLoop} 輪）\n\n`;
            finalReportMarkdown += `- **失敗分類**: ${failureCategory}\n\n`;
            finalReportMarkdown += `**錯誤訊息**: ${message}\n\n`;
            if (stack && stack !== message) {
                finalReportMarkdown += `**錯誤堆疊**:\n\`\`\`\n${stack}\n\`\`\`\n\n`;
            }
            // 記錄 AI 原始輸出（如果有的話）
            if (rawCode) {
                finalReportMarkdown += `**AI 實際輸出內容（前 500 字元）**:\n\`\`\`\n${rawCode.substring(0, 500)}\n\`\`\`\n\n`;
            }
            fs.writeFileSync(existingReport, finalReportMarkdown, 'utf8');
            sidebarProvider.webview?.postMessage({
                command: 'updateCoverage',
                fileName: displayName,
                file: path.basename(params.filePath),
                func: params.funcName || '',
                score: retainedBaseline ? `${bestScore}%` : '失敗',
                coverage: retainedBaseline ? bestCoverage?.coverageText ?? null : null,
                reason: retainedBaseline
                    ? `已保留 ${bestScore}% 基準；後續步驟失敗`
                    : message.includes('CUDA') ? 'VRAM 不足' : (message.length > 50 ? message.substring(0, 47) + '...' : message)
            });
            break;
        }

        // Analyst proposes bounded scenarios; Writer owns code. Do not spend a call after the last round.
        analystTasks = qualityStrategyHints(survivedMutants).join('\n');
        if (currentLoop < params.maxLoops && (survivedMutants || qualityGaps.length) && mayUseModelAuthoredTests) {
            const measured = [survivedMutants, ...qualityGaps].filter(Boolean).join('\n');
            try {
                const sys = getQualityAnalystSystemPrompt();
                const prompt = `TARGET SOURCE\n${astContext?.code || ''}\nMODULE: ${targetImportModule}\n`
                    + `MEASURED GAPS\n${measured}\nCURRENT TESTS\n${fs.readFileSync(testPath, 'utf8')}\n`
                    + `CONDITIONAL STRATEGIES (not output facts)\n${analystTasks}`;
                if (estimateTokens(sys + prompt) > activeModelProfile.budgetTokens) {
                    recordRole('analyst-quality', 'budget-exceeded', { measured });
                } else {
                    const raw = await requestLlmApi(params, sys, prompt, log, 'text');
                    const tasks = parseQualityTasks(raw, measured);
                    recordRole('analyst-quality', tasks ? 'parsed-hypotheses' : 'invalid-response', { raw, tasks, measured });
                    if (tasks) {
                        analystTasks += '\n' + JSON.stringify(tasks);
                        journal.record(currentLoop, 'next-tasks', 'unverified', { tasks });
                        journal.knowledge({ nextTasks: tasks, taskStatus: 'hypotheses-require-execution' });
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


    const finalReportPath = path.join(sessionDir, `final_report.md`);
    fs.writeFileSync(finalReportPath, finalReportMarkdown, 'utf8');
    sidebarProvider.webview?.postMessage({
        command: 'attachResultReport',
        fileName: displayName,
        reportPath: finalReportPath
    });
    log(`[系統] 分析結束！測試檔與最終報告已儲存至:\n${sessionDir}`);
    
    const doc = await vscode.workspace.openTextDocument(finalReportPath);
    throwIfExecutionCancelled();
    await vscode.window.showTextDocument(doc, { preview: false });
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
            
            let snippet = `【目標變異體】\n${mLine.trim()}\n【發生位置周遭程式碼 (第 ${start+1}~${end+1} 行)】\n\`\`\`python\n`;
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
