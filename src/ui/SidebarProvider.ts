import { localize } from '../i18n/core';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewContent } from './webviewContent';
import { initI18n, t } from '../i18n';
import { extractFunctionsWithAst, findPythonFilesInDir } from '../utils/utils';
import { BatchScopeController } from './BatchScopeController';
import { BatchScopeSelection } from '../pipeline/batchScope';
import { buildGoogleGenerateContentRequest, buildGoogleListModelsRequest, getGenerateContentModelNames, getGoogleGeneratedText, getGoogleModelConnectionMetadata, googleThinkingSession, normalizeGoogleModelName } from '../llm/cloudApi';
import { CloudCredential, normalizeCloudCredentials, toCloudCredentialOptions } from '../llm/cloudCredentials';
import { formatModelQualificationLog, LOCAL_RUNTIME_QUALIFICATION_VERSION, ModelQualificationProfile, QUALIFICATION_VERSION, qualificationEndpointKey } from '../llm/modelQualification';
import { buildOllamaPlainTestGenerationProbe, buildOllamaRoleQualificationProbe, requestOllamaQualification } from '../llm/ollamaCapability';
import { readLocalRuntimeMetadata } from '../llm/localRuntimeMetadata';
import { resolveLocalRuntimeContext } from '../prompts/promptBudget';
import { findModelProfile, restoreModelProfiles, StoredModelProfile } from '../llm/modelProfileRegistry';
import { getRuntimeContextPreference, restoreRuntimeContextPreferences, RuntimeContextPreference, RUNTIME_CONTEXT_PREFERENCES_KEY, upsertRuntimeContextPreference } from '../llm/runtimeContextPreferences';
import { getOllamaAllocationObservation, OLLAMA_ALLOCATION_OBSERVATIONS_KEY, upsertOllamaAllocationObservation } from '../llm/ollamaAllocationObservations';
import { PLAIN_TEST_GENERATION_PROBE_PROMPT } from '../llm/testGenerationQualification';
import { runIsolatedProbe, verifyRunnableTestGenerationProbe } from '../llm/modelProbeExecution';
import { buildRoleQualificationProfile, formatRoleQualificationLog, runRoleQualificationProbes } from '../llm/roleQualification';
import { buildCustomChatCompletionBody, getCustomChatCompletionText, responseSchemaForOutputFormat } from '../llm/customApi';
import { CONNECTION_DISCOVERY_TIMEOUT_MS, fetchWithServerRetry, fetchWithTimeout, MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS, MODEL_QUALIFICATION_TIMEOUT_MS, retryTransientProviderRequest } from '../llm/connectionTimeout';
import { configuredPythonForResource } from '../environment/pythonEnvironmentController';
import { pythonEnvironmentActivity } from '../environment/pythonEnvironmentSetup';

export class MutationViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mutation-test-view';
    public webview?: vscode.Webview;
    private view?: vscode.WebviewView;
    private activeAnalysis?: string;
    private languageRefreshPending = false;
    private readonly batchScope: BatchScopeController;
    private projectRevision = 0;
    private contextPreferenceWrites: Promise<void> = Promise.resolve();

    constructor(private readonly secretStorage: vscode.SecretStorage, private readonly uiState: vscode.Memento) {
        this.batchScope = new BatchScopeController(uiState);
    }

    public previewBatchScope(root: string, files: readonly string[]): Promise<BatchScopeSelection | undefined> {
        return this.batchScope.preview(root, files);
    }

    public cancelBatchScopePreview(): void { this.batchScope.invalidate(); }

    public runtimeContextPreferencesSnapshot(): RuntimeContextPreference[] {
        return restoreRuntimeContextPreferences(this.uiState.get(RUNTIME_CONTEXT_PREFERENCES_KEY));
    }

    private async saveRuntimeContextPreference(identity: { endpointKey: string; modelName: string },
        tokens: number, source: RuntimeContextPreference['source'],
        expectedAutomaticPreference?: RuntimeContextPreference | null): Promise<boolean> {
        let saved = false;
        const write = this.contextPreferenceWrites.catch(() => undefined).then(async () => {
            const current = this.uiState.get(RUNTIME_CONTEXT_PREFERENCES_KEY);
            if (expectedAutomaticPreference !== undefined) {
                const config = vscode.workspace.getConfiguration('llmUnitTest');
                if (this.activeAnalysis || config.get<unknown>('runtimeContextTokens', 0) !== 0
                    || qualificationEndpointKey('local', config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434')) !== identity.endpointKey
                    || JSON.stringify(getRuntimeContextPreference(current, identity) ?? null)
                        !== JSON.stringify(expectedAutomaticPreference)) { return; }
            }
            await this.uiState.update(RUNTIME_CONTEXT_PREFERENCES_KEY,
                upsertRuntimeContextPreference(current, identity, tokens, source));
            saved = true;
        });
        this.contextPreferenceWrites = write;
        await write;
        return saved;
    }

    /** Allocation and model upper bound are separate facts. Reading the upper
     * bound may refresh automatic capacity, but never overrides a user choice. */
    private async readLocalRuntimeContext(modelName: string, configuredTokens: unknown, capture = true, endpoint?: string, ignoreQualification = false,
        startup?: { cachedProfile?: StoredModelProfile; preferences: RuntimeContextPreference[]; signal: AbortSignal }) {
        const config = vscode.workspace.getConfiguration('llmUnitTest');
        const baseUrl = (endpoint || config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434')).replace(/\/$/, '');
        const identity = { endpointKey: qualificationEndpointKey('local', baseUrl), modelName };
        const preference = getRuntimeContextPreference(startup?.preferences ?? this.runtimeContextPreferencesSnapshot(), identity);
        const stored = findModelProfile(startup ? startup.cachedProfile ? [startup.cachedProfile] : []
            : restoreModelProfiles(this.uiState.get('llmUnitTest.modelProfiles.v1')),
            { ...identity, envType: 'local' });
        const { metadata, allocation, diagnostic } = await readLocalRuntimeMetadata({ baseUrl, modelName,
            cachedProfile: stored, signal: startup?.signal });
        if (allocation?.runtimeContextSource === 'ollama-ps' && !startup?.signal.aborted) {
            const write = this.contextPreferenceWrites.catch(() => undefined).then(async () => {
                if (startup?.signal.aborted) { return; }
                await this.uiState.update(OLLAMA_ALLOCATION_OBSERVATIONS_KEY,
                    upsertOllamaAllocationObservation(this.uiState.get(OLLAMA_ALLOCATION_OBSERVATIONS_KEY),
                        { ...identity, tokens: allocation.effectiveRuntimeContextTokens }));
            });
            this.contextPreferenceWrites = write;
            await write;
        }
        const resolveRuntime = (currentPreference: RuntimeContextPreference | undefined) =>
            resolveLocalRuntimeContext({ ...metadata, ...allocation, runtimeContextTokens: configuredTokens,
                preferredRuntimeContextTokens: currentPreference?.tokens, preferredRuntimeContextSource: currentPreference?.source,
                qualificationRuntime: ignoreQualification ? undefined : stored?.qualificationRuntime });
        let runtime = resolveRuntime(preference);
        let usedPreference = preference;
        if (capture && !this.activeAnalysis && configuredTokens === 0 && runtime.ok
            && (!preference || preference.source === 'captured-runtime' && preference.tokens !== runtime.contextWindow)
            && config.get<unknown>('runtimeContextTokens', 0) === configuredTokens
            && qualificationEndpointKey('local', config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434')) === identity.endpointKey) {
            const saved = await this.saveRuntimeContextPreference(identity, runtime.contextWindow,
                'captured-runtime', preference ?? null);
            usedPreference = saved ? { ...identity, tokens: runtime.contextWindow, source: 'captured-runtime' }
                : getRuntimeContextPreference(this.runtimeContextPreferencesSnapshot(), identity);
            // An automatic refresh cannot replace a manual choice queued while
            // metadata was being fetched. Probes still share this resolved value.
            if (!saved) { runtime = resolveRuntime(usedPreference); }
        }
        const lastAllocation = getOllamaAllocationObservation(this.uiState.get(OLLAMA_ALLOCATION_OBSERVATIONS_KEY), identity)?.tokens
            ?? (stored?.runtimeContextSource === 'ollama-ps' && Number.isSafeInteger(stored.effectiveRuntimeContextTokens)
                && stored.effectiveRuntimeContextTokens! > 0 ? stored.effectiveRuntimeContextTokens : undefined);
        const profileRuntime = allocation?.runtimeContextSource === 'ollama-num-ctx' && lastAllocation
            ? undefined : allocation;
        return { baseUrl, identity, metadata, allocation, lastAllocation, profileRuntime, runtime, preference: usedPreference, diagnostic, stored };
    }

    /** Recheck the run's exact model before any target. Discovery never grants role qualification. */
    public async prepareLocalAnalysisRuntime(input: { modelName: string; baseUrl: string; configuredTokens: unknown;
        preferences: RuntimeContextPreference[]; cachedProfile?: StoredModelProfile; signal: AbortSignal;
        canPublish: () => boolean }) {
        const selection = await this.readLocalRuntimeContext(input.modelName, input.configuredTokens, false, input.baseUrl,
            false, { cachedProfile: input.cachedProfile, preferences: input.preferences, signal: input.signal });
        if (!input.signal.aborted && input.canPublish()) {
            this.publishLocalRuntimeContext(selection, input.configuredTokens);
            void this.webview?.postMessage({ command: 'appendLog', text:
                `[model-runtime-metadata] ${selection.diagnostic.status}; show=${selection.diagnostic.show.reasonCode}; allocation=${selection.diagnostic.allocation.reasonCode}` });
        }
        const profile: StoredModelProfile = { ...selection.stored, ...selection.metadata, ...selection.profileRuntime,
            envType: 'local', ...selection.identity };
        return { profile, diagnostic: selection.diagnostic };
    }

    private publishLocalRuntimeContext(selection: Awaited<ReturnType<MutationViewProvider['readLocalRuntimeContext']>>,
        configuredTokens: unknown, revision?: unknown, allocationCurrent = true): void {
        void this.webview?.postMessage({ command: 'modelRuntimeContext', modelName: selection.identity.modelName,
            endpointKey: selection.identity.endpointKey, revision, configuredTokens,
            savedTokens: selection.preference?.tokens, savedSource: selection.preference?.source,
            allocatedTokens: selection.allocation?.runtimeContextSource === 'ollama-ps'
                ? selection.allocation.effectiveRuntimeContextTokens : selection.lastAllocation,
            allocationCurrent: allocationCurrent && selection.allocation?.runtimeContextSource === 'ollama-ps',
            allocationSource: selection.allocation?.runtimeContextSource,
            defaultTokens: selection.allocation?.runtimeContextSource === 'ollama-num-ctx'
                ? selection.allocation.effectiveRuntimeContextTokens : undefined,
            modelLimit: selection.metadata.contextLengthKnown ? selection.metadata.contextLength : undefined,
            requestTokens: selection.runtime.ok ? selection.runtime.contextWindow : undefined,
            metadataStatus: selection.diagnostic.status, metadataDiagnostic: selection.diagnostic,
            reasonCode: selection.runtime.ok ? undefined : selection.runtime.reasonCode });
    }

    public beginAnalysis(id: string): void { this.activeAnalysis = id; }
    public endAnalysis(id: string): void {
        if (this.activeAnalysis !== id) { return; }
        this.activeAnalysis = undefined;
        if (this.languageRefreshPending) { this.languageRefreshPending = false; this.refreshLanguage(); }
    }

    public refreshLanguage(): void {
        initI18n();
        if (this.activeAnalysis) { this.languageRefreshPending = true; return; }
        if (!this.webview) { return; }
        if (this.view) { this.view.title = t('ui.modelSettings'); }
        const config = vscode.workspace.getConfiguration('llmUnitTest');
        const html = getWebviewContent(t, config.get('language', 'auto'), config.get('promptStrategy', 'auto'),
            config.get('ollamaBaseUrl', 'http://127.0.0.1:11434'), config.get('validationMode', 'full'),
            config.get('mutationEngine', 'builtin'), config.get('mutationWorkers', 2));
        if (this.webview.html !== html) { this.webview.html = html; }
    }

    /** Keep each picker independent; local UI history must not become project configuration. */
    private lastFolder(kind: 'project' | 'output' | 'batch', fallback = ''): string {
        const saved = this.uiState.get<unknown>(`llmUnitTest.lastFolders.v1.${kind}`);
        return typeof saved === 'string' && saved.trim() ? saved : fallback;
    }

    private async rememberFolder(kind: 'project' | 'output' | 'batch', folder: string): Promise<void> {
        await this.uiState.update(`llmUnitTest.lastFolders.v1.${kind}`, folder);
    }

    private async rememberRunPreference(config: vscode.WorkspaceConfiguration, key: string, value: string | number): Promise<void> {
        const setting = config.inspect?.(key);
        const target = setting?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
            : setting?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : true;
        await config.update(key, value, target);
    }

    private appendModelQualificationLog(profile: ModelQualificationProfile, responsePreview?: string): void {
        void this.webview?.postMessage({
            command: 'appendLog',
            text: formatModelQualificationLog(profile, responsePreview)
        });
    }

    private appendRoleQualificationLog(profile: ModelQualificationProfile): void {
        if (!profile.roleQualification) { return; }
        void this.webview?.postMessage({ command: 'appendLog', text: formatRoleQualificationLog(profile.roleQualification) });
    }

    private async getStoredCloudCredentials(): Promise<Record<string, CloudCredential>> {
        try {
            const rawKeys = await this.secretStorage.get('llm_api_keys');
            return normalizeCloudCredentials(rawKeys ? JSON.parse(rawKeys) : {});
        } catch (error) {
            console.error(localize("無法解析 llm_api_keys："), error);
            return {};
        }
    }

    private async getStoredCustomKeys(): Promise<Record<string, any>> {
        try {
            const rawCustomKeys = await this.secretStorage.get('llm_custom_keys');
            return rawCustomKeys ? JSON.parse(rawCustomKeys) : {};
        } catch (error) {
            console.error(localize("無法解析 llm_custom_keys："), error);
            return {};
        }
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        initI18n();
        this.view = webviewView;
        this.view.title = t('ui.modelSettings');
        this.webview = webviewView.webview;
        this.webview.options = { enableScripts: true };

        const config = vscode.workspace.getConfiguration('llmUnitTest');
        const lang = config.get<string>('language', 'auto');
        const strategy = config.get<string>('promptStrategy', 'auto');
        const ollamaUrl = config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434');
        this.webview.html = getWebviewContent(t, lang, strategy, ollamaUrl, config.get('validationMode', 'full'),
            config.get('mutationEngine', 'builtin'), config.get('mutationWorkers', 2));

        this.webview.onDidReceiveMessage(async (message) => {
            const config = vscode.workspace.getConfiguration('llmUnitTest');

            switch (message.command) {
                case 'getInitialData': {
                    const keys = await this.getStoredCloudCredentials();
                    this.webview?.postMessage({ command: 'setApiKeys', keys: toCloudCredentialOptions(keys) });

                    const customKeys = await this.getStoredCustomKeys();
                    this.webview?.postMessage({ command: 'setCustomKeys', keys: customKeys });

                    const savedProjPath = this.lastFolder('project', config.get<string>('projectPath', ''));
                    const savedPath = this.lastFolder('output', config.get<string>('outputPath', ''));
                    const savedBatchPath = this.lastFolder('batch');
                    this.webview?.postMessage({ command: 'pythonEnvironmentSelection',
                        python: configuredPythonForResource(savedProjPath, savedProjPath) });

                    // Retain the legacy message for older views. The current
                    // unified all selection always uses savedProjPath.
                    if (savedBatchPath) {
                        this.webview?.postMessage({ command: 'setBatchPath', path: savedBatchPath });
                    }
                    if (savedProjPath) {
                        this.webview?.postMessage({ command: 'setProjectPath', path: savedProjPath });
                    }
                    if (savedPath) {
                        this.webview?.postMessage({ command: 'setOutputPath', path: savedPath });
                    }
                    const files = await this.findPythonFiles(savedProjPath);
                    this.webview?.postMessage({ command: 'setFiles', projectPath: savedProjPath, files });

                    // Background fetch for local models
                    this.fetchLocalModels().then(models => {
                        this.webview?.postMessage({ command: 'setModels', models });
                    });
                    break;
                }

                case 'setLanguage': {
                    if (!['auto', 'en', 'zh-tw'].includes(message.lang)) { break; }
                    const setting = config.inspect?.('language');
                    await config.update('language', message.lang, setting?.workspaceValue !== undefined
                        ? vscode.ConfigurationTarget.Workspace : true);
                    this.refreshLanguage();
                    break;
                }
                
                case 'setPromptStrategy': {
                    await config.update('promptStrategy', message.strategy, true);
                    if (this.webview) {
                        const lang = config.get<string>('language', 'auto');
                        const ollamaUrl = config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434');
                        this.webview.html = getWebviewContent(t, lang, message.strategy, ollamaUrl, config.get('validationMode', 'full'),
                            config.get('mutationEngine', 'builtin'), config.get('mutationWorkers', 2));
                    }
                    break;
                }

                case 'setValidationMode': {
                    if (!this.activeAnalysis && (message.mode === 'execution' || message.mode === 'full')) {
                        await this.rememberRunPreference(config, 'validationMode', message.mode);
                    }
                    break;
                }

                case 'setMutationEngine': {
                    if (!this.activeAnalysis && ['builtin', 'mutatest', 'mutmut'].includes(message.engine)) {
                        await this.rememberRunPreference(config, 'mutationEngine', message.engine);
                    }
                    break;
                }

                case 'setMutationWorkers': {
                    if (!this.activeAnalysis && Number.isInteger(message.workers) && message.workers >= 1 && message.workers <= 4) {
                        await this.rememberRunPreference(config, 'mutationWorkers', message.workers);
                    }
                    break;
                }

                case 'saveOllamaUrl': {
                    await config.update('ollamaBaseUrl', message.url, true);
                    void this.webview?.postMessage({ command: 'ollamaUrlSaved' });
                    vscode.window.showInformationMessage(localize("✅ 已儲存 Ollama URL：{0}", message.url));
                    this.fetchLocalModels().then(models => {
                        this.webview?.postMessage({ command: 'setModels', models });
                    });
                    break;
                }


                case 'browseProjectFolder': {
                    const existingProject = this.lastFolder('project', config.get<string>('projectPath', ''));
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: localize("選擇專案資料夾"),
                        defaultUri: existingProject ? vscode.Uri.file(existingProject) : undefined
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const projectPath = fileUri[0].fsPath;
                        const revision = ++this.projectRevision;
                        this.batchScope.invalidate();
                        await this.rememberFolder('project', projectPath);
                        try {
                            await config.update('projectPath', projectPath, true);
                        } catch (e) {
                            console.error(localize("更新 projectPath 設定失敗"), e);
                        }
                        this.webview?.postMessage({ command: 'setProjectPath', path: projectPath });
                        
                        // 顯示載入中
                        vscode.window.showInformationMessage(localize("正在掃描資料夾中的 Python 檔案，請稍候..."));

                        // 重新掃描並更新檔案列表
                        const files = await this.findPythonFiles(projectPath);
                        if (revision !== this.projectRevision) { break; }
                        this.webview?.postMessage({ command: 'setFiles', projectPath, files });
                        
                        if (files.length === 0) {
                            vscode.window.showWarningMessage(localize("在選擇的資料夾中沒有找到任何 .py 檔案。"));
                        } else {
                            vscode.window.showInformationMessage(localize("✅ 成功載入 {0} 個 Python 檔案", files.length));
                        }
                    }
                    break;
                }

                case 'browseFolder': {
                    const existingOutput = this.lastFolder('output', config.get<string>('outputPath', ''));
                    const existingProject2 = this.lastFolder('project', config.get<string>('projectPath', ''));
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: localize("選擇輸出資料夾"),
                        defaultUri: existingOutput
                            ? vscode.Uri.file(existingOutput)
                            : existingProject2 ? vscode.Uri.file(existingProject2) : undefined
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const outputPath = fileUri[0].fsPath;
                        await this.rememberFolder('output', outputPath);
                        try {
                            await config.update('outputPath', outputPath, true);
                        } catch (e) {
                            console.error(localize("更新 outputPath 設定失敗"), e);
                        }
                        this.webview?.postMessage({ command: 'setOutputPath', path: outputPath });
                    }
                    break;
                }

                case 'browseBatchFolder': {
                    const existingProject3 = this.lastFolder('project', config.get<string>('projectPath', ''));
                    const existingBatch = this.lastFolder('batch', existingProject3);
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: localize("選擇批次測試資料夾"),
                        defaultUri: existingBatch ? vscode.Uri.file(existingBatch) : undefined
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const batchPath = fileUri[0].fsPath;
                        this.projectRevision++;
                        this.batchScope.invalidate();
                        await this.rememberFolder('batch', batchPath);
                        this.webview?.postMessage({ command: 'setBatchPath', path: batchPath });
                    }
                    break;
                }

                case 'getFunctions': {
                    this.webview?.postMessage({ command: 'pythonEnvironmentSelection',
                        python: configuredPythonForResource(message.filePath, this.lastFolder('project')) });
                    const funcs = await this.findPythonFunctions(message.filePath);
                    this.webview?.postMessage({ command: 'setFunctions', filePath: message.filePath, funcs });
                    break;
                }

                case 'prepareImportSetup': {
                    await vscode.commands.executeCommand('llm-unit-test.prepareImportSetup', {
                        projectRoot: typeof message.projectRoot === 'string' ? message.projectRoot : undefined,
                        outputPath: typeof message.outputPath === 'string' ? message.outputPath : undefined
                    });
                    break;
                }
                case 'configureTestResources': {
                    if (this.activeAnalysis) { break; }
                    await vscode.commands.executeCommand('llm-unit-test.configureTestResources', {
                        projectRoot: typeof message.projectRoot === 'string' ? message.projectRoot : undefined,
                        outputPath: typeof message.outputPath === 'string' ? message.outputPath : undefined
                    });
                    break;
                }
                case 'previewBatchScope': {
                    if (this.activeAnalysis) { break; }
                    const root = typeof message.projectRoot === 'string' ? message.projectRoot : this.lastFolder('project');
                    if (!root || !fs.existsSync(root)) { await vscode.window.showWarningMessage(t('ui.selectProject')); break; }
                    const revision = this.projectRevision;
                    const output = typeof message.outputPath === 'string' ? message.outputPath : config.get<string>('outputPath', '');
                    try {
                        const excluded = output && path.resolve(output) !== path.resolve(root) ? [output] : [];
                        const files = await findPythonFilesInDir(root, true, excluded, true);
                        if (revision !== this.projectRevision) { break; }
                        const selection = await this.previewBatchScope(root, files);
                        if (selection && revision === this.projectRevision) {
                            this.webview?.postMessage({ command: 'batchScopeSelected', projectRoot: root,
                                text: t('ui.batchScopeSelected', selection.selectedFiles.length, selection.knownFiles.length) });
                        }
                    } catch {
                        if (revision === this.projectRevision) { await vscode.window.showWarningMessage(t('ui.batchScopeScanFailed')); }
                    }
                    break;
                }
                case 'prepareProjectEnvironment':
                case 'preparePythonEnvironment': {
                    const projectRoot = typeof message.projectRoot === 'string' ? message.projectRoot : undefined;
                    await vscode.commands.executeCommand('llm-unit-test.preparePythonEnvironment', {
                        filePath: message.command === 'prepareProjectEnvironment' ? projectRoot
                            : typeof message.filePath === 'string' ? message.filePath : undefined,
                        projectRoot
                    });
                    break;
                }

                case 'openTestResult': {
                    const reportPath = typeof message.reportPath === 'string' ? message.reportPath : '';
                    if (!reportPath || !['final_report.md', 'workflow_report.md', 'failure_report.md'].includes(path.basename(reportPath)) || !fs.existsSync(reportPath)) {
                        vscode.window.showWarningMessage(localize("找不到此函式的測試結果報告。請先等待本次測試完成。"));
                        break;
                    }
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(reportPath));
                    await vscode.window.showTextDocument(document, { preview: true });
                    break;
                }

                case 'updateApiKey': {
                    const currentKeys = await this.getStoredCloudCredentials();
                    if (message.oldName && message.oldName !== message.newName) {
                        delete currentKeys[message.oldName];
                    }
                    currentKeys[message.newName] = { model: message.model, key: message.key };
                    await this.secretStorage.store('llm_api_keys', JSON.stringify(currentKeys));
                    this.webview?.postMessage({ command: 'setApiKeys', keys: toCloudCredentialOptions(currentKeys) });
                    this.webview?.postMessage({ command: 'apiKeySaved', keyName: message.newName });
                    vscode.window.showInformationMessage(localize("🔒 已安全儲存 API Key 至系統金鑰庫：{0}", message.newName));
                    break;
                }

                case 'deleteApiKey': {
                    const currentKeys = await this.getStoredCloudCredentials();
                    if (currentKeys[message.name]) {
                        delete currentKeys[message.name];
                        await this.secretStorage.store('llm_api_keys', JSON.stringify(currentKeys));
                        this.webview?.postMessage({ command: 'setApiKeys', keys: toCloudCredentialOptions(currentKeys) });
                        vscode.window.showInformationMessage(localize("🗑️ 已自安全金鑰庫移除：{0}", message.name));
                    }
                    break;
                }

                case 'updateCustomKey': {
                    const currentKeys = await this.getStoredCustomKeys();
                    if (message.oldName && message.oldName !== message.newName) {
                        delete currentKeys[message.oldName];
                    }
                    currentKeys[message.newName] = { url: message.url, model: message.model, key: message.key };
                    await this.secretStorage.store('llm_custom_keys', JSON.stringify(currentKeys));
                    this.webview?.postMessage({ command: 'setCustomKeys', keys: currentKeys });
                    vscode.window.showInformationMessage(localize("🔒 已安全儲存自訂 API：{0}", message.newName));
                    break;
                }

                case 'deleteCustomKey': {
                    const currentKeys = await this.getStoredCustomKeys();
                    if (currentKeys[message.name]) {
                        delete currentKeys[message.name];
                        await this.secretStorage.store('llm_custom_keys', JSON.stringify(currentKeys));
                        this.webview?.postMessage({ command: 'setCustomKeys', keys: currentKeys });
                        vscode.window.showInformationMessage(localize("🗑️ 已自安全金鑰庫移除自訂 API：{0}", message.name));
                    }
                    break;
                }

                case 'startAnalysis': {
                    const params = { ...message };
                    if (params.envType === 'cloud') {
                        const keys = await this.getStoredCloudCredentials();
                        const credential = keys[params.cloudKeyName];
                        if (!credential) {
                            vscode.window.showErrorMessage(localize("找不到此模型的 Google AI Studio API Key。"));
                            this.webview?.postMessage({ command: 'analysisFinished' });
                            break;
                        }
                        params.modelName = credential.model;
                        params.cloudKey = credential.key;
                    }
                    vscode.commands.executeCommand('llm-unit-test.runCaptureAndTest', params);
                    break;
                }

                case 'startBatchAnalysis': {
                    const params = { ...message };
                    if (params.envType === 'cloud') {
                        const keys = await this.getStoredCloudCredentials();
                        const credential = keys[params.cloudKeyName];
                        if (!credential) {
                            vscode.window.showErrorMessage(localize("找不到此模型的 Google AI Studio API Key。"));
                            this.webview?.postMessage({ command: 'analysisFinished' });
                            break;
                        }
                        params.modelName = credential.model;
                        params.cloudKey = credential.key;
                    }
                    vscode.commands.executeCommand('llm-unit-test.runBatchAnalysis', params);
                    break;
                }

                case 'getModelRuntimeContext': {
                    if (this.activeAnalysis || typeof message.modelName !== 'string' || !message.modelName.trim()) { break; }
                    if (typeof message.ollamaUrl === 'string' && qualificationEndpointKey('local', message.ollamaUrl)
                        !== qualificationEndpointKey('local', config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434'))) { break; }
                    const configured = config.get<unknown>('runtimeContextTokens', 0);
                    const selection = await this.readLocalRuntimeContext(message.modelName, configured);
                    this.publishLocalRuntimeContext(selection, configured, message.revision);
                    break;
                }
                case 'setModelRuntimeContextTokens': {
                    if (this.activeAnalysis || typeof message.modelName !== 'string' || !message.modelName.trim()
                        || typeof message.tokens !== 'number' || !Number.isSafeInteger(message.tokens) || message.tokens < 0) { break; }
                    if (typeof message.ollamaUrl === 'string' && qualificationEndpointKey('local', message.ollamaUrl)
                        !== qualificationEndpointKey('local', config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434'))) { break; }
                    const configured = config.get<unknown>('runtimeContextTokens', 0);
                    const selection = await this.readLocalRuntimeContext(message.modelName, configured, false);
                    const newRuntime = resolveLocalRuntimeContext({ ...selection.metadata, ...selection.allocation,
                        runtimeContextTokens: 0, preferredRuntimeContextTokens: message.tokens,
                        preferredRuntimeContextSource: 'user-choice' });
                    if (!newRuntime.ok) {
                        vscode.window.showWarningMessage(t('ui.runtimeContextInvalid'));
                        this.publishLocalRuntimeContext(selection, configured, message.revision);
                        break;
                    }
                    // Never overwrite an explicit setting during discovery. A direct
                    // save action may edit that same setting at its existing scope.
                    const current = vscode.workspace.getConfiguration('llmUnitTest');
                    if (current.get<unknown>('runtimeContextTokens', 0) !== configured
                        || qualificationEndpointKey('local', current.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434')) !== selection.identity.endpointKey
                        || this.activeAnalysis) { break; }
                    if (typeof configured === 'number' && configured > 0) {
                        await this.rememberRunPreference(current, 'runtimeContextTokens', message.tokens);
                    }
                    await this.saveRuntimeContextPreference(selection.identity, message.tokens, 'user-choice');
                    const updated = await this.readLocalRuntimeContext(message.modelName,
                        current.get<unknown>('runtimeContextTokens', 0), true, undefined, message.tokens === 0);
                    this.publishLocalRuntimeContext(updated, current.get<unknown>('runtimeContextTokens', 0), message.revision);
                    void this.webview?.postMessage({ command: 'appendLog', text: t('ui.runtimeContextSaved') });
                    break;
                }
                case 'testConnection': {
                    // One connection action owns one immutable runtime setting,
                    // including when the user edits configuration during a probe.
                    const requestedRuntimeContext = message.envType === 'local'
                        ? config.get<unknown>('runtimeContextTokens', 0) : undefined;
                    const releasePython = pythonEnvironmentActivity.acquire('use');
                    if (!releasePython) {
                        vscode.window.showInformationMessage(localize("Python 環境準備中，請等待完成後再測試模型連線。"));
                        break;
                    }
                    try { await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: localize("正在測試 API 連線..."),
                        cancellable: false
                    }, async () => {
                        try {
                            const timedFetch = (url: string, init: RequestInit, timeoutMs: number) =>
                                fetchWithTimeout<Response>(
                                    (input, options) => fetch(input, options),
                                    url,
                                    init,
                                    timeoutMs
                                );
                            const projectRoot = message.projectRoot || this.lastFolder('project');
                            const pythonExecutable = configuredPythonForResource(message.filePath || projectRoot, projectRoot);
                            const isolatedProbeExecutor = (code: string) => runIsolatedProbe(
                                code, MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS, pythonExecutable
                            );

                            if (message.envType === 'local') {
                                const config = vscode.workspace.getConfiguration('llmUnitTest');
                                const baseUrl = config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434');
                                const response = await timedFetch(
                                    `${baseUrl}/api/tags`,
                                    {},
                                    CONNECTION_DISCOVERY_TIMEOUT_MS
                                );
                                if (!response.ok) {throw new Error(`HTTP ${response.status}`);}

                                if (message.modelName) {
                                    const selection = await this.readLocalRuntimeContext(message.modelName, requestedRuntimeContext, true, baseUrl);
                                    const { metadata, runtime } = selection;
                                    // A probe may change allocation; its pre-request ps observation
                                    // remains a recent fact, rather than a claim about post-request state.
                                    this.publishLocalRuntimeContext(selection, requestedRuntimeContext, message.contextRevision, false);
                                    const profile = {
                                        paramSize: metadata.paramSize, contextLength: metadata.contextLength,
                                        contextLengthKnown: metadata.contextLengthKnown,
                                        ...selection.profileRuntime,
                                        envType: 'local' as const,
                                        endpointKey: selection.identity.endpointKey,
                                        modelName: message.modelName
                                    };
                                    if (!runtime.ok) {
                                        const reason = runtime.reasonCode === 'invalid-runtime-context'
                                            ? localize("Context 必須為 0（自動）或正整數。")
                                            : runtime.reasonCode === 'runtime-context-metadata-required'
                                                ? localize("無法確認模型的 Context 上限，不能使用明確指定的 Context。")
                                                : localize("指定的 Context 超過模型回報的上限。");
                                        const blocked = { ...profile, qualificationVersion: QUALIFICATION_VERSION,
                                            testGenerationReady: false, testGenerationReason: reason,
                                            roleQualification: buildRoleQualificationProfile({ state: 'unverified', reason }) };
                                        this.webview?.postMessage({ command: 'modelProbeResult', profile: blocked });
                                        vscode.commands.executeCommand('llm-unit-test.updateModelProfile', blocked);
                                        this.appendRoleQualificationLog(blocked);
                                        vscode.window.showWarningMessage(localize("⚠️ Local Ollama 服務可連線，但本機 Context 設定不可用（{0}）。未執行角色探針，請修正設定後重新測試連線。", reason));
                                        return;
                                    }
                                    const qualificationRuntime = { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: runtime.contextWindow } as const;
                                    if (!metadata.contextLengthKnown) {
                                        this.webview?.postMessage({ command: 'appendLog', text: localize("模型未提供可驗證的 Context 上限，本次角色探針使用已選容量 {0} tokens；資格僅綁定此值。", runtime.contextWindow.toLocaleString()) });
                                    }
                                    this.webview?.postMessage({ command: 'modelProbeResult', profile });
                                    vscode.commands.executeCommand('llm-unit-test.updateModelProfile', profile);
                                    try {
                                        const plainResponse = await requestOllamaQualification(baseUrl,
                                            buildOllamaPlainTestGenerationProbe(message.modelName, runtime.contextWindow));
                                        const capability = await verifyRunnableTestGenerationProbe(
                                            plainResponse, isolatedProbeExecutor
                                        );
                                        const roleQualification = await runRoleQualificationProbes(
                                            { state: capability.capability, reason: capability.reason },
                                            async (prompt, format) => {
                                                const roleResponse = await requestOllamaQualification(baseUrl,
                                                    buildOllamaRoleQualificationProbe(message.modelName, prompt, format, runtime.contextWindow));
                                                return typeof roleResponse?.response === 'string' ? roleResponse.response : undefined;
                                            }, isolatedProbeExecutor
                                        );
                                        const qualificationProfile = { ...profile, qualificationRuntime,
                                            testGenerationReady: capability.capability === 'verified',
                                            testGenerationReason: capability.reason, qualificationVersion: QUALIFICATION_VERSION,
                                            testGenerationMode: 'plain-python', roleQualification };
                                        this.webview?.postMessage({ command: 'modelProbeResult', profile: qualificationProfile });
                                        vscode.commands.executeCommand('llm-unit-test.updateModelProfile', qualificationProfile);
                                        this.appendModelQualificationLog(qualificationProfile);
                                        this.appendRoleQualificationLog(qualificationProfile);
                                        const latestConfig = vscode.workspace.getConfiguration('llmUnitTest');
                                        const latestPreference = getRuntimeContextPreference(this.runtimeContextPreferencesSnapshot(), selection.identity);
                                        if (latestConfig.get<unknown>('runtimeContextTokens', 0) !== requestedRuntimeContext
                                            || qualificationEndpointKey('local', latestConfig.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434')) !== selection.identity.endpointKey
                                            || JSON.stringify(latestPreference) !== JSON.stringify(selection.preference)) {
                                            vscode.window.showWarningMessage(localize("本次角色探針使用 Runtime Context {0} tokens；設定已變更，請重新測試連線以驗證目前設定。", runtime.contextWindow.toLocaleString()));
                                        } else if (capability.capability === 'verified') {
                                            vscode.window.showInformationMessage(localize("✅ Local Ollama 連線成功！模型：{0}，本次 Runtime Context：{1} tokens；已通過純 Python unittest 驗證。", metadata.paramSize, runtime.contextWindow.toLocaleString()));
                                        } else {
                                            vscode.window.showWarningMessage(localize("⚠️ Local Ollama 連線成功，但未通過 unittest 生成驗證（{0}）；本次 Runtime Context：{1} tokens。", capability.reason, runtime.contextWindow.toLocaleString()));
                                        }
                                    } catch {
                                        const reason = localize("測試連線逾時或無法完成 unittest 生成探針。");
                                        const qualificationProfile = { ...profile, qualificationRuntime,
                                            qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: false,
                                            testGenerationReason: reason, testGenerationMode: localize("未完成"),
                                            roleQualification: buildRoleQualificationProfile({ state: 'unverified', reason }) };
                                        this.webview?.postMessage({ command: 'modelProbeResult', profile: qualificationProfile });
                                        vscode.commands.executeCommand('llm-unit-test.updateModelProfile', qualificationProfile);
                                        this.appendModelQualificationLog(qualificationProfile);
                                        this.appendRoleQualificationLog(qualificationProfile);
                                        vscode.window.showWarningMessage(localize("⚠️ Local Ollama 服務可連線，但本次角色探針未完成；Runtime Context：{0} tokens。請重新測試連線。", runtime.contextWindow.toLocaleString()));
                                    }
                                } else {
                                    vscode.window.showInformationMessage(localize("✅ Local Ollama 連線成功！"));
                                }
                            } else if (message.envType === 'cloud') {
                                const keys = await this.getStoredCloudCredentials();
                                const credential = keys[message.cloudKeyName];
                                if (!credential) {
                                    throw new Error(localize("找不到對應的 API Key"));
                                }

                                const listedModels: unknown[] = [];
                                let nextPageToken: string | undefined;
                                for (let page = 0; page < 10; page++) {
                                    const listRequest = buildGoogleListModelsRequest(credential.key, nextPageToken);
                                    const listResponse = await timedFetch(listRequest.url, {
                                        headers: listRequest.headers
                                    }, CONNECTION_DISCOVERY_TIMEOUT_MS);
                                    if (!listResponse.ok) {
                                        throw new Error(localize("無法讀取 Google 可用模型清單（HTTP {0}）", listResponse.status));
                                    }
                                    const modelList = await listResponse.json() as { models?: unknown[]; nextPageToken?: string };
                                    listedModels.push(...(modelList.models || []));
                                    nextPageToken = modelList.nextPageToken;
                                    if (!nextPageToken) { break; }
                                }
                                const usableModels = getGenerateContentModelNames(listedModels as any[]);
                                const selectedModel = normalizeGoogleModelName(credential.model);
                                if (!usableModels.includes(selectedModel)) {
                                    const suggestions = usableModels.slice(0, 12).join(', ') || localize("無");
                                    throw new Error(localize("模型「{0}」不存在、目前 API Key 無權使用，或不支援 generateContent。請改用可用模型：{1}", selectedModel, suggestions));
                                }
                                const connectionMetadata = getGoogleModelConnectionMetadata(listedModels as any[], credential.model);
                                
                                const cloudProbe = async (prompt: string, format: 'text' | 'review-json' = 'text') => {
                                    const controller = new AbortController();
                                    const timer = setTimeout(() => controller.abort(), MODEL_QUALIFICATION_TIMEOUT_MS);
                                    try {
                                        const request = buildGoogleGenerateContentRequest(credential.model, credential.key, prompt, {
                                            temperature: 0,
                                            thinkingMode: vscode.workspace.getConfiguration('llmUnitTest').get('cloudThinkingMode', 'minimal') === 'minimal'
                                                ? 'minimal' : 'provider-default',
                                            ...(format === 'review-json' ? { responseMimeType: 'application/json' as const,
                                                responseSchema: responseSchemaForOutputFormat(format) } : {})
                                        });
                                        const response = await googleThinkingSession.send(request, next => retryTransientProviderRequest(
                                            () => fetch(next.url, { method: 'POST', headers: next.headers,
                                                body: JSON.stringify(next.body), signal: controller.signal }),
                                            { maxAttempts: 2, isCancelled: () => controller.signal.aborted }
                                        ));
                                        if (!response.ok) { await response.body?.cancel(); return undefined; }
                                        return getGoogleGeneratedText(await response.json());
                                    } finally { clearTimeout(timer); }
                                };
                                const capability = await verifyRunnableTestGenerationProbe(
                                    { response: await cloudProbe(PLAIN_TEST_GENERATION_PROBE_PROMPT) },
                                    isolatedProbeExecutor
                                );
                                const roleQualification = await runRoleQualificationProbes(
                                    { state: capability.capability, reason: capability.reason },
                                    (prompt, format) => cloudProbe(prompt, format), isolatedProbeExecutor
                                );
                                const profile = {
                                    paramSize: connectionMetadata.paramSize,
                                    contextLength: connectionMetadata.contextLength,
                                    envType: 'cloud' as const,
                                    endpointKey: qualificationEndpointKey('cloud'),
                                    modelName: credential.model,
                                    testGenerationReady: capability.capability === 'verified',
                                    testGenerationReason: capability.reason,
                                    qualificationVersion: QUALIFICATION_VERSION,
                                    testGenerationMode: 'plain-python',
                                    roleQualification
                                };
                                this.webview?.postMessage({ command: 'modelProbeResult', profile });
                                vscode.commands.executeCommand('llm-unit-test.updateModelProfile', profile);
                                this.appendModelQualificationLog(profile, capability.responsePreview);
                                this.appendRoleQualificationLog(profile);
                                if (capability.capability === 'verified') {
                                    const contextMessage = connectionMetadata.contextLengthKnown
                                        ? localize("最大輸入 Context：{0} tokens", connectionMetadata.contextLength.toLocaleString())
                                        : localize("最大輸入 Context：API 未公開（採保守 4,096-token 預算）");
                                    vscode.window.showInformationMessage(
                                        localize("✅ Cloud AI Studio 連線成功！模型：{0}；{1}；已通過純 Python unittest 驗證。", connectionMetadata.paramSize, contextMessage)
                                    );
                                } else {
                                    vscode.window.showWarningMessage(
                                        localize("⚠️ Cloud Gemini 連線成功，但未通過 unittest 生成驗證（{0}）。Tier 1 的確定性測試仍可使用。", capability.reason)
                                    );
                                }
                            } else if (message.envType === 'custom') {
                                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                                if (message.customKey) {headers['Authorization'] = `Bearer ${message.customKey}`;}
                                
                                const response = await timedFetch(message.customUrl, {
                                    method: 'POST',
                                    headers: headers,
                                    body: JSON.stringify(buildCustomChatCompletionBody(
                                        message.modelName,
                                        'Return only runnable Python unittest code.',
                                        PLAIN_TEST_GENERATION_PROBE_PROMPT,
                                        'text'
                                    ))
                                }, MODEL_QUALIFICATION_TIMEOUT_MS);
                                const capability = await verifyRunnableTestGenerationProbe(
                                    response.ok ? { response: getCustomChatCompletionText(await response.json()) } : undefined,
                                    isolatedProbeExecutor
                                );
                                const roleQualification = await runRoleQualificationProbes(
                                    { state: capability.capability, reason: capability.reason },
                                    async (prompt, format) => {
                                        const roleResponse = await timedFetch(message.customUrl, {
                                            method: 'POST', headers,
                                            body: JSON.stringify(buildCustomChatCompletionBody(
                                                message.modelName, 'Return only the requested role artifact.', prompt, format
                                            ))
                                        }, MODEL_QUALIFICATION_TIMEOUT_MS);
                                        return roleResponse.ok ? getCustomChatCompletionText(await roleResponse.json()) : undefined;
                                    }, isolatedProbeExecutor
                                );
                                const profile = {
                                    paramSize: 'Custom API',
                                    contextLength: 8192,
                                    envType: 'custom',
                                    endpointKey: qualificationEndpointKey('custom', message.customUrl),
                                    modelName: message.modelName,
                                    testGenerationReady: capability.capability === 'verified',
                                    testGenerationReason: capability.reason,
                                    qualificationVersion: QUALIFICATION_VERSION,
                                    testGenerationMode: 'plain-python',
                                    roleQualification
                                } as const;
                                this.webview?.postMessage({ command: 'modelProbeResult', profile });
                                vscode.commands.executeCommand('llm-unit-test.updateModelProfile', profile);
                                this.appendModelQualificationLog(profile, capability.responsePreview);
                                this.appendRoleQualificationLog(profile);
                                if (capability.capability === 'verified') {
                                    vscode.window.showInformationMessage(
                                        localize("✅ Custom API 連線成功！已通過純 Python unittest 驗證。")
                                    );
                                } else {
                                    vscode.window.showWarningMessage(
                                        localize("⚠️ Custom API 連線成功，但未通過 unittest 生成驗證（{0}）。Tier 1 的確定性測試仍可使用。", capability.reason)
                                    );
                                }
                            }
                        } catch (error: any) {
                            vscode.window.showErrorMessage(localize("❌ 連線失敗: {0}", error.message));
                            this.webview?.postMessage({ command: 'appendLog', text: localize("[錯誤] 連線測試失敗: {0}", error.message) });
                        }
                    }); } finally { releasePython(); }
                    break;
                }

                case 'abortTest': {
                    vscode.commands.executeCommand('llm-unit-test.abortTest');
                    this.webview?.postMessage({ command: 'analysisFinished' });
                    break;
                }

            }
        });
    }

    // --- 輔助函式：掃描檔案與函式 ---

    private async findPythonFiles(dirPath?: string): Promise<{ name: string; path: string }[]> {
        let rootPath = dirPath;
        if (!rootPath) {
            rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        }
        if (!rootPath || !fs.existsSync(rootPath)) {
            return [];
        }

        const files: { name: string; path: string }[] = [];
        const ignoredDirs = new Set(['node_modules', 'venv', 'env', '.env', '.venv', '.git', '__pycache__', '.pytest_cache']);
        const dirQueue: string[] = [rootPath];
        let activeCount = 0;
        const MAX_CONCURRENCY = 8;

        try {
            await new Promise<void>((resolve) => {
                const checkNext = () => {
                    if (dirQueue.length === 0 && activeCount === 0) {
                        resolve();
                        return;
                    }
                    while (activeCount < MAX_CONCURRENCY && dirQueue.length > 0) {
                        const currentDir = dirQueue.shift()!;
                        activeCount++;
                        fs.promises.readdir(currentDir, { withFileTypes: true })
                            .then((entries) => {
                                for (const dirent of entries) {
                                    const file = dirent.name;
                                    if (file.startsWith('.') && file !== '.py' && file.length > 1) { continue; }
                                    if (ignoredDirs.has(file)) { continue; }
                                    const fullPath = path.join(currentDir, file);
                                    if (dirent.isDirectory()) {
                                        dirQueue.push(fullPath);
                                    } else if (file.endsWith('.py')) {
                                        files.push({ name: path.relative(rootPath, fullPath), path: fullPath });
                                    }
                                }
                            })
                            .catch((readError) => {
                                console.warn(localize("[SidebarProvider] 無法讀取目錄 {0}:", currentDir), readError);
                            })
                            .finally(() => {
                                activeCount--;
                                checkNext();
                            });
                    }
                };
                checkNext();
            });
        } catch (e) {
            console.error(localize("掃描專案檔案失敗"), e);
        }
        return files.sort((left, right) => left.name.localeCompare(right.name));
    }

    private async findPythonFunctions(filePath: string): Promise<string[]> {
        const releasePython = pythonEnvironmentActivity.acquire('use');
        if (!releasePython) { return []; }
        try {
            const infos = await extractFunctionsWithAst(filePath, configuredPythonForResource(filePath, this.lastFolder('project')));
            return infos.map(f => f.fullName);
        } finally { releasePython(); }
    }

    private async fetchLocalModels(): Promise<string[]> {
        try {
            const config = vscode.workspace.getConfiguration('llmUnitTest');
            const baseUrl = config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434');
            const response = await fetchWithTimeout<Response>(
                (input, options) => fetch(input, options),
                `${baseUrl}/api/tags`,
                {},
                CONNECTION_DISCOVERY_TIMEOUT_MS
            );
            if (response.ok) {
                const data = await response.json() as any;
                if (data && data.models) {
                    return data.models.map((m: any) => m.name);
                }
            }
        } catch (e) {
            console.warn('[SidebarProvider] Ollama not running or unreachable:', e);
        }
        return [];
    }
}
