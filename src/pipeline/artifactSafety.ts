import { createHash } from 'node:crypto';

export const WITHHELD_SENSITIVE_CONTENT = '[withheld-sensitive-content]';

/** Ignore empty/implausibly short configuration values that would match ordinary identifiers. */
export function normalizeKnownSecrets(values: readonly string[]): readonly string[] {
    return [...new Set(values.filter(value => typeof value === 'string' && value.length >= 8))];
}

/** Shared high-confidence credential detection for generated candidates and persisted journals. */
export function containsCredential(text: string, knownSecrets: readonly string[] = []): boolean {
    return knownSecrets.some(secret => secret.length >= 8 && text.includes(secret))
        || /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)
        || /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/.test(text)
        || /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/i.test(text)
        || /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*['"]?\s*[:=]\s*['"][A-Za-z0-9_./+\-=]{24,}['"]/i.test(text);
}

/** Redact only matching strings, including nested data and sensitive object keys. */
export function redactCredentialStrings(value: unknown, knownSecrets: readonly string[] = []): unknown {
    if (typeof value === 'string') {
        return containsCredential(value, knownSecrets) ? WITHHELD_SENSITIVE_CONTENT : value;
    }
    if (Array.isArray(value)) { return value.map(item => redactCredentialStrings(item, knownSecrets)); }
    if (!value || typeof value !== 'object') { return value; }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        const safeKey = containsCredential(key, knownSecrets)
            ? `[withheld-sensitive-key-${createHash('sha256').update(key).digest('hex').slice(0, 16)}]` : key;
        const contextualCredential = typeof item === 'string'
            && containsCredential(`${key} = ${JSON.stringify(item)}`, knownSecrets);
        return [safeKey, contextualCredential ? WITHHELD_SENSITIVE_CONTENT : redactCredentialStrings(item, knownSecrets)];
    }));
}
