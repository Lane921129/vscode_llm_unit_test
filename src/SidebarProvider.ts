import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewContent } from './webviewContent';
import { initI18n, t } from './i18n';
import { extractFunctionsWithAst } from './utils';

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
            switch (message.command) {
                case 'getInitialData': {
                    // 從 SecretStorage 讀取 API 金鑰
                    const rawKeys = await this.secretStorage.get('llm_api_keys');
                    const keys = rawKeys ? JSON.parse(rawKeys) : {};
                    this.webview?.postMessage({ command: 'setApiKeys', keys: Object.keys(keys) });
                    break;
                }

                case 'updateApiKey': {
                    const rawKeys = await this.secretStorage.get('llm_api_keys');
                    const keys = rawKeys ? JSON.parse(rawKeys) : {};
                    if (message.oldName && message.oldName !== message.newName) {
                        delete keys[message.oldName];
                    }
                    keys[message.newName] = message.key;
                    await this.secretStorage.store('llm_api_keys', JSON.stringify(keys));
                    this.webview?.postMessage({ command: 'setApiKeys', keys: Object.keys(keys) });
                    vscode.window.showInformationMessage(`🔒 已安全儲存 API Key 至系統金鑰庫：${message.newName}`);
                    break;
                }

                case 'deleteApiKey': {
                    const rawKeys = await this.secretStorage.get('llm_api_keys');
                    const keys = rawKeys ? JSON.parse(rawKeys) : {};
                    delete keys[message.name];
                    await this.secretStorage.store('llm_api_keys', JSON.stringify(keys));
                    this.webview?.postMessage({ command: 'setApiKeys', keys: Object.keys(keys) });
                    vscode.window.showInformationMessage(`🗑️ 已自安全金鑰庫移除：${message.name}`);
                    break;
                }

                case 'getFunctions': {
                    const funcs = await extractFunctionsWithAst(message.filePath);
                    this.webview?.postMessage({ command: 'setFunctions', funcs: funcs.map(f => f.fullName) });
                    break;
                }
            }
        });
    }
}