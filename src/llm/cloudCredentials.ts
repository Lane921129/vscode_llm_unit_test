export interface CloudCredential {
    model: string;
    key: string;
}

export interface CloudCredentialOption {
    model: string;
}

type StoredCloudCredential = string | Partial<CloudCredential>;

/**
 * Read both the current credential shape and the legacy { name: key } shape.
 * Legacy entries use their label as the model because that was the old UI's
 * implicit contract; users can then update them with an explicit model.
 */
export function normalizeCloudCredentials(value: unknown): Record<string, CloudCredential> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    const credentials: Record<string, CloudCredential> = {};
    for (const [name, stored] of Object.entries(value as Record<string, StoredCloudCredential>)) {
        if (typeof stored === 'string' && stored.trim()) {
            credentials[name] = { model: name, key: stored };
        } else if (
            stored &&
            typeof stored === 'object' &&
            typeof stored.model === 'string' && stored.model.trim() &&
            typeof stored.key === 'string' && stored.key.trim()
        ) {
            credentials[name] = { model: stored.model, key: stored.key };
        }
    }
    return credentials;
}

/** Return display data only. API keys must never be sent back to the webview. */
export function toCloudCredentialOptions(
    credentials: Record<string, CloudCredential>
): Record<string, CloudCredentialOption> {
    return Object.fromEntries(
        Object.entries(credentials).map(([name, credential]) => [name, { model: credential.model }])
    );
}
