import { createResultLayout, roundDirectory, preserveCandidate } from './pipeline/resultLayout';
import { loadTargetProbeFixtures, ProbeFixtureIdentity } from './pipeline/probeInputFixtures';
import { traceTimingPreferences } from './pipeline/traceStartupBudget';
import { generatedLoadRepairFeedback, readGeneratedRunnerDiagnostics } from './pipeline/generatedRunnerDiagnostics';
import { localize, withLanguage } from './i18n/core';
import { initI18n } from './i18n';
import * as vscode from 'vscode';
import { MutationViewProvider } from './ui/SidebarProvider';
import {
    getSystemPrompt, getUserPrompt, getTier1EvidenceBoundSystemPrompt, getTier3SystemPrompt, getTier3UserPrompt,
    getBugFixerSystemPrompt, getBugFixerUserPrompt, getReviewEvidence, mergeBugFixReplacementDetailed, canRepairTestMethod,
    fitReviewPrompt, getTestReviewerSystemPrompt,
    buildSemanticAnalyzerSystemPrompt, getSemanticAnalyzerUserPrompt, restrictSemanticInputHintsToTargetParameters, formatSemanticContextForPrompt, SemanticAnalysis,
    getQualityAnalystSystemPrompt, selectQualityFocus, QualityAnalystSession, qualityStrategyHints,
    buildWriterRevisionRequest, ROLE_CONTRACT_VERSIONS, WriterReviewFeedback
} from './roles';
import { CandidatePipelineHooks, CandidateValidationError } from './pipeline/testCandidatePipeline';
import { validateSeedThenCandidate } from './pipeline/seedCandidatePipeline';
import { RejectedCandidateStore, CandidateRejectionGate } from './pipeline/rejectedCandidateStore';
import { reviewWithContractRepair } from './roles/reviewContractRepair';
import { semanticWithContractRepair } from './roles/semanticContractRepair';
import { buildReviewFacts, buildReviewerEvidenceDiagnostic } from './roles/reviewFacts';
import { formatModelRequestTimeout } from './pipeline/modelRequestTimingPresentation';
import { validatePassingTestPreservation } from './pipeline/passingTestPreservation';
import { passingTestIds } from './validation/repairFeedback';
import { buildWriterSeedPrompt, buildWriterExpansionPrompt, buildWriterAdditionRevisionPrompt,
    buildWriterAdditionSystemPrompt, buildWriterSeedSystemPrompt, buildWriterCaseAdditionPrompt,
    selectWriterAdditionMethodName, buildWriterAdditionMethodInstruction } from './roles/writerPhases';
import { bindQualityTaskObservations, QualityTaskEvidence, qualityTasksForWriter,
    qualityFocusInputDiagnostic, qualityInputAlreadyTested, qualityFocusCasesForPrompt,
    resolveQualityTaskTraceCaseIds } from './pipeline/qualityTaskEvidence';
import { selectWriterSeedCaseIds } from './prompts/compactWriterContext';
import { seedCaseFactsForPrompt, validateWriterSeedContract } from './pipeline/writerSeedContract';
import { composeFocusedWriterAdditions } from './pipeline/focusedWriterAdditions';
import { getRuntimeContextPreference, RuntimeContextPreference } from './llm/runtimeContextPreferences';
import { LocalRuntimeMetadataDiagnostic } from './llm/localRuntimeMetadata';
import { collectNumericRepairEvidence } from './pipeline/numericTestSkill';
import { NumericEvidenceLedger } from './pipeline/numericEvidenceLedger';
import { verificationMode, VerificationMode } from './pipeline/verificationMode';
import { runExecutionVerification } from './pipeline/executionVerification';
import { readSavedWriterCandidate, SavedWriterCandidateRequest } from './pipeline/savedWriterCandidate';
import { EXECUTION_DEPENDENCY_BOUNDARY_GUIDANCE, executionHelperRepairGuidance, sourceHelperUsePointNames, sourceLiteralRepairGuidance } from './prompts/dependencyMockContract';
import { getExecutionWriterSystemPrompt, getExecutionWriterPrompt } from './roles/unittestWriter';
import { repairSourceLiteralArgument, repairSourceMockReceiver, repairSourceTestBinding, repairSourceMockSetup, repairSourceParameterMock } from './pipeline/sourceLiteralArgumentRepair';
import { compareCoverageQuality, coverageGapIds } from './pipeline/qualityRegression';
import { AnalysisJournal, evidenceHash, QualityProgress } from './pipeline/analysisJournal';
import { CandidateCheckpointStore, CandidateCoverage } from './pipeline/candidateCheckpoint';
import { SOURCE_VERSIONS_VERSION, sourceVersionsCurrent } from './pipeline/sourceVersions';
import { TargetBudget, TargetBudgetLimits, currentTargetBudget, runWithTargetBudget, planAnalysisTargetBudget } from './pipeline/targetBudget';
import { parseBehaviorObservations, recoverBehaviorProgress, mergeBehaviorObservations } from './pipeline/behaviorObservations';
import { buildProbeInputs, callerForPrompt, TypedProbeInputsV1 } from './pipeline/probeInputs';
import { createDefaultQualityPolicy } from './pipeline/qualityPolicy';
import { normalizeExecutionSettings } from './pipeline/executionSettings';
import { snapshotExecutionTargetBudget } from './pipeline/executionTimingSettings';
import { createAnalysisDirectory, createBatchDirectory } from './pipeline/analysisOutput';
import { reserveArtifactFiles } from './pipeline/artifactPaths';
import { BatchJournal } from './pipeline/batchJournal';
import { partitionBatchPreflight, BatchPreflightTarget, BatchPreflightRow } from './pipeline/batchPreflightPartition';
import { writeBatchPreflightSnapshot } from './pipeline/batchPreflightSnapshot';
import { presentOutcome, presentSummaryOutcome, describeStageEvent, withOutcomeHeader } from './pipeline/resultPresentation';
import { TierHistory } from './pipeline/tierHistory';
import { focusedSeedOutputFloor, isTestFocus, resolveTestFocus, testFocusInstruction, testFocusLabel } from './pipeline/testFocus';
import { mayFallbackTier, selectCandidateRepairRole } from './tier/tierFailurePolicy';
import { ReportIdentity, writeTargetReports, renderMutationBaselineTiming } from './pipeline/targetReport';
import { planMutationProbes } from './pipeline/mutationProbePlan';
import { deduplicateTargets } from './pipeline/batchScope';
import { prepareQualityExperiments, buildQualityExperimentEvidencePrompt, assessQualityCandidateNovelty } from './pipeline/qualityExperiments';
import { QualityImprovementSession, PendingQualityFocus } from './pipeline/qualityImprovementSession';
import { containsCredential } from './pipeline/artifactSafety';
import { AI_WORKFLOW_VERSION, requireReviewApproval, ReviewApproval } from './pipeline/aiWorkflow';
import { invalidateCurrentPreflightFailures, preflightTargetModule, PreflightResult, ResolvedDependency } from './pipeline/modulePreflight';
import { createImportFixturePlan, currentImportFixtures, withImportFixtures } from './pipeline/importFixtures';
import {
    BehaviorObservation,
    BehaviorObservations,
    SemanticPlanV2,
    summarizeObservationPhase,
    observationsForPrompt,
    WriterEvidenceBundleV3
} from './pipeline/evidenceContracts';
import { normalizeScenarioOutput, reconcileScenarios, ScenarioIdentity } from './validation/scenarioIdentity';
import { dispatchTestRules } from './pipeline/testRuleDispatcher';
import { pythonToolPath } from './pipeline/pythonTools';
import { extractFunctionsWithAst, findPythonFilesInDir } from './utils/utils';
import { mergeTestSnippets, mergeTestSnippetsPreservingBaseline, mergeWriterTestAddition,
    extractWriterAdditionCode, projectWriterAdditionContext } from './validation/testMerger';
import { buildGoogleGenerateContentRequest, getGoogleGeneratedText, GoogleGenerateContentRequest, googleThinkingSession, resolveGoogleApiKey } from './llm/cloudApi';
import { buildOllamaPromptEnvelope } from './llm/ollamaPrompt';
import { addOutputContract, buildCustomChatCompletionBody, CustomOutputFormat, getCustomChatCompletionText, isStructuredResponseUsable, responseSchemaForOutputFormat, shouldRetryStructuredOutputAsText } from './llm/customApi';
import { SerialRequestQueue, SerialRequestQueueError } from './llm/serialRequestQueue';
import { fetchModelResponse, getSafeTransportFailureCode } from './llm/modelTransport';
import { extractPythonTestCode, unwrapGeneratedCodeEnvelope, validateUnittestStructure } from './validation/generatedTestValidator';
import { buildVerifiedConstructorCall } from './tier/tier1TestBuilder';
import { findModelProfile, restoreModelProfiles, StoredModelProfile, upsertModelProfile } from './llm/modelProfileRegistry';
import { QUALIFICATION_VERSION, selectAnalysisResponseFormat, selectTestGenerationResponseFormat, qualificationEndpointKey, qualificationAppliesToRequest, qualificationForRequest, type ModelQualificationProfile } from './llm/modelQualification';
import { RoleQualificationProfile, qualifiedRole } from './llm/roleQualification';
import { ReviewSession, ReviewStatus } from './roles/reviewSession';
import { resolveTier, resolveTier1GenerationMode } from './tier/tierRouter';
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
import { configureTestResources } from './environment/resourceSetupController';
import { inspectProjectImports, ImportCheckTarget } from './environment/projectImportCheck';
import { verifyInitializationSources } from './environment/initializationPlanning';
import { ImportFixtureRule } from './pipeline/importFixtures';
import { buildTargetIsolatedResourceContext, type IsolatedResourceSourceEvidence } from './prompts/isolatedResourceContext';
import { readResourceSetupFailure } from './pipeline/resourceSetupFailure';
import { pythonEnvironmentActivity } from './environment/pythonEnvironmentSetup';
import { AnalysisEnvironmentLease } from './environment/analysisEnvironmentLease';
import { captureBatchSetupScope } from './pipeline/batchSetupContinuity';
import { MutationEngineSelection } from './mutation/mutationExecution';
import { SelectedMutationEngine, selectMutationEngine, mutationArguments } from './mutation/mutationSelection';
import { mutationProcessFailure } from './mutation/mutationProcessFailure';
import { MutationRun, MutationContext, parseIsolatedMutationRun,
    mutationScore as measuredMutationScore } from './mutation/mutationResult';
import { exceptionNamesFromEvidence } from './validation/exceptionEvidence';
import { validateTraceEvidence } from './validation/traceAssertionEvidence';
import { selectPromptDetail } from './prompts/promptDetailStrategy';
import { contextGrowthCeiling, contextInputBudget, estimatePromptTokens, promptFits, runtimeContextWindow, resolveLocalRuntimeContext } from './prompts/promptBudget';
import { roleRequestBudget, type WriterRevisionWorkload } from './prompts/roleRequestBudget';
import { assessPromptCapacity } from './prompts/promptCapacity';
import { formatPromptCapacity } from './pipeline/promptCapacityPresentation';
import { CONTEXT_GROWTH_INPUT_HEADROOM_TOKENS, planContextGrowth } from './prompts/contextGrowth';
import { requalifyLocalRuntime, runLocalRuntimeQualificationProbe, runtimeQualificationExecutionBudget } from './llm/localRuntimeRequalification';
import { runtimeRoleAuthorization } from './llm/runtimeQualificationSession';
import { unprobedLocalQualification } from './llm/connectionQualification';
import { currentBatchRuntimeQualification, initializeBatchRuntimeQualification } from './pipeline/batchRuntimeQualification';
import { planWriterOutputGrowth, WriterOutputBudget } from './prompts/writerOutputBudget';
import { planTraceStartupBudget } from './pipeline/traceStartupBudget';
import { getCompletedOllamaText, outputShape, readOutputShapeDiagnostic } from './llm/ollamaResponse';
import { buildModelOutputPreview, diagnoseModelOutput, readModelOutputPreview, writerOutputFormatCorrection } from './llm/modelOutputDiagnostics';
import { readCandidateMethodInventory, CandidateSyntaxDiagnostic } from './pipeline/candidateMethodInventory';
import { buildWriterSeedFormatRepairPrompt, buildWriterReviewCorrectionPrompt } from './roles/writerPhases';
import { writerSeedCompletionPrompt, assembleWriterSeedCompletion } from './llm/writerSeedCompletion';
import { writerSeedCodePrefix } from './pipeline/targetContract';
import { formatSourceLineContext } from './pipeline/sourceLineContext';
import { prepareParameterFixtureExperiments, ParameterFixtureSession, checkParameterFixtureReplay, parameterFixtureReplayInstruction, type FixtureEvidence } from './pipeline/parameterFixtureExperiments';
import { readOllamaGenerationResponse } from './llm/ollamaGenerationResponse';
import { COMPACT_WRITER_VERSION, buildWriterRevisionContext } from './prompts/compactWriterContext';
import { AnalysisStageError, classifyExecutionFailure, modelRequestHttpStatus } from './utils/executionFailureCategory';
import { RepairResponseError, REPAIR_REASON_LABELS, repairReasonCode, formatRepairRouting } from './pipeline/repairDiagnostics';
import { deadlineAtFromTimeoutSeconds, GENERATION_RETRY_MAX_ATTEMPTS, remainingDeadlineMs, retryTransientProviderRequest } from './llm/connectionTimeout';
import { boundedRoleStageDeadline, createRequestProgress, createRequestQueueTiming, createTransportAttemptTiming, type RequestTimingEvent, type TransportAttemptTiming } from './llm/requestTiming';
import { createOutputRecoveryStage, outputRecoveryAttemptDeadline, outputRecoveryTokenLimit, planOutputRecoveryRetry } from './llm/outputRecoveryTiming';
import { buildSupplementalProbeInputs, SupplementalProbeInput } from './tier/supplementalProbeInputs';
import { traceSubsetForCaller } from './tier/callerTracePartition';
import { planCallerPartitions } from './tier/callerPartitionPlan';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { runSpawn } from './utils/processRunner';
import { existingRealPath } from './utils/fileIdentity';
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
            // A target has exhausted its own bounded repair loop. Do not
            // schedule another target after a terminal execution failure.
            throw err;
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
): Promise<{ scaffold: string; patches: string[]; namespace_patches?: string[]; mock_names: string[]; class_name?: string | null; is_async?: boolean } | null> {
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

interface ModelProfile extends ModelQualificationProfile {
    paramSize: string;      // e.g. "2.0B", "13.0B", "Cloud (Gemini)"
    contextLength: number;  // max context tokens from model
    contextLengthKnown?: boolean;
    effectiveRuntimeContextTokens?: number;
    runtimeContextSource?: StoredModelProfile['runtimeContextSource'];
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
    writerSeedPromptMode?: 'instruction' | 'code-completion';
    requireRoleQualification?: boolean;
    current: ModelProfile;
    stored: StoredModelProfile[];
    runtimeContextTokens: unknown;
    runtimeContextPreferences: RuntimeContextPreference[];
    targetBudget?: unknown;
    localRuntimeMetadata?: LocalRuntimeMetadataDiagnostic;
}
const analysisRuns = new ExecutionManager<ModelSnapshot>();
interface AnalysisView { webview?: Pick<vscode.Webview, 'postMessage'> }

type AnalysisModelSelection = Pick<AnalysisParams, 'envType' | 'modelName' | 'ollamaUrl' | 'customUrl'>;

/** Resolve the exact initial model/context once with the same policy as targets. */
function initialAnalysisModel(params: AnalysisModelSelection, modelSnapshot: ModelSnapshot) {
    const selectedEndpointKey = qualificationEndpointKey(params.envType,
        params.envType === 'local' ? params.ollamaUrl : params.envType === 'custom' ? params.customUrl : undefined);
    const selectedStoredProfile = findModelProfile(modelSnapshot.stored, {
        envType: params.envType, modelName: params.modelName, endpointKey: selectedEndpointKey
    });
    const selectedModelProfile = selectedStoredProfile ? withBudget(selectedStoredProfile)
        : (modelSnapshot.current.envType === params.envType && modelSnapshot.current.modelName === params.modelName
            && (modelSnapshot.current.endpointKey || qualificationEndpointKey(params.envType)) === selectedEndpointKey
            ? modelSnapshot.current : defaultModelProfile());
    const contextPreference = getRuntimeContextPreference(modelSnapshot.runtimeContextPreferences,
        { endpointKey: selectedEndpointKey, modelName: params.modelName });
    const localRuntime = params.envType === 'local' ? resolveLocalRuntimeContext({
        paramSize: selectedModelProfile.paramSize, contextLength: selectedModelProfile.contextLength,
        contextLengthKnown: selectedModelProfile.contextLengthKnown,
        runtimeContextTokens: modelSnapshot.runtimeContextTokens,
        preferredRuntimeContextTokens: contextPreference?.tokens,
        preferredRuntimeContextSource: contextPreference?.source,
        qualificationRuntime: selectedModelProfile.qualificationRuntime,
        effectiveRuntimeContextTokens: selectedModelProfile.effectiveRuntimeContextTokens
    }) : undefined;
    const requestContextWindow = localRuntime?.ok ? localRuntime.contextWindow
        : runtimeContextWindow(selectedModelProfile.paramSize, selectedModelProfile.contextLength);
    const activeModelProfile = { ...selectedModelProfile,
        budgetTokens: localRuntime?.ok ? localRuntime.inputBudget : selectedModelProfile.budgetTokens };
    const qualificationRequest = { envType: params.envType, modelName: params.modelName,
        endpointKey: selectedEndpointKey, runtimeContextTokens: requestContextWindow };
    return { selectedEndpointKey, selectedModelProfile, contextPreference, localRuntime,
        requestContextWindow, activeModelProfile, qualificationRequest };
}

/** Global prerequisites must fail before import setup, Trace or role requests. */
async function requireInitialAutoRoles(params: AnalysisModelSelection & Partial<Pick<AnalysisParams,
    'promptStrategy' | 'validationMode' | 'filePath' | 'funcName' | 'pythonExecutable'>>, snapshot: ModelSnapshot) {
    if (snapshot.requireRoleQualification !== true) { return; }
    const mode = verificationMode(params.validationMode);
    const { activeModelProfile, localRuntime, qualificationRequest } = initialAnalysisModel(params, snapshot);
    const current = !(localRuntime && !localRuntime.ok)
        && qualificationAppliesToRequest(activeModelProfile, qualificationRequest);
    const writer = qualificationForRequest(activeModelProfile, qualificationRequest) === true
        && qualifiedRole('writer', activeModelProfile.roleQualification, current, true);
    const reviewer = qualifiedRole('reviewer', activeModelProfile.roleQualification, current);
    if (writer && (mode === 'execution' || reviewer)) { return; }
    // Explicit inert/dummy targets have no AI workflow and retain their
    // diagnostic fast path. Only static AST is read; no application is loaded.
    if (mode === 'full' && params.filePath && params.funcName) {
        if (hasDummyFunctionNameMarker(params.funcName)) { return; }
        const ast = await extractAstContext(params.filePath, params.funcName, normalizePythonExecutable(params.pythonExecutable));
        throwIfExecutionCancelled();
        if (isStubFunction(ast)) { return; }
    }
    if (localRuntime && !localRuntime.ok) {
        throw new AnalysisStageError('validation', 'model-runtime',
            localize('本機 Context 設定無法使用；請檢查 llmUnitTest.runtimeContextTokens，並重新執行模型測試連線。')
                + ` [${localRuntime.reasonCode}]`, { reasonCode: localRuntime.reasonCode });
    }
    throw new AnalysisStageError('validation', 'role-qualification', isTestFocus(params.promptStrategy)
        ? localize('測試重點模式需要先完成本次容量的 Writer 角色測試連線；完整流程亦需 Reviewer。')
        : mode === 'full'
        ? localize('完整流程的 Auto 需要先完成 Writer 與 Reviewer 角色測試連線。')
        : localize('Auto 的 Writer 尚未通過此模型的生成探測。請先執行「測試連線」，或明確選擇手動 Tier；執行驗證模式不會改用 Trace 代替生成。'));
}

async function runAnalysisSession<T extends AnalysisModelSelection & Partial<Pick<AnalysisParams,
    'promptStrategy' | 'validationMode' | 'filePath' | 'funcName' | 'pythonExecutable' | 'targetBudget' | 'requireRoleQualification'>>>(
    params: T,
    sidebar: MutationViewProvider,
    operation: (params: T & { sessionDate: string }, log: (text: string) => void, view: AnalysisView,
        withEnvironmentSetup: <R>(setup: () => Promise<R>) => Promise<R>) => Promise<void>
): Promise<void> {
    const config = vscode.workspace.getConfiguration('llmUnitTest');
    const required = params.requireRoleQualification ?? config.get<unknown>('requireRoleQualification', false);
    if (typeof required !== 'boolean') { throw new AnalysisStageError('validation', 'qualification-policy', 'Invalid role qualification policy.'); }
    const writerSeedPromptMode = config.get<unknown>('writerSeedPromptMode', 'instruction');
    if (writerSeedPromptMode !== 'instruction' && writerSeedPromptMode !== 'code-completion') {
        throw new AnalysisStageError('validation', 'writer-prompt-policy', 'Invalid Writer seed prompt mode.');
    }
    const environmentLease = AnalysisEnvironmentLease.acquire(pythonEnvironmentActivity);
    if (!environmentLease) {
        const hadActiveAnalysis = analysisRuns.hasActiveRun;
        await vscode.window.showInformationMessage(localize("Python 環境準備中，請等待完成後再開始測試。"));
        if (!hadActiveAnalysis && !analysisRuns.hasActiveRun) {
            void sidebar.webview?.postMessage({ command: 'analysisFinished' });
        }
        return;
    }
    const selectedParams = params.envType === 'local' ? { ...params,
        ollamaUrl: params.ollamaUrl || config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434') } : params;
    const execution = analysisRuns.begin({ current: currentModelProfile, stored: storedModelProfiles,
        writerSeedPromptMode,
        requireRoleQualification: required,
        runtimeContextTokens: config.get<unknown>('runtimeContextTokens', 0),
        runtimeContextPreferences: sidebar.runtimeContextPreferencesSnapshot(),
        targetBudget: params.targetBudget ?? config.get<unknown>('targetBudget', {}) });
    if (!execution) {
        environmentLease.release();
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
    const runParams = { ...selectedParams, sessionDate: formatSessionDate() };
    await withLanguage(() => runInExecution(execution, async () => {
        try {
            // Capture once for the entire run; retries and later batch targets
            // must not borrow changed settings or renew their own counters.
            runParams.targetBudget = snapshotExecutionTargetBudget(execution.snapshot.targetBudget);
            if (selectedParams.envType === 'local' && selectedParams.modelName) {
                const identity = { envType: 'local' as const, modelName: selectedParams.modelName,
                    endpointKey: qualificationEndpointKey('local', selectedParams.ollamaUrl) };
                const snapshot = execution.snapshot;
                const cachedProfile = findModelProfile(snapshot.stored, identity)
                    ?? (snapshot.current.envType === identity.envType && snapshot.current.modelName
                        ? findModelProfile([{ ...snapshot.current, envType: identity.envType, modelName: snapshot.current.modelName }], identity)
                        : undefined);
                const controller = new AbortController();
                const releaseCancellation = execution.onCancel(() => controller.abort());
                try {
                    const prepared = await sidebar.prepareLocalAnalysisRuntime({ modelName: selectedParams.modelName,
                        baseUrl: selectedParams.ollamaUrl!, configuredTokens: snapshot.runtimeContextTokens,
                        preferences: snapshot.runtimeContextPreferences, cachedProfile, signal: controller.signal,
                        canPublish: () => analysisRuns.canPublish(execution) });
                    execution.throwIfCancelled();
                    // Finalize discovery exactly once before any target reads this run's snapshot.
                    // Global profiles, user choices and role qualifications are not changed.
                    snapshot.stored = upsertModelProfile(snapshot.stored, prepared.profile);
                    snapshot.localRuntimeMetadata = prepared.diagnostic;
                } finally { releaseCancellation(); }
            }
            execution.throwIfCancelled();
            await requireInitialAutoRoles(runParams, execution.snapshot);
            await operation(runParams, log, view, setup => environmentLease.withSetup(execution, setup));
        }
        catch (error: any) {
            if (!execution.cancelled) {
                const text = error instanceof AnalysisStageError ? `[${error.stage}] ${error.message}`
                    : localize("[錯誤] 測試執行發生異常: {0}", error?.message ?? error);
                log(text);
                void vscode.window?.showErrorMessage?.(text);
            }
        } finally {
            environmentLease.release();
            if (analysisRuns.finish(execution)) {
                void sidebar.webview?.postMessage({ command: 'analysisFinished' });
            }
        }
    }));
    sidebar.endAnalysis(execution.id);
}

let extensionBuildIdentity: Pick<ReportProvenance, 'extensionId' | 'extensionVersion' | 'buildTimestamp' | 'extensionMode' | 'buildArtifactHash'> = {
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
    requireRoleQualification?: boolean;
    validationMode?: VerificationMode;
    /** Explicit saved AI candidate; revalidated and re-executed, never trusted as a pass. */
    replayCandidate?: SavedWriterCandidateRequest;
    envType: 'local' | 'cloud' | 'custom';
    modelName: string;
    filePath: string;
    funcName: string;
    promptStrategy?: string;
    ollamaUrl?: string;
    maxLoops: number;
    mutpyTimeout?: number;
    mutationEngine?: MutationEngineSelection;
    mutationWorkers?: number;
    timeoutSeconds: number;
    /** Immutable run-level limits selected before any target or request starts. */
    targetBudget?: Partial<TargetBudgetLimits>;
    outputPath: string;
    customUrl?: string;
    customKey?: string;
    cloudKey?: string;
    projectName?: string;
    sessionDate?: string;
    /** Optional venv or laboratory interpreter; empty values fall back to PATH python. */
    pythonExecutable?: string;
    /** Effective runner-owned context resolved from the immutable run snapshot. */
    requestContextTokens?: number;
    /** Role-owned output cap paired with the final input budget; local transport only. */
    requestOutputTokens?: number;
    /** Optional caller-owned Ollama prompt-evaluation batch; neither context nor output limit. */
    requestPromptBatchTokens?: number;
    /** Internal seed completion scope; not a saved model capability. */
    requestSeedCompletion?: boolean;
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
    probeInputFixture?: ProbeFixtureIdentity;
    source_setup_call_contract?: unknown;
    source_location?: unknown;
    /** Python AST uses null for module-level functions without an owning class. */
    class_name?: string | null;
    target_import_module?: string;
    args: string[];
    type_shape_version?: 'type-shape-v1';
    signature?: Array<{ name: string; kind: 'positional_only' | 'positional_or_keyword' | 'keyword_only' | 'var_positional' | 'var_keyword'; annotation: string | null; default: string | null; required: boolean; type_shape?: import('./pipeline/inputPlanning').TypeShape }>;
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
    dependency_fixture_contract?: Record<string, unknown>;
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
    let buildArtifactHash: string | undefined;
    try {
        buildTimestamp = fs.statSync(__filename).mtime.toISOString();
        buildArtifactHash = evidenceHash(fs.readFileSync(__filename, 'utf8'));
    } catch {
        // Keep reports portable even when a host cannot expose bundle metadata.
    }
    extensionBuildIdentity = {
        extensionId: context.extension.id,
        extensionVersion: String(context.extension.packageJSON.version || 'unknown'),
        buildTimestamp,
        ...(buildArtifactHash ? { buildArtifactHash } : {}),
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
    context.subscriptions.push(vscode.commands.registerCommand('llm-unit-test.configureWriterSeedPromptMode', async () => {
        const selected = await vscode.window.showQuickPick([
            { label: localize('Writer：程式碼續寫優先'), mode: 'code-completion' },
            { label: localize('Writer：指令模式'), mode: 'instruction' }
        ], { placeHolder: localize('選擇下次執行的 Writer 初始生成方式；不影響 Analyst 或 Reviewer。') });
        if (!selected) { return; }
        await vscode.workspace.getConfiguration('llmUnitTest').update('writerSeedPromptMode', selected.mode, vscode.ConfigurationTarget.Global);
        await vscode.window.showInformationMessage(localize('Writer 生成方式已儲存，下次開始測試時生效。'));
    }));
    context.subscriptions.push(importSetup, vscode.commands.registerCommand('llm-unit-test.prepareImportSetup',
        (params?: { projectRoot?: string; outputPath?: string }) => importSetup.prepare(params?.projectRoot, params?.outputPath)));
    context.subscriptions.push(vscode.commands.registerCommand('llm-unit-test.configureTestResources',
        async (params?: { projectRoot?: string; outputPath?: string }) => {
            if (await configureTestResources(params?.projectRoot, params?.outputPath)) {
                await importSetup.prepare(params?.projectRoot, params?.outputPath);
            }
        }));
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
                validationMode: verificationMode(params.validationMode ?? vscode.workspace.getConfiguration('llmUnitTest').get('validationMode', 'full')),
                mutationEngine: params.mutationEngine ?? vscode.workspace.getConfiguration('llmUnitTest').get<MutationEngineSelection>('mutationEngine', 'builtin'),
                mutationWorkers: params.mutationWorkers ?? vscode.workspace.getConfiguration('llmUnitTest').get<number>('mutationWorkers', 2) };
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
                validationMode: verificationMode(params.validationMode ?? vscode.workspace.getConfiguration('llmUnitTest').get('validationMode', 'full')),
                mutationEngine: params.mutationEngine ?? vscode.workspace.getConfiguration('llmUnitTest').get<MutationEngineSelection>('mutationEngine', 'builtin'),
                mutationWorkers: params.mutationWorkers ?? vscode.workspace.getConfiguration('llmUnitTest').get<number>('mutationWorkers', 2) };
            await runAnalysisSession(paramsWithPython, sidebarProvider, async (runParams, log, view, withEnvironmentSetup) => {
                const projectName = path.basename(runParams.batchPath);
                const batchDirectory = createBatchDirectory(runParams.outputPath || runParams.batchPath,
                    runParams.sessionDate || formatSessionDate(), projectName);
                const batch = new BatchJournal(batchDirectory, runParams.batchPath, {
                    model: runParams.modelName, buildTimestamp: extensionBuildIdentity.buildTimestamp,
                    python: runParams.pythonExecutable, validationMode: runParams.validationMode
                });
                let outcome: 'completed' | 'cancelled' | 'failed' | 'environment-blocked' = 'failed';
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
                    throwIfExecutionCancelled();
                    const scope = await sidebarProvider.previewBatchScope(runParams.batchPath, files);
                    throwIfExecutionCancelled();
                    if (!scope) { outcome = 'cancelled'; return; }
                    batch.selectScope(scope);
                    const continuity = captureBatchSetupScope(scope, runParams.pythonExecutable);
                    files = scope.selectedFiles.map(file => path.join(scope.root, file));
                    initializeBatchRuntimeQualification(scope.root, files, runParams.pythonExecutable);
                    const tasks: Array<() => Promise<void>> = [];
                    const taskSources: BatchPreflightTarget[] = [];
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
                        const unique = deduplicateTargets(funcs);
                        // Keep one diagnosable target for each ambiguous definition; never choose a body here.
                        const targets = [...unique.targets.map(func => func.fullName), ...unique.ambiguousTargets];
                        batch.discover(file, targets);
                        const importTarget = funcs.find(func => !hasDummyFunctionNameMarker(func.fullName));
                        if (importTarget) { importTargets.push({ file, target: importTarget.fullName }); }
                        for (const target of targets) {
                            const id = tasks.length;
                            taskSources.push({ id, file: path.relative(existingRealPath(scope.root), existingRealPath(file)).replace(/\\/g, '/'), target });
                            tasks.push(async () => {
                                throwIfExecutionCancelled();
                                batch.begin(id);
                                log(localize("[系統] 批次目標：{0}:{1}", path.basename(file), target));
                                try { await executeSingleFileAnalysis({
                                    ...runParams, filePath: file, funcName: target,
                                    projectName, batchJournal: batch, batchTargetId: id
                                }, log, view); }
                                finally { batch.refresh(id); }
                            });
                        }
                    }
                    batch.start();
                    const readPlan = () => {
                        const config = vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri.file(runParams.batchPath));
                        const rules = config.get<ImportFixtureRule[]>('importFixtures', []);
                        const root = config.get<string>('importFixtureRoot', '');
                        return { rules, root, plan: createImportFixturePlan(runParams.batchPath, rules, root) };
                    };
                    const inspect = async () => {
                        const saved = readPlan();
                        const check = await inspectProjectImports(runParams.batchPath, runParams.pythonExecutable, importTargets,
                            path.join(batchDirectory, 'preflight'), saved.rules, log, saved.root, true);
                        batch.preflightEvidence({ phase: 'initial', status: check.planningSources ? 'planned-awaiting-confirmation' : 'checked', fixtureId: saved.plan?.id || null,
                            resourceCount: saved.plan?.rules.reduce((count, rule) => count + (rule.resources?.length || 0), 0) || 0,
                            blockedModules: check.rows.filter(row => row.status === 'blocked').length,
                            report: path.join(check.directory, 'import_check.md') });
                        if ((readPlan().plan?.id || null) !== (saved.plan?.id || null)) {
                            throw new Error(localize('初始化設定在預檢期間改變，批次已停止；請重新開始。'));
                        }
                        return check;
                    };
                    const importCheck = await inspect();
                    let finalRows: BatchPreflightRow[] = importCheck.rows;
                    let actualImports = !importCheck.planningSources;
                    let finalFixtureId = importCheck.fixtureId ?? readPlan().plan?.id ?? null;
                    const snapshotPreflight = () => writeBatchPreflightSnapshot(batchDirectory, { rows: finalRows, actualImports,
                        fixtureId: finalFixtureId, knownSecrets: [runParams.cloudKey, runParams.customKey].filter((key): key is string => Boolean(key)) });
                    snapshotPreflight();
                    const blockedModules = importCheck.rows.filter(row => row.status === 'blocked').length;
                    batch.preflight(blockedModules);
                    if (blockedModules) {
                        const report = path.join(importCheck.directory, 'import_check.md');
                        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(report), { preview: true });
                        const choice = importCheck.planningSources ? localize('處理初始化設定') : await vscode.window.showWarningMessage(
                            localize("{0} 個模組載入受阻；尚未呼叫模型。處理初始化後，已確認可載入的來源會接續測試；受阻來源另列原因。也可直接繼續已就緒目標。", blockedModules),
                            { modal: true }, localize("處理初始化設定"), localize("繼續測試並記錄失敗"));
                        throwIfExecutionCancelled();
                        const decision = choice === localize('處理初始化設定') ? 'prepare'
                            : choice === localize('繼續測試並記錄失敗') ? 'continue-diagnostics' : 'cancelled';
                        batch.preflightEvidence({ phase: 'decision', status: decision, fixtureId: readPlan().plan?.id || null });
                        if (decision === 'cancelled') { outcome = 'cancelled'; return; }
                        if (decision === 'prepare') {
                            outcome = 'environment-blocked';
                            log(localize('[系統] 批次暫停等待初始化設定；確認清單並重檢就緒後接續原選取目標。'));
                            batch.preflightEvidence({ phase: 'setup', status: 'requested' });
                            let setup;
                            try { setup = await withEnvironmentSetup(() => importSetup.prepare(runParams.batchPath, path.dirname(batchDirectory), importTargets)); }
                            catch (error) {
                                batch.preflightEvidence({ phase: 'setup', status: isExecutionCancelled() ? 'cancelled' : 'failed' });
                                throw error;
                            }
                            throwIfExecutionCancelled();
                            if (setup.rows.length) { batch.preflight(setup.rows.filter(row => row.status === 'blocked').length); }
                            batch.preflightEvidence({ phase: 'setup', status: setup.status, fixtureId: setup.fixtureId,
                                blockedModules: setup.rows.filter(row => row.status === 'blocked').length,
                                ...(setup.status === 'ready' ? { resourceCount: readPlan().plan?.rules.reduce((count, rule) => count + (rule.resources?.length || 0), 0) || 0 } : {}),
                                ...(setup.directory ? { report: path.join(setup.directory, 'import_setup.md') } : {}) });
                            finalRows = setup.rows;
                            actualImports = setup.actualImports === true;
                            finalFixtureId = setup.fixtureId;
                            snapshotPreflight();
                            if (!['ready', 'blocked'].includes(setup.status) || setup.actualImports !== true) {
                                outcome = ['cancelled', 'declined'].includes(setup.status) ? 'cancelled' : 'environment-blocked';
                                log(localize('[系統] 初始化未就緒（{0}）；本批次停止，未開始的目標保持未完成。請查看初始化報告。', setup.status));
                                return;
                            }
                            try {
                                continuity.verify(setup, importTargets, configuredPythonForResource(runParams.batchPath, runParams.batchPath), { allowBlocked: true });
                                if ((readPlan().plan?.id || null) !== setup.fixtureId) {
                                    throw new Error(localize('初始化設定在預檢期間改變，批次已停止；請重新開始。'));
                                }
                            } catch (error) {
                                batch.preflightEvidence({ phase: 'decision', status: 'continuation-invalidated' });
                                throw error;
                            }
                            // The setup result already includes the one confirmed rescan. Recheck its
                            // identity synchronously; do not start another approval/preflight loop.
                            // Setup uses its own execution cache. Refresh this original analysis too,
                            // including repairs that leave the fixture ID unchanged (e.g. imports).
                            invalidateCurrentPreflightFailures();
                            finalRows = setup.rows;
                            actualImports = true;
                            finalFixtureId = setup.fixtureId;
                            batch.preflightEvidence({ phase: 'decision', status: setup.status === 'ready' ? 'resumed' : 'resumed-partially', fixtureId: setup.fixtureId });
                        }
                    }
                    continuity.verifySources(configuredPythonForResource(runParams.batchPath, runParams.batchPath));
                    if (importCheck.initializationSources) { verifyInitializationSources(importCheck.root, importCheck.initializationSources); }
                    if ((readPlan().plan?.id || null) !== finalFixtureId) {
                        throw new Error(localize('初始化設定在預檢期間改變，批次已停止；請重新開始。'));
                    }
                    const finalPreflightReport = snapshotPreflight();
                    const partition = partitionBatchPreflight(taskSources, finalRows, { actualImports, identityValid: true });
                    if (partition.status === 'invalid') {
                        outcome = 'environment-blocked';
                        batch.preflightEvidence({ phase: 'decision', status: 'continuation-invalidated', report: finalPreflightReport });
                        return;
                    }
                    batch.blockPreflightTargets(partition.blocked, finalPreflightReport);
                    batch.preflight(finalRows.filter(row => row.status !== 'loaded').length);
                    batch.preflightEvidence({ phase: 'decision', status: partition.status, fixtureId: finalFixtureId,
                        blockedModules: finalRows.filter(row => row.status !== 'loaded').length, report: finalPreflightReport });
                    log(localize('[系統] 批次有 {0} 個可執行目標、{1} 個環境受阻目標；受阻者不計為測試通過。', partition.runnableIds.length, partition.blocked.length));
                    await runSequentially(partition.runnableIds.map(id => tasks[id]), log);
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
        sidebarProvider.cancelBatchScopePreview();
        if (analysisRuns.cancel()) {
            sidebarProvider.webview?.postMessage({ command: 'analysisStopping',
                text: localize('請等待目前分析或環境準備完成。') });
        }
    });

    const updateModelProfileCmd = vscode.commands.registerCommand('llm-unit-test.updateModelProfile', (profile: {
        paramSize: string;
        contextLength: number;
        contextLengthKnown?: boolean;
        effectiveRuntimeContextTokens?: number;
        runtimeContextSource?: StoredModelProfile['runtimeContextSource'];
        qualificationRuntime?: ModelQualificationProfile['qualificationRuntime'];
        envType?: 'local' | 'cloud' | 'custom';
        modelName?: string;
        testGenerationReady?: boolean;
        testGenerationReason?: string;
        testGenerationMode?: string;
        qualificationVersion?: string;
        endpointKey?: string;
        roleQualification?: RoleQualificationProfile;
    }) => {
        const previousRuntimeMetadata = profile.envType === 'local' && profile.modelName
            ? findModelProfile(storedModelProfiles, { envType: 'local', modelName: profile.modelName,
                endpointKey: profile.endpointKey }) : undefined;
        const updatedProfile: ModelProfile = {
            paramSize: profile.paramSize,
            contextLength: profile.contextLength,
            contextLengthKnown: profile.contextLengthKnown === true,
            effectiveRuntimeContextTokens: profile.effectiveRuntimeContextTokens ?? previousRuntimeMetadata?.effectiveRuntimeContextTokens,
            runtimeContextSource: profile.runtimeContextSource ?? previousRuntimeMetadata?.runtimeContextSource,
            qualificationRuntime: profile.qualificationRuntime,
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
                contextLengthKnown: updatedProfile.contextLengthKnown,
                effectiveRuntimeContextTokens: updatedProfile.effectiveRuntimeContextTokens,
                runtimeContextSource: updatedProfile.runtimeContextSource,
                qualificationRuntime: updatedProfile.qualificationRuntime,
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
const tracePreflightTimes = new WeakMap<object, Map<string, number>>();
function rememberTracePreflight(file: string, elapsedMs: number | undefined): void {
    const owner = currentExecution();
    if (!owner || typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) { return; }
    const timings = tracePreflightTimes.get(owner) || new Map<string, number>();
    timings.set(path.resolve(file), elapsedMs); tracePreflightTimes.set(owner, timings);
}
async function runBehaviorProbe(
    filePath: string,
    funcName: string,
    callerArgs?: CallerContext[],
    pythonExecutable: string = 'python',
    supplementalInputs: SupplementalProbeInput[] = [],
    progressDirectory?: string,
    skillInputs?: TypedProbeInputsV1,
    userFixture = false
): Promise<BehaviorProbeResult | null> {
    const pythonScript = pythonToolPath('trace');
    const baseArgs = [pythonScript, filePath, funcName];
    const suppliedInputs = skillInputs || buildProbeInputs(callerArgs || [], supplementalInputs);
    try {
        currentTargetBudget()?.assertRemaining();
        const owner = currentExecution();
        const preflightElapsedMs = owner && tracePreflightTimes.get(owner)?.get(path.resolve(filePath));
        const timingConfig = vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri?.file?.(filePath));
        const preferences = traceTimingPreferences(timingConfig.get<unknown>('traceTimeoutSeconds', 60),
            timingConfig.get<unknown>('tracePlanningTimeoutSeconds', 15), timingConfig.get<unknown>('traceCaseTimeoutSeconds', 5));
        const startupBudget = planTraceStartupBudget(preflightElapsedMs, currentTargetBudget()?.remainingMs() ?? 300000, preferences);
        const probeDeadlineAt = Math.min(Date.now() + startupBudget.outerTimeoutMs, currentTargetBudget()?.deadlineAt ?? Infinity);
        const runProbe = async (inputs: TypedProbeInputsV1 | null = null): Promise<BehaviorProbeResult> => {
            currentTargetBudget()?.assertRemaining();
            const remainingMs = remainingDeadlineMs(probeDeadlineAt);
            if (remainingMs <= 0) { throw new AnalysisStageError('ast-trace', 'trace', 'Trace planning allowance exhausted.'); }
            const totalTimeoutSeconds = Math.min(startupBudget.totalTimeoutSeconds, remainingMs / 1000);
            const [progressPath] = reserveArtifactFiles(progressDirectory || os.tmpdir(), ['trace'], 'jsonl');
            const args = [...baseArgs, '-', JSON.stringify({
                planning_timeout_seconds: Math.min(startupBudget.planningTimeoutSeconds, totalTimeoutSeconds),
                total_timeout_seconds: totalTimeoutSeconds, case_timeout_seconds: startupBudget.caseTimeoutSeconds,
                progress_path: progressPath
            })];
            try {
                const run = await runSpawn(pythonExecutable, args, {
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, input: JSON.stringify(inputs), timeout: remainingMs
                });
                if (run.code !== 0) { throw new Error('Trace worker process failed'); }
                return { ...parseBehaviorObservations(run.stdout.trim(), funcName), trace_timing: startupBudget };
            } catch (error) {
                throwIfExecutionCancelled();
                if (error instanceof AnalysisStageError) { throw error; }
                const recovered = fs.existsSync(progressPath) ? recoverBehaviorProgress(fs.readFileSync(progressPath, 'utf8'),
                    funcName, error instanceof Error ? error.message : 'Trace interrupted') : undefined;
                if (recovered) { return { ...recovered, trace_timing: startupBudget }; }
                throw error;
            } finally {
                if (!progressDirectory && fs.existsSync(progressPath)) { fs.unlinkSync(progressPath); }
            }
        };
        const initial = await runProbe(suppliedInputs);
        if (!userFixture && shouldRetryTraceWithoutCallerInputs(initial, suppliedInputs?.cases.length || 0)) {
            const retry = await runProbe();
            return { ...mergeBehaviorObservations(initial, retry), input_source: 'source_guided_retry' };
        }
        return {
            ...initial,
            input_source: userFixture ? 'user_fixture' : skillInputs || supplementalInputs.length > 0
                ? 'semantic_guided'
                : suppliedInputs?.cases.length ? 'caller_literals' : 'source_guided'
        };
    } catch (e: any) {
        throwIfExecutionCancelled();
        if (e instanceof AnalysisStageError) { throw e; }
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
type RequestTelemetry = RequestTimingEvent & { format?: CustomOutputFormat };
interface RequestTimingState { transportAttempt: number; queueWaitMs: number | null }

async function requestLlmApi(
    params: AnalysisParams,
    systemPrompt: string,
    userPrompt: string,
    log: (text: string) => void,
    outputFormat: CustomOutputFormat = 'text',
    sharedDeadlineAt?: number,
    onTiming?: (event: RequestTelemetry) => void
): Promise<string> {
    const queuedAt = Date.now();
    const deadlineAt = sharedDeadlineAt ?? deadlineAtFromTimeoutSeconds(params.timeoutSeconds, queuedAt);
    const controller = new AbortController();
    const release = currentExecution()?.onCancel(() => controller.abort());
    try {
        onTiming?.({ ...createRequestProgress('queued', queuedAt), format: outputFormat });
        return await llmRequestQueue.run(() => {
            throwIfExecutionCancelled();
            const queueTiming = createRequestQueueTiming(queuedAt, Date.now());
            onTiming?.({ ...queueTiming, format: outputFormat });
            onTiming?.({ ...createRequestProgress('dispatch', queuedAt), format: outputFormat });
            return requestLlmApiUnlocked(params, systemPrompt, userPrompt, log, outputFormat, deadlineAt,
                onTiming, { transportAttempt: 0, queueWaitMs: queueTiming.queueWaitMs });
        }, { deadlineAt, signal: controller.signal, onQueueExit: exit => {
            if (exit.reason !== 'started') {
                onTiming?.({ ...createRequestQueueTiming(queuedAt, exit.exitedAt), format: outputFormat });
                onTiming?.({ ...createRequestProgress(exit.reason === 'timeout' ? 'queue-timeout' : 'queue-cancelled',
                    queuedAt, {}, exit.exitedAt), format: outputFormat });
            }
        } });
    } catch (error) {
        throwIfExecutionCancelled();
        if (error instanceof SerialRequestQueueError) {
            throw new AnalysisStageError('timeout', 'model-request',
                localize('模型請求在排隊時已達期限，尚未開始 HTTP 傳輸。'),
                { cause: 'deadline', phase: 'queue', queueWaitMs: error.queueWaitMs,
                    deadlineAt, transportStarted: false, reasonCode: 'queue-timeout' });
        }
        throw error;
    } finally { release?.(); }
}

async function requestLlmApiUnlocked(
    params: AnalysisParams,
    systemPrompt: string,
    userPrompt: string,
    log: (text: string) => void,
    outputFormat: CustomOutputFormat = 'text',
    /** Structured-output fallback must consume the original request allowance. */
    deadlineAt = deadlineAtFromTimeoutSeconds(params.timeoutSeconds),
    onTiming?: (event: RequestTelemetry) => void,
    timingState: RequestTimingState = { transportAttempt: 0, queueWaitMs: null }
): Promise<string> {
    const remainingTimeoutMs = remainingDeadlineMs(deadlineAt);
    if (remainingTimeoutMs <= 0) {
        throw new AnalysisStageError('timeout', 'model-request', formatModelRequestTimeout(params.timeoutSeconds, 0),
            { cause: 'deadline', phase: 'queue', queueWaitMs: timingState.queueWaitMs });
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
        if (params.requestPromptBatchTokens !== undefined
            && (!Number.isSafeInteger(params.requestPromptBatchTokens) || params.requestPromptBatchTokens <= 0)) {
            throw new AnalysisStageError('validation', 'model-runtime', 'Ollama prompt batch must be a positive safe integer.');
        }
        const baseUrl = params.ollamaUrl || 'http://127.0.0.1:11434';
        apiUrl = `${baseUrl.replace(/\/$/, '')}/api/generate`;
        bodyData = {
            model: params.modelName,
            ...(params.requestSeedCompletion ? { prompt: userPrompt, raw: true }
                : buildOllamaPromptEnvelope(contractedSystemPrompt, userPrompt)),
            stream: true,
            options: { temperature: 0, ...(params.requestContextTokens ? { num_ctx: params.requestContextTokens } : {}),
                ...(params.requestOutputTokens ? { num_predict: params.requestOutputTokens } : {}),
                ...(params.requestPromptBatchTokens ? { num_batch: params.requestPromptBatchTokens } : {}) },
            ...(expectsJsonObject ? { format: ['semantic-json', 'review-json', 'quality-json'].includes(outputFormat) ? responseSchemaForOutputFormat(outputFormat) : 'json' } : {})
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
    let requestPhase: 'http-wait' | 'response-read' | 'backoff' = 'http-wait';
    let attemptTiming: { transportAttempt: number; startedAt: number; headersAt?: number;
        responseReadStartedAt?: number; responseReadFinishedAt?: number; httpStatus?: number } | undefined;
    const reportTiming = (outcome: 'completed' | 'http-error' | 'network-error' | 'response-error' | 'timeout' | 'cancelled',
        ollamaPayload?: unknown, failureCode?: string) => {
        if (!attemptTiming) { return; }
        onTiming?.({ ...createTransportAttemptTiming({ ...attemptTiming, outcome, finishedAt: Date.now(),
            queueWaitMs: timingState.queueWaitMs, failureCode, ...(params.envType === 'local' ? { ollamaPayload } : {}) }), format: outputFormat });
        attemptTiming = undefined;
    };
    const transportTimeout = (code: string | undefined) => code !== undefined
        && ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code);
    const release = currentExecution()?.onCancel(() => controller.abort());
    const timeoutId = setTimeout(() => {
        deadlineExpired = true;
        controller.abort();
        log(formatModelRequestTimeout(params.timeoutSeconds, remainingTimeoutMs));
    }, remainingTimeoutMs);
    try {
        const send = (request?: GoogleGenerateContentRequest) => retryTransientProviderRequest(
            async () => {
                currentTargetBudget()?.consumeTransportAttempt(estimateTokens(contractedSystemPrompt + '\n' + userPrompt));
                throwIfExecutionCancelled();
                requestPhase = 'http-wait';
                attemptTiming = { transportAttempt: ++timingState.transportAttempt, startedAt: Date.now() };
                const wireBody = JSON.stringify(request?.body || bodyData);
                onTiming?.({ ...createRequestProgress('http-request', attemptTiming.startedAt,
                    { transportAttempt: attemptTiming.transportAttempt,
                        requestBodyBytes: Buffer.byteLength(wireBody, 'utf8'), requestBodyHash: evidenceHash(wireBody) }), format: outputFormat });
                try {
                    const response = await fetchModelResponse(request?.url || apiUrl, {
                        method: 'POST', headers: request?.headers || headers,
                        body: wireBody, signal: controller.signal
                    }, { deadlineAt });
                    attemptTiming.headersAt = Date.now();
                    attemptTiming.httpStatus = response.status;
                    onTiming?.({ ...createRequestProgress('http-headers', attemptTiming.startedAt,
                        { transportAttempt: attemptTiming.transportAttempt, httpStatus: response.status }), format: outputFormat });
                    if (!response.ok) { reportTiming('http-error'); }
                    return response;
                } catch (error) {
                    const failureCode = getSafeTransportFailureCode(error);
                    reportTiming(isExecutionCancelled() ? 'cancelled'
                        : deadlineExpired || remainingDeadlineMs(deadlineAt) <= 0 || transportTimeout(failureCode)
                            ? 'timeout' : 'network-error', undefined, failureCode);
                    throw error;
                }
            },
            {
                maxAttempts: GENERATION_RETRY_MAX_ATTEMPTS,
                isCancelled: () => controller.signal.aborted
                    || isExecutionCancelled()
                    || remainingDeadlineMs(deadlineAt) <= 0,
                onRetry: event => { requestPhase = 'backoff'; log(
                    localize("[供應商重試] {0}；等待 {1}ms 後重試 ", event.reason, event.delayMs)
                    + `(${event.retryAttempt}/${event.maxAttempts})。`
                ); }
            }
        );
        const response = cloudRequest ? await googleThinkingSession.send(cloudRequest, send,
            () => log(localize("[思考量回退] 供應商明確不支援低思考量，沿原時限使用服務預設。"))) : await send();
        throwIfExecutionCancelled();
        if (!response.ok) {
            try { void response.body?.cancel().catch(() => {}); } catch { /* Preserve the HTTP failure and original deadline. */ }
            if (shouldRetryStructuredOutputAsText(response.status, outputFormat)) {
                log(localize("[格式回退] 供應商拒絕結構化輸出（HTTP {0}），沿原時限改用一般文字輸出。", response.status));
                return requestLlmApiUnlocked(params, contractedSystemPrompt, userPrompt, log, 'text', deadlineAt, onTiming, timingState);
            }
            throw new AnalysisStageError('model-api', 'model-request',
                localize("API 伺服器錯誤 (HTTP {0})；未記錄供應商回應內容。", response.status), { httpStatus: response.status });
        }

        requestPhase = 'response-read';
        if (attemptTiming) { attemptTiming.responseReadStartedAt = Date.now(); }
        let firstTextAt: number | undefined;
        const resJson = params.envType === 'local'
            ? await readOllamaGenerationResponse(response, progress => {
                if (progress.phase === 'first-text') { firstTextAt = Date.now(); }
                onTiming?.({ ...createRequestProgress(progress.phase === 'completed' ? 'response-completed' : progress.phase,
                    attemptTiming?.startedAt ?? Date.now(), { transportAttempt: attemptTiming?.transportAttempt,
                        httpStatus: attemptTiming?.httpStatus, receivedChunks: progress.receivedChunks,
                        receivedBytes: progress.receivedBytes, responseCharacters: progress.responseCharacters,
                        firstTextMs: firstTextAt === undefined ? null
                            : Math.max(0, firstTextAt - (attemptTiming?.startedAt ?? firstTextAt)) }), format: outputFormat });
            }) : await response.json() as Record<string, unknown>;
        if (attemptTiming) { attemptTiming.responseReadFinishedAt = Date.now(); }
        throwIfExecutionCancelled();
        if (deadlineExpired || remainingDeadlineMs(deadlineAt) <= 0) { throw new Error('Model request deadline expired'); }
        reportTiming('completed', resJson);

        let responseText: string;
        if (params.envType === 'local') {
            responseText = getCompletedOllamaText(resJson, params.requestOutputTokens, {
                knownSecrets: [params.cloudKey, params.customKey].filter((value): value is string => Boolean(value)),
                excludedTexts: [contractedSystemPrompt, userPrompt],
                // Never whitelist a runtime prompt, source, fixture or candidate.
                publicInstructionTexts: [buildWriterSeedSystemPrompt('', true), buildWriterSeedSystemPrompt('', false),
                    buildWriterSeedSystemPrompt(''), writerOutputFormatCorrection(true), writerOutputFormatCorrection(false),
                    writerOutputFormatCorrection(true, 'seed-scope-overrun')]
            }, params.requestSeedCompletion);
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
        if (containsCredential(responseText, [params.cloudKey, params.customKey].filter((value): value is string => Boolean(value)))) {
            throw new AnalysisStageError('validation', 'sensitive-output',
                localize('模型回覆含疑似憑證，已停止採用；未保存或執行該回覆。'));
        }
        if (!['semantic-json', 'review-json', 'quality-json'].includes(outputFormat) && !isStructuredResponseUsable(responseText, outputFormat)) {
            log(localize("[格式回退] 模型回傳了不完整的結構化內容，改用一般文字輸出重試。"));
            return requestLlmApiUnlocked(params, contractedSystemPrompt, userPrompt, log, 'text', deadlineAt, onTiming, timingState);
        }
        throwIfExecutionCancelled();
        return responseText;
    } catch (error) {
        const invalidProviderJson = requestPhase === 'response-read' && error instanceof SyntaxError;
        if (requestPhase === 'response-read' && attemptTiming?.responseReadStartedAt !== undefined
            && attemptTiming.responseReadFinishedAt === undefined) {
            attemptTiming.responseReadFinishedAt = Date.now();
        }
        const invalidStream = error instanceof AnalysisStageError && error.stage === 'model-response';
        const failureCode = getSafeTransportFailureCode(error);
        reportTiming(isExecutionCancelled() ? 'cancelled'
            : deadlineExpired || remainingDeadlineMs(deadlineAt) <= 0 || transportTimeout(failureCode) ? 'timeout'
                : invalidProviderJson || invalidStream ? 'response-error' : 'network-error', undefined, failureCode);
        throwIfExecutionCancelled();
        if (deadlineExpired || remainingDeadlineMs(deadlineAt) <= 0) {
            throw new AnalysisStageError('timeout', 'model-request', formatModelRequestTimeout(params.timeoutSeconds, remainingTimeoutMs),
                { cause: 'deadline', outputFormat, deadlineAt, phase: requestPhase,
                    requestAllowanceMs: remainingTimeoutMs, configuredRequestAllowanceMs: params.timeoutSeconds * 1000,
                    queueWaitMs: timingState.queueWaitMs, ...(failureCode ? { failureCode } : {}) });
        }
        if (error instanceof AnalysisStageError) { throw error; }
        if (transportTimeout(failureCode)) {
            throw new AnalysisStageError('timeout', 'model-request',
                localize('HTTP 傳輸等待逾時（{0}）；未記錄供應商回應內容。', failureCode),
                { cause: 'transport-timeout', failureCode, phase: requestPhase, deadlineAt,
                    requestAllowanceMs: remainingTimeoutMs, configuredRequestAllowanceMs: params.timeoutSeconds * 1000,
                    queueWaitMs: timingState.queueWaitMs });
        }
        if (invalidProviderJson) {
            throw new AnalysisStageError('model-format', 'model-response',
                localize("無法解析的 API 回傳格式；內容可能未完成或缺少可用文字。"),
                { reasonCode: 'invalid-provider-json', phase: 'response-read' });
        }
        throw new AnalysisStageError('model-api', 'model-request', localize("API 連線或回應讀取失敗；未記錄供應商回應內容。"),
            { phase: requestPhase, ...(failureCode ? { failureCode } : {}) });
    } finally {
        clearTimeout(timeoutId);
        release?.();
    }
}

function sanitizeLlmResponse(rawCode: string): string {
    const cleanCode = unwrapGeneratedCodeEnvelope(rawCode);

    // 偵測無限 thinking 迴圈（小模型常見問題）
    const thinkingCount = (cleanCode.match(/<thinking>/g) || []).length;
    if (thinkingCount >= 3) { return ''; }
    const emojiLoopMatch = cleanCode.match(/([\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF])\1{7,}/u);
    if (emojiLoopMatch) { return ''; }

    return extractPythonTestCode(cleanCode);
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
    bindingContext?: { module: string; target: string; className?: string | null; source?: string; moduleSource?: string; dependencies: Record<string, string> }
): Promise<{ valid: boolean; reason?: string; reasonCode?: string; repairRole?: 'writer' }> {
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
            if (!bindingContext) { return { valid: false, reason: localize("生成測試未通過 Python 語法解析。") }; }
            throw new AnalysisStageError('validation', 'static-analysis', localize("Python AST 驗證工具執行失敗；未交給 Writer 修復或降級 Tier。"),
                { reasonCode: 'bindings-tool-failed' });
        }
        if (bindingContext) {
            const bindings = JSON.parse(parsed.stdout) as { valid: boolean; reason?: string; reasonCode?: string; repairRole?: 'writer' };
            if (!bindings || typeof bindings.valid !== 'boolean') {
                throw new AnalysisStageError('validation', 'static-analysis', 'Invalid binding validator contract.', { reasonCode: 'bindings-contract-invalid' });
            }
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
                throw new AnalysisStageError('validation', 'static-analysis', 'Target call validator failed.', { reasonCode: 'target-calls-tool-failed' });
            }
            try {
                const callValidation = JSON.parse(compatibility.stdout) as { valid?: boolean; reason?: string };
                if (!callValidation || typeof callValidation.valid !== 'boolean') { throw new Error('Invalid target call contract'); }
                if (!callValidation.valid) {
                    return { valid: false, reason: callValidation.reason || localize("呼叫不符合被測函式簽名") };
                }
            } catch {
                throw new AnalysisStageError('validation', 'static-analysis', 'Invalid target call validator contract.', { reasonCode: 'target-calls-contract-invalid' });
            }
        }
        return { valid: true };
    } catch (error: any) {
        if (error instanceof AnalysisStageError) { throw error; }
        throwIfExecutionCancelled();
        throw new AnalysisStageError('validation', 'static-analysis', localize("Python AST 驗證工具無法完成；未交給 Writer 修復或降級 Tier。"),
            { reasonCode: 'bindings-tool-unavailable' });
    }
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
    const plan = astContext.traceResult?.input_plan;
    if (plan) {
        const labels = { ready: localize('已準備測資'), partial: localize('已準備部分測資'), 'needs-input': localize('需要補充輸入或 fixture') };
        astReport += localize('- 輸入規劃：{0}；產生 {1} 個候選（{2}）\n', labels[plan.status], plan.generated_cases, plan.schema_version);
        for (const diagnostic of plan.diagnostics) {
            astReport += `  - ${diagnostic.parameter || localize('初始化')}：${diagnostic.code}（${diagnostic.reason}）\n`;
        }
    }
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
    probeBehavior = true,
    knownSecrets: readonly string[] = []
): Promise<AstContext | null> {
    log(localize("[AST] 正在解析函式 `{0}` 的結構與依賴...", funcName));
    const astContext = await extractAstContext(filePath, funcName, pythonExecutable);
    if (!astContext || astContext.error) {
        return astContext;
    }
    log(localize("[AST] 解析完成！已擷取函式特徵與依賴。"));
    const environment = await beforeBehavior(astContext);
    rememberTracePreflight(filePath, environment.elapsedMs);
    astContext.dependencyResolution = environment.dependencies || [];
    astContext.dependencyContexts = [...(astContext.localDependencyContexts || [])];
    astContext.sourceVersions = environment.sourceVersions.map(item => ({ ...item }));
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
    const fixtureFile = vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri?.file?.(filePath)).get<string>('probeInputFile', '');
    const fixture = loadTargetProbeFixtures({ root: projectRoot, file: filePath, target: funcName,
        sourceHash: evidenceHash(fs.readFileSync(filePath, 'utf8')), fixtureFile, knownSecrets });
    if (fixture.status === 'rejected') {
        throw new AnalysisStageError('ast-trace', 'trace', localize("來源綁定的 Trace 測資無效；請修正測資檔後重試。"),
            { reasonCode: 'probe-input-fixture-rejected', diagnostics: fixture.diagnostics });
    }
    astContext.probeInputFixture = fixture.identity;
    const traceResult = await runBehaviorProbe(filePath, funcName, astContext.callerContexts, pythonExecutable, [], progressDirectory,
        fixture.inputs, fixture.status === 'loaded');
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
    const configured = params.targetBudget ?? {};
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
    const budget = planAnalysisTargetBudget(normalizeExecutionSettings(params).maxLoops, limits);
    return withImportFixtures(fixtures, () => runWithTargetBudget(new TargetBudget(budget),
        () => executeSingleFileAnalysisWithBudget(params, log, sidebarProvider, root)));
}

async function executeSingleFileAnalysisWithBudget(params: AnalysisParams, log: (text: string) => void, sidebarProvider: AnalysisView, projectRoot: string) {
    params = { ...params, ...normalizeExecutionSettings(params) };
    const mode = verificationMode(params.validationMode);
    if (params.replayCandidate && mode !== 'execution') {
        throw new AnalysisStageError('validation', 'candidate-replay', 'Saved candidate replay requires explicit execution mode.');
    }
    const gateDescription = mode === 'full' ? localize("結構、執行、覆蓋率與突變驗證") : localize("結構、真實目標呼叫與隔離執行驗證");
    throwIfExecutionCancelled();
    const modelSnapshot = currentExecution<ModelSnapshot>()?.snapshot
        ?? { current: currentModelProfile, stored: storedModelProfiles, runtimeContextTokens: 0, runtimeContextPreferences: [] };
    let currentLoop = 1;
    let terminalFailure: { error: unknown } | undefined;
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
    let bestReviewApproval: ReviewApproval | undefined;
    let bestCoverage: RetainedCoverage | null = null;
    let bestTier: number | undefined;
    let qualityGaps: string[] = [];
    let reviewWarnings: string[] = [];
    let reviewStatus: ReviewStatus = 'incomplete';
    const reviewSession = new ReviewSession();
    const reviewerRevisionWorkloads = new Map<string, {
        feedbackHash: string; workload: WriterRevisionWorkload; feedback: WriterReviewFeedback;
    }>();
    const reviewerCorrectionScopes = new Map<string, readonly string[]>();
    let analystTasks = '';
    const qualityProgress = new QualityProgress(3);
    // Keep the qualified selection for reports and output paths, while using
    // the AST-confirmed leaf name when building Python calls and assertions.
    let targetFuncName = params.funcName;
    const pythonExecutable = normalizePythonExecutable(params.pythonExecutable);

    // ─── Tier 路由：依使用者設定或自動路由 ───
    const focusedWorkflow = isTestFocus(params.promptStrategy);
    const testFocus = resolveTestFocus(params.promptStrategy);
    const userTierSetting = focusedWorkflow ? 'auto' : params.promptStrategy || 'auto';
    // 複雜度評估（對無選擇函式時用預設分數）
    const dummyNameMarked = hasDummyFunctionNameMarker(params.funcName);
    let complexityScore = 30;
    if (params.funcName && !dummyNameMarked && !focusedWorkflow) {
        const comp = await assessFunctionComplexity(params.filePath, params.funcName, pythonExecutable);
        complexityScore = comp.score;
        log(localize("[Tier] 複雜度評估: {0}/100 ({1}){2}", comp.score, comp.level, comp.reasons.length > 0 ? ' - ' + comp.reasons.slice(0,2).join('; ') : ''));
    } else if (dummyNameMarked) {
        log(localize("[快速通道] 偵測到 dummy 名稱標記，跳過複雜度評估與後續 AST 分析。"));
    }
    const initialModel = initialAnalysisModel(params, modelSnapshot);
    const { selectedEndpointKey, selectedModelProfile, contextPreference, localRuntime, activeModelProfile, qualificationRequest } = initialModel;
    let requestContextWindow = initialModel.requestContextWindow;
    const runtimeQualifications = currentBatchRuntimeQualification(projectRoot, params.filePath, pythonExecutable);
    const runtimeIdentity = (numCtx: number) => runtimeQualifications.identity({ endpointKey: selectedEndpointKey,
        modelName: params.modelName, numCtx, qualificationVersion: QUALIFICATION_VERSION }, currentImportFixtures()?.id);
    let batchContextReused = false;
    const preferredContext = params.envType === 'local' && localRuntime?.ok
        && activeModelProfile.contextLengthKnown === true ? runtimeQualifications.preferredContext(runtimeIdentity(requestContextWindow)) : undefined;
    if (preferredContext && preferredContext > requestContextWindow && preferredContext <= activeModelProfile.contextLength) {
        const cached = runtimeQualifications.session.get(runtimeIdentity(preferredContext));
        if (cached) {
            requestContextWindow = preferredContext;
            qualificationRequest.runtimeContextTokens = preferredContext;
            Object.assign(activeModelProfile, cached);
            activeModelProfile.budgetTokens = contextInputBudget(activeModelProfile.paramSize, preferredContext);
            batchContextReused = true;
        }
    }
    const modelParamBillion = parseFloat(activeModelProfile.paramSize);
    // When another model has already been probed in this session but the
    // selected one has no saved entry, retain the conservative Tier-1 gate.
    // A fresh extension with no probe data stays neutral for compatibility.
    const qualifiedForSelectedModel = activeModelProfile.envType && activeModelProfile.modelName
        ? qualificationForRequest(activeModelProfile, qualificationRequest)
        : modelSnapshot.current.testGenerationReady !== undefined ? false : undefined;
    const currentQualification = !(localRuntime && !localRuntime.ok)
        && qualificationAppliesToRequest(activeModelProfile, qualificationRequest);
    let roleQualification = currentQualification ? activeModelProfile.roleQualification : undefined;
    const writerReady = qualifiedForSelectedModel === true
        ? qualifiedRole('writer', roleQualification, currentQualification, true) : qualifiedForSelectedModel;
    const reviewerReady = qualifiedRole('reviewer', roleQualification, currentQualification);
    const fixerReady = qualifiedRole('bugFixer', roleQualification, currentQualification);
    const requireRoleQualification = modelSnapshot.requireRoleQualification === true;
    const tier1GenerationMode = requireRoleQualification ? resolveTier1GenerationMode(writerReady, userTierSetting) : 'llm-evidence-bound';
    const mayUseModelAuthoredTests = tier1GenerationMode === 'llm-evidence-bound';
    let seedPending = mayUseModelAuthoredTests && mode === 'full';
    const mayUseModelAuthoredReview = !requireRoleQualification || reviewerReady;
    let mayUseModelAuthoredRepair = !requireRoleQualification || fixerReady;
    const writerOutputBudget = new WriterOutputBudget();
    // Analyst output needs belong to this target and never raise Writer's floor.
    const analystOutputBudget = new WriterOutputBudget();
    let writerAdditionBaseline: string | undefined;
    const methodInventories = new Map<string, ScenarioIdentity[]>();
    const candidateSyntaxFailures = new Map<string, CandidateSyntaxDiagnostic>();
    const completedOutputDiagnostics = new Map<string, {
        responseShape: ReturnType<typeof outputShape>; responsePreview: ReturnType<typeof buildModelOutputPreview>;
        contextWindow: number; outputTokenLimit?: number;
        syntaxPreview: (code: string, line: number | null) => ReturnType<typeof buildModelOutputPreview>;
    }>();
    let inventoryExecutedBaseline: ((baseline: string) => Promise<void>) | undefined;
    let activeSeedCaseIds: string[] | undefined;
    let activeSeedCaseFacts = '';
    let focusedMockSetup = '';
    let seedTargetIsAsync: boolean | undefined;
    let seedPackagingPrefix = '';
    const testGenerationResponseFormat = selectTestGenerationResponseFormat(activeModelProfile);
    const analysisResponseFormat = selectAnalysisResponseFormat(activeModelProfile);
    if (testGenerationResponseFormat === 'text') {
        log(localize('Writer 使用純 Python；Analyst 使用獨立的 JSON 計畫契約。'));
    }
    if (!requireRoleQualification) {
        log(localize('事先角色資格測試為可選；本次直接生成，仍須通過執行、審查與品質驗證。'));
    } else if (qualifiedForSelectedModel === undefined) {
        log(userTierSetting === 'auto'
            ? mode === 'execution'
                ? localize("[模型能力] 此供應商／模型尚未完成 Writer 探測；執行驗證的 Auto 需要先透過「測試連線」確認生成能力。")
                : localize('完整流程的 Auto 需要先完成 Writer 與 Reviewer 角色測試連線。')
            : localize("[模型能力] 此供應商／模型尚未完成 unittest 探測；依你的手動 Tier {0} 選擇繼續執行。輸出仍須通過{1}。", userTierSetting.replace('tier', ''), gateDescription));
    }
    const resolvedTier = focusedWorkflow || !requireRoleQualification && userTierSetting === 'auto' ? 2 : resolveTier(
        modelParamBillion,
        complexityScore,
        userTierSetting,
        qualifiedForSelectedModel
    );
    // Tier 2 uses this for divide-and-conquer; it must derive from measured
    // capability, never from a finite list of vendor/model name fragments.
    let evalStrategy = focusedWorkflow ? 'small' as const : selectPromptDetail(
        activeModelProfile.paramSize,
        activeModelProfile.contextLength,
        resolvedTier
    );
    if (qualifiedForSelectedModel === false && userTierSetting !== 'auto') {
        log(localize("[模型能力] 此模型尚未通過 unittest 探測；保留你的手動 Tier 選擇，並以{0}檢查每次輸出。", gateDescription));
    }
    log(mode === 'execution' ? localize("[系統] 執行驗證：使用來源與明確 Mock 生成測試，延後完整品質流程。")
        : focusedWorkflow ? localize('[測試重點] {0}；使用共同品質流程。', testFocusLabel(testFocus))
        : localize("[系統] 策略路由: {0} → Tier {1}", userTierSetting === 'auto' ? localize("Auto 自動") : localize("使用者指定"), resolvedTier));

    if (!params.filePath || !fs.existsSync(params.filePath)) {
        throw new AnalysisStageError('ast-trace', 'static-analysis', localize("[錯誤] 找不到目標檔案路徑"));
    }

    let survivedMutants = "";
    let tier1GenerationModeRecorded = false;
    const reportDateStr = new Date().toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let currentTier = resolvedTier;
    let finalReportMarkdown = localize("# {0}\n\n- **目標檔案**: {1}\n- **測試函式**: {2}\n- **起始生成方式**: {3}\n- **日期**: {4}\n\n", mode === 'execution' ? localize("執行驗證與修復報告") : localize("突變測試與修復分析報告"), params.filePath, params.funcName || localize("全檔案"), mode === 'execution' ? localize("來源與明確 Mock 測試假設；採執行驗證流程") : focusedWorkflow ? testFocusLabel(testFocus) : 'Tier ' + currentTier, reportDateStr);
    finalReportMarkdown += formatReportProvenance({
        ...extensionBuildIdentity,
        modelProvider: params.envType,
        modelName: params.modelName,
        requestedTier: userTierSetting,
        ...(focusedWorkflow ? { testFocus } : {}),
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
        target: params.funcName || 'file', modelIdentity: `${params.envType}/${params.modelName}`, requestedTier: userTierSetting,
        ...(focusedWorkflow ? { testFocus } : {}),
        requestedMutationEngine: params.mutationEngine || 'builtin', mutationWorkers: params.mutationWorkers ?? 2,
        build: { ...extensionBuildIdentity } };

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
    const knownSecrets = [params.cloudKey, params.customKey].filter((value): value is string => Boolean(value));
    const journal = new AnalysisJournal(sessionDir, initialSource, params.funcName || 'file', params.modelName,
        mode === 'full' ? qualityPolicy : undefined, mode, reportIdentity, knownSecrets);
    const rejectedCandidates = new RejectedCandidateStore(sessionDir, {
        sourceHash: journal.sourceHash, target: params.funcName || 'file', runId: journal.runId, sourceCode: initialSource
    }, knownSecrets);
    finalReportMarkdown += localize("- **驗證目標**: {0}\n", mode === 'execution' ? localize("執行驗證（Trace、覆蓋率、突變與品質審查延後）") : localize("完整品質驗證"));
    const tierHistory: TierHistory = { requested: userTierSetting, initial: resolvedTier, rounds: [], transitions: [] };
    if (mode === 'full') { journal.knowledge(focusedWorkflow ? { testFocus } : { tierHistory }); }
    const qualityAnalystSession = new QualityAnalystSession();
    const qualityExperiments = new QualityImprovementSession();
    let qualityObservationEvidence = '';
    const parameterFixtureExperiments = new ParameterFixtureSession();
    let activeParameterFixtureEvidence: FixtureEvidence | undefined;
    let qualityTraceProjection = '';
    let qualityTraceReference = '';
    const appendQualityEvidence = (prompt: string): string => {
        if (!qualityObservationEvidence || prompt.includes(qualityObservationEvidence)) { return prompt; }
        // Only omit a repeated envelope when the complete current Trace projection
        // is already in this role's prompt. Partial or caller-scoped traces still need it.
        const addition = qualityTraceProjection && prompt.includes(qualityTraceProjection)
            ? qualityTraceReference : qualityObservationEvidence;
        return prompt.includes(addition) ? prompt : prompt + '\n\n' + addition;
    };
    const numericEvidence = new NumericEvidenceLedger({ runId: journal.runId, sourceHash: journal.sourceHash,
        target: params.funcName || 'file' }, knownSecrets);
    const numericEvidencePrompt = () => numericEvidence.prompt(Math.min(12000, activeModelProfile.budgetTokens));
    let pendingQualityGap: PendingQualityFocus | undefined;
    let activeQualityTaskEvidence: QualityTaskEvidence | undefined;
    const focusedWriterDeadlines = new Map<string, number>();
    let focusedQualityFeedback = '';
    let pendingQualityAttempts = 0;
    let deferredFocusId: string | undefined;
    const writeReport = (body = finalReportMarkdown) => {
        existingReport = writeTargetReports(sessionDir, reportIdentity, journal.sourceHash, journal.runId, journal.snapshot(), body);
    };
    const importFixtures = currentImportFixtures();
    if (importFixtures) {
        fs.writeFileSync(path.join(sessionDir, 'import_fixtures.json'), JSON.stringify(importFixtures, null, 2), 'utf8');
        journal.knowledge({ importFixtureId: importFixtures.id, importFixtureContract: 'import-fixtures-v1' });
        finalReportMarkdown += localize('\n- **隔離測試設定**: {0}（import_fixtures.json）。宣告資源在暫存區實際建立；啟動入口仍使用明確 mock。正式資料未納入測試。\n', importFixtures.id);
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
    let mutationSelection: SelectedMutationEngine | undefined;
    let mutationSelectionTask: Promise<void> | undefined;
    let mutationPreflightRequired = false;
    const ensureMutationSelection = async (deadlineAt: number): Promise<void> => {
        if (!mutationPreflightRequired) { return; }
        const checkCurrent = () => {
            throwIfExecutionCancelled();
            currentTargetBudget()?.assertRemaining();
            if (remainingDeadlineMs(deadlineAt) <= 0) {
                throw new AnalysisStageError('timeout', 'mutation-preflight',
                    localize('執行超時 (超過 {0} 秒)', params.timeoutSeconds),
                    { reasonCode: 'request-deadline-exhausted' });
            }
            if (!runtimeQualifications.current()) {
                throw new AnalysisStageError('validation', 'source-changed', localize('來源或相依版本改變，停止保存舊執行證據。'));
            }
        };
        checkCurrent();
        if (!mutationSelectionTask) {
            // A complete role prompt must fit before starting this potentially
            // expensive probe. Its result, including failure, belongs to this
            // target and never receives a new deadline on later role attempts.
            mutationSelectionTask = (async () => {
                try {
                    const selection = await selectMutationEngine(params.mutationEngine, params.mutationWorkers,
                        args => runSpawn(pythonExecutable, args,
                            { timeout: Math.min(10000, remainingDeadlineMs(deadlineAt)) }));
                    checkCurrent();
                    mutationSelection = selection;
                    journal.knowledge({ mutationSelection });
                    recordRole('mutation-engine', 'selected', mutationSelection);
                    log(localize('[突變引擎] 指定 {0}；使用 {1}（{2}），並行數 {3}。',
                        selection.requested, selection.actual, selection.operatorSetVersion, selection.workers));
                } catch (error) {
                    recordRole('mutation-engine', 'failed', { requested: params.mutationEngine || 'builtin', category: 'environment',
                        reason: error instanceof AnalysisStageError ? error.message : localize('外部突變引擎預檢失敗，請核對所選 Python、套件版本與平台。') });
                    throw error;
                }
            })();
        }
        await mutationSelectionTask;
        checkCurrent();
    };
    let resourceProjectionEvidence: IsolatedResourceSourceEvidence | undefined;
    const importResourcePrompt = (): string => {
        if (!importFixtures) { return ''; }
        const resourceContext = buildTargetIsolatedResourceContext(importFixtures,
            resourceProjectionEvidence, 6000, knownSecrets);
        if (!resourceContext.complete) {
            const sourceChanged = resourceContext.status === 'source-drift';
            throw new AnalysisStageError('validation', sourceChanged ? 'source-changed' : 'resource-context',
                sourceChanged ? localize('來源版本已改變，停止使用舊證據。')
                    : localize('隔離資源語境無法完整核對，未送出模型請求。'),
                { status: resourceContext.status, resourceCount: resourceContext.resourceCount });
        }
        // The complete resource context below already explains materialization,
        // controlled seeds and forbidden direct I/O. Do not repeat those rules.
        return '\n\n[Import test setup] Saved import-fixtures-v1: entry points and legacy mkdir/configFiles are import-only mocks. '
            + 'Observations describe this test setup, not production data, network or GUI startup.'
            + '\n\n' + resourceContext.context;
    };
    const writerAdditionMethodInstruction = async (baseline: string): Promise<string> => {
        const baselineHash = evidenceHash(baseline);
        if (!methodInventories.has(baselineHash)) {
            // Bug Fixer can produce a new executable hash without going through
            // the Writer composition hook. Re-read that exact baseline's AST;
            // never borrow names from an older candidate or guess a first method.
            await inventoryExecutedBaseline?.(baseline);
        }
        const methods = methodInventories.get(baselineHash);
        if (!methods?.length) {
            throw new AnalysisStageError('validation', 'writer-addition-context',
                'The executed Writer baseline has no valid AST method inventory.',
                { reasonCode: 'writer-method-inventory-unavailable' });
        }
        return buildWriterAdditionMethodInstruction(selectWriterAdditionMethodName(baselineHash,
            activeQualityTaskEvidence?.focusId || analystTasks, methods.map(item => item.id)));
    };
    const requestBudgetedOne = async (
        requestParams: AnalysisParams, system: string, prompt: string,
        requestLog: (text: string) => void, format: CustomOutputFormat = 'text',
        role: 'writer' | 'writer-revision' | 'reviewer' | 'bug-fixer' | 'analyst-planning' | 'analyst-quality' = 'writer',
        sharedDeadlineAt?: number, reservedInputTokens = 0, revisionCurrentCode?: string,
        writerCaseMode?: { evidence: QualityTaskEvidence; methodName: string }, initialAttemptDeadlineAt?: number,
        revisionWorkload?: WriterRevisionWorkload, sourceSelectionScope?: 'literal-argument' | 'mock-receiver' | 'test-binding' | 'mock-receiver-binding' | 'mock-setup' | 'parameter-mock'
    ): Promise<string> => {
        if (sourceSelectionScope && (mode !== 'execution' || format !== 'text'
            || (['test-binding', 'mock-receiver-binding', 'mock-setup', 'parameter-mock'].includes(sourceSelectionScope) ? role !== 'writer-revision' : role !== 'bug-fixer'))) {
            throw new AnalysisStageError('validation', 'source-selection-scope', 'Source selection requires its execution-only Writer or Bug Fixer task.');
        }
        if (role === 'writer' && mode === 'full' && !writerCaseMode) {
            writerAdditionBaseline = seedPending ? undefined : checkpoints.executable?.code || bestCode || undefined;
            if (!seedPending) {
                prompt = buildWriterExpansionPrompt(prompt, checkpoints.executable?.code || bestCode || '', analystTasks);
            }
        }
        if (mode === 'full' && writerAdditionBaseline && ['writer', 'writer-revision'].includes(role)) {
            system = buildWriterAdditionSystemPrompt(system);
            format = 'text';
        }
        if (writerCaseMode) {
            system += '\n\nWRITER_CASE_SUBTASK_V1: This request owns exactly ONE observed case. '
                + 'Return exactly one NEW method with exactly one target call copied from the final WRITER_FOCUS_CASE_FACTS_V1. '
                + 'The wider family and earlier analysis are context; do not write their other cases in this subtask. '
                + `Name the new method ${writerCaseMode.methodName}; copy its required signature at the end of the user prompt. `
                + 'Do not reuse a seed or accumulator method name. The host will assemble all case additions, '
                + 'then execute and review the whole candidate before mutation. The accumulator is unexecuted and unapproved.';
        }
        if (mode === 'full' && seedPending && ['writer', 'writer-revision'].includes(role)) {
            system = buildWriterSeedSystemPrompt(system, seedTargetIsAsync);
            if (activeSeedCaseFacts && !prompt.includes(activeSeedCaseFacts)) { prompt += '\n\n' + activeSeedCaseFacts; }
        }
        if (!writerCaseMode && !sourceSelectionScope) { prompt = appendQualityEvidence(prompt); }
        if (mode === 'full' && numericEvidence.hasEvidence && !writerCaseMode) {
            const observations = numericEvidencePrompt();
            if (!prompt.includes(observations)) { prompt += '\n\n' + observations; }
        }
        if (focusedWorkflow && mode === 'full' && ['writer', 'writer-revision', 'analyst-planning', 'analyst-quality'].includes(role)) {
            prompt += '\n\n' + testFocusInstruction(testFocus);
        }
        if (focusedWorkflow && seedPending && role === 'writer' && focusedMockSetup) {
            prompt += '\n\nSOURCE MOCK SETUP (non-executable TODO guidance, not output evidence):\n' + focusedMockSetup;
        }
        if (!sourceSelectionScope) { prompt += importResourcePrompt(); }
        if (mode === 'full' && seedPending && ['writer', 'writer-revision'].includes(role)) {
            // Finish both generation and correction with the same small task.
            // Wider focus/resource context must not become a request to expand.
            prompt = buildWriterSeedPrompt(prompt);
        }
        if (mode === 'full' && writerAdditionBaseline && ['writer', 'writer-revision'].includes(role)) {
            if (activeParameterFixtureEvidence) { prompt += parameterFixtureReplayInstruction(activeParameterFixtureEvidence); }
            const focusCases = qualityFocusCasesForPrompt(writerCaseMode?.evidence || activeQualityTaskEvidence);
            if (focusCases && !prompt.includes(focusCases)) { prompt += '\n\n' + focusCases; }
            if (writerCaseMode) {
                prompt += `\n\nREQUIRED NEW METHOD SIGNATURE (body must be authored by you):\ndef ${writerCaseMode.methodName}(self):\n`;
            } else {
                const baselineHash = evidenceHash(writerAdditionBaseline);
                const instruction = await writerAdditionMethodInstruction(writerAdditionBaseline);
                prompt += instruction;
                recordRole('writer-addition', 'scope-selected', { signatureHash: evidenceHash(instruction), baselineCodeHash: baselineHash,
                    methodBodyAuthor: 'model', scenarioDeduplicationPreserved: true });
            }
        }
        const writerOutputScope = mode === 'full' && !seedPending && writerAdditionBaseline
            && ['writer', 'writer-revision'].includes(role) ? 'single-test-addition' as const : undefined;
        let contractedSystem = addOutputContract(system, format);
        let completionPrefix = '';
        const instructionSystem = contractedSystem, instructionPrompt = prompt;
        const singleTestSeedOutput = !sourceSelectionScope && (mode === 'full' && seedPending
            && ['writer', 'writer-revision'].includes(role)
            || mode === 'execution' && role === 'writer' && requestParams.requestSeedCompletion === true);
        const preferredCompletion = requestParams.envType === 'local' && role === 'writer'
            && modelSnapshot.writerSeedPromptMode === 'code-completion' && Boolean(seedPackagingPrefix)
            && (mode === 'full' && seedPending || mode === 'execution' && requestParams.requestSeedCompletion === true);
        if (preferredCompletion) {
            completionPrefix = seedPackagingPrefix;
            prompt = writerSeedCompletionPrompt(contractedSystem, prompt, completionPrefix);
            system = ''; contractedSystem = '';
            recordRole('writer-seed', 'completion-selected', { version: 'seed-code-completion-v1', selection: 'configured-preference',
                packagingPrefixHash: evidenceHash(completionPrefix), methodBodyAuthor: 'model', evidencePreserved: true });
        }
        const recoveryAllowed = !sourceSelectionScope && requestParams.envType === 'local' && ['writer', 'writer-revision', 'analyst-planning'].includes(role)
            && localRuntime?.ok === true;
        const outputStage = createOutputRecoveryStage({ timeoutSeconds: requestParams.timeoutSeconds, recoveryAllowed,
            sharedDeadlineAt, initialAttemptDeadlineAt, targetDeadlineAt: currentTargetBudget()?.deadlineAt });
        if (recoveryAllowed) {
            recordRole('model-request', 'recovery-stage-planned', { role, ...outputStage, targetDeadlinePreserved: true });
        }
        // Reserve both attempts up front. Each respects the user's request limit;
        // output retry, HTTP fallback and context growth never renew the stage or target.
        let observedInputTokens: number | undefined;
        let recoveryTransport: TransportAttemptTiming | undefined;
        let recoveryMode: 'output-growth' | 'format-correction' | undefined;
        for (let outputAttempt = 0; outputAttempt < outputStage.maximumAttempts; outputAttempt++) {
        const qualificationDeadline = outputRecoveryAttemptDeadline(outputStage, outputAttempt);
        throwIfExecutionCancelled();
        currentTargetBudget()?.assertRemaining();
        if (!runtimeQualifications.current()) {
            throw new AnalysisStageError('validation', 'source-changed', localize('來源或相依版本改變，停止保存舊執行證據。'));
        }
        const roleOutputBudget = role === 'analyst-planning' ? analystOutputBudget : writerOutputBudget;
        const estimatedInputTokens = estimatePromptTokens(contractedSystem + '\n' + prompt);
        const requiredInputTokens = Math.max(estimatedInputTokens, observedInputTokens ?? 0);
        const correctionReserve = reservedInputTokens + (outputAttempt > 0 ? CONTEXT_GROWTH_INPUT_HEADROOM_TOKENS : 0);
        const minimumOutputTokens = Math.max(roleOutputBudget.minimumTokens,
            focusedWorkflow && seedPending && role === 'writer'
                ? focusedSeedOutputFloor(requestContextWindow, requiredInputTokens, correctionReserve) : 0);
        const capacityAt = (contextWindow: number) => assessPromptCapacity({ envType: requestParams.envType, mode,
            role, seedPending, contextWindow, estimatedInputTokens, observedInputTokens,
            reservedInputTokens: correctionReserve, revisionCurrentCode, revisionWorkload, writerOutputScope, minimumOutputTokens,
            ...contextGrowthCeiling(activeModelProfile, contextWindow),
            modelContextLimitSource: modelSnapshot.localRuntimeMetadata?.source ?? 'unknown' });
        const initialCapacity = capacityAt(requestContextWindow);
        journal.knowledge({ promptCapacity: initialCapacity });
        recordRole('model-capacity', 'assessed', initialCapacity);
        const currentRoleBudget = roleRequestBudget({ envType: requestParams.envType, mode,
            role, seedPending, contextWindow: requestContextWindow, inputBudget: activeModelProfile.budgetTokens,
            revisionCurrentCode, revisionWorkload, writerOutputScope, minimumOutputTokens });
        if (requestParams.envType === 'local'
            && (!promptFits(contractedSystem, prompt, currentRoleBudget.inputBudget, correctionReserve)
                || requiredInputTokens + correctionReserve > currentRoleBudget.inputBudget)) {
            // Budget the output cap that the larger request will actually use.
            // Never grow using an old, smaller seed cap and then send a larger one.
            const limitBudget = roleRequestBudget({ envType: requestParams.envType, mode, role, seedPending,
                contextWindow: activeModelProfile.contextLength,
                inputBudget: contextInputBudget(activeModelProfile.paramSize, activeModelProfile.contextLength),
                revisionCurrentCode, revisionWorkload, writerOutputScope, minimumOutputTokens });
            const growth = planContextGrowth({ currentContextTokens: requestContextWindow,
                ...contextGrowthCeiling(activeModelProfile, requestContextWindow),
                estimatedPromptTokens: requiredInputTokens,
                reservedInputTokens: correctionReserve, requestOutputTokens: limitBudget.requestOutputTokens });
            if (growth.status === 'grown') {
                const grownRoleBudget = roleRequestBudget({ envType: requestParams.envType, mode, role, seedPending,
                    contextWindow: growth.contextTokens,
                    inputBudget: contextInputBudget(activeModelProfile.paramSize, growth.contextTokens),
                    revisionCurrentCode, revisionWorkload, writerOutputScope, minimumOutputTokens });
                if (!promptFits(contractedSystem, prompt, grownRoleBudget.inputBudget, correctionReserve)
                    || requiredInputTokens + correctionReserve > grownRoleBudget.inputBudget) {
                    const capacity = capacityAt(growth.contextTokens);
                    const metrics = { role, format, estimatedInputTokens, ...grownRoleBudget,
                        reservedInputTokens: correctionReserve, contextWindow: growth.contextTokens, capacity };
                    recordRole('model-request', 'budget-exceeded', metrics);
                    throw new AnalysisStageError('validation', 'prompt-budget',
                        formatPromptCapacity(capacity, true)!, metrics);
                }
                // Capacity qualification also sends model requests. Verify
                // the chosen engine before those probes, not just before
                // the later formal Analyst/Writer transport.
                await ensureMutationSelection(qualificationDeadline);
                const previousContextWindow = requestContextWindow;
                const qualificationStartedAt = Date.now();
                recordRole('model-runtime', 'context-growth-requested', { role, previousContextWindow,
                    contextWindow: growth.contextTokens, modelContextLimit: growth.modelContextLimit,
                    estimatedInputTokens: growth.requiredInputTokens, savedChoicePreserved: true });
                const identity = runtimeIdentity(growth.contextTokens);
                const includeBugFixer = role === 'bug-fixer' || roleQualification?.bugFixer.state === 'verified';
                const cached = runtimeQualifications.session.get(identity, includeBugFixer);
                if (cached) {
                    recordRole('context-qualification', 'cache-hit', { role, contextWindow: growth.contextTokens,
                        roleQualification: cached.roleQualification, qualificationVersion: cached.qualificationVersion });
                }
                const requalified = cached || (!requireRoleQualification ? unprobedLocalQualification(growth.contextTokens) : await requalifyLocalRuntime({ numCtx: growth.contextTokens, includeBugFixer,
                    request: async (probeRole, probeSystem, probePrompt, probeFormat) => {
                        throwIfExecutionCancelled();
                        currentTargetBudget()?.assertRemaining();
                        const probeOutputTokens = Math.min(1024, Math.max(1, Math.ceil(growth.contextTokens * 0.3)));
                        if (!promptFits(addOutputContract(probeSystem, probeFormat), probePrompt,
                            growth.contextTokens - probeOutputTokens)) {
                            throw new AnalysisStageError('validation', 'role-qualification',
                                localize('新容量無法容納完整角色探針；未沿用舊容量認證。'));
                        }
                        currentTargetBudget()?.consumeModelRequest();
                        recordRole('context-qualification', 'requested', { role: probeRole, contextWindow: growth.contextTokens, deadlineAt: qualificationDeadline });
                        recordRole('model-request', 'requested', { role: probeRole, phase: 'context-qualification',
                            contextWindow: growth.contextTokens, deadlineAt: qualificationDeadline });
                        const response = await requestLlmApi({ ...requestParams, requestContextTokens: growth.contextTokens,
                            requestOutputTokens: probeOutputTokens }, probeSystem, probePrompt, requestLog, probeFormat, qualificationDeadline,
                            timing => recordRole('model-request', 'timing', { role: probeRole, phase: 'context-qualification', ...timing }));
                        if (containsCredential(response, knownSecrets)) {
                            throw new AnalysisStageError('validation', 'sensitive-output',
                                localize('模型回覆含疑似憑證，已停止採用；未保存或執行該回覆。'));
                        }
                        recordRole('context-qualification', 'completed', { role: probeRole, contextWindow: growth.contextTokens });
                        return response;
                    },
                    executor: code => runLocalRuntimeQualificationProbe(code, runtimeQualificationExecutionBudget(qualificationDeadline), pythonExecutable)
                }));
                throwIfExecutionCancelled();
                currentTargetBudget()?.assertRemaining();
                if (!runtimeQualifications.current()) { throw new AnalysisStageError('validation', 'source-changed', 'Runtime qualification scope changed.'); }
                if (!cached) { runtimeQualifications.session.set(identity, requalified); }
                const requestedRole = role === 'reviewer' ? 'reviewer' : role === 'bug-fixer' ? 'bugFixer' : 'writer';
                const authorization = runtimeRoleAuthorization({ policy: requireRoleQualification ? 'auto' : 'optional',
                    role: requestedRole, qualification: requalified.roleQualification, currentIdentity: true });
                const usable = authorization.allowed && (!requireRoleQualification
                    || requalified.roleQualification.writer.state === 'verified'
                    && (mode !== 'full' || requalified.roleQualification.reviewer.state === 'verified'));
                if (!usable) {
                    recordRole('model-runtime', 'qualification-failed', { contextWindow: growth.contextTokens,
                        elapsedMs: Date.now() - qualificationStartedAt,
                        writer: requalified.roleQualification.writer.state, reviewer: requalified.roleQualification.reviewer.state,
                        bugFixer: requalified.roleQualification.bugFixer.state,
                        authorization, roleQualification: requalified.roleQualification });
                    throw new AnalysisStageError('validation', 'role-qualification',
                        localize('容量增加後的角色資格未通過；未沿用舊容量認證。'));
                }
                requestContextWindow = growth.contextTokens;
                activeModelProfile.budgetTokens = contextInputBudget(activeModelProfile.paramSize, requestContextWindow);
                Object.assign(activeModelProfile, requalified);
                roleQualification = requalified.roleQualification;
                mayUseModelAuthoredRepair = runtimeRoleAuthorization({ policy: requireRoleQualification ? 'auto' : 'optional',
                    role: 'bugFixer', qualification: roleQualification, currentIdentity: true }).allowed;
                runtimeQualifications.rememberContext(identity);
                journal.knowledge({ roleQualification, runtimeContextTokens: requestContextWindow });
                recordRole('model-runtime', 'context-grown', { role, previousContextWindow,
                    contextWindow: requestContextWindow, modelContextLimit: growth.modelContextLimit,
                    elapsedMs: Date.now() - qualificationStartedAt,
                    qualificationRuntime: requalified.qualificationRuntime, roleQualification, authorization,
                    qualificationCacheHit: !!cached, savedChoicePreserved: true });
                log(localize(requireRoleQualification ? '[容量調整] 完整提示超額，num_ctx 由 {0} 提高至 {1}；上限 {2}，已重驗角色，保留已儲存選擇。'
                    : '[容量調整] num_ctx 由 {0} 提高至 {1}；上限 {2}，略過可選資格探針，正式候選仍須驗證。',
                    previousContextWindow, requestContextWindow, growth.modelContextLimit));
            } else {
                recordRole('model-runtime', 'context-growth-blocked', { role, contextWindow: requestContextWindow,
                    reasonCode: growth.status === 'blocked' ? growth.reasonCode : 'role-budget-still-exceeded' });
            }
        }
        const contextWindow = requestContextWindow;
        const roleBudget = roleRequestBudget({ envType: requestParams.envType, mode, role, seedPending,
            contextWindow, inputBudget: activeModelProfile.budgetTokens, revisionCurrentCode, revisionWorkload, writerOutputScope, minimumOutputTokens });
        // Probes are separate logical requests. Start this formal request's allowance
        // once after prerequisites, still within the original stage/shared/target cap.
        const formalAttemptStartedAt = Date.now();
        const deadline = outputRecoveryAttemptDeadline(outputStage, outputAttempt, formalAttemptStartedAt);
        const metrics = { role, format, estimatedInputTokens,
            ...(sourceSelectionScope ? { requestScope: sourceSelectionScope === 'literal-argument'
                ? 'source-literal-selection-v1' : sourceSelectionScope === 'test-binding'
                    ? 'source-test-binding-selection-v1' : sourceSelectionScope === 'parameter-mock'
                        ? 'source-parameter-mock-selection-v1' : sourceSelectionScope === 'mock-setup'
                        ? 'source-mock-setup-selection-v1' : sourceSelectionScope === 'mock-receiver-binding'
                        ? 'source-mock-receiver-binding-selection-v1' : 'source-mock-receiver-selection-v1' } : {}),
            ...roleBudget, reservedInputTokens: correctionReserve,
            ...(writerOutputScope ? { writerOutputScope } : {}),
            ...(role === 'writer-revision' && revisionWorkload ? { revisionWorkload } : {}),
            capacity: capacityAt(contextWindow),
            ...(observedInputTokens !== undefined ? { observedInputTokens, effectiveInputTokens: requiredInputTokens } : {}),
            contextWindow, deadlineAt: deadline, stageDeadlineAt: outputStage.deadlineAt, outputAttempt, recoveryMode,
            ...(completionPrefix ? { writerPromptMode: 'seed-code-completion-v1', packagingPrefixHash: evidenceHash(completionPrefix),
                methodBodyAuthor: 'model' } : {}),
            ...(localRuntime?.ok ? { contextPolicy: localRuntime.mode, configuredContextTokens: localRuntime.configuredTokens } : {}),
            writerContext: prompt.startsWith(COMPACT_WRITER_VERSION) ? COMPACT_WRITER_VERSION : undefined };
        if (!promptFits(contractedSystem, prompt, roleBudget.inputBudget, correctionReserve)
            || requiredInputTokens + correctionReserve > roleBudget.inputBudget) {
            recordRole('model-request', 'budget-exceeded', metrics);
            throw new AnalysisStageError('validation', 'prompt-budget',
                formatPromptCapacity(metrics.capacity, true)!, metrics);
        }
        await ensureMutationSelection(deadline);
        if (outputAttempt > 0 && roleBudget.requestOutputTokens) {
            const recovery = planOutputRecoveryRetry({ ...outputStage, deadlineAt: deadline },
                roleBudget.requestOutputTokens, recoveryTransport, formalAttemptStartedAt,
                recoveryMode === 'format-correction' ? 'format-correction' : 'same-prompt');
            if (!recovery.allowed) {
                const detail = { role, ...recovery, requestOutputTokens: roleBudget.requestOutputTokens,
                    deadlineAt: deadline, stageDeadlineAt: outputStage.deadlineAt, targetDeadlinePreserved: true };
                recordRole('model-request', 'output-recovery-blocked', detail);
                throw new AnalysisStageError('model-format', 'model-request',
                    localize('模型輸出已達上限，剩餘時間不足以完成較長的重送；未採用截斷內容，也未重置目標期限。'), detail);
            }
        }
        const started = Date.now();
        let completedTransport: TransportAttemptTiming | undefined;
        currentTargetBudget()?.consumeModelRequest();
        recordRole('model-request', 'requested', metrics);
        try {
            const response = await requestLlmApi({ ...requestParams, requestContextTokens: contextWindow,
                requestOutputTokens: roleBudget.requestOutputTokens, requestSeedCompletion: Boolean(completionPrefix) }, system, prompt, requestLog, format, deadline,
                timing => {
                    if (timing.kind === 'transport' && timing.outcome === 'completed') { completedTransport = timing; }
                    recordRole('model-request', 'timing', { role, ...timing });
                });
            if (containsCredential(response, knownSecrets)) {
                throw new AnalysisStageError('validation', 'sensitive-output',
                    localize('模型回覆含疑似憑證，已停止採用；未保存或執行該回覆。'));
            }
            recordRole('model-request', 'completed', { ...metrics, elapsedMs: Date.now() - started });
            const completed = completionPrefix ? assembleWriterSeedCompletion(completionPrefix, response) : response;
            if (!sourceSelectionScope && ['writer', 'writer-revision'].includes(role)) {
                // Retain the privacy context, never the raw provider reply. The
                // extracted Python coordinates become known only after inventory.
                const privacy = { knownSecrets, excludedTexts: [contractedSystem, prompt, initialSource],
                    publicInstructionTexts: [buildWriterSeedSystemPrompt('', true), buildWriterSeedSystemPrompt('', false),
                        buildWriterSeedSystemPrompt(''), writerOutputFormatCorrection(true), writerOutputFormatCorrection(false)] };
                completedOutputDiagnostics.set(evidenceHash(completed), { responseShape: outputShape(response),
                    responsePreview: buildModelOutputPreview(response, privacy),
                    syntaxPreview: (code, line) => buildModelOutputPreview(code, { ...privacy, focusLine: line }),
                    contextWindow, outputTokenLimit: roleBudget.requestOutputTokens });
            }
            return completed;
        } catch (error) {
            const diagnostic = error instanceof AnalysisStageError && error.diagnostic && typeof error.diagnostic === 'object'
                ? error.diagnostic as { reasonCode?: unknown; outputTokenLimit?: unknown; responseShape?: unknown;
                    responsePreview?: unknown; phase?: unknown; transportStarted?: unknown } : undefined;
            const outputDiagnosis = diagnoseModelOutput(readOutputShapeDiagnostic(diagnostic?.responseShape), { singleTestSeed: singleTestSeedOutput });
            recordRole('model-request', 'error', { ...metrics, elapsedMs: Date.now() - started,
                category: error instanceof AnalysisStageError ? error.category : 'unknown',
                ...(diagnostic?.reasonCode === 'output-token-limit'
                    ? { reasonCode: 'output-token-limit', outputTokenLimit: diagnostic.outputTokenLimit,
                        outputDiagnosis, ...(singleTestSeedOutput ? { outputScope: 'single-test-seed' } : {}),
                        ...(readModelOutputPreview(diagnostic.responsePreview)
                            ? { responsePreview: readModelOutputPreview(diagnostic.responsePreview) } : {}),
                        ...(readOutputShapeDiagnostic(diagnostic.responseShape)
                            ? { responseShape: readOutputShapeDiagnostic(diagnostic.responseShape) } : {}) } : {}),
                ...(typeof diagnostic?.phase === 'string' && ['queue', 'http-wait', 'response-read', 'backoff'].includes(diagnostic.phase)
                    ? { phase: diagnostic.phase } : {}),
                ...(diagnostic?.reasonCode === 'queue-timeout' && diagnostic.phase === 'queue' && diagnostic.transportStarted === false
                    ? { reasonCode: 'queue-timeout', transportStarted: false } : {}),
                ...(modelRequestHttpStatus(error) !== undefined ? { httpStatus: modelRequestHttpStatus(error) } : {}),
                reason: error instanceof AnalysisStageError ? `${error.stage}: ${error.category}` : 'model request failed' });
            if (outputAttempt === 0 && requestParams.envType === 'local' && ['writer', 'writer-revision', 'analyst-planning'].includes(role)
                && error instanceof AnalysisStageError && diagnostic?.reasonCode === 'output-token-limit'
                && recoveryAllowed && remainingDeadlineMs(outputStage.deadlineAt) > 0) {
                if (['writer', 'writer-revision'].includes(role)
                    && ['repetitive-without-tests', 'repetitive-test-shells', 'seed-scope-overrun'].includes(outputDiagnosis)) {
                    // A changed prompt cannot borrow timing/input counts. Use the
                    // remaining original deadline; the configured timeout is a cap.
                    const recovery = planOutputRecoveryRetry(outputStage, roleBudget.requestOutputTokens || 1,
                        undefined, Date.now(), 'format-correction');
                    if (!recovery.allowed) {
                        recordRole('model-request', 'output-recovery-blocked', { role, ...recovery,
                            recoveryMode: 'format-correction', targetDeadlinePreserved: true });
                        throw error;
                    }
                    const seed = mode === 'full' && seedPending;
                    prompt = instructionPrompt + writerOutputFormatCorrection(seed || mode === 'execution', outputDiagnosis);
                    system = instructionSystem; contractedSystem = instructionSystem;
                    completionPrefix = '';
                    if (seed && seedPackagingPrefix && !preferredCompletion) {
                        // A completed instruction echo is evidence for trying completion;
                        // it does not establish a permanent capability or grant execution.
                        completionPrefix = seedPackagingPrefix;
                        prompt = writerSeedCompletionPrompt(instructionSystem, prompt, completionPrefix);
                        system = ''; contractedSystem = '';
                    }
                    recoveryMode = 'format-correction';
                    observedInputTokens = undefined;
                    recoveryTransport = undefined;
                    recordRole('model-request', 'output-format-retry', { role, ...recovery,
                        ...(preferredCompletion ? { previousWriterPromptMode: 'seed-code-completion-v1' } : {}),
                        writerPromptMode: completionPrefix ? 'seed-code-completion-v1' : 'instruction',
                        outputDiagnosis, requestOutputTokens: roleBudget.requestOutputTokens,
                        previousOutputTokens: diagnostic.outputTokenLimit, responseShape: readOutputShapeDiagnostic(diagnostic.responseShape),
                        retry: 1, deadlineAt: outputStage.deadlineAt, targetDeadlinePreserved: true,
                        evidencePreserved: true, discardedOutputReused: false });
                    if (completionPrefix) {
                        recordRole('writer-seed', 'completion-selected', { version: 'seed-code-completion-v1',
                            packagingPrefixHash: evidenceHash(completionPrefix), methodBodyAuthor: 'model',
                            evidencePreserved: true, discardedOutputReused: false, targetDeadlinePreserved: true });
                    }
                    requestLog(outputDiagnosis === 'seed-scope-overrun'
                        ? localize('[輸出恢復] {0} 超出單一種子範圍；改送一次格式修正，不以增額要求完成整份測試集。', role)
                        : localize('[輸出恢復] {0} 回覆高度重複且未形成可辨識測試；改送一次格式修正，保留原期限。', role));
                    continue;
                }
                const stats = completedTransport?.ollama;
                if (completedTransport?.outcome === 'completed' && stats?.done === true && stats.completionReason === 'length'
                    && Number.isSafeInteger(stats.promptEvalCount) && (stats.promptEvalCount as number) > 0) {
                    observedInputTokens = stats.promptEvalCount!;
                }
                const growth = planWriterOutputGrowth({ exhaustedCap: diagnostic.outputTokenLimit,
                    currentContextTokens: requestContextWindow, ...contextGrowthCeiling(activeModelProfile, requestContextWindow),
                    estimatedPromptTokens: estimatedInputTokens, observedPromptTokens: observedInputTokens,
                    reservedInputTokens, timedOutputLimit: outputRecoveryTokenLimit(outputStage, completedTransport) });
                if (growth.status === 'blocked') {
                    recordRole('model-request', 'output-recovery-blocked', { role,
                        previousOutputTokens: diagnostic.outputTokenLimit, contextWindow: requestContextWindow,
                        estimatedInputTokens, observedInputTokens, stageDeadlineAt: outputStage.deadlineAt,
                        ...((typeof diagnostic.outputTokenLimit === 'number' && Number.isSafeInteger(diagnostic.outputTokenLimit))
                            ? planOutputRecoveryRetry(outputStage, Math.min(Number.MAX_SAFE_INTEGER,
                                Math.max(diagnostic.outputTokenLimit + 1024, Math.ceil(diagnostic.outputTokenLimit * 1.5))), completedTransport) : {}),
                        reasonCode: growth.reasonCode,
                        targetDeadlinePreserved: true });
                } else {
                    const nextOutputTokens = growth.outputTokens;
                    const recovery = planOutputRecoveryRetry(outputStage, nextOutputTokens, completedTransport);
                    if (!recovery.allowed) {
                        const detail = { role, ...recovery, previousOutputTokens: diagnostic.outputTokenLimit,
                            requestOutputTokens: nextOutputTokens, stageDeadlineAt: outputStage.deadlineAt, targetDeadlinePreserved: true };
                        recordRole('model-request', 'output-recovery-blocked', detail);
                        throw new AnalysisStageError('model-format', 'model-request',
                            localize('模型輸出已達上限，剩餘時間不足以完成較長的重送；未採用截斷內容，也未重置目標期限。'), detail);
                    }
                    if (!roleOutputBudget.learn(nextOutputTokens)) { throw error; }
                    recoveryTransport = completedTransport;
                    recoveryMode = 'output-growth';
                    recordRole('model-request', 'output-budget-grown', { role,
                        previousOutputTokens: diagnostic.outputTokenLimit, requestOutputTokens: nextOutputTokens,
                        estimatedInputTokens, observedInputTokens, boundedBy: growth.boundedBy,
                        capacityCeiling: growth.capacityCeiling,
                        retry: 1, deadlinePreserved: true, deadlineAt: outputStage.deadlineAt,
                        stageDeadlineAt: outputStage.deadlineAt, attemptDeadlineAt: deadline, ...recovery });
                    continue;
                }
            }
            throw error;
        }
        }
        throw new AnalysisStageError('model-format', 'model-request', 'Role output recovery exhausted.');
    };
    const recordRejected = (code: string, attempt: number, gate: CandidateRejectionGate, reasonCode: string) => {
        const artifact = rejectedCandidates.record({ code, phase: seedPending ? 'seed' : currentLoop > 1 ? 'expand' : 'generation',
            tier: currentTier, attempt, gate, reasonCode });
        recordRole('candidate-artifact', 'rejected', { ...artifact, category: 'validation', gate, reason: reasonCode });
    };
    finalReportMarkdown += localize("- **執行識別**: {0}\n- **來源版本**: {1}\n\n", journal.runId, journal.sourceHash);
    if (batchContextReused) {
        recordRole('model-runtime', 'batch-context-reused', { contextWindow: requestContextWindow, savedChoicePreserved: true });
        recordRole('context-qualification', 'cache-hit', { contextWindow: requestContextWindow,
            roleQualification, qualificationVersion: QUALIFICATION_VERSION });
    }
    recordRole('pipeline', 'running', { target: params.funcName });
    journal.knowledge({ roleQualificationRequired: requireRoleQualification });
    recordRole('qualification-policy', requireRoleQualification ? 'required' : 'optional', { priorProbeRequired: requireRoleQualification });
    const releaseResourceObserver = currentExecution()?.subscribeResourceLifecycle(event => {
        journal.record(currentLoop, 'isolated-resources', event.cleaned ? 'cleaned' : 'failed', event);
        journal.knowledge({ resourceLifecycle: event });
    });
    try {
    if (localRuntime && !localRuntime.ok) {
        recordRole('model-runtime', 'rejected', { reasonCode: localRuntime.reasonCode });
        throw new AnalysisStageError('validation', 'model-runtime',
            localize('本機 Context 設定無法使用；請檢查 llmUnitTest.runtimeContextTokens，並重新執行模型測試連線。'),
            { reasonCode: localRuntime.reasonCode });
    }
    if (localRuntime?.ok) {
        recordRole('model-runtime', 'selected', { contextWindow: requestContextWindow,
            inputBudget: activeModelProfile.budgetTokens, configuredContextTokens: localRuntime.configuredTokens,
            contextPolicy: localRuntime.mode, metadataContextKnown: activeModelProfile.contextLengthKnown === true,
            modelContextLimit: activeModelProfile.contextLengthKnown === true ? activeModelProfile.contextLength : null,
            modelContextLimitSource: modelSnapshot.localRuntimeMetadata?.source ?? 'unknown',
            savedContextTokens: contextPreference?.tokens, savedContextSource: contextPreference?.source,
            lastObservedRuntimeContextTokens: selectedModelProfile.effectiveRuntimeContextTokens,
            runtimeContextSource: selectedModelProfile.runtimeContextSource,
            metadataDiagnostic: modelSnapshot.localRuntimeMetadata,
            qualificationApplicable: currentQualification });
        const observedContext = selectedModelProfile.effectiveRuntimeContextTokens;
        if (selectedModelProfile.runtimeContextSource === 'ollama-ps' && Number.isSafeInteger(observedContext)
            && (observedContext as number) > 0 && observedContext !== requestContextWindow) {
            recordRole('model-runtime', 'allocation-differs', { contextWindow: requestContextWindow,
                lastObservedRuntimeContextTokens: observedContext, savedChoicePreserved: true });
        }
    }
    const targetDir = path.dirname(params.filePath);
    let astContext: AstContext | null = null;
    let preflight: Awaited<ReturnType<typeof preflightTargetModule>> | undefined;
    const checkEnvironment = async (context: AstContext | null) => {
        const module = inferTargetImportModule(params.filePath, context?.file_imports || []);
        journal.knowledge({ sourceStructure: context?.code || null, sourceContext: context,
            initialTargetObservations: null, roleQualification: roleQualification || null });
        preflight = await preflightTargetModule(pythonExecutable, params.filePath, module,
            [targetDir, path.dirname(targetDir), path.dirname(path.dirname(targetDir)), projectRoot, sessionDir], sessionDir,
            context?.dependencies || [], projectRoot);
        runtimeQualifications.bindDependencies(preflight.sourceVersions);
        rememberTracePreflight(params.filePath, preflight.elapsedMs);
        resourceProjectionEvidence = preflight.resourceScope?.eligible ? {
            version: SOURCE_VERSIONS_VERSION,
            target: { file: params.filePath, hash: journal.sourceHash },
            sources: preflight.sourceVersions
        } : undefined;
        recordRole('environment', 'passed', { module: preflight.module, importFixtures: preflight.importFixtures,
            elapsedMs: preflight.elapsedMs,
            traceStartupBudget: planTraceStartupBudget(preflight.elapsedMs, currentTargetBudget()?.remainingMs() ?? 60000) });
        return preflight;
    };
    if (params.funcName) {
        astContext = await resolveAstAndDependencies(
            params.filePath,
            params.funcName,
            projectRoot,
            pythonExecutable,
            log,
            checkEnvironment,
            sessionDir,
            mode === 'full',
            knownSecrets
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
        moduleSource: initialSource,
        dependencies: Object.fromEntries((astContext?.file_imports || [])
            .filter((item: any) => item.kind === 'from' && item.name && item.name !== '*'
                && (astContext?.calls || []).includes(item.alias || item.bound_name || item.name))
            .map((item: any) => [item.alias || item.bound_name || item.name, `${item.module}.${item.name}`])) as Record<string, string>
    };
    const sourceMockUsePointNames = [...new Set([
        ...Object.keys(testBindingContext.dependencies), ...sourceHelperUsePointNames(astContext)
    ])];
    if (astContext && !astContext.error) {
        astContext.target_import_module = targetImportModule;
    }
    journal.knowledge({ sourceStructure: astContext?.code || null, sourceContext: astContext,
        initialTargetObservations: astContext?.traceResult || null,
        importContract: { ...testBindingContext, moduleSource: undefined, moduleSourceHash: evidenceHash(initialSource) },
        roleQualification: roleQualification || null });
    if (!preflight) { await checkEnvironment(astContext); }
    journal.knowledge({ dependencyEvidenceVersion: SOURCE_VERSIONS_VERSION,
        dependencyVersions: astContext?.sourceVersions || preflight!.sourceVersions });
    const testExecutionEnv = buildGeneratedTestEnvironment(process.env, preflight!.importPaths);
    const writerBaselineContexts = new Map<string, Awaited<ReturnType<typeof projectWriterAdditionContext>>>();
    const additionRejections = new Map<string, { reason: string; reasonCode: string; gate: 'revision-scope' | 'unittest-structure' }>();
    const recordCandidateMethods = async (code: string, phase: 'generated' | 'merged', role: string,
        baseline = '') => {
        const codeHash = evidenceHash(code);
        const read = async (value: string): Promise<ScenarioIdentity[] | undefined> => {
            if (!value) { return []; }
            const hash = evidenceHash(value);
            if (methodInventories.has(hash)) { return methodInventories.get(hash); }
            if (candidateSyntaxFailures.has(hash)) { return undefined; }
            const result = await readCandidateMethodInventory({ code: value, python: pythonExecutable, env: testExecutionEnv }).catch(error => {
                if (error instanceof AnalysisStageError && error.stage === 'candidate-inventory-tool') {
                    recordRole('candidate-methods', 'tool-unavailable', { codeHash: hash,
                        category: error.category, reasonCode: (error.diagnostic as { reasonCode?: string })?.reasonCode });
                }
                throw error;
            });
            if (result.status === 'syntax-error') {
                candidateSyntaxFailures.set(hash, result.syntax);
                return undefined;
            }
            methodInventories.set(hash, result.methods);
            return result.methods;
        };
        const methods = await read(code);
        const baselineMethods = baseline ? await read(baseline) : [];
        recordRole('candidate-methods', methods?.length ? 'inventoried' : 'unavailable', {
            schemaVersion: 'candidate-methods-v1', target: params.funcName || targetFuncName,
            runId: journal.runId, sourceHash: journal.sourceHash, codeHash, phase, role,
            ...(methods?.length ? { methods: methods.map(({ id, fingerprint }) => ({ id, fingerprint })) }
                : { reasonCode: candidateSyntaxFailures.has(codeHash) ? 'python-syntax-error' : 'candidate-methods-not-inventoried',
                    ...(candidateSyntaxFailures.has(codeHash) ? { syntax: candidateSyntaxFailures.get(codeHash) } : {}) }),
            baselineCodeHash: evidenceHash(baseline), baselineMethods
        });
    };
    inventoryExecutedBaseline = baseline => recordCandidateMethods(baseline, 'merged', 'executable-baseline', baseline);
    const bindSingleAdditionInventory = (code: string, mergedCode: string, baseline: string,
        addedMethods: Array<{ className: string; name: string }>, role: string) => {
        if (methodInventories.get(evidenceHash(code))?.length !== 0 || addedMethods.length !== 1) { return; }
        const [{ className, name }] = addedMethods;
        const method = methodInventories.get(evidenceHash(mergedCode))?.find(item => item.id === `${className}.${name}`);
        if (!method) { return; }
        // The merger proves the unique class; the completed merged AST supplies
        // its actual fingerprint. A bare response text hash proves neither.
        const methods = [{ id: method.id, fingerprint: method.fingerprint }];
        methodInventories.set(evidenceHash(code), methods);
        recordRole('candidate-methods', 'inventoried', { schemaVersion: 'candidate-methods-v1',
            target: params.funcName || targetFuncName, runId: journal.runId, sourceHash: journal.sourceHash,
            codeHash: evidenceHash(code), phase: 'generated', role, methods,
            inventoryOrigin: 'ast-single-addition-binding', baselineCodeHash: evidenceHash(baseline),
            baselineMethods: methodInventories.get(evidenceHash(baseline)) });
    };
    const requestBudgeted: typeof requestBudgetedOne = async (requestParams, system, prompt, requestLog,
        format = 'text', role = 'writer', sharedDeadlineAt, reservedInputTokens = 0, revisionCurrentCode,
        writerCaseMode, initialAttemptDeadlineAt, revisionWorkload, sourceSelectionScope) => {
        const evidence = activeQualityTaskEvidence;
        const baseline = checkpoints.executable?.code || bestCode;
        // Candidate revisions must retain their exact execution/Reviewer finding
        // prompt. A fresh per-case generation would discard that feedback and
        // freeze an executable but unapproved draft as a new baseline.
        if (mode !== 'full' || seedPending || role !== 'writer' || revisionCurrentCode !== undefined
            || !baseline || !evidence || evidence.cases.length < 2
            || astContext?.class_name !== null || astContext.is_async !== false || astContext.method_kind !== 'module') {
            return requestBudgetedOne(requestParams, system, prompt, requestLog, format, role,
                sharedDeadlineAt, reservedInputTokens, revisionCurrentCode, writerCaseMode, initialAttemptDeadlineAt, revisionWorkload, sourceSelectionScope);
        }
        writerAdditionBaseline = baseline;
        // Every case and its bounded correction shares this family's original
        // deadline and the target's counters. No subtask renews either budget.
        const familyKey = evidence.focusId + ':' + evidenceHash(baseline);
        const plannedDeadline = Math.min(sharedDeadlineAt ?? Infinity, currentTargetBudget()?.deadlineAt ?? Infinity,
            Date.now() + requestParams.timeoutSeconds * 2000 * evidence.cases.length);
        const deadline = Math.min(focusedWriterDeadlines.get(familyKey) ?? plannedDeadline, plannedDeadline);
        focusedWriterDeadlines.set(familyKey, deadline);
        const baselineHash = evidenceHash(baseline);
        if (!writerBaselineContexts.has(baselineHash)) {
            writerBaselineContexts.set(baselineHash, await projectWriterAdditionContext({ baseline,
                python: pythonExecutable, env: testExecutionEnv }));
        }
        const baselineContext = writerBaselineContexts.get(baselineHash)!;
        if (!baselineContext.ok && baselineContext.reasonCode !== 'addition-context-unsupported') {
            throw new AnalysisStageError('validation', 'writer-addition-context',
                'The Writer baseline context tool did not establish a valid result.', { reasonCode: baselineContext.reasonCode });
        }
        recordRole('writer-baseline-context', baselineContext.ok ? 'projected' : 'complete', {
            baselineCodeHash: baselineHash, passingBytesPreserved: true,
            ...(baselineContext.ok ? { methodIds: baselineContext.methodIds } : { reasonCode: baselineContext.reasonCode }) });
        let lastCaseAddition = '';
        const composed = await composeFocusedWriterAdditions({ baseline, evidence,
            request: async (caseEvidence, accumulator, ordinal, total, correction) => {
                throwIfExecutionCancelled();
                const methodName = `test_focus_${evidence.focusId.slice(1)}_${evidenceHash(baseline).slice(0, 8)}_${ordinal}`;
                const identity = { runId: journal.runId, sourceHash: journal.sourceHash, target: params.funcName || targetFuncName };
                const projection = resolveQualityTaskTraceCaseIds({ identity, evidence: caseEvidence,
                    observations: astContext.traceResult ? { ...identity, value: astContext.traceResult } : undefined });
                if (projection.status !== 'resolved') {
                    recordRole('writer-case', 'observation-rejected', { reasonCode: projection.reasonCode,
                        focusId: evidence.focusId, caseId: caseEvidence.cases[0].caseId });
                    throw new AnalysisStageError('validation', 'quality-case-projection',
                        'The current Writer case could not be matched to its complete typed observation.', { reasonCode: projection.reasonCode });
                }
                // Construct this subtask from the complete source/setup evidence,
                // not an earlier rejected draft. Prior AI bodies are not facts
                // and can make the model exchange two otherwise correct cases.
                const casePrompt = getUserPrompt(params.filePath, params.funcName || targetFuncName, astContext.code,
                    'small', { ...astContext, writerScenarioCaseIds: projection.caseIds },
                    undefined, activeModelProfile.budgetTokens, params.modelName, writerEvidenceBundle);
                const gap = `Observed case ${ordinal}/${total}; write only this case in one new method.`;
                const subtask = (baselineContext.ok
                    ? buildWriterCaseAdditionPrompt(casePrompt, baselineContext.contextCode, baselineHash, baselineContext.methodIds, gap)
                    : buildWriterExpansionPrompt(casePrompt, baseline, gap))
                    + (accumulator === baseline ? '\nThe original baseline metadata above also lists all existing method names.\n'
                        : '\n\nAI DRAFT METHOD INVENTORY (unexecuted, unapproved; names only):\n'
                            + JSON.stringify({ codeHash: evidenceHash(accumulator),
                                methods: (methodInventories.get(evidenceHash(accumulator)) || []).map(method => method.id) }) + '\n')
                    + (correction ? `\nCONTRACT CORRECTION: ${correction}\n` : '');
                recordRole('writer-case', 'scope-selected', { caseId: caseEvidence.cases[0].caseId,
                    observedCaseIds: projection.caseIds, focusId: evidence.focusId, ordinal, total,
                    correction: !!correction, methodName, deadlineAt: deadline });
                lastCaseAddition = await requestBudgetedOne(requestParams, system, subtask, requestLog, 'text', role,
                    deadline, reservedInputTokens, revisionCurrentCode, { evidence: caseEvidence, methodName });
                await recordCandidateMethods(extractWriterAdditionCode(lastCaseAddition), 'generated', role, accumulator);
                return lastCaseAddition;
            },
            merge: async (accumulator, addition) => {
                const merged = await mergeWriterTestAddition({ baseline: accumulator, addition,
                    python: pythonExecutable, env: testExecutionEnv });
                if (!merged.ok && merged.reasonCode === 'merge-tool-error') {
                    throw new AnalysisStageError('validation', 'writer-addition-tool', 'Writer case composition did not complete.');
                }
                if (merged.ok) {
                    await recordCandidateMethods(merged.mergedCode, 'merged', role, accumulator);
                    bindSingleAdditionInventory(extractWriterAdditionCode(addition), merged.mergedCode,
                        accumulator, merged.addedMethods, role);
                }
                return merged;
            },
            validate: async (code, caseEvidence, previousBaseline) => {
                const identity = { runId: journal.runId, sourceHash: journal.sourceHash, target: params.funcName || targetFuncName };
                const [facts, previous] = await Promise.all([
                    buildReviewFacts({ ...identity, code, module: targetImportModule,
                        python: pythonExecutable, env: testExecutionEnv, executionVerified: false, knownSecrets }),
                    buildReviewFacts({ ...identity, code: previousBaseline, module: targetImportModule,
                        python: pythonExecutable, env: testExecutionEnv, executionVerified: false, knownSecrets })
                ]);
                const previousIds = previous.methods.map(method => method.name);
                const added = facts.methods.filter(method => !previousIds.includes(method.name));
                if (added.length !== 1 || added[0].calls.length !== 1) { return 'writer-case-call-unproven'; }
                return qualityFocusInputDiagnostic(facts, caseEvidence, previousIds);
            },
            onEvent: (status, detail) => {
                recordRole('writer-case', status, { ...detail, focusId: evidence.focusId });
                if (status === 'rejected' && lastCaseAddition && detail.reasonCode) {
                    recordRejected(extractWriterAdditionCode(lastCaseAddition), detail.attempt, 'revision-scope', detail.reasonCode);
                }
            }
        });
        writerAdditionBaseline = baseline;
        if (!composed.ok) {
            const rejected = composed.addition || baseline;
            additionRejections.set(evidenceHash(extractWriterAdditionCode(rejected)), {
                gate: 'revision-scope', reasonCode: composed.reasonCode,
                reason: 'A focused Writer case did not produce a valid addition: ' + composed.reasonCode });
            return rejected;
        }
        return composed.code;
    };
    const prepareWriterCandidate = async (raw: string, role: string, attempt: number): Promise<string> => {
        const code = writerAdditionBaseline ? extractWriterAdditionCode(raw) : sanitizeLlmResponse(raw);
        await recordCandidateMethods(code, 'generated', role, writerAdditionBaseline);
        const completedDiagnostic = completedOutputDiagnostics.get(evidenceHash(raw));
        completedOutputDiagnostics.delete(evidenceHash(raw));
        const syntax = candidateSyntaxFailures.get(evidenceHash(code));
        if (syntax) {
            const { syntaxPreview, ...diagnostic } = completedDiagnostic || {};
            recordRole('model-request', 'format-rejected', { role, reasonCode: 'response-python-syntax',
                candidateHash: evidenceHash(code), syntax, ...diagnostic,
                ...(syntaxPreview ? { responsePreview: syntaxPreview(code, syntax.line), previewScope: 'extracted-python' } : {}) });
        }
        if (writerAdditionBaseline && additionRejections.has(evidenceHash(code))) { return code; }
        if (!writerAdditionBaseline) {
            const identity = { runId: journal.runId, sourceHash: journal.sourceHash, target: params.funcName || targetFuncName };
            const seedEvidence = { identity, selectedCaseIds: activeSeedCaseIds,
                observations: astContext?.traceResult ? { ...identity, value: astContext.traceResult } : undefined,
                ...(astContext?.class_name === null && astContext.is_async === false && astContext.method_kind === 'module'
                    ? { targetKind: 'sync-top-level-function' as const } : {}) };
            // Shape is independent of an input oracle. Even without Trace, a
            // seed must not hide an entire suite behind one test method.
            if (seedPending && methodInventories.has(evidenceHash(code))) {
                const facts = await buildReviewFacts({ ...identity, code, module: targetImportModule,
                    python: pythonExecutable, env: testExecutionEnv, executionVerified: false, knownSecrets });
                const result = validateWriterSeedContract({ ...seedEvidence, facts });
                recordRole('writer-seed-input', result.status, { ...result, codeHash: evidenceHash(code) });
                if (result.status === 'rejected') {
                    additionRejections.set(evidenceHash(code), { gate: 'unittest-structure', reasonCode: result.reasonCode!,
                        reason: 'The seed must contain exactly one test method with one direct target call. '
                            + 'Keep ONE evidence-supported case; expansion follows successful execution. '
                            + (activeSeedCaseFacts ? 'Use exactly WRITER_SEED_CASE_FACTS_V1. '
                                : 'Use one source-supported, same-test controlled dependency case; no selected Trace oracle is available. ')
                            + 'Do not add guessed boundary cases or unrelated exception requirements.' });
                }
            }
            return code;
        }
        const merged = await mergeWriterTestAddition({ baseline: writerAdditionBaseline,
            addition: raw, python: pythonExecutable, env: testExecutionEnv });
        throwIfExecutionCancelled();
        if (!merged.ok) {
            recordRejected(code, attempt, 'revision-scope', merged.reasonCode);
            recordRole('writer-addition', 'rejected', { reasonCode: merged.reasonCode,
                baselineCodeHash: evidenceHash(writerAdditionBaseline), additionCodeHash: evidenceHash(code) });
            if (merged.reasonCode === 'merge-tool-error') {
                throw new AnalysisStageError('validation', 'writer-addition-tool', 'Writer addition composition did not complete.');
            }
            additionRejections.set(evidenceHash(code), { reason: 'Writer addition rejected: ' + merged.reasonCode,
                reasonCode: merged.reasonCode, gate: 'revision-scope' });
            return code;
        }
        if ((activeQualityTaskEvidence || activeParameterFixtureEvidence) && merged.addedMethodsCount === 0) {
            const reasonCode = 'writer-addition-no-focus-test';
            recordRejected(code, attempt, 'revision-scope', reasonCode);
            additionRejections.set(evidenceHash(merged.mergedCode), { gate: 'revision-scope', reasonCode,
                reason: 'This quality gap has new executed input observations. The unchanged baseline contains no new test for them. '
                    + 'Return one new test method using the supplied focus calls and their observed outcomes; '
                    + 'do not copy the existing baseline or claim it already exercises different inputs.' });
            recordRole('writer-addition', 'rejected', { reasonCode, baselineCodeHash: evidenceHash(writerAdditionBaseline),
                additionCodeHash: evidenceHash(code), codeHash: evidenceHash(merged.mergedCode),
                focusId: activeQualityTaskEvidence?.focusId || activeParameterFixtureEvidence?.gapId, addedMethodsCount: 0 });
            return merged.mergedCode;
        }
        recordRole('writer-addition', 'merged', { baselineCodeHash: evidenceHash(writerAdditionBaseline),
            additionCodeHash: evidenceHash(code), codeHash: evidenceHash(merged.mergedCode),
            addedMethods: merged.addedMethods, addedMethodsCount: merged.addedMethodsCount });
        await recordCandidateMethods(merged.mergedCode, 'merged', role, writerAdditionBaseline);
        // A single bare method has no standalone TestCase identity. The AST
        // merger resolves its unique baseline class; only that completed proof
        // may finish the earlier method inventory (never a guessed count).
        bindSingleAdditionInventory(code, merged.mergedCode, writerAdditionBaseline, merged.addedMethods, role);
        if (activeParameterFixtureEvidence) {
            const replay = await checkParameterFixtureReplay({ source: initialSource, sourcePath: params.filePath, code: merged.mergedCode,
                baseline: writerAdditionBaseline, module: targetImportModule, evidence: activeParameterFixtureEvidence,
                python: pythonExecutable, env: testExecutionEnv, knownSecrets });
            recordRole('parameter-fixture-replay', replay.status, { ...replay, codeHash: evidenceHash(merged.mergedCode),
                fingerprint: activeParameterFixtureEvidence.fingerprint, gapId: activeParameterFixtureEvidence.gapId });
            if (replay.status === 'contradicted') {
                additionRejections.set(evidenceHash(merged.mergedCode), { gate: 'revision-scope', reasonCode: replay.reasonCode,
                    reason: 'The new method does not replay the exact PARAMETER_FIXTURE_OBSERVATIONS_V1 input control. '
                        + 'For operation=raise, the named attribute must raise the specified built-in exception when READ: '
                        + 'write an explicit test-owned property/getter, not an attribute value of None, a dict key, or Mock return_value. '
                        + 'The getter belongs on the object the target reads; putting a getter object inside an ordinary attribute does not trigger it. '
                        + 'The target may catch this getter exception and return normally; assert its supplied observed outcome. '
                        + 'For remove keep the attribute absent; for false use the exact supplied None value. '
                        + 'Preserve every other supplied fixture control and the executed baseline; replace only the unaccepted addition.' });
            }
        }
        if (activeQualityTaskEvidence) {
            const identity = { runId: journal.runId, sourceHash: journal.sourceHash, target: params.funcName || targetFuncName };
            const facts = await buildReviewFacts({ ...identity, code: merged.mergedCode, module: targetImportModule,
                python: pythonExecutable, env: testExecutionEnv, executionVerified: false, knownSecrets });
            const failure = qualityFocusInputDiagnostic(facts, activeQualityTaskEvidence,
                (methodInventories.get(evidenceHash(writerAdditionBaseline)) || []).map(item => item.id));
            if (failure) {
                additionRejections.set(evidenceHash(merged.mergedCode), { reasonCode: failure, gate: 'revision-scope',
                    reason: failure === 'quality-focus-case-family-incomplete'
                        ? 'The new method covers only part of the supplied observed case family. Include EVERY exact targetCall from '
                            + 'WRITER_FOCUS_CASE_FACTS_V1 with its corresponding observed result; do not omit cases or swap arguments.'
                        : 'The new test uses an input outside the bound focus observations. Use exactly the supplied observed case family; '
                            + 'do not replace it with unrelated return or exception cases.' });
                recordRole('quality-focus-inputs', 'rejected', { reasonCode: failure,
                    codeHash: evidenceHash(merged.mergedCode), focusId: activeQualityTaskEvidence.focusId });
            }
        }
        return merged.mergedCode;
    };
    if (mode === 'full' && !isStubFunction(astContext)) {
        mutationPreflightRequired = true;
        journal.knowledge({ workflowVersion: AI_WORKFLOW_VERSION, testAuthor: 'llm',
            reviewStatus: 'incomplete', mutationStatus: 'not-measured', mutationScore: null });
        if ((!mayUseModelAuthoredTests || !mayUseModelAuthoredReview) && !isStubFunction(astContext)) {
            throw new AnalysisStageError('validation', 'role-qualification',
                localize('完整 AI 流程需要可用的 Writer 與 Reviewer；請先完成角色測試連線。'));
        }
    }


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
        const executionSetup = await runMockScaffold(params.filePath, params.funcName, undefined,
            targetImportModule, pythonExecutable);
        throwIfExecutionCancelled();
        if (evidenceHash(fs.readFileSync(params.filePath, 'utf8')) !== journal.sourceHash
            || !sourceVersionsCurrent(astContext.sourceVersions || preflight!.sourceVersions)) {
            throw new AnalysisStageError('validation', 'source-changed', localize('來源版本已改變，停止使用舊證據。'));
        }
        const protectedUsePoints = new Set([`${targetImportModule}.${params.funcName}`,
            ...(astContext.class_name ? [`${targetImportModule}.${astContext.class_name}`] : [])]);
        const executionUsePoints = [...new Set([
            ...sourceMockUsePointNames.map(name => `${targetImportModule}.${name}`),
            ...(executionSetup && Array.isArray(executionSetup.patches)
                && executionSetup.patches.every(point => typeof point === 'string') ? executionSetup.patches : [])
        ])].filter(point => !protectedUsePoints.has(point));
        const executionMockSetup = executionUsePoints.length
            ? '\nSOURCE MOCK USE POINTS (source-derived setup guidance, not result facts):\n'
                + JSON.stringify(executionUsePoints)
                + '\nFor a controlled dependency case, import unittest.mock.patch and use a with patch(...) as mock_dependency '
                + 'context around the real target call. Configure the consumed receiver/return chain shown in the source contract. '
                + 'Creating a local Mock or SimpleNamespace does not replace a module dependency: bind it at its exact use point. '
                + 'The host supplies no decorator arguments or dependency values. Author setup and assertions yourself; never patch the target or owner.\n' : '';
        const namespaceOptions = executionSetup?.namespace_patches;
        const executionNamespaceSetup = Array.isArray(namespaceOptions) && namespaceOptions.length
            && namespaceOptions.every(point => typeof point === 'string' && point.startsWith(targetImportModule + '.')
                && !protectedUsePoints.has(point))
            ? '\nSOURCE_MODULE_NAMESPACE_OPTIONS_V1 (source-bound imported dependency bindings, not target outputs):\n'
                + JSON.stringify(namespaceOptions.map(point => ({ binding: point,
                    setup: `with patch(${JSON.stringify(point)}) as dependency_module:` })))
                + '\nThese are alternative setup scopes, not instructions to patch every binding. If an imported dependency has source-used member calls, choose its exact listed canonical binding and a distinct local alias. '
                + 'Configure only source-consumed members/return chains; keep the real target and all assertions inside that scope. '
                + 'Assert calls only on source-used members, not the module object or invented members. '
                + 'Dependency fixture values and meaningful assertions must still be authored by you. Never patch the selected target or its owner.\n' : '';
        if (executionMockSetup) {
            recordRole('writer-context', 'mock-setup-selected', { origin: 'source-use-points', executable: false,
                patchCount: executionUsePoints.length, allModelSizes: true, validationMode: 'execution',
                style: 'context-manager-guidance' });
        }
        const executionRules = dispatchTestRules(astContext.code, astContext);
        recordRole('rule-dispatcher', 'deterministic', { ...executionRules, validationMode: 'execution' });
        const executionEvidence: WriterEvidenceBundleV3 = {
            schemaVersion: 'writer-evidence-v3', sourceHash: evidenceHash(astContext.code),
            semanticGuidance: '', ruleSelection: executionRules,
            evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance']
        };
        const evidence = getUserPrompt(params.filePath, targetFuncName, astContext.code, 'small',
            { ...astContext, target_import_module: targetImportModule, writerGenerationPhase: 'seed' },
            undefined, activeModelProfile.budgetTokens, params.modelName, executionEvidence) + executionMockSetup + executionNamespaceSetup;
        seedPackagingPrefix = writerSeedCodePrefix(targetImportModule, params.funcName, astContext);
        const accepted = await runExecutionVerification({ directory: sessionDir, artifactDirectory: roundDirectory(sessionDir, 1), file: params.filePath,
            target: params.funcName, python: pythonExecutable, env: testExecutionEnv,
            targetModule: targetImportModule,
            dependencies: astContext.sourceVersions || [], journal,
            generate: async () => {
                if (params.replayCandidate) {
                    const saved = readSavedWriterCandidate(params.replayCandidate, { sourceFile: params.filePath,
                        sourceHash: journal.sourceHash, target: params.funcName, model: params.modelName,
                        modelIdentity: `${params.envType}/${params.modelName}` });
                    journal.knowledge({ generationOrigin: saved.origin });
                    recordRole('writer', 'candidate-replayed', saved.origin);
                    return saved.code;
                }
                return sanitizeLlmResponse(await requestBudgeted({ ...params, requestSeedCompletion: true },
                    buildWriterSeedSystemPrompt('', astContext.is_async, true),
                    buildWriterSeedPrompt(getExecutionWriterPrompt(evidence), true), log, testGenerationResponseFormat));
            },
            hooks: {
                event: recordRole,
                validate: async code => {
                    const result = await validateGeneratedTestCode(code, targetFuncName, targetImportModule,
                        astContext.method_kind === 'property' ? 'property' : 'call', astContext.signature,
                        exceptionNamesFromEvidence(astContext), astContext.class_name, pythonExecutable, testBindingContext);
                    return result.valid ? undefined : result.reason || 'Structure validation failed';
                },
                repairRole: (code, failure) => canRepairTestMethod(code, failure) ? 'bug-fixer' : 'writer',
                revise: async (code, failure, role, attempt, repairEvidence) => {
                    if (params.replayCandidate && params.replayCandidate.repair !== true) {
                        throw new AnalysisStageError('validation', 'candidate-replay', failure);
                    }
                    if (role === 'bug-fixer' && !mayUseModelAuthoredRepair) {
                        throw new AnalysisStageError('validation', 'fixer-qualification', localize("Auto 的 Bug Fixer 尚未通過資格探測；已保存失敗測試。"));
                    }
                    if (role === 'writer' && /Writer binding repair: [_\p{ID_Start}][_\p{ID_Continue}]* is undefined or read before its local binding in [_\p{ID_Start}][_\p{ID_Continue}]*\./u.test(failure)) {
                        const bindingCandidate = await repairSourceTestBinding({ source: astContext.code,
                            code, failure, target: params.funcName || targetFuncName, python: pythonExecutable,
                            module: targetImportModule, moduleSource: fs.readFileSync(params.filePath, 'utf8'), moduleSourceHash: journal.sourceHash,
                            checkCurrent: () => {
                                throwIfExecutionCancelled(); currentTargetBudget()?.assertRemaining();
                                if (!runtimeQualifications.current()) {
                                    throw new AnalysisStageError('validation', 'source-changed', 'Source scope changed during binding repair.');
                                }
                            },
                            request: (system, prompt) => requestBudgeted(params, system, prompt, log,
                                'text', 'writer-revision', undefined, 0, undefined, undefined, undefined, undefined, 'test-binding'),
                            event: (status, detail) => recordRole('writer', status, detail) });
                        if (bindingCandidate !== undefined) {
                            recordRole('writer', 'candidate', { code: bindingCandidate,
                                repairMode: 'source-test-binding-repair-v1', contractVersion: ROLE_CONTRACT_VERSIONS.writerRevision });
                            return bindingCandidate;
                        }
                    }
                    if (role === 'writer' && /^Do not patch .+: .+ is a parameter of .+, not a module attribute of .+\./.test(failure)) {
                        const parameterCandidate = await repairSourceParameterMock({ source: astContext.code,
                            code, failure, target: params.funcName || targetFuncName, python: pythonExecutable,
                            module: targetImportModule, moduleSource: fs.readFileSync(params.filePath, 'utf8'), moduleSourceHash: journal.sourceHash,
                            checkCurrent: () => {
                                throwIfExecutionCancelled(); currentTargetBudget()?.assertRemaining();
                                if (!runtimeQualifications.current()) {
                                    throw new AnalysisStageError('validation', 'source-changed', 'Source scope changed during parameter Mock repair.');
                                }
                            },
                            request: (system, prompt) => requestBudgeted(params, system, prompt, log,
                                'text', 'writer-revision', undefined, 0, undefined, undefined, undefined, undefined, 'parameter-mock'),
                            event: (status, detail) => recordRole('writer', status, detail) });
                        if (parameterCandidate !== undefined) {
                            recordRole('writer', 'candidate', { code: parameterCandidate,
                                repairMode: 'source-parameter-mock-repair-v1', contractVersion: ROLE_CONTRACT_VERSIONS.writerRevision });
                            return parameterCandidate;
                        }
                    }
                    if (role === 'writer' && failure.startsWith('Do not patch immutable datetime/date attribute ')) {
                        const setupCandidate = await repairSourceMockSetup({ source: astContext.code,
                            code, failure, target: params.funcName || targetFuncName, python: pythonExecutable,
                            module: targetImportModule, moduleSource: fs.readFileSync(params.filePath, 'utf8'), moduleSourceHash: journal.sourceHash,
                            checkCurrent: () => {
                                throwIfExecutionCancelled(); currentTargetBudget()?.assertRemaining();
                                if (!runtimeQualifications.current()) {
                                    throw new AnalysisStageError('validation', 'source-changed', 'Source scope changed during Mock setup repair.');
                                }
                            },
                            request: (system, prompt) => requestBudgeted(params, system, prompt, log,
                                'text', 'writer-revision', undefined, 0, undefined, undefined, undefined, undefined, 'mock-setup'),
                            event: (status, detail) => recordRole('writer', status, detail) });
                        if (setupCandidate !== undefined) {
                            recordRole('writer', 'candidate', { code: setupCandidate,
                                repairMode: 'source-mock-setup-repair-v1', contractVersion: ROLE_CONTRACT_VERSIONS.writerRevision });
                            return setupCandidate;
                        }
                    }
                    if (role === 'writer' && failure.startsWith('Mock assertion is not proven to observe an explicit target use-point patch or a mock passed to the target.')) {
                        const bindingCandidate = await repairSourceMockReceiver({ source: astContext.code,
                            code, failure, target: params.funcName || targetFuncName, python: pythonExecutable, module: targetImportModule,
                            moduleSource: fs.readFileSync(params.filePath, 'utf8'), moduleSourceHash: journal.sourceHash,
                            checkCurrent: () => {
                                throwIfExecutionCancelled(); currentTargetBudget()?.assertRemaining();
                                if (!runtimeQualifications.current()) {
                                    throw new AnalysisStageError('validation', 'source-changed', 'Source scope changed during Mock binding repair.');
                                }
                            },
                            request: (system, prompt) => requestBudgeted(params, system, prompt, log,
                                'text', 'writer-revision', undefined, 0, undefined, undefined, undefined, undefined, 'mock-receiver-binding'),
                            event: (status, detail) => recordRole('writer', status, detail) });
                        if (bindingCandidate !== undefined) {
                            recordRole('writer', 'candidate', { code: bindingCandidate,
                                repairMode: 'source-mock-receiver-binding-selection-v1', contractVersion: ROLE_CONTRACT_VERSIONS.writerRevision });
                            return bindingCandidate;
                        }
                    }
                    if (role === 'bug-fixer') {
                        for (const kind of ['literal-argument', 'mock-receiver'] as const) {
                            const sourceRepair = kind === 'literal-argument' ? repairSourceLiteralArgument : repairSourceMockReceiver;
                            const sourceCandidate = await sourceRepair({ source: astContext.code,
                                code, failure, target: params.funcName || targetFuncName,
                                python: pythonExecutable, module: targetImportModule,
                                ...(kind === 'mock-receiver' ? { moduleSource: fs.readFileSync(params.filePath, 'utf8'), moduleSourceHash: journal.sourceHash } : {}),
                                checkCurrent: () => {
                                    throwIfExecutionCancelled(); currentTargetBudget()?.assertRemaining();
                                    if (!runtimeQualifications.current()) {
                                        throw new AnalysisStageError('validation', 'source-changed', 'Source scope changed during spelling repair.');
                                    }
                                },
                                request: (system, prompt) => requestBudgeted(params, system, prompt, log,
                                    'text', 'bug-fixer', undefined, 0, undefined, undefined, undefined, undefined, kind),
                                event: (status, detail) => recordRole('bug-fixer', status, detail) });
                            if (sourceCandidate !== undefined) {
                                recordRole('bug-fixer', 'candidate', { code: sourceCandidate,
                                    repairMode: kind === 'literal-argument' ? 'source-literal-argument-repair-v1'
                                        : 'source-mock-receiver-repair-v1', contractVersion: ROLE_CONTRACT_VERSIONS.bugFix });
                                return sourceCandidate;
                            }
                        }
                    }
                    const system = role === 'bug-fixer'
                        ? getBugFixerSystemPrompt() + '\n' + EXECUTION_DEPENDENCY_BOUNDARY_GUIDANCE : getExecutionWriterSystemPrompt();
                    const prompt = (role === 'bug-fixer'
                        ? getBugFixerUserPrompt(code, failure, targetFuncName, astContext.args, astContext.code,
                            astContext, targetImportModule, undefined,
                            sourceMockUsePointNames.map(name => `${targetImportModule}.${name}`))
                        : getExecutionWriterPrompt(evidence, code, failure)) + '\n' + (repairEvidence || '')
                        + executionHelperRepairGuidance(failure, targetImportModule, params.filePath,
                            astContext, sourceMockUsePointNames)
                        + sourceLiteralRepairGuidance(failure, targetImportModule, astContext);
                    const raw = await requestBudgeted(params, system, prompt, log,
                        role === 'bug-fixer' ? 'text' : testGenerationResponseFormat,
                        role === 'bug-fixer' ? 'bug-fixer' : 'writer-revision', undefined, 0,
                        role === 'writer' ? code : undefined, undefined, undefined,
                        role === 'writer' ? { findingCount: 1, missingScenarioCount: 0 } : undefined);
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
        const expectationRepair = journal.snapshot().expectationRepair as { file: string } | undefined;
        if (expectationRepair) {
            finalReportMarkdown += localize("\n- **預期值修正**：{0}計算依據：[{1}]({2})。這只驗證與來源行為一致，不代表獨立需求正確性。\n",
                localize('工具僅提供算術假設；測試由 AI 修訂，再經實際執行驗證。'), expectationRepair.file, expectationRepair.file);
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
            journal.knowledge({ terminalStatus: 'stub-skipped', reason, testAuthor: 'none',
                reviewStatus: 'not-required', mutationStatus: 'not-measured', mutationScore: null });
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
        journal.knowledge({ terminalStatus: 'stub-smoke-generated', executionVerified: false, testAuthor: 'host-smoke',
            reviewStatus: 'not-required', mutationStatus: 'not-measured', mutationScore: null });
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
                && sourceVersionsCurrent(astContext?.sourceVersions || preflight!.sourceVersions);
        } catch { return false; }
    };
    const invalidateSourceEvidence = () => {
        runtimeQualifications.clear();
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
            const parsedSemResult = await semanticWithContractRepair({ prompt: semUsr,
                targetParameters: Array.isArray(astContext.args) ? astContext.args : undefined,
                deadlineAt: boundedRoleStageDeadline(params.timeoutSeconds, 2, currentTargetBudget()?.deadlineAt),
                attemptTimeoutSeconds: params.timeoutSeconds,
                request: (prompt, attemptDeadline, reserve, stageDeadline) => requestBudgeted(params, semSys, prompt, log,
                    analysisResponseFormat === 'text' ? 'text' : 'semantic-json', 'analyst-planning', stageDeadline, reserve,
                    undefined, undefined, attemptDeadline),
                checkCurrent: () => {
                    throwIfExecutionCancelled();
                    if (!evidenceStillCurrent()) {
                        throw new AnalysisStageError('validation', 'source-changed', localize('來源版本已改變，停止使用舊證據。'));
                    }
                },
                event: (status, detail) => recordRole('analyst-planning', status, detail)
            });
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
                    result: semanticPlanContract
                });
                const hasStrategy = semResult.test_strategy?.input_hints?.length > 0;
                log(localize("[語意分析師] ✅ 分析完成！相依行為: {0} 個、候選不可達路徑: {1} 個、測資策略參數提示: {2} 個。", semResult.dependency_behaviors.length, semResult.unreachable_paths.length, hasStrategy ? semResult.test_strategy.input_hints.length : 0));
            } else {
                throw new AnalysisStageError('model-format', 'analyst-planning',
                    localize('分析師回覆無效；已停止，尚未進入測試生成。'));
            }
        } catch (semErr: any) {
            throwIfExecutionCancelled();
            recordRole('analyst-planning', 'failed', { reason: semErr.message });
            if (semErr instanceof AnalysisStageError) { throw semErr; }
            throw new AnalysisStageError('model-api', 'analyst-planning',
                localize('分析師未完成；已停止，尚未進入測試生成。'));
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

    if (focusedWorkflow && mode === 'full' && astContext && !astContext.error) {
        const setup = await runMockScaffold(params.filePath, params.funcName, undefined, targetImportModule, pythonExecutable);
        if (setup?.patches.length) {
            focusedMockSetup = setup.scaffold;
            recordRole('writer-context', 'mock-setup-selected', { origin: 'source-use-points', executable: false,
                patchCount: setup.patches.length, allModelSizes: true });
        }
    }
    while (currentLoop <= params.maxLoops && !qualityToolsSatisfied) {

        if (isExecutionCancelled()) {
            log(localize("[系統] ⚠️ 測試已由使用者強制中止。"));
            break;
        }

        log(localize("\n--- 🔄 第 {0} 輪開始 ---", currentLoop));
        currentTier = resolvedTier;
        tierHistory.rounds.push({ loop: currentLoop, start: currentTier });
        if (focusedWorkflow) {
            recordRole('test-focus', 'started', { focus: testFocus, workflow: 'shared-quality-loop-v1' });
        } else {
            journal.knowledge({ tierHistory });
            recordRole('tier', 'started', { tier: currentTier, requested: userTierSetting });
        }
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

        // One measured gap per expansion. The phase wrapper carries the full baseline
        // and the selected task once; the source and observations already live in evidence.
        let systemPrompt = getSystemPrompt(currentLoop, evalStrategy as 'small' | 'large', undefined, params.modelName);
        const focusContext = '';
        // Select one complete observed case for initial generation only. Original
        // artifacts and the contexts used by validation/review/repair stay complete.
        const seedCaseIds = seedPending ? selectWriterSeedCaseIds(astContext?.traceResult) : undefined;
        activeSeedCaseIds = seedCaseIds;
        const seedIdentity = { runId: journal.runId, sourceHash: journal.sourceHash, target: params.funcName || targetFuncName };
        activeSeedCaseFacts = seedPending ? seedCaseFactsForPrompt({ identity: seedIdentity, selectedCaseIds: seedCaseIds,
            observations: astContext?.traceResult ? { ...seedIdentity, value: astContext.traceResult } : undefined,
            ...(astContext?.class_name === null && astContext.is_async === false && astContext.method_kind === 'module'
                ? { targetKind: 'sync-top-level-function' as const } : {}) }) : '';
        // Reserve the same phase system, complete facts and output floor that the
        // final request will carry before optional Writer materials use this allowance.
        const generationBaseline = seedPending ? '' : checkpoints.executable?.code || bestCode || '';
        seedTargetIsAsync = typeof astContext?.is_async === 'boolean' ? astContext.is_async : undefined;
        seedPackagingPrefix = writerSeedCodePrefix(targetImportModule, params.funcName || targetFuncName, astContext);
        const generationSystem = mode === 'full' && seedPending ? buildWriterSeedSystemPrompt(systemPrompt, seedTargetIsAsync)
            : mode === 'full' && generationBaseline ? buildWriterAdditionSystemPrompt(systemPrompt) : systemPrompt;
        const generationFormat = mode === 'full' && generationBaseline ? 'text' : testGenerationResponseFormat;
        let generationEnvelope = addOutputContract(generationSystem, generationFormat) + '\n'
            + (seedPending ? buildWriterSeedPrompt('') : buildWriterExpansionPrompt('', generationBaseline, analystTasks));
        if (mode === 'full' && generationBaseline) {
            generationEnvelope += await writerAdditionMethodInstruction(generationBaseline);
        }
        if (mode === 'full' && seedPending && activeSeedCaseFacts) { generationEnvelope += '\n\n' + activeSeedCaseFacts; }
        if (qualityObservationEvidence) { generationEnvelope += '\n\n' + qualityObservationEvidence; }
        const generationNumericEvidence = numericEvidencePrompt();
        if (mode === 'full' && numericEvidence.hasEvidence && generationNumericEvidence) {
            generationEnvelope += '\n\n' + generationNumericEvidence;
        }
        generationEnvelope += importResourcePrompt();
        const generationFocusCases = mode === 'full' && generationBaseline ? qualityFocusCasesForPrompt(activeQualityTaskEvidence) : '';
        if (generationFocusCases) { generationEnvelope += '\n\n' + generationFocusCases; }
        const generationRoleBudget = roleRequestBudget({ envType: params.envType, mode, role: 'writer', seedPending,
            contextWindow: requestContextWindow, inputBudget: activeModelProfile.budgetTokens,
            writerOutputScope: mode === 'full' && generationBaseline ? 'single-test-addition' : undefined,
            minimumOutputTokens: writerOutputBudget.minimumTokens });
        const generationBudget = Math.max(1, generationRoleBudget.inputBudget - estimateTokens(generationEnvelope));
        const writerContext = seedPending ? { ...astContext, writerGenerationPhase: 'seed',
            ...(seedCaseIds ? { writerScenarioCaseIds: seedCaseIds } : {}) } : astContext;
        if (seedCaseIds) {
            recordRole('writer-context', 'selected', { phase: 'seed', caseIds: seedCaseIds,
                scope: 'one-complete-observation', evidenceRetained: true });
        }
        const userPrompt = getUserPrompt(
            params.filePath,
            targetFuncName,
            targetCode,
            evalStrategy as 'small' | 'large',
            writerContext,
            focusContext,
            generationBudget,
            params.modelName,
            writerEvidenceBundle
        );
        const estimatedTokens = estimateTokens(systemPrompt + userPrompt);
        log(localize("[Budget] Prompt 估算：{0} / {1} tokens (模型: {2}, Context: {3})", estimatedTokens.toLocaleString(), generationRoleBudget.inputBudget.toLocaleString(), activeModelProfile.paramSize, requestContextWindow.toLocaleString()));


        let rawCode = ""; // 宣告在外層 try 前面，讓 catch 也能存取
        let sanitizedCode = "";
        let loopCoverage: RetainedCoverage | null = null;
        let loopAssessment: TargetCoverageAssessment = { available: false, coverageText: 'N/A', missingLines: localize("未知") };
        let loopExecution = '';
        let reviewApproval: ReviewApproval | undefined;
        qualityGaps = [];
        try {
            // ─── Tier 降階修復迴圈 ───
            let tierSuccess = false;
            while (currentTier >= 1 && !tierSuccess && !isExecutionCancelled()) {
                try {
                if (!focusedWorkflow) { log(localize("[Tier 執行] 目前使用策略：Tier {0}", currentTier)); }
                sanitizedCode = '';
                rawCode = '';

                const callerPlan = planCallerPartitions(astContext?.callerContexts || []);
                const callerContextsCount = callerPlan.callers.length;
                const useDivideAndConquer = !sanitizedCode && !seedPending && (currentTier === 2) && (evalStrategy === 'small')
                    && callerPlan.mode === 'partitioned' && (!survivedMutants);
                if (currentTier === 2 && evalStrategy === 'small' && !survivedMutants) {
                    const { callers: _callers, ...detail } = callerPlan;
                    recordRole('caller-partition', 'planned', detail);
                    log(localize("[分治規劃] {0} 個呼叫站、{1} 組已知輸入：{2}。", callerPlan.totalCallers, callerPlan.distinctInputs, useDivideAndConquer ? localize("按不同輸入分組") : localize("使用單次生成，保留完整語境")));
                }

                // Every production Tier uses AI-authored tests; Trace is evidence only.
                if (currentTier === 1 && !survivedMutants) {
                    if (!tier1GenerationModeRecorded) {
                        finalReportMarkdown += `- **Tier 1 generation mode**: ${tier1GenerationMode}\n\n`;
                        tier1GenerationModeRecorded = true;
                    }
                    systemPrompt = getTier1EvidenceBoundSystemPrompt();
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
                        const extracted = await prepareWriterCandidate(raw, 'writer', 0);
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
                        generationBudget,
                        params.modelName,
                        writerEvidenceBundle
                    );

                    let subRaw = "";
                    let subGenerationPrompt = subUserPrompt;
                    let subRevisionCode: string | undefined;
                    for (let retry = 0; retry < 2; retry++) {
                        try {
                            // An expansion repair must also return the executed baseline;
                            // its short rejected partition cannot size that full output.
                            subRaw = await requestBudgeted(params, systemPrompt, subGenerationPrompt, log, testGenerationResponseFormat,
                                subRevisionCode === undefined ? 'writer' : 'writer-revision', undefined, 0,
                                seedPending ? subRevisionCode : undefined, undefined, undefined,
                                subRevisionCode === undefined ? undefined : { findingCount: 1, missingScenarioCount: 0 });
                            const subClean = await prepareWriterCandidate(subRaw,
                                subRevisionCode === undefined ? 'writer' : 'writer-revision', retry);
                            if (subClean) {
                                const additionFailure = additionRejections.get(evidenceHash(subClean));
                                const subValidation = additionFailure ? { valid: false, ...additionFailure }
                                    : await validateGeneratedTestCode(
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
                                recordRejected(subClean, retry, additionFailure ? additionFailure.gate : subValidation.valid ? 'assertion-evidence' : 'unittest-structure',
                                    subValidation.valid ? 'trace-evidence-rejected' : subValidation.reasonCode || 'candidate-structure-rejected');
                                if (retry === 0) {
                                    log(localize("[分治合流] 呼叫點 {0} 子回覆未通過格式／行為觀測證據驗證：{1}；將重試此子任務。", cIdx + 1, subReason));
                                    subGenerationPrompt = buildWriterRevisionRequest({
                                        code: subClean, findings: subReason,
                                        moduleName: targetImportModule, functionName: targetFuncName,
                                        evidence: subUserPrompt
                                    });
                                    if (!seedPending && mode === 'full') {
                                        subGenerationPrompt = buildWriterAdditionRevisionPrompt(subGenerationPrompt,
                                            writerAdditionBaseline || checkpoints.executable?.code || bestCode || '', subClean, subReason);
                                    }
                                    subRevisionCode = subClean;
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
                    const mergeBaseline = checkpoints.executable?.code || bestCode;
                    const mergeRes = mergeBaseline
                        ? await mergeTestSnippetsPreservingBaseline({ baseline: mergeBaseline, snippets: subSnippets,
                            className: `Test${targetFuncName || 'Merged'}`, python: pythonExecutable, env: testExecutionEnv })
                        : { ok: true as const, ...mergeTestSnippets(subSnippets, `Test${targetFuncName || 'Merged'}`) };
                    if (mergeRes.ok) {
                        sanitizedCode = mergeRes.mergedCode;
                        log(localize("[分治合流] 🎉 成功重組為單一類別，共包含 {0} 個獨立測試方法！", mergeRes.totalMethodsCount));
                    } else {
                        recordRole('caller-merge', 'rejected', { reasonCode: mergeRes.reasonCode, preservedBaseline: true });
                    }
                }
            }

            // 若非分治合流模式，或分治合流未取得結果，走標準 Single-Pass 流程
            if (!sanitizedCode) {
                let generationPrompt = userPrompt;
                let generationRevisionCode: string | undefined;
                for (let llmRetry = 0; llmRetry < 2; llmRetry++) {
                    if (llmRetry === 0) {log(localize("[LLM] 正在呼叫模型推論中... (模型: {0})", params.modelName));}
                    try {
                        // Expansion repairs retain the full checkpoint as well as this
                        // candidate, so only a pending seed can size a bounded output.
                        rawCode = await requestBudgeted(params, systemPrompt, generationPrompt, log, testGenerationResponseFormat,
                            generationRevisionCode === undefined ? 'writer' : 'writer-revision', undefined, 0,
                            seedPending ? generationRevisionCode : undefined, undefined, undefined,
                            generationRevisionCode === undefined ? undefined : { findingCount: 1, missingScenarioCount: 0 });
                    } catch (err: any) {
                        if (err instanceof AnalysisStageError) { throw err; }
                        if (llmRetry === 0) {
                            log(localize("[警告] 網路或 API 請求失敗: {0}，嘗試自動重試 (1/1)...", err.message));
                            continue;
                        } else {
                            throw err;
                        }
                    }

                    sanitizedCode = await prepareWriterCandidate(rawCode,
                        generationRevisionCode === undefined ? 'writer' : 'writer-revision', llmRetry);

                    if (!sanitizedCode) {
                        recordRejected('', llmRetry, 'response-format', 'no-python-candidate');
                        if (llmRetry === 0) {
                            log(localize("[警告] 模型回傳程式碼為空或包含無效標籤，嘗試自動重試..."));
                            continue;
                        } else {
                            throw new CandidateValidationError(localize("模型產生的程式碼內容為空 (已重試失敗)"));
                        }
                    }

                    if (!methodInventories.has(evidenceHash(sanitizedCode))) {
                        const reason = localize('模型回覆未能抽取為可解析的 Python 測試；未推定為缺少 import。');
                        recordRejected(sanitizedCode, llmRetry, 'response-format', 'response-not-extracted-python');
                        if (llmRetry > 0) { throw new CandidateValidationError(reason); }
                        const syntax = candidateSyntaxFailures.get(evidenceHash(sanitizedCode));
                        generationPrompt = seedPending && syntax ? buildWriterSeedFormatRepairPrompt(userPrompt, syntax)
                            : buildWriterRevisionRequest({ code: '', findings: reason,
                            moduleName: targetImportModule, functionName: targetFuncName,
                            evidence: buildWriterRevisionContext({ module: targetImportModule, name: targetFuncName,
                                source: astContext?.code || targetCode, context: astContext, evidence: writerEvidenceBundle }) });
                        recordRole('model-request', 'output-format-retry', { role: 'writer',
                            reasonCode: syntax ? 'response-python-syntax' : 'response-not-extracted-python',
                            ...(seedPending && syntax ? { writerPromptMode: 'same-seed-format-repair-v1',
                                originalPromptHash: evidenceHash(userPrompt), evidencePreserved: true } : {}) });
                        if (writerAdditionBaseline) {
                            generationPrompt = buildWriterAdditionRevisionPrompt(generationPrompt, writerAdditionBaseline, '', reason);
                        }
                        generationRevisionCode = '';
                        continue;
                    }

                    // 🚨 偵測 AI 是否在複製原始碼（小模型常見的注意力崩潰）
                    const hasTestMethods = sanitizedCode.includes('def test_') || sanitizedCode.includes('self.assert');
                    const looksLikeSourceCopy = !hasTestMethods && targetFuncName && sanitizedCode.includes(`def ${targetFuncName}`);
                    if (looksLikeSourceCopy) {
                        recordRejected(sanitizedCode, llmRetry, 'response-format', 'source-copy');
                        if (llmRetry === 0) {
                            log(localize("[警告] ⚠️ AI 輸出的是原始碼而不是測試碼（偵測到複製行為），嘗試重試..."));
                            continue;
                        } else {
                            throw new CandidateValidationError(localize("AI 連續兩次輸出了原始碼而非測試碼，無法產生有效測試"));
                        }
                    }

                    // 驗證 AI 產出的程式碼格式是否符合要求，若不合規則嘗試自動救援
                    if (!sanitizedCode.includes('unittest.TestCase') && !sanitizedCode.includes('import unittest')) {
                        log(localize("[警告] AI 未按格式輸出 unittest.TestCase，嘗試自動救援轉換..."));
                        const rescued = await rescueToUnittest(sanitizedCode, params.filePath, targetFuncName, targetImportModule, pythonExecutable);
                        if (!rescued) {
                            recordRejected(sanitizedCode, llmRetry, 'unittest-structure', 'no-executable-unittest');
                            if (llmRetry === 0) {
                                log(localize("[警告] AI 回傳格式無法解析出有效的測試案例，嘗試重新請求..."));
                                continue;
                            } else {
                                throw new CandidateValidationError(localize("AI 輸出格式連續兩次無法解析為有效測試（無任何 assert 或可用語句）"));
                            }
                        }
                        log(localize("[救援] 自動轉換成功！已將 AI 輸出包裝為 unittest.TestCase 格式。"));
                        sanitizedCode = rescued;
                        await recordCandidateMethods(sanitizedCode, 'merged', 'writer');
                    }

                    const compositionFailure = additionRejections.get(evidenceHash(sanitizedCode));
                    const candidateValidation = compositionFailure
                        ? { valid: false, ...compositionFailure }
                        : !methodInventories.has(evidenceHash(sanitizedCode))
                            ? { valid: false, reason: localize('模型回覆未能抽取為可解析的 Python 測試；未推定為缺少 import。'),
                                reasonCode: 'response-not-extracted-python' }
                            : await validateGeneratedTestCode(
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
                        recordRejected(sanitizedCode, llmRetry, compositionFailure?.gate
                            || (candidateValidation.valid ? 'assertion-evidence' : 'unittest-structure'),
                            candidateValidation.valid ? 'trace-evidence-rejected' : candidateValidation.reasonCode || 'candidate-structure-rejected');
                        if (llmRetry === 0) {
                            log(localize("[警告] 模型輸出未通過證據／Python unittest 驗證：{0}；將以嚴格格式要求重試。", validationReason));
                            generationPrompt = buildWriterRevisionRequest({
                                code: sanitizedCode, findings: validationReason || localize("不明驗證錯誤"),
                                moduleName: targetImportModule, functionName: targetFuncName,
                                evidence: writerEvidenceBundle ? buildWriterRevisionContext({
                                    module: targetImportModule, name: targetFuncName,
                                    source: astContext?.code || targetCode, context: astContext,
                                    evidence: writerEvidenceBundle
                                }) : userPrompt
                            });
                            if (!seedPending && mode === 'full') {
                            generationPrompt = buildWriterAdditionRevisionPrompt(generationPrompt,
                                    writerAdditionBaseline || checkpoints.executable?.code || bestCode || '', sanitizedCode,
                                    validationReason || analystTasks);
                            }
                            generationRevisionCode = sanitizedCode;
                            sanitizedCode = '';
                            continue;
                        }
                        throw new CandidateValidationError(localize("模型連續兩次未通過證據／Python unittest 驗證：{0}", validationReason));
                    }

                    break; // 成功跳出 retry
                }
            }

            // Reports retain validated test artifacts and diagnostic events, never full provider replies.

            let finalCode = sanitizedCode;
            
            // Import, fixture and assertion changes belong to the AI revision path.
            const baseName = path.basename(params.filePath, '.py');

            if (bestCode && !seedPending) {
                const novelty = await assessQualityCandidateNovelty(bestCode, finalCode, pythonExecutable, testExecutionEnv);
                recordRole('quality-novelty', novelty.novelMethods ? 'novel' : 'duplicate', novelty);
                if (!novelty.novelMethods) {
                    throw new AnalysisStageError('validation', 'quality-stagnation',
                        localize('候選僅重複或重新命名既有測試，未新增可驗證情境；保留已測量基線。'));
                }
            }
            recordRole('writer', 'candidate', { tier: currentTier, responseHash: evidenceHash(rawCode),
                responseCharacters: rawCode.length, code: finalCode });
            const repairContext = (code: string, failure: string) => getBugFixerUserPrompt(
                code, failure, targetFuncName, astContext?.args || [], astContext?.code || targetCode,
                astContext, targetImportModule, undefined,
                sourceMockUsePointNames.map(name => `${targetImportModule}.${name}`)
            );
            const roleEvidence = appendQualityEvidence(getReviewEvidence('', '', targetFuncName, astContext?.args || [],
                astContext?.code || targetCode, astContext, targetImportModule, undefined,
                sourceMockUsePointNames.map(name => `${targetImportModule}.${name}`)));
            const inventories = new Map<string, ScenarioIdentity[]>();
            const inventory = async (code: string): Promise<ScenarioIdentity[]> => {
                const hash = evidenceHash(code);
                if (!inventories.has(hash)) {
                    const result = await runSpawn(pythonExecutable,
                        ['-B', pythonToolPath('scenarios')],
                        { input: code, timeout: 5000, env: testExecutionEnv });
                    if (result.code !== 0) { throw new AnalysisStageError('validation', 'scenario-inventory', localize("無法建立測試情境識別；工具未完成，未採用候選。")); }
                    inventories.set(hash, JSON.parse(result.stdout));
                }
                return inventories.get(hash)!;
            };
            // A passed seed survives Tier fallback even before its first approved mutation run.
            const retainedExecution = checkpoints.executable;
            const retainedCode = retainedExecution?.code || bestCode;
            const passingExecutions = new Map<string, string[]>();
            let baselineScenarios = retainedExecution?.scenarios.length ? retainedExecution.scenarios
                : bestScenarios.length ? bestScenarios : retainedCode ? await inventory(retainedCode) : [];
            const checkPreservation = async (previous: string, candidate: string, protectedMethods: 'all' | readonly string[]) => {
                if (previous === candidate || !previous || (protectedMethods !== 'all' && !protectedMethods.length)) { return undefined; }
                const result = await validatePassingTestPreservation({ previousCode: previous, candidateCode: candidate,
                    protectedMethods, python: pythonExecutable, env: testExecutionEnv });
                throwIfExecutionCancelled();
                if (result.valid) { return undefined; }
                recordRole('passing-tests', 'preservation-rejected', { ...result,
                    previousTestHash: evidenceHash(previous), candidateTestHash: evidenceHash(candidate) });
                return { reason: result.reason, reasonCode: result.reasonCode!, gate: 'revision-scope' as const };
            };
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
                    dependencyEvidenceVersion: SOURCE_VERSIONS_VERSION,
                    dependencyVersions: astContext?.sourceVersions || preflight!.sourceVersions });
                journal.knowledge({ executableBaseline: { path: 'executable_baseline.json', testFile: snapshot.testFile,
                    codeHash: snapshot.codeHash, tier: snapshot.tier, reviewStatus: snapshot.reviewStatus, mutationStatus: snapshot.mutationStatus } });
                recordRole('executable-baseline', 'checkpointed', { codeHash: snapshot.codeHash,
                    testFile: snapshot.testFile, reviewStatus: snapshot.reviewStatus, mutationScore: null });
                writeReport(finalReportMarkdown
                    + localize("\n### 已保存可執行測試\n\n- 測試：{0}\n- 審查狀態：{1}\n- 本候選突變：尚未測量\n", snapshot.testFile, status));
            };
            const candidateHooks: CandidatePipelineHooks = {
                reviewRequired: true,
                checkCancelled: throwIfExecutionCancelled,
                event: recordRole,
                rejectedCandidate: recordRejected,
                repairEvidence: ruleSelection.ids.includes('numeric_calculation') ? async (code, failure) => {
                    const evidence = await collectNumericRepairEvidence({
                    code, failure, source: initialSource, target: params.funcName || targetFuncName, module: targetImportModule,
                    python: pythonExecutable, env: testExecutionEnv, directory: loopDir,
                    runId: journal.runId, sourceHash: journal.sourceHash, knownSecrets,
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
                    });
                    if (!evidence) { return undefined; }
                    recordRole('numeric-evidence', 'retained', numericEvidence.add(evidence));
                    return numericEvidencePrompt();
                } : undefined,
                executable: (code, execution) => checkpointExecutable(code, execution.out, execution.qualityGaps,
                    'incomplete', [], execution.coverage || loopAssessment),
                validate: async (code) => {
                    const additionFailure = additionRejections.get(evidenceHash(code));
                    if (additionFailure) { return additionFailure; }
                    const preservation = await checkPreservation(checkpoints.executable?.code || retainedCode, code, 'all');
                    if (preservation) { return preservation; }
                    const structural = await validateGeneratedTestCode(code, targetFuncName, baseName,
                        astContext?.method_kind === 'property' ? 'property' : 'call', astContext?.signature,
                        exceptionNamesFromEvidence(astContext), astContext?.class_name || undefined, pythonExecutable, testBindingContext);
                    if (!structural.valid) {
                        recordRole('structure', 'rejected', { reasonCode: structural.reasonCode || 'candidate-structure-rejected',
                            repairRole: 'writer' });
                        return { reason: structural.reason || 'Structure validation failed',
                            gate: 'unittest-structure', reasonCode: structural.reasonCode || 'candidate-structure-rejected' };
                    }
                    const trace = await validateTraceEvidence(code, targetFuncName, astContext?.traceResult, targetImportModule, pythonExecutable, astContext?.class_name);
                    return !trace.valid ? { reason: trace.reason || 'Validation failed',
                        gate: 'assertion-evidence', reasonCode: 'trace-evidence-rejected' } : undefined;
                },
                review: async (code) => {
                    reviewerRevisionWorkloads.delete(evidenceHash(code));
                    reviewerCorrectionScopes.delete(evidenceHash(code));
                    if (!mayUseModelAuthoredReview) {
                        recordRole('reviewer', 'unqualified', {});
                        return undefined;
                    }
                    const sys = getTestReviewerSystemPrompt();
                    const identity = { runId: journal.runId, sourceHash: journal.sourceHash, target: params.funcName || targetFuncName };
                    const facts = await buildReviewFacts({ ...identity, code, module: targetImportModule,
                        python: pythonExecutable, env: testExecutionEnv, executionVerified: true,
                        numericEvidencePrompt: numericEvidencePrompt(), knownSecrets,
                        observations: astContext?.traceResult ? { ...identity, value: astContext.traceResult } : undefined });
                    throwIfExecutionCancelled();
                    recordRole('reviewer-evidence', 'assembled', buildReviewerEvidenceDiagnostic(facts));
                    const prompt = fitReviewPrompt({ tests: code, evidence: roleEvidence + '\n' + numericEvidencePrompt(), executionVerified: true, facts },
                        Number.MAX_SAFE_INTEGER);
                    // The shared final gate owns growth and includes all resources,
                    // corrections and quality evidence before any wire request.
                    if (!prompt) {
                        recordRole('reviewer', 'budget-exceeded', {
                            role: 'reviewer', inputBudget: activeModelProfile.budgetTokens,
                            contextWindow: requestContextWindow,
                            estimatedInputTokens: null,
                            reason: localize('完整審查證據超過預算；已保留測試，突變測試未執行。') });
                        return undefined;
                    }
                    const assessment = await reviewSession.review(evidenceHash(sys + '\n' + prompt + '\n' + (importFixtures?.id || '')), async () => {
                        try {
                            return await reviewWithContractRepair({ tests: code, prompt, knownSecrets,
                                constraints: { target: params.funcName || targetFuncName, facts, identity,
                                    methodKind: astContext?.method_kind || (astContext?.class_name ? 'instance' : 'module'),
                                    module: targetImportModule,
                                    dependencyUsePoints: (astContext?.calls || []).map((name: string) => `${targetImportModule}.${name}`) },
                                deadlineAt: Math.min(deadlineAtFromTimeoutSeconds(params.timeoutSeconds), currentTargetBudget()?.deadlineAt ?? Infinity),
                                request: (reviewPrompt, deadline) => requestBudgeted(params, sys, reviewPrompt, log, 'review-json', 'reviewer', deadline),
                                checkCancelled: throwIfExecutionCancelled,
                                event: (status, detail) => recordRole('reviewer', status, detail)
                            });
                        } catch (error: any) {
                            throwIfExecutionCancelled();
                            recordRole('reviewer', 'failed', { reason: error.message,
                                category: error instanceof AnalysisStageError ? error.category : classifyExecutionFailure(error.message) });
                            throw error;
                        }
                    }, (status, detail) => recordRole('reviewer', status, detail));
                    if (assessment?.issues.length) {
                        const methods = methodInventories.get(evidenceHash(code));
                        if (!methods?.length) {
                            throw new AnalysisStageError('validation', 'candidate-inventory-tool', 'Review revision requires the current method inventory.');
                        }
                        const preserveMethodSet = assessment.issues.every(issue => issue.category && issue.category !== 'missing-scenario');
                        reviewerRevisionWorkloads.set(evidenceHash(code), {
                            feedbackHash: evidenceHash(JSON.stringify(assessment.issues)),
                            feedback: { version: 'writer-review-feedback-v1', testHash: evidenceHash(code),
                                findings: structuredClone(assessment.issues),
                                methodScope: { mode: preserveMethodSet ? 'preserve-method-set' : 'allow-additions',
                                    methodIds: methods.map(method => method.id) } },
                            workload: { findingCount: assessment.issues.length,
                                missingScenarioCount: assessment.issues.filter(issue => issue.category === 'missing-scenario').length }
                        });
                        if (preserveMethodSet) {
                            reviewerCorrectionScopes.set(evidenceHash(code), methods.map(method => method.id));
                        }
                    }
                    return assessment;
                },
                repairRole: (code, failure) => selectCandidateRepairRole(mayUseModelAuthoredRepair, canRepairTestMethod(code, failure)),
                revise: async (code, failure, role, attempt) => {
                    if (role === 'writer' ? !mayUseModelAuthoredTests : !mayUseModelAuthoredRepair) {
                        throw new AnalysisStageError('validation', 'role-qualification', localize("Auto 未驗證 {0} 角色不可呼叫該角色修訂。", role));
                    }
                    const workloadKey = evidenceHash(code);
                    const reviewedWork = reviewerRevisionWorkloads.get(workloadKey);
                    const matchedReview = reviewedWork?.feedbackHash === evidenceHash(failure) ? reviewedWork : undefined;
                    const sys = role === 'bug-fixer' ? getBugFixerSystemPrompt()
                        : 'You are the test Writer. Revise the current tests for the supplied concrete review or structure findings. Preserve passing cases and verified assertions. Do not invent requirements. Output the complete test file in one python code fence.';
                    let prompt = role === 'bug-fixer' ? repairContext(code, failure)
                        : buildWriterRevisionRequest({
                            code,
                            findings: failure,
                            reviewFeedback: matchedReview?.feedback,
                            moduleName: targetImportModule,
                            functionName: targetFuncName,
                            evidence: buildWriterRevisionContext({ module: targetImportModule, name: targetFuncName,
                                source: astContext?.code || targetCode, context: astContext, evidence: writerEvidenceBundle,
                                allowedMockTargets: sourceMockUsePointNames.map(name => `${targetImportModule}.${name}`) })
                        });
                    if (role === 'writer' && writerAdditionBaseline) {
                        prompt = buildWriterAdditionRevisionPrompt(prompt, writerAdditionBaseline, code, failure);
                    }
                    const correctionMethods = role === 'writer' ? reviewerCorrectionScopes.get(evidenceHash(code)) : undefined;
                    if (correctionMethods) { prompt = buildWriterReviewCorrectionPrompt(prompt); }
                    // requestBudgeted checks the final prompt, including numeric/resource
                    // evidence, and records a stage-owned failure without Tier fallback.
                    const revisionWorkload = matchedReview?.workload ?? { findingCount: 1, missingScenarioCount: 0 };
                    reviewerRevisionWorkloads.delete(workloadKey);
                    const repairStarted = Date.now();
                    const raw = await requestBudgeted(
                        params, sys, prompt, log,
                        role === 'bug-fixer' ? 'text' : testGenerationResponseFormat,
                        role === 'bug-fixer' ? 'bug-fixer' : 'writer-revision', undefined, 0,
                        role === 'writer' ? code : undefined, undefined, undefined,
                        role === 'writer' ? revisionWorkload : undefined
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
                        return merged.code!;
                    }
                    const candidate = await prepareWriterCandidate(raw, 'writer-revision', attempt);
                    if (correctionMethods) {
                        const methods = methodInventories.get(evidenceHash(candidate));
                        if (methods && (methods.length !== correctionMethods.length
                            || methods.some(method => !correctionMethods.includes(method.id)))) {
                            additionRejections.set(evidenceHash(candidate), { gate: 'revision-scope',
                                reasonCode: 'review-revision-scope-expanded',
                                reason: 'Review correction must keep the exact existing test method identities. '
                                    + 'Correct the cited findings only; do not add, remove or rename tests. Return the complete file.' });
                            recordRole('writer-review-scope', 'rejected', { reasonCode: 'review-revision-scope-expanded',
                                previousCodeHash: evidenceHash(code), codeHash: evidenceHash(candidate),
                                expectedMethodCount: correctionMethods.length, actualMethodCount: methods.length });
                        } else if (methods) {
                            reviewerCorrectionScopes.set(evidenceHash(candidate), correctionMethods);
                        }
                    }
                    return candidate;
                },
                validateRevision: async (previousCode, candidateCode, failure, role) => {
                    const preservePassed = () => checkPreservation(previousCode, candidateCode,
                        passingExecutions.get(evidenceHash(previousCode)) || []);
                    if (role !== 'bug-fixer') { return preservePassed(); }
                    // Keep the Bug Fixer's narrower, established scope diagnostic first.
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
                        return result.valid === true ? preservePassed() : { reason: localize(REPAIR_REASON_LABELS[reasonCode]), reasonCode };
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
                    const [invocationFile, coverageFile, resultFile] = reserveArtifactFiles(testDir, ['invocation', 'coverage', 'result'], 'json');
                    const [isolationFile] = reserveArtifactFiles(testDir, ['isolation'], 'jsonl');
                    const executionArguments = [...generatedUnittestArguments(path.basename(testPath, '.py'), targetDir, true, true),
                        '--target-file', params.filePath, '--target-name', params.funcName || targetFuncName,
                        '--target-evidence', invocationFile, '--target-run-id', testRunId, '--target-test-file', testPath,
                        '--violation-report', isolationFile, '--result-json', resultFile];
                    const run = await runSpawn(pythonExecutable,
                        executionArguments,
                        { cwd: testDir, env: testExecutionEnv, timeout: 30000 });
                    const resourceFailure = readResourceSetupFailure({ isolationFile, sourceFile: params.filePath,
                        testFile: testPath, targetRunId: testRunId, sourceHash: journal.sourceHash, testHash,
                        importFixturePlanId: currentImportFixtures()?.id, exitCode: run.code });
                    if (resourceFailure) {
                        throw new AnalysisStageError('environment', 'resource-setup',
                            localize('隔離測試資料庫缺少資料表或欄位；請在「隔離測試資源」補齊 schema 後重新執行。'), resourceFailure);
                    }
                    const runnerDiagnostic = readGeneratedRunnerDiagnostics({ resultFile, invocationFile,
                        sourceFile: params.filePath, testFile: testPath, target: params.funcName || targetFuncName,
                        testRunId, sourceHash: journal.sourceHash, testHash });
                    if (runnerDiagnostic) {
                        recordRole('validation', 'load-failed', runnerDiagnostic);
                        if (run.code === 0 || runnerDiagnostic.repairRole !== 'writer') {
                            throw new AnalysisStageError('validation', 'generated-test-runner',
                                localize('生成測試的載入或身分證據無效；停止修復，未計入通過。'), runnerDiagnostic);
                        }
                        return { ok: false, out: generatedLoadRepairFeedback(`${run.stdout}${run.stderr}`),
                            qualityGaps: [], repairRole: 'writer' as const };
                    }
                    const scenarios = await inventory(code);
                    passingExecutions.set(evidenceHash(code), [...passingTestIds(run.stdout + run.stderr, path.basename(testPath, '.py'))]);
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
                    if (coverage.code !== 0) { throw new AnalysisStageError('environment', 'coverage', localize("Coverage 工具執行失敗；未採用候選品質證據。")); }
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
            };
            const accepted = await validateSeedThenCandidate({ code: finalCode, seed: seedPending,
                hooks: candidateHooks,
                seedAccepted: () => { seedPending = false; journal.knowledge({ writerPhase: 'expand' }); },
                baseline: retainedCode ? { code: retainedCode, output: retainedExecution?.execution || bestExecution } : undefined });
            finalCode = accepted.code;
            if (accepted.reviewStatus === 'completed' && accepted.approvedCodeHash === evidenceHash(finalCode)) {
                reviewApproval = { workflowVersion: AI_WORKFLOW_VERSION, runId: journal.runId,
                    sourceHash: journal.sourceHash, target: params.funcName || targetFuncName, testHash: accepted.approvedCodeHash };
            }
            requireReviewApproval(finalCode, reviewApproval, { runId: journal.runId,
                sourceHash: journal.sourceHash, target: params.funcName || targetFuncName });
            journal.knowledge({ reviewApproval, testAuthor: 'llm' });
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
            if (focusedWorkflow || !mayFallbackTier(tierErr, currentTier)) { throw tierErr; }
            if (tierErr instanceof RepairResponseError) {
                recordRole('bug-fixer', 'tier-failed', { tier: currentTier, category: 'model-format',
                    reason: tierErr.message, reasonCodes: tierErr.diagnostic.reasonCodes });
                recordRole('repair-routing', 'selected', { action: currentTier > 1 ? 'tier-fallback' : 'stop-tier-fallback',
                    fromTier: currentTier, toTier: currentTier > 1 ? currentTier - 1 : currentTier });
            } else {
                recordRole('writer', 'tier-failed', { tier: currentTier, reason: tierErr.message,
                    ...(tierErr instanceof CandidateValidationError ? { category: tierErr.category, origin: 'generated-test' } : {}),
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


            const selectedMutation = mutationSelection!;
            const engine = selectedMutation.actual;
            const mutationTimeoutSeconds = normalizeExecutionSettings(params).mutpyTimeout;
            throwIfExecutionCancelled();
            const measuredCandidate = checkpoints.executable;
            if (!measuredCandidate || evidenceHash(fs.readFileSync(testPath, 'utf8')) !== measuredCandidate.codeHash) {
                throw new AnalysisStageError('validation', 'candidate-changed', localize('測試檔已改變，不能沿用先前執行結果進行突變測量。'));
            }
            if (!evidenceStillCurrent()) {
                throw new AnalysisStageError('validation', 'source-changed', localize('來源版本已改變，停止使用舊證據。'));
            }
            requireReviewApproval(fs.readFileSync(testPath, 'utf8'), reviewApproval, { runId: journal.runId,
                sourceHash: journal.sourceHash, target: params.funcName || targetFuncName });
            const mutationContext: MutationContext = { sourcePath: params.filePath,
                sourceHash: journal.sourceHash, testHash: measuredCandidate.codeHash,
                targetScope: { kind: params.funcName ? 'function' : 'module', qualifiedName: params.funcName || 'module' },
                stageTimeoutSeconds: mutationTimeoutSeconds };
            recordRole('mutation', 'started', { engine, operatorSetVersion: selectedMutation.operatorSetVersion,
                workers: selectedMutation.workers, stageTimeoutSeconds: mutationTimeoutSeconds });
            log(localize('[{0}] 正在隔離執行完整突變集合；本階段預算 {1} 秒，並行數 {2}。',
                engine, mutationTimeoutSeconds, selectedMutation.workers));
            const mutationExecution = await runSpawn(pythonExecutable,
                mutationArguments(selectedMutation, params.filePath, testPath, targetFuncName || '',
                    astContext?.class_name || '', mutationTimeoutSeconds),
                { cwd: testDir, env: testExecutionEnv, timeout: (mutationTimeoutSeconds + 5) * 1000 });
            throwIfExecutionCancelled();
            if (mutationExecution.code !== 0) {
                throw mutationProcessFailure(engine, mutationExecution);
            }
            let mutationRun: MutationRun = parseIsolatedMutationRun(mutationExecution.stdout, mutationContext, engine);
            // Persist rejected evidence before any gate can stop this round.
            fs.writeFileSync(path.join(loopDir, `loop${currentLoop}_mutation.json`), JSON.stringify(mutationRun, null, 2), 'utf8');
            finalReportMarkdown += renderMutationBaselineTiming(mutationRun);
            if (mutationRun.baselineAllocatedSeconds !== undefined) {
                recordRole('mutation-baseline', mutationRun.baselineStatus, {
                    baselineTimeoutSeconds: mutationRun.baselineTimeoutSeconds,
                    baselineAllocatedSeconds: mutationRun.baselineAllocatedSeconds,
                    baselineElapsedMs: mutationRun.baselineElapsedMs,
                    mutantTimeoutPolicy: mutationRun.mutantTimeoutPolicy,
                    configuredMutantTimeoutSeconds: mutationRun.configuredMutantTimeoutSeconds,
                    effectiveMutantTimeoutSeconds: mutationRun.effectiveMutantTimeoutSeconds,
                    stageTimeoutSeconds: mutationRun.stageTimeoutSeconds,
                    scoreAvailable: false
                });
            }
            if (mutationRun.operatorSetVersion !== null && mutationRun.operatorSetVersion !== selectedMutation.operatorSetVersion) {
                journal.knowledge({ latestMutation: mutationRun });
                throw new AnalysisStageError('mutation', 'mutation-execution', localize('突變規則版本與預檢不一致；不接受量測結果。'));
            }
            let noMutationCandidates = false;
            const mutpyResult = JSON.stringify(mutationRun, null, 2);
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
                score: noMutationCandidates ? null : mutationScore, survivors: survivorIds, qualityGaps,
                engine: mutationRun.engine, operatorSetVersion: mutationRun.operatorSetVersion,
                workers: mutationRun.workers, elapsedMs: mutationRun.elapsedMs });
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
                bestReviewApproval = reviewApproval;
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
                reviewApproval = bestReviewApproval;
                measuredQualityGaps = [...bestMeasuredGaps];
                acceptedScenarios = bestScenarios;
                const restored = checkpoints.restoreQualityExecutable();
                journal.knowledge({ executableBaseline: { path: 'executable_baseline.json', testFile: restored.testFile,
                    codeHash: restored.codeHash, tier: restored.tier, reviewStatus: restored.reviewStatus, mutationStatus: restored.mutationStatus } });
                recordRole('executable-baseline', 'restored', { codeHash: restored.codeHash,
                    testFile: restored.testFile, reviewStatus: restored.reviewStatus, mutationScore: null });
                finalReportMarkdown += localize("> 已還原歷史基線，測試、分數（{0}%）、覆蓋與存活變異體同步還原；原候選保留於 role_events.jsonl。\n\n", bestScore);
            }
            if (pendingQualityGap) {
                // Judge the retained candidate after rollback, against the exact selected gap.
                const measurement = qualityExperiments.measureFocus(pendingQualityGap, loopAssessment, mutationRun);
                recordRole('quality-experiment', measurement.status, { gapId: pendingQualityGap.focus.id, ...measurement });
                focusedQualityFeedback = measurement.feedback;
                if (measurement.status === 'resolved') { pendingQualityGap = undefined; pendingQualityAttempts = 0; }
                else if (measurement.status === 'unchanged') {
                    pendingQualityAttempts++;
                    if (pendingQualityAttempts >= 2) {
                        // An unproven equivalent/hard mutant must not consume every remaining round.
                        deferredFocusId = pendingQualityGap.focus.id;
                        recordRole('quality-experiment', 'deferred', { gapId: deferredFocusId,
                            reasonCode: 'focused-attempt-limit', attempts: pendingQualityAttempts, resolved: false });
                        pendingQualityGap = undefined;
                        pendingQualityAttempts = 0;
                    } else {
                        // Preserve the task, but compare the next global gain with this retained round.
                        pendingQualityGap = qualityExperiments.beginFocus(pendingQualityGap.focus, loopAssessment, mutationRun);
                    }
                }
                journal.knowledge({ qualityExperiments: qualityExperiments.events });
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
                dependencyEvidenceVersion: SOURCE_VERSIONS_VERSION,
                dependencyVersions: astContext?.sourceVersions || preflight!.sourceVersions,
                scenarios: acceptedScenarios, execution: loopExecution, coverage: loopCoverage,
                mutationStatus: checkpoints.quality!.mutationStatus, mutationScore: noMutationCandidates ? null : mutationScore,
                survivors: survivedMutants.split('\n').filter(Boolean), qualityGaps,
                reviewWarnings, reviewStatus, reviewApproval,
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
                    : error instanceof CandidateValidationError ? error.category
                    : error instanceof AnalysisStageError ? error.category : classifyExecutionFailure(message);
            const failureStage = error instanceof RepairResponseError ? 'bug-fixer-response'
                : error instanceof CandidateValidationError ? error.stage
                : error instanceof AnalysisStageError ? error.stage : 'pipeline';
            recordRole('pipeline', retainedBaseline ? 'retained-baseline' : 'failed', {
                reason: message, category: failureCategory, retainedScore
            });
            journal.knowledge({
                terminalStatus: !evidenceValid ? 'source-changed' : failureCategory === 'cancelled' ? 'cancelled'
                    : failureStage === 'reviewer' ? 'review-blocked' : retainedBaseline ? 'retained-after-failure' : 'failed',
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
                journal.knowledge({ reviewApproval: bestReviewApproval });
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
                    mutationScore: null, mutationStatus: failureStage === 'reviewer' ? 'not-measured' : 'incomplete', survivors: null });
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
            terminalFailure = { error };
            break;
        }

        // Analyst proposes bounded scenarios; Writer owns code. Do not spend a call after the last round.
        analystTasks = focusedQualityFeedback;
        if (!pendingQualityGap) {
            qualityObservationEvidence = '';
            activeParameterFixtureEvidence = undefined;
            qualityTraceProjection = '';
            qualityTraceReference = '';
        }
        if (currentLoop < params.maxLoops && (survivedMutants || qualityGaps.length) && mayUseModelAuthoredTests) {
            try {
                let taskEvidence: QualityTaskEvidence | undefined;
                activeQualityTaskEvidence = undefined;
                activeParameterFixtureEvidence = undefined;
                // Measured comparison survivors can propose bounded numeric inputs
                // without another model call. Only isolated observations become oracles.
                let observedBoundary = false;
                // Planning is static and cheap. Prefer a gap with a supported bounded input
                // before spending a request on an unsupported survivor; observe only the chosen gap.
                let numericPlan = bestMutation && astContext && evidenceStillCurrent()
                    ? await planMutationProbes(initialSource, params.funcName || targetFuncName,
                        bestMutation, astContext.traceResult, pythonExecutable) : undefined;
                if (numericPlan?.inputs.length && bestCode && astContext) {
                    const identity = { runId: journal.runId, sourceHash: journal.sourceHash, target: params.funcName || targetFuncName };
                    const facts = await buildReviewFacts({ ...identity, code: bestCode, module: targetImportModule,
                        python: pythonExecutable, env: testExecutionEnv, executionVerified: true, knownSecrets });
                    const testedCalls = facts.methods.flatMap(method => method.calls.map(call => call.call));
                    // This changes the next experiment selection only. Existing tests,
                    // unproven equivalence and every survivor stay in the quality denominator.
                    numericPlan = { ...numericPlan, inputs: numericPlan.inputs.filter(input => !qualityInputAlreadyTested(input, testedCalls)) };
                }
                const survivorLines = survivedMutants.split('\n').filter(Boolean);
                const proposedIds = new Set(numericPlan?.inputs.map(input => input.mutantId) || []);
                const supportedSurvivors = survivorLines.filter(line => [...proposedIds].some(id => line.startsWith(`- id ${id},`)));
                const focus = pendingQualityGap?.focus || selectQualityFocus(loopAssessment, survivorLines, currentLoop, supportedSurvivors,
                    deferredFocusId ? [deferredFocusId] : [], focusedWorkflow ? testFocus : 'full');
                if (deferredFocusId && focus?.id !== deferredFocusId) {
                    analystTasks += '\nThe previous focus remains unresolved and is deferred. Work only on the following current FOCUS; '
                        + 'do not claim the previous task resolved or remove its mutant from scoring.';
                }
                deferredFocusId = undefined;
                if (focus) {
                    if (!pendingQualityGap && bestMutation) {
                        pendingQualityGap = qualityExperiments.beginFocus(focus, loopAssessment, bestMutation);
                    }
                    analystTasks += '\nMEASURED GAP (not an output oracle):\n' + JSON.stringify(focus)
                        + '\n' + qualityStrategyHints(focus.evidence).join('\n')
                        + '\n' + formatSourceLineContext(astContext?.code || '', astContext?.source_location, focus.evidence);
                }
                const focusedMutant = focus?.kind === 'survivor' ? bestMutation?.mutants.find(mutant =>
                    mutant.status === 'SURVIVED' && focus.evidence.startsWith(`- id ${mutant.id},`)) : undefined;
                if (focus && bestCode && evidenceStillCurrent() && !(params.funcName || targetFuncName).includes('.')) {
                    const result = await prepareParameterFixtureExperiments({ sourcePath: params.filePath, source: initialSource,
                        target: params.funcName || targetFuncName, module: targetImportModule, testCode: bestCode,
                        focus: { ...focus, mutant: focusedMutant,
                            line: focus.kind === 'coverage' ? Number(/^(?:line|branch):(\d+)/.exec(focus.evidence)?.[1]) || undefined : undefined },
                        python: pythonExecutable, env: testExecutionEnv, knownSecrets,
                        triedFingerprints: parameterFixtureExperiments.triedFingerprints });
                    throwIfExecutionCancelled();
                    if (!evidenceStillCurrent()) { throw new Error(localize('來源或相依已變更，未採用補測觀測。')); }
                    parameterFixtureExperiments.record(result);
                    fs.writeFileSync(path.join(loopDir, `loop${currentLoop}_parameter_fixture_experiments.json`), JSON.stringify(result, null, 2), 'utf8');
                    recordRole('parameter-fixture-experiment', result.status, { gapId: focus.id,
                        fingerprints: result.experiments.map(item => item.fingerprint), reason: result.reason });
                    const nextEvidence = parameterFixtureExperiments.prompt(result,
                        Math.min(8000, Math.floor(activeModelProfile.budgetTokens * 0.6)), knownSecrets,
                        evidence => { activeParameterFixtureEvidence = evidence; });
                    if (nextEvidence) {
                        qualityObservationEvidence = nextEvidence;
                        qualityTraceProjection = '';
                        qualityTraceReference = '';
                        observedBoundary = true;
                        recordRole('quality-evidence', 'writer-required', { gapId: focus.id, testAuthor: 'llm',
                            evidenceMode: 'parameter-fixture-observations-v1' });
                    } else if (qualityObservationEvidence.startsWith('PARAMETER_FIXTURE_OBSERVATIONS_V1')) {
                        qualityObservationEvidence = '';
                    }
                } else if (focus && bestCode && evidenceStillCurrent()) {
                    const result = await prepareQualityExperiments({ sourcePath: params.filePath, source: initialSource,
                        target: params.funcName || targetFuncName, module: targetImportModule, testCode: bestCode,
                        focus: { ...focus, mutant: focusedMutant,
                            line: focus.kind === 'coverage' ? Number(/^(?:line|branch):(\d+)/.exec(focus.evidence)?.[1]) || undefined : undefined },
                        python: pythonExecutable, env: testExecutionEnv, knownSecrets, triedFingerprints: qualityExperiments.triedFingerprints });
                    throwIfExecutionCancelled();
                    if (!evidenceStillCurrent()) { throw new Error(localize('來源或相依已變更，未採用補測觀測。')); }
                    qualityExperiments.record(result);
                    if (containsCredential(JSON.stringify(result), knownSecrets)) {
                        recordRole('quality-experiment', 'withheld', { gapId: focus.id, reasonCode: 'credential-detected' });
                        throw new AnalysisStageError('validation', 'sensitive-output',
                            localize('補測觀測含疑似憑證，未保存觀測或建立測試。'));
                    }
                    fs.writeFileSync(path.join(loopDir, `loop${currentLoop}_quality_experiments.json`), JSON.stringify(result, null, 2), 'utf8');
                    recordRole('quality-experiment', result.status, { gapId: focus.id,
                        fingerprints: result.experiments.map(item => item.fingerprint), reason: result.reason });
                    journal.knowledge({ qualityExperiments: qualityExperiments.events });
                    const available = qualityExperiments.evidenceFor(result);
                    const handoff = available?.gapId === focus.id ? available : undefined;
                    const nextEvidence = buildQualityExperimentEvidencePrompt(handoff || result,
                        Math.min(12000, Math.floor(activeModelProfile.budgetTokens * 0.6)), knownSecrets,
                        fingerprints => { if (handoff) { qualityExperiments.recordHandoff(handoff, fingerprints); } });
                    if (nextEvidence && (handoff || !qualityObservationEvidence)) {
                        qualityObservationEvidence = nextEvidence;
                        qualityTraceProjection = '';
                        qualityTraceReference = '';
                    }
                    observedBoundary = result.status === 'observed';
                    if (observedBoundary) {
                        recordRole('quality-evidence', 'writer-required', { gapId: focus.id, testAuthor: 'llm' });
                    }
                }
                if (!observedBoundary && focus?.kind === 'survivor' && focusedMutant && bestMutation && astContext && evidenceStillCurrent()) {
                    const plan = { ...numericPlan!, inputs: (numericPlan?.inputs || [])
                        .filter(input => input.mutantId === focusedMutant.id) };
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
                            if (containsCredential(JSON.stringify(observations), knownSecrets)) {
                                throw new AnalysisStageError('validation', 'sensitive-output',
                                    localize('補測觀測含疑似憑證，未保存觀測或建立測試。'));
                            }
                            astContext.traceResult = mergeBehaviorProbeResults(astContext.traceResult, observations);
                            taskEvidence = bindQualityTaskObservations({ runId: journal.runId, sourceHash: journal.sourceHash,
                                target: params.funcName || targetFuncName, focus, proposedInputs: plan.inputs,
                                observations: { runId: journal.runId, sourceHash: journal.sourceHash,
                                    target: params.funcName || targetFuncName, value: observations } });
                            activeQualityTaskEvidence = taskEvidence;
                            recordRole('quality-task-evidence', taskEvidence ? 'bound' : 'unavailable', {
                                focusId: focus.id, caseIds: taskEvidence?.cases.map(item => item.caseId) || [],
                                reasonCode: taskEvidence ? 'exact-observed-focus-inputs' : 'focus-inputs-not-assertable' });
                            writerEvidenceBundle.mergedTargetObservations = astContext.traceResult;
                            qualityObservationEvidence = 'VERIFIED BOUNDARY OBSERVATIONS (the AI must write tests):\n'
                                + JSON.stringify({ sourceHash: journal.sourceHash, target: params.funcName || targetFuncName,
                                    gapId: focus.id, observations: observationsForPrompt(observations),
                                    limitation: 'Current behavior under these exact inputs; not independent requirements.' });
                            qualityTraceProjection = JSON.stringify(observationsForPrompt(astContext.traceResult));
                            qualityTraceReference = 'VERIFIED BOUNDARY EVIDENCE: the complete merged Trace projection already supplied includes this gap: '
                                + JSON.stringify({ sourceHash: journal.sourceHash, target: params.funcName || targetFuncName, gapId: focus.id })
                                + '. Use exact observed inputs only; the AI writes the tests.';
                            journal.knowledge({ verifiedObservations: astContext.traceResult,
                                nextTasks: [{ origin: 'measured-mutation-inputs', inputs: plan.inputs,
                                    verification: localize("觀測僅支持相同輸入的斷言；下一輪仍須通過獨立基線、執行、審查與突變量測。") }],
                                taskStatus: 'observed-inputs-require-ai-tests' });
                            analystTasks += '\nNew boundary inputs have isolated execution observations in TRACE evidence. '
                                + 'The Writer must write the additional tests, preserving passed model cases. '
                                + 'The tools do not add tests. Use only the exact observed input/output pairs.\n' + JSON.stringify(plan.inputs);
                        }
                        recordRole('mutation-inputs', observedBoundary ? 'observed' : 'unavailable', {
                            inputCount: plan.inputs.length, summary: summarizeObservationPhase(observations || undefined) });
                    }
                }
                const sys = getQualityAnalystSystemPrompt(Boolean(taskEvidence));
                if (focus) {
                    const tasks = await qualityAnalystSession.request({ focus,
                        observations: taskEvidence,
                        identity: { runId: journal.runId, sourceHash: journal.sourceHash, target: params.funcName || targetFuncName },
                        context: `TARGET SOURCE\n${astContext?.code || ''}\nMODULE: ${targetImportModule}\n`
                            + formatSourceLineContext(astContext?.code || '', astContext?.source_location, focus.evidence) + '\n'
                            + `CURRENT TESTS\n${fs.readFileSync(testPath, 'utf8')}\n`
                            + `CONDITIONAL STRATEGIES (not output facts)\n${qualityStrategyHints(focus.evidence).join('\n')}`,
                        deadlineAt: deadlineAtFromTimeoutSeconds(params.timeoutSeconds),
                        checkCancelled: throwIfExecutionCancelled,
                        event: (status, detail) => recordRole('analyst-quality', status, detail),
                        request: (prompt, deadline) => requestBudgeted(params, sys, prompt, log,
                            analysisResponseFormat === 'text' ? 'text' : 'quality-json', 'analyst-quality', deadline)
                    });
                    if (tasks?.length) {
                        analystTasks += '\n' + qualityTasksForWriter(tasks);
                        journal.record(currentLoop, 'next-tasks', 'unverified', { tasks });
                        journal.knowledge({ nextTasks: tasks, taskStatus: 'hypotheses-require-execution' });
                    } else {
                        if (taskEvidence) {
                            analystTasks += '\n' + qualityTasksForWriter([{ evidence: focus.evidence,
                                hypothesis: 'Measured focus input family; model plan unavailable.',
                                scenario: taskEvidence.scenarioId, verification: 'verify-observed-behavior',
                                boundObservations: taskEvidence }]);
                        }
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
                if (error instanceof AnalysisStageError) { throw error; }
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
                : error instanceof CandidateValidationError ? error.category
                : error instanceof AnalysisStageError ? error.category : classifyExecutionFailure(message);
        const stage = error instanceof RepairResponseError ? 'bug-fixer-response'
            : error instanceof CandidateValidationError ? error.stage
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
        // The report is persisted by finally before the caller stops scheduling.
        throw error;
    } finally {
        releaseResourceObserver?.();
        if (journal.snapshot().terminalStatus === 'running') {
            journal.knowledge({ terminalStatus: isExecutionCancelled() ? 'cancelled' : 'incomplete' });
        }
        journal.knowledge({ targetBudget: currentTargetBudget()?.snapshot() });
        writeReport();
        sidebarProvider.webview?.postMessage({ command: 'updateOutcome', fileName: displayName, file: displayFile,
            func: params.funcName || '', reportPath: existingReport, outcome: presentSummaryOutcome(journal.snapshot()) });
    }
    // Full-mode failures may have restored a valid checkpoint before leaving
    // the loop. Propagate only after reports/cleanup, without overwriting that
    // retained-after-failure or review-blocked outcome in the outer catch.
    if (terminalFailure) { throw terminalFailure.error; }
}


export function deactivate() {}
