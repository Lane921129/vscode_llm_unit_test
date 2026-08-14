import * as vscode from 'vscode';
import en from './en';
import zhTw from './zh-tw';

type Dictionary = typeof zhTw;

let currentDict: Dictionary = zhTw;

export function initI18n() {
    const config = vscode.workspace.getConfiguration('llmUnitTest');
    let lang = config.get<string>('language', 'auto');
    
    if (lang === 'auto') {
        // vscode.env.language returns 'en', 'zh-tw', 'zh-cn', etc.
        lang = vscode.env.language.toLowerCase();
    }

    if (lang.startsWith('en')) {
        currentDict = en;
    } else {
        currentDict = zhTw;
    }
}

export function t(keyPath: string, ...args: any[]): string {
    const keys = keyPath.split('.');
    let value: any = currentDict;
    for (const key of keys) {
        if (value && typeof value === 'object') {
            value = value[key];
        } else {
            value = undefined;
            break;
        }
    }
    
    if (typeof value === 'string') {
        let result = value;
        for (let i = 0; i < args.length; i++) {
            result = result.replace(`{${i}}`, String(args[i]));
        }
        return result;
    }
    
    return keyPath; // fallback to key path if not found
}

export function getPromptLanguageName(): string {
    return currentDict.prompt.languageName;
}
