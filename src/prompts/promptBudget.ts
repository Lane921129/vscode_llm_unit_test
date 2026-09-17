/** Capability metadata only; model/provider names are deliberately absent. */
export function parameterBillions(size: string): number | undefined {
    const match = size.trim().match(/^(\d+(?:\.\d+)?)\s*([BM])$/i);
    if (!match) { return undefined; }
    return Number(match[1]) / (match[2].toUpperCase() === 'M' ? 1000 : 1);
}

export function contextInputBudget(size: string, contextLength: number): number {
    const context = Number.isFinite(contextLength) && contextLength > 0 ? contextLength : 4096;
    const parameters = parameterBillions(size);
    const cap = parameters === undefined ? 20000 : parameters <= 2 ? 1800
        : parameters <= 7 ? 3500 : parameters <= 13 ? 6000 : 12000;
    return Math.min(Math.floor(context * 0.7), cap);
}

/** Stable across roles, reserves 30% for output, never expands to a huge advertised maximum. */
export function runtimeContextWindow(size: string, contextLength: number): number {
    const advertised = Number.isFinite(contextLength) && contextLength > 0 ? Math.floor(contextLength) : 4096;
    return Math.min(advertised, Math.ceil(contextInputBudget(size, advertised) / 0.7));
}

/** Conservative estimate, not provider tokenizer usage. */
export function estimatePromptTokens(text: string): number {
    const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
    return Math.ceil((text.length - nonAscii) / 3.5 + nonAscii);
}

export function promptFits(system: string, prompt: string, budget: number): boolean {
    return estimatePromptTokens(system + '\n' + prompt) <= budget;
}
