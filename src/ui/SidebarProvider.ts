import { requireSuccessfulProbeResponse } from '../llm/probeResponse';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewContent } from './webviewContent';
import { initI18n, t } from '../i18n';
import { extractFunctionsWithAst } from '../utils/utils';
import { buildGoogleGenerateContentRequest, buildGoogleListModelsRequest, getGenerateContentModelNames, getGoogleGeneratedText, getGoogleModelConnectionMetadata, normalizeGoogleModelName } from '../llm/cloudApi';
import { normalizeCloudCredentials, toCloudCredentialOptions } from '../llm/cloudCredentials';
import { buildOllamaPlainTestGenerationProbe, buildOllamaTestGenerationProbe } from '../llm/ollamaCapability';
import { PLAIN_TEST_GENERATION_PROBE_PROMPT, TEST_GENERATION_PROBE_PROMPT, TEST_GENERATION_PROBE_SCHEMA } from '../llm/testGenerationQualification';
import { verifyRunnableTestGenerationProbe } from '../llm/modelProbeExecution';
import { buildCustomChatCompletionBody, getCustomChatCompletionText } from '../llm/customApi';
import { CONNECTION_DISCOVERY_TIMEOUT_MS, fetchWithServerRetry, fetchWithTimeout, MODEL_QUALIFICATION_TIMEOUT_MS } from '../llm/connectionTimeout';

export class MutationViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mutation-test-view';
    public webview?: vscode.Webview;

    constructor(private readonly secretStorage: vscode.SecretStorage) {}

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
                    const rawKeys = await this.secretStorage.get('llm_api_keys');
                    const keys = normalizeCloudCredentials(rawKeys ? JSON.parse(rawKeys) : {});
                    this.webview?.postMessage({ command: 'setApiKeys', keys: toCloudCredentialOptions(keys) });

                    const rawCustomKeys = await this.secretStorage.get('llm_custom_keys');
                    const customKeys: Record<string, any> = rawCustomKeys ? JSON.parse(rawCustomKeys) : {};
                    this.webview?.postMessage({ command: 'setCustomKeys', keys: customKeys });

                    const savedProjPath = config.get<string>('projectPath', '');
                    const files = await this.findPythonFiles(savedProjPath);
                    const savedPath = config.get<string>('outputPath', '');

                    if (savedProjPath) {
                        this.webview?.postMessage({ command: 'setProjectPath', path: savedProjPath });
                    }
                    this.webview?.postMessage({ command: 'setFiles', files });
                    if (savedPath) {
                        this.webview?.postMessage({ command: 'setOutputPath', path: savedPath });
                    }

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
                        this.webview.html = getWebviewContent(t, message.lang, strategy);
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
                    const existingProject = config.get<string>('projectPath', '');
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: '選擇專案資料夾',
                        defaultUri: existingProject ? vscode.Uri.file(existingProject) : undefined
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const projectPath = fileUri[0].fsPath;
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
                    const existingOutput = config.get<string>('outputPath', '');
                    const existingProject2 = config.get<string>('projectPath', '');
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
                    const existingProject3 = config.get<string>('projectPath', '');
                    const options: vscode.OpenDialogOptions = {
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: '選擇批次測試資料夾',
                        defaultUri: existingProject3 ? vscode.Uri.file(existingProject3) : undefined
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const batchPath = fileUri[0].fsPath;
                        this.webview?.postMessage({ command: 'setBatchPath', path: batchPath });
                    }
                    break;
                }

                case 'getFunctions': {
                    const funcs = await this.findPythonFunctions(message.filePath);
                    this.webview?.postMessage({ command: 'setFunctions', funcs });
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
                    const rawKeys = await this.secretStorage.get('llm_api_keys');
                    const currentKeys = normalizeCloudCredentials(rawKeys ? JSON.parse(rawKeys) : {});
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
                    const rawKeys = await this.secretStorage.get('llm_api_keys');
                    const currentKeys = normalizeCloudCredentials(rawKeys ? JSON.parse(rawKeys) : {});
                    if (currentKeys[message.name]) {
                        delete currentKeys[message.name];
                        await this.secretStorage.store('llm_api_keys', JSON.stringify(currentKeys));
                        this.webview?.postMessage({ command: 'setApiKeys', keys: toCloudCredentialOptions(currentKeys) });
                        vscode.window.showInformationMessage(`🗑️ 已自安全金鑰庫移除：${message.name}`);
                    }
                    break;
                }

                case 'updateCustomKey': {
                    const rawCustomKeys = await this.secretStorage.get('llm_custom_keys');
                    const currentKeys: Record<string, any> = rawCustomKeys ? JSON.parse(rawCustomKeys) : {};
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
                    const rawCustomKeys = await this.secretStorage.get('llm_custom_keys');
                    const currentKeys: Record<string, any> = rawCustomKeys ? JSON.parse(rawCustomKeys) : {};
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
                        const rawKeys = await this.secretStorage.get('llm_api_keys');
                        const keys = normalizeCloudCredentials(rawKeys ? JSON.parse(rawKeys) : {});
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
                        const rawKeys = await this.secretStorage.get('llm_api_keys');
                        const keys = normalizeCloudCredentials(rawKeys ? JSON.parse(rawKeys) : {});
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
                    vscode.window.withProgress({
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
                                                modelName: message.modelName
                                            };
                                            // 傳送探針結果給 webview 顯示
                                            this.webview?.postMessage({ command: 'modelProbeResult', profile });
                                            // 同時傳給 extension 主程式
                                            vscode.commands.executeCommand('llm-unit-test.updateModelProfile', profile);
                                            try {
                                                const outputResponse = await timedFetch(`${baseUrl}/api/generate`, {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify(buildOllamaTestGenerationProbe(message.modelName))
                                                }, MODEL_QUALIFICATION_TIMEOUT_MS);
                                                const outputPayload = outputResponse.ok ? await outputResponse.json() : undefined;
                                                let capability = await verifyRunnableTestGenerationProbe(outputPayload);
                                                let plainPythonVerified = false;
                                                if (capability.capability !== 'verified') {
                                                    const plainResponse = await timedFetch(`${baseUrl}/api/generate`, {
                                                        method: 'POST',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify(buildOllamaPlainTestGenerationProbe(message.modelName))
                                                    }, MODEL_QUALIFICATION_TIMEOUT_MS);
                                                    capability = await verifyRunnableTestGenerationProbe(
                                                        plainResponse.ok ? await plainResponse.json() : undefined
                                                    );
                                                    plainPythonVerified = capability.capability === 'verified';
                                                }
                                                vscode.commands.executeCommand('llm-unit-test.updateModelProfile', {
                                                    ...profile,
                                                    testGenerationReady: capability.capability === 'verified',
                                                    testGenerationReason: capability.reason,
                                                    testGenerationMode: plainPythonVerified ? '純 Python unittest' : '結構化 JSON unittest'
                                                });
                                                if (capability.capability === 'verified') {
                                                    vscode.window.showInformationMessage(
                                                        `✅ Local Ollama 連線成功！模型：${paramSize}，最大 Context：${contextLength.toLocaleString()} tokens；已通過${plainPythonVerified ? '純 Python unittest' : '結構化輸出'}驗證。`
                                                    );
                                                } else {
                                                    vscode.window.showWarningMessage(
                                                        `⚠️ Local Ollama 連線成功，但未通過 unittest 生成驗證（${capability.reason}）。Tier 1 的確定性測試仍可使用；Tier 2–4 建議改用 Instruct 模型。`
                                                    );
                                                }
                                            } catch {
                                                vscode.commands.executeCommand('llm-unit-test.updateModelProfile', {
                                                    ...profile,
                                                    testGenerationReady: false,
                                                    testGenerationReason: '測試連線逾時或無法完成 unittest 生成探針。',
                                                    testGenerationMode: '未完成'
                                                });
                                                vscode.window.showWarningMessage(
                                                    '⚠️ Local Ollama 連線成功，但結構化輸出驗證逾時或失敗。Tier 1 的確定性測試仍可使用；Tier 2–4 建議改用 Instruct 模型。'
                                                );
                                            }
                                        } else {
                                            vscode.window.showInformationMessage(`✅ Local Ollama 連線成功！`);
                                        }
                                    } catch {
                                        // 探針失敗不影響主流程
                                        vscode.window.showInformationMessage(`✅ Local Ollama 連線成功！`);
                                    }
                                } else {
                                    vscode.window.showInformationMessage(`✅ Local Ollama 連線成功！`);
                                }
                            } else if (message.envType === 'cloud') {
                                const rawKeys = await this.secretStorage.get('llm_api_keys');
                                const keys = normalizeCloudCredentials(rawKeys ? JSON.parse(rawKeys) : {});
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
                                
                                const request = buildGoogleGenerateContentRequest(
                                    credential.model,
                                    credential.key,
                                    TEST_GENERATION_PROBE_PROMPT,
                                    { responseMimeType: 'application/json', responseSchema: TEST_GENERATION_PROBE_SCHEMA }
                                );
                                const response = await fetchWithServerRetry<Response>(fetch, request.url, {
                                    method: 'POST',
                                    headers: request.headers,
                                    body: JSON.stringify(request.body)
                                }, MODEL_QUALIFICATION_TIMEOUT_MS);
                                let capability = await verifyRunnableTestGenerationProbe(response.ok
                                    ? { response: getGoogleGeneratedText(await response.json()) }
                                    : undefined);
                                let plainPythonVerified = false;
                                if (capability.capability !== 'verified') {
                                    const plainRequest = buildGoogleGenerateContentRequest(
                                        credential.model,
                                        credential.key,
                                        PLAIN_TEST_GENERATION_PROBE_PROMPT
                                    );
                                    const plainResponse = await fetchWithServerRetry<Response>(fetch, plainRequest.url, {
                                        method: 'POST',
                                        headers: plainRequest.headers,
                                        body: JSON.stringify(plainRequest.body)
                                    }, MODEL_QUALIFICATION_TIMEOUT_MS);
                                    await requireSuccessfulProbeResponse(plainResponse);
                                    capability = await verifyRunnableTestGenerationProbe(plainResponse.ok
                                        ? { response: getGoogleGeneratedText(await plainResponse.json()) }
                                        : undefined);
                                    plainPythonVerified = capability.capability === 'verified';
                                }
                                const profile = {
                                    paramSize: connectionMetadata.paramSize,
                                    contextLength: connectionMetadata.contextLength,
                                    envType: 'cloud' as const,
                                    modelName: credential.model,
                                    testGenerationReady: capability.capability === 'verified',
                                    testGenerationReason: capability.reason,
                                    testGenerationMode: plainPythonVerified ? '純 Python unittest' : '結構化 JSON unittest'
                                };
                                this.webview?.postMessage({ command: 'modelProbeResult', profile });
                                vscode.commands.executeCommand('llm-unit-test.updateModelProfile', profile);
                                if (capability.capability === 'verified') {
                                    const contextMessage = connectionMetadata.contextLengthKnown
                                        ? `最大輸入 Context：${connectionMetadata.contextLength.toLocaleString()} tokens`
                                        : '最大輸入 Context：API 未公開（採保守 4,096-token 預算）';
                                    vscode.window.showInformationMessage(
                                        `✅ Cloud AI Studio 連線成功！模型：${connectionMetadata.paramSize}；${contextMessage}；已通過${plainPythonVerified ? '純 Python unittest' : '結構化輸出'}驗證。`
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
                                        'Return only the requested structured output.',
                                        TEST_GENERATION_PROBE_PROMPT,
                                        'json'
                                    ))
                                }, MODEL_QUALIFICATION_TIMEOUT_MS);
                                let capability = await verifyRunnableTestGenerationProbe(response.ok
                                    ? { response: getCustomChatCompletionText(await response.json()) }
                                    : undefined);
                                let plainPythonVerified = false;
                                if (capability.capability !== 'verified') {
                                    const plainResponse = await timedFetch(message.customUrl, {
                                        method: 'POST',
                                        headers,
                                        body: JSON.stringify(buildCustomChatCompletionBody(
                                            message.modelName,
                                            'Return only runnable Python unittest code.',
                                            PLAIN_TEST_GENERATION_PROBE_PROMPT,
                                            'text'
                                        ))
                                    }, MODEL_QUALIFICATION_TIMEOUT_MS);
                                    await requireSuccessfulProbeResponse(plainResponse);
                                    capability = await verifyRunnableTestGenerationProbe(plainResponse.ok
                                        ? { response: getCustomChatCompletionText(await plainResponse.json()) }
                                        : undefined);
                                    plainPythonVerified = capability.capability === 'verified';
                                }
                                vscode.commands.executeCommand('llm-unit-test.updateModelProfile', {
                                    paramSize: 'Custom API',
                                    contextLength: 8192,
                                    envType: 'custom',
                                    modelName: message.modelName,
                                    testGenerationReady: capability.capability === 'verified',
                                    testGenerationReason: capability.reason,
                                    testGenerationMode: plainPythonVerified ? '純 Python unittest' : '結構化 JSON unittest'
                                });
                                if (capability.capability === 'verified') {
                                    vscode.window.showInformationMessage(
                                        `✅ Custom API 連線成功！已通過${plainPythonVerified ? '純 Python unittest' : '結構化輸出'}驗證。`
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
                    });
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

        const walkAsync = async (dir: string) => {
            let list: fs.Dirent[];
            try {
                list = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch (e) {
                return;
            }
            
            const tasks = list.map(async (dirent) => {
                const file = dirent.name;
                if (file.startsWith('.') && file !== '.py' && file.length > 1) {return;} // skip hidden folders
                if (ignoredDirs.has(file)) {return;}
                
                const fullPath = path.join(dir, file);
                try {
                    if (dirent.isDirectory()) {
                        await walkAsync(fullPath);
                    } else if (file.endsWith('.py')) {
                        files.push({ name: file, path: fullPath });
                    }
                } catch (e) {
                    // ignore
                }
            });
            await Promise.all(tasks);
        };

        try {
            await walkAsync(rootPath);
        } catch (e) {
            console.error('掃描專案檔案失敗', e);
        }
        return files;
    }

    private async findPythonFunctions(filePath: string): Promise<string[]> {
        const configuredPython = vscode.workspace.getConfiguration('llmUnitTest').get<string>('pythonPath', '');
        const infos = await extractFunctionsWithAst(filePath, configuredPython);
        return infos.map(f => f.fullName);
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
            // Ollama not running or unreachable
        }
        return [];
    }
}
