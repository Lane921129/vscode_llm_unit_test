import en from './en';
import zhTw from './zh-tw';
import { englishMessages } from './messages';
import { AsyncLocalStorage } from 'node:async_hooks';

export type Language = 'en' | 'zh-tw';
let language: Language = 'zh-tw';
const runLanguage = new AsyncLocalStorage<Language>();

export function setLanguage(configured: string, hostLanguage = 'zh-tw'): void {
    const selected = configured === 'auto' ? hostLanguage : configured;
    language = selected.toLowerCase().startsWith('en') ? 'en' : 'zh-tw';
}

export function getLanguage(): Language { return runLanguage.getStore() ?? language; }

/** A settings change affects the next run without mixing languages in an active report. */
export function withLanguage<T>(operation: () => T): T { return runLanguage.run(getLanguage(), operation); }

/** Substitute once: placeholders inside evidence, names and paths stay literal. */
export function formatMessage(template: string, args: readonly unknown[]): string {
    return template.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
        Number(index) < args.length ? String(args[Number(index)]) : placeholder);
}

/** Source-key catalog for framework messages. Never translate interpolated evidence. */
export function localize(source: string, ...args: unknown[]): string {
    return formatMessage(getLanguage() === 'en' && Object.hasOwn(englishMessages, source) ? englishMessages[source] : source, args);
}

export function t(keyPath: string, ...args: unknown[]): string {
    let value: unknown = getLanguage() === 'en' ? en : zhTw;
    for (const key of keyPath.split('.')) {
        value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    }
    return typeof value === 'string' ? formatMessage(value, args) : keyPath;
}

export function getPromptLanguageName(): string { return t('prompt.languageName'); }
