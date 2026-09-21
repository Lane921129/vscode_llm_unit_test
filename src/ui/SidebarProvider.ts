import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewContent } from './webviewContent';
import { initI18n, t } from '../i18n';
import { extractFunctionsWithAst } from '../utils/utils';
import { buildGoogleGenerateContentRequest, buildGoogleListModelsRequest, getGenerateContentModelNames, getGoogleGeneratedText, getGoogleModelConnectionMetadata, googleThinkingSession, normalizeGoogleModelName } from '../llm/cloudApi';
import { CloudCredential, normalizeCloudCredentials, toCloudCredentialOptions } from '../llm/cloudCredentials';
import { formatModelQualificationLog, ModelQualificationProfile, QUALIFICATION_VERSION, qualificationEndpointKey } from '../llm/modelQualification';
import { buildOllamaPlainTestGenerationProbe } from '../llm/ollamaCapability';
import { PLAIN_TEST_GENERATION_PROBE_PROMPT } from '../llm/testGenerationQualification';
import { runIsolatedProbe, verifyRunnableTestGenerationProbe } from '../llm/modelProbeExecution';
import { buildRoleQualificationProfile, formatRoleQualificationLog, runRoleQualificationProbes } from '../llm/roleQualification';
import { buildCustomChatCompletionBody, getCustomChatCompletionText } from '../llm/customApi';
import { CONNECTION_DISCOVERY_TIMEOUT_MS, fetchWithServerRetry, fetchWithTimeout, MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS, MODEL_QUALIFICATION_TIMEOUT_MS, retryTransientProviderRequest } from '../llm/connectionTimeout';
import { configuredPythonForResource } from '../environment/pythonEnvironmentController';
import { pythonEnvironmentActivity } from '../environment/pythonEnvironmentSetup';

export class MutationViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mutation-test-view';
    public webview?: vscode.Webview;

    constructor(private readonly secretStorage: vscode.SecretStorage, private readonly uiState: vscode.Memento) {}

    /** Keep each picker independent; local UI history must not become project configuration. */
    private lastFolder(kind: 'project' | 'output' | 'batch', fallback = ''): string {
        const saved = this.uiState.get<unknown>(`llmUnitTest.lastFolders.v1.${kind}`);
        return typeof saved === 'string' && saved.trim() ? saved : fallback;
    }

    private async rememberFolder(kind: 'project' | 'output' | 'batch', folder: string): Promise<void> {
        await this.uiState.update(`llmUnitTest.lastFolders.v1.${kind}`, folder);
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
            console.error('無法解析 llm_api_keys：', error);
            return {};
        }
    }

    private async getStoredCustomKeys(): Promise<Record<string, any>> {
        try {
            const rawCustomKeys = await this.secretStorage.get('llm_custom_keys');
            return rawCustomKeys ? JSON.parse(rawCustomKeys) : {};
        } catch (error) {
            console.error('無法解析 llm_custom_keys：', error);
            return {};
        }
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        initI18n();
        this.webview = webviewView.webview;
        this.webview.options = { enableScripts: true };

        const config = vscode.workspace.getConfiguration('llmUnitTest');
        const lang = config.get<string>('language', 'auto');
        const strategy = config.get<string>('promptStrategy', 'auto');
        const ollamaUrl = config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434');
        this.webview.html = getWebviewContent(t, lang, strategy, ollamaUrl);

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

                    // Restore the explicit batch choice before the Webview's
                    // project-path fallback can fill the batch field.
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
                    this.webview?.postMessage({ command: 'setFiles', files });

                    // Background fetch for local models
                    this.fetchLocalModels().then(models => {
                        this.webview?.postMessage({ command: 'setModels', models });
                    });
                    break;
                }

                case 'setLanguage': {
                    await config.update('language', message.lang, true);
                    initI18n();
                    if (this.webview) {
                        const strategy = config.get<string>('promptStrategy', 'auto');
                        const ollamaUrl = config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434');
                        this.webview.html = getWebviewContent(t, message.lang, strategy, ollamaUrl);
                    }
                    break;
                }
                
                case 'setPromptStrategy': {
                    await config.update('promptStrategy', message.strategy, true);
                    if (this.webview) {
                        const lang = config.get<string>('language', 'auto');
                        const ollamaUrl = config.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434');
                        this.webview.html = getWebviewContent(t, lang, message.strategy, ollamaUrl);
                    }
                    break;
                }

                case 'saveOllamaUrl': {
                    await config.update('ollamaBaseUrl', message.url, true);
                    vscode.window.showInformationMessage(`✅ 已儲存 Ollama URL：${message.url}`);
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
                        openLabel: '選擇專案資料夾',
                        defaultUri: existingProject ? vscode.Uri.file(existingProject) : undefined
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const projectPath = fileUri[0].fsPath;
                        await this.rememberFolder('project', projectPath);
                        try {
                            await config.update('projectPath', projectPath, true);
                        } catch (e) {
                            console.error('更新 projectPath 設定失敗', e);
                        }
                        this.webview?.postMessage({ command: 'setProjectPath', path: projectPath });
                        
                        // 顯示載入中
                        vscode.window.showInformationMessage(`正在掃描資料夾中的 Python 檔案，請稍候...`);

                        // 重新掃描並更新檔案列表
                        const files = await this.findPythonFiles(projectPath);
                        this.webview?.postMessage({ command: 'setFiles', files });
                        
                        if (files.length === 0) {
                            vscode.window.showWarningMessage('在選擇的資料夾中沒有找到任何 .py 檔案。');
                        } else {
                            vscode.window.showInformationMessage(`✅ 成功載入 ${files.length} 個 Python 檔案`);
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
                        openLabel: '選擇輸出資料夾',
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
                            console.error('更新 outputPath 設定失敗', e);
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
                        openLabel: '選擇批次測試資料夾',
                        defaultUri: existingBatch ? vscode.Uri.file(existingBatch) : undefined
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const batchPath = fileUri[0].fsPath;
                        await this.rememberFolder('batch', batchPath);
                        this.webview?.postMessage({ command: 'setBatchPath', path: batchPath });
                    }
                    break;
                }

                case 'getFunctions': {
                    this.webview?.postMessage({ command: 'pythonEnvironmentSelection',
                        python: configuredPythonForResource(message.filePath, this.lastFolder('project')) });
                    const funcs = await this.findPythonFunctions(message.filePath);
                    this.webview?.postMessage({ command: 'setFunctions', funcs });
                    break;
                }

                case 'preparePythonEnvironment': {
                    await vscode.commands.executeCommand('llm-unit-test.preparePythonEnvironment', {
                        filePath: typeof message.filePath === 'string' ? message.filePath : undefined,
                        projectRoot: typeof message.projectRoot === 'string' ? message.projectRoot : undefined
                    });
                    break;
                }

                case 'openTestResult': {
                    const reportPath = typeof message.reportPath === 'string' ? message.reportPath : '';
                    if (!reportPath || path.basename(reportPath) !== 'final_report.md' || !fs.existsSync(reportPath)) {
                        vscode.window.showWarningMessage('找不到此函式的測試結果報告。請先等待本次測試完成。');
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
                    vscode.window.showInformationMessage(`🔒 已安全儲存 API Key 至系統金鑰庫：${message.newName}`);
                    break;
                }

                case 'deleteApiKey': {
                    const currentKeys = await this.getStoredCloudCredentials();
                    if (currentKeys[message.name]) {
                        delete currentKeys[message.name];
                        await this.secretStorage.store('llm_api_keys', JSON.stringify(currentKeys));
                        this.webview?.postMessage({ command: 'setApiKeys', keys: toCloudCredentialOptions(currentKeys) });
                        vscode.window.showInformationMessage(`🗑️ 已自安全金鑰庫移除：${message.name}`);
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
                    vscode.window.showInformationMessage(`🔒 已安全儲存自訂 API：${message.newName}`);
                    break;
                }

                case 'deleteCustomKey': {
                    const currentKeys = await this.getStoredCustomKeys();
                    if (currentKeys[message.name]) {
                        delete currentKeys[message.name];
                        await this.secretStorage.store('llm_custom_keys', JSON.stringify(currentKeys));
                        this.webview?.postMessage({ command: 'setCustomKeys', keys: currentKeys });
                        vscode.window.showInformationMessage(`🗑️ 已自安全金鑰庫移除自訂 API：${message.name}`);
                    }
                    break;
                }

                case 'startAnalysis': {
                    const params = { ...message };
                    if (params.envType === 'cloud') {
                        const keys = await this.getStoredCloudCredentials();
                        const credential = keys[params.cloudKeyName];
                        if (!credential) {
                            vscode.window.showErrorMessage('找不到此模型的 Google AI Studio API Key。');
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
                            vscode.window.showErrorMessage('找不到此模型的 Google AI Studio API Key。');
                            this.webview?.postMessage({ command: 'analysisFinished' });
                            break;
                        }
                        params.modelName = credential.model;
                        params.cloudKey = credential.key;
                    }
                    vscode.commands.executeCommand('llm-unit-test.runBatchAnalysis', params);
                    break;
                }

                case 'testConnection': {
                    const releasePython = pythonEnvironmentActivity.acquire('use');
                    if (!releasePython) {
                        vscode.window.showInformationMessage('Python 環境準備中，請等待完成後再測試模型連線。');
                        break;
                    }
                    try { await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "正在測試 API 連線...",
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

                                // 🔍 Model Probe: 查詢模型詳細資訊
                                if (message.modelName) {
                                    try {
                                        const showResponse = await timedFetch(`${baseUrl}/api/show`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ model: message.modelName })
                                        }, CONNECTION_DISCOVERY_TIMEOUT_MS);

                                        if (showResponse.ok) {
                                            const modelData = await showResponse.json() as any;
                                            const paramSize: string = modelData?.details?.parameter_size ?? 'unknown';
                                            
                                            // 嘗試從 model_info 取得 context_length（key 不固定，需搜尋）
                                            let contextLength = 4096; // 預設值
                                            if (modelData?.model_info) {
                                                const infoKeys = Object.keys(modelData.model_info);
                                                const ctxKey = infoKeys.find(k => k.endsWith('.context_length'));
                                                if (ctxKey) {
                                                    contextLength = modelData.model_info[ctxKey];
                                                }
                                            }

                                            const profile = {
                                                paramSize,
                                                contextLength,
                                                envType: 'local' as const,
                                                endpointKey: qualificationEndpointKey('local', baseUrl),
                                                modelName: message.modelName
                                            };
                                            // 傳送探針結果給 webview 顯示
                                            this.webview?.postMessage({ command: 'modelProbeResult', profile });
                                            // 同時傳給 extension 主程式
                                            vscode.commands.executeCommand('llm-unit-test.updateModelProfile', profile);
                                            try {
                                                const plainResponse = await timedFetch(`${baseUrl}/api/generate`, {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify(buildOllamaPlainTestGenerationProbe(message.modelName))
                                                }, MODEL_QUALIFICATION_TIMEOUT_MS);
                                                const capability = await verifyRunnableTestGenerationProbe(
                                                    plainResponse.ok ? await plainResponse.json() : undefined,
                                                    isolatedProbeExecutor
                                                );
                                                const roleQualification = await runRoleQualificationProbes(
                                                    { state: capability.capability, reason: capability.reason },
                                                    async (prompt, format) => {
                                                        const roleResponse = await timedFetch(`${baseUrl}/api/generate`, {
                                                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                            body: JSON.stringify({ model: message.modelName, prompt, stream: false,
                                                                ...(format === 'json' ? { format: 'json' } : {}), options: { temperature: 0 } })
                                                        }, MODEL_QUALIFICATION_TIMEOUT_MS);
                                                        if (!roleResponse.ok) { return undefined; }
                                                        return (await roleResponse.json() as { response?: string }).response;
                                                    }
                                                );
                                                const qualificationProfile = {
                                                    ...profile,
                                                    testGenerationReady: capability.capability === 'verified',
                                                    testGenerationReason: capability.reason,
                                                    qualificationVersion: QUALIFICATION_VERSION,
                                                    testGenerationMode: '純 Python unittest',
                                                    roleQualification
                                                };
                                                this.webview?.postMessage({ command: 'modelProbeResult', profile: qualificationProfile });
                                                vscode.commands.executeCommand('llm-unit-test.updateModelProfile', qualificationProfile);
                                                this.appendModelQualificationLog(qualificationProfile, capability.responsePreview);
                                                this.appendRoleQualificationLog(qualificationProfile);
                                                if (capability.capability === 'verified') {
                                                    vscode.window.showInformationMessage(
                                                        `✅ Local Ollama 連線成功！模型：${paramSize}，最大 Context：${contextLength.toLocaleString()} tokens；已通過純 Python unittest 驗證。`
                                                    );
                                                } else {
                                                    vscode.window.showWarningMessage(
                                                        `⚠️ Local Ollama 連線成功，但未通過 unittest 生成驗證（${capability.reason}）。Tier 1 的確定性測試仍可使用；Tier 2–4 建議改用 Instruct 模型。`
                                                    );
                                                }
                                            } catch {
                                                const qualificationProfile = {
                                                    ...profile,
                                                    qualificationVersion: QUALIFICATION_VERSION,
                                                    testGenerationReady: false,
                                                    testGenerationReason: '測試連線逾時或無法完成 unittest 生成探針。',
                                                    testGenerationMode: '未完成',
                                                    roleQualification: buildRoleQualificationProfile(
                                                        { state: 'unverified', reason: 'Writer 探針未完成，角色探針未執行。' }
                                                    )
                                                };
                                                this.webview?.postMessage({ command: 'modelProbeResult', profile: qualificationProfile });
                                                vscode.commands.executeCommand('llm-unit-test.updateModelProfile', qualificationProfile);
                                                this.appendModelQualificationLog(qualificationProfile);
                                                this.appendRoleQualificationLog(qualificationProfile);
                                                vscode.window.showWarningMessage(
                                                    '⚠️ Local Ollama 連線成功，但結構化輸出驗證逾時或失敗。Tier 1 的確定性測試仍可使用；Tier 2–4 建議改用 Instruct 模型。'
                                                );
                                            }
                                        } else {
                                            vscode.window.showInformationMessage(`✅ Local Ollama 連線成功！`);
                                        }
                                    } catch (probeError) {
                                        console.warn('[SidebarProvider] Local probe failed:', probeError);
                                        vscode.window.showInformationMessage(`✅ Local Ollama 連線成功！`);
                                    }
                                } else {
                                    vscode.window.showInformationMessage(`✅ Local Ollama 連線成功！`);
                                }
                            } else if (message.envType === 'cloud') {
                                const keys = await this.getStoredCloudCredentials();
                                const credential = keys[message.cloudKeyName];
                                if (!credential) {
                                    throw new Error("找不到對應的 API Key");
                                }

                                const listedModels: unknown[] = [];
                                let nextPageToken: string | undefined;
                                for (let page = 0; page < 10; page++) {
                                    const listRequest = buildGoogleListModelsRequest(credential.key, nextPageToken);
                                    const listResponse = await timedFetch(listRequest.url, {
                                        headers: listRequest.headers
                                    }, CONNECTION_DISCOVERY_TIMEOUT_MS);
                                    if (!listResponse.ok) {
                                        throw new Error(`無法讀取 Google 可用模型清單（HTTP ${listResponse.status}）`);
                                    }
                                    const modelList = await listResponse.json() as { models?: unknown[]; nextPageToken?: string };
                                    listedModels.push(...(modelList.models || []));
                                    nextPageToken = modelList.nextPageToken;
                                    if (!nextPageToken) { break; }
                                }
                                const usableModels = getGenerateContentModelNames(listedModels as any[]);
                                const selectedModel = normalizeGoogleModelName(credential.model);
                                if (!usableModels.includes(selectedModel)) {
                                    const suggestions = usableModels.slice(0, 12).join(', ') || '無';
                                    throw new Error(`模型「${selectedModel}」不存在、目前 API Key 無權使用，或不支援 generateContent。請改用可用模型：${suggestions}`);
                                }
                                const connectionMetadata = getGoogleModelConnectionMetadata(listedModels as any[], credential.model);
                                
                                const cloudProbe = async (prompt: string, json = false) => {
                                    const controller = new AbortController();
                                    const timer = setTimeout(() => controller.abort(), MODEL_QUALIFICATION_TIMEOUT_MS);
                                    try {
                                        const request = buildGoogleGenerateContentRequest(credential.model, credential.key, prompt, {
                                            temperature: 0,
                                            thinkingMode: vscode.workspace.getConfiguration('llmUnitTest').get('cloudThinkingMode', 'minimal') === 'minimal'
                                                ? 'minimal' : 'provider-default',
                                            ...(json ? { responseMimeType: 'application/json' as const } : {})
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
                                    (prompt, format) => cloudProbe(prompt, format === 'json')
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
                                    testGenerationMode: '純 Python unittest',
                                    roleQualification
                                };
                                this.webview?.postMessage({ command: 'modelProbeResult', profile });
                                vscode.commands.executeCommand('llm-unit-test.updateModelProfile', profile);
                                this.appendModelQualificationLog(profile, capability.responsePreview);
                                this.appendRoleQualificationLog(profile);
                                if (capability.capability === 'verified') {
                                    const contextMessage = connectionMetadata.contextLengthKnown
                                        ? `最大輸入 Context：${connectionMetadata.contextLength.toLocaleString()} tokens`
                                        : '最大輸入 Context：API 未公開（採保守 4,096-token 預算）';
                                    vscode.window.showInformationMessage(
                                        `✅ Cloud AI Studio 連線成功！模型：${connectionMetadata.paramSize}；${contextMessage}；已通過純 Python unittest 驗證。`
                                    );
                                } else {
                                    vscode.window.showWarningMessage(
                                        `⚠️ Cloud Gemini 連線成功，但未通過 unittest 生成驗證（${capability.reason}）。Tier 1 的確定性測試仍可使用。`
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
                                    }
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
                                    testGenerationMode: '純 Python unittest',
                                    roleQualification
                                } as const;
                                this.webview?.postMessage({ command: 'modelProbeResult', profile });
                                vscode.commands.executeCommand('llm-unit-test.updateModelProfile', profile);
                                this.appendModelQualificationLog(profile, capability.responsePreview);
                                this.appendRoleQualificationLog(profile);
                                if (capability.capability === 'verified') {
                                    vscode.window.showInformationMessage(
                                        `✅ Custom API 連線成功！已通過純 Python unittest 驗證。`
                                    );
                                } else {
                                    vscode.window.showWarningMessage(
                                        `⚠️ Custom API 連線成功，但未通過 unittest 生成驗證（${capability.reason}）。Tier 1 的確定性測試仍可使用。`
                                    );
                                }
                            }
                        } catch (error: any) {
                            vscode.window.showErrorMessage(`❌ 連線失敗: ${error.message}`);
                            this.webview?.postMessage({ command: 'appendLog', text: `[錯誤] 連線測試失敗: ${error.message}` });
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
                                        files.push({ name: file, path: fullPath });
                                    }
                                }
                            })
                            .catch((readError) => {
                                console.warn(`[SidebarProvider] 無法讀取目錄 ${currentDir}:`, readError);
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
            console.error('掃描專案檔案失敗', e);
        }
        return files;
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
