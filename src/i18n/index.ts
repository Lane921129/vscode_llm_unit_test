import * as vscode from 'vscode';
import { setLanguage } from './core';
export { t, getPromptLanguageName } from './core';

export function initI18n(): void {
    const config = vscode.workspace.getConfiguration('llmUnitTest');
    setLanguage(config.get<string>('language', 'auto'), vscode.env?.language || 'zh-tw');
}
