import { containsCredential, WITHHELD_SENSITIVE_CONTENT } from '../pipeline/artifactSafety';

export type OutputDiagnosis = 'repetitive-without-tests' | 'repetitive-test-shells' | 'seed-scope-overrun' | 'test-structure-present' | 'no-test-structure' | 'unknown';

/** Chooses recovery only. Lexical counts never establish Python validity. */
export function diagnoseModelOutput(value: unknown, scope?: { singleTestSeed?: boolean }): OutputDiagnosis {
    if (!value || typeof value !== 'object') { return 'unknown'; }
    const shape = value as Record<string, unknown>;
    if (shape.version !== 'output-shape-v1' || shape.sampleComplete !== true
        || ['nonemptyLines', 'repeatedLines', 'testMethods', 'assertionCalls'].some(key =>
            !Number.isSafeInteger(shape[key]) || Number(shape[key]) < 0)
        || Number(shape.repeatedLines) > Number(shape.nonemptyLines)) { return 'unknown'; }
    const repetitive = Number(shape.nonemptyLines) >= 16
        && Number(shape.repeatedLines) * 5 >= Number(shape.nonemptyLines) * 4;
    if (repetitive && Number(shape.assertionCalls) === 0) {
        if (Number(shape.testMethods) === 0) { return 'repetitive-without-tests'; }
        // Repeated fenced wrappers are not progress merely because they repeat
        // def test_*. A single unfinished fixture or an existing assertion keeps
        // the original growth route. This still grants no candidate validity.
        if (Number(shape.testMethods) > 1 && Number.isSafeInteger(shape.pythonFences)
            && Number(shape.pythonFences) >= 4) { return 'repetitive-test-shells'; }
    }
    if (scope?.singleTestSeed === true && Number(shape.testMethods) > 1) { return 'seed-scope-overrun'; }
    return Number(shape.testMethods) || Number(shape.assertionCalls) ? 'test-structure-present' : 'no-test-structure';
}

export interface ModelOutputPreview {
    version: 'model-output-preview-v1'; executable: false; complete: false;
    responseCharacters: number; sampledLines: number;
    samples: { line: number; repetitions: number; characters: number; text: string }[];
}

const sensitiveAssignment = /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\s*['"]?\s*[:=]/i;
function safeLine(text: string): string {
    if (containsCredential(text) || sensitiveAssignment.test(text)) { return WITHHELD_SENSITIVE_CONTENT; }
    return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+|(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+|\/(?:[A-Za-z0-9._~-]+\/)+[^\s"'<>]*/gi,
        '[withheld-location]').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** Only a bounded diagnostic excerpt, never the provider envelope or candidate.
 * Suppress prompt/source echoes and credentials before applying display limits.
 * Only caller-supplied, static framework instructions may be shown as echoes. */
export function buildModelOutputPreview(text: string, privacy: {
    knownSecrets?: readonly string[]; excludedTexts?: readonly string[]; publicInstructionTexts?: readonly string[];
    /** Coordinates belong to this exact text, never an offset guessed from a raw reply. */
    focusLine?: number | null;
}): ModelOutputPreview {
    const lines = text.slice(0, 65536).split('\n').slice(0, 2048);
    const unique = new Map<string, { line: number; repetitions: number; characters: number }>();
    lines.forEach((line, index) => {
        const key = line.trim();
        if (!key) { return; }
        const found = unique.get(key);
        if (found) { found.repetitions++; }
        else { unique.set(key, { line: index + 1, repetitions: 1, characters: key.length }); }
    });
    const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');
    const publicLines = new Set((privacy.publicInstructionTexts || []).flatMap(value => value.split('\n'))
        .flatMap(value => [normalize(value), normalize('# ' + value)]));
    const excluded = (privacy.excludedTexts || []).flatMap(value => value.split('\n'))
        .map(normalize).filter(value => value.length >= 8 && !publicLines.has(value));
    const words = /[_\p{L}\p{N}]+/gu;
    let privateWords: Set<string> | undefined;
    const redactEcho = (line: string): string => {
        const normalized = normalize(line);
        const matches = excluded.filter(value => normalized.includes(value) || value.includes(normalized));
        if (!matches.length) { return safeLine(line); }
        // Full/partial source lines remain hidden. Only a long diagnostic that
        // overlaps short identifier/call spellings can use a local projection.
        const symbol = /^[_\p{ID_Start}][_\p{ID_Continue}]*(?:\.[_\p{ID_Start}][_\p{ID_Continue}]*)*(?:\(\))?$/u;
        if (matches.some(value => value.includes(normalized) || value.length > 64 || !symbol.test(value))) {
            return '[withheld-prompt-content]';
        }
        if (!privateWords) {
            const publicWords = new Set((privacy.publicInstructionTexts || []).flatMap(value => value.match(words) || []));
            // Include short private identifiers/literals too, even when they did
            // not cause the original eight-character echo match. Public words
            // are permitted only from caller-owned static framework text.
            privateWords = new Set((privacy.excludedTexts || []).flatMap(value => value.match(words) || [])
                .filter(word => !publicWords.has(word)));
        }
        // Redact complete tokens before display truncation; otherwise a private
        // identifier crossing the cutoff could escape as an unmatched prefix.
        // Hide locations first too: token projection must not break their syntax.
        return safeLine(normalized).replace(words, word =>
            privateWords!.has(word) ? '[withheld-prompt-content]' : word);
    };
    const sensitive = containsCredential(text, privacy.knownSecrets) || sensitiveAssignment.test(text);
    let remaining = Math.min(1200, Math.floor(text.length / 2));
    const samples: ModelOutputPreview['samples'] = [];
    const ordered = new Map<string, { line: number; repetitions: number; characters: number }>();
    if (Number.isSafeInteger(privacy.focusLine) && Number(privacy.focusLine) > 0 && Number(privacy.focusLine) <= lines.length) {
        for (const offset of [0, -1, 1, -2, 2, 3]) {
            const index = Number(privacy.focusLine) - 1 + offset;
            const line = lines[index]?.trim(), count = line ? unique.get(line) : undefined;
            if (line && count && !ordered.has(line)) { ordered.set(line, { ...count, line: index + 1 }); }
        }
    }
    for (const [line, count] of unique) { if (!ordered.has(line)) { ordered.set(line, count); } }
    for (const [line, count] of ordered) {
        if (samples.length === 6 || remaining <= 0) { break; }
        const limit = Math.min(240, remaining);
        const safe = sensitive ? WITHHELD_SENSITIVE_CONTENT : redactEcho(line);
        const excerpt = safe.length > limit ? safe.slice(0, Math.max(0, limit - 1)) + '…' : safe;
        remaining -= excerpt.length;
        samples.push({ ...count, text: excerpt });
    }
    return { version: 'model-output-preview-v1', executable: false, complete: false,
        responseCharacters: text.length, sampledLines: lines.length, samples };
}

/** Whitelist fields on replay; report rendering must not trust arbitrary JSON. */
export function readModelOutputPreview(value: unknown): ModelOutputPreview | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
    const data = value as ModelOutputPreview;
    if (data.version !== 'model-output-preview-v1' || data.executable !== false || data.complete !== false
        || !Number.isSafeInteger(data.responseCharacters) || data.responseCharacters < 0
        || !Number.isSafeInteger(data.sampledLines) || data.sampledLines < 0 || data.sampledLines > 2048
        || !Array.isArray(data.samples) || data.samples.length > 6) { return undefined; }
    const samples: ModelOutputPreview['samples'] = [];
    for (const item of data.samples) {
        if (!item || !Number.isSafeInteger(item.line) || item.line < 1 || item.line > data.sampledLines
            || !Number.isSafeInteger(item.repetitions) || item.repetitions < 1 || item.repetitions > data.sampledLines
            || !Number.isSafeInteger(item.characters) || item.characters < 0
            || typeof item.text !== 'string' || item.text.length > 241 || /[\r\n]/.test(item.text)) { return undefined; }
        samples.push({ line: item.line, repetitions: item.repetitions, characters: item.characters, text: safeLine(item.text) });
    }
    if (samples.reduce((sum, item) => sum + item.text.length, 0) > 1206) { return undefined; }
    return { version: data.version, executable: false, complete: false,
        responseCharacters: data.responseCharacters, sampledLines: data.sampledLines, samples };
}

export function writerOutputFormatCorrection(seed: boolean, reason?: OutputDiagnosis): string {
    return '\n\nWRITER_OUTPUT_FORMAT_REPAIR_V1\n'
        + (reason === 'seed-scope-overrun'
            ? 'The previous response reached its output cap while writing multiple test methods outside the requested single-test seed scope. '
            : 'The previous response reached its output cap and repeated instructions or test wrappers without recognizable unittest assertions. ')
        + 'Do not repeat instructions, headings, source implementation or analysis. '
        + (seed ? 'Return exactly ONE runnable unittest method and ONE real target call inside a complete test file. '
            : 'Return only the test artifact in the ORIGINAL requested scope; preserve the required baseline and repair boundaries. ')
        + 'Use one Python code fence, explicit imports and evidence-supported self.assert* checks. '
        + 'All original target, input, fixture, expected-value and safety requirements remain binding. '
        + 'Close the fence and stop. The discarded response is not a candidate; no partial content is supplied for completion.';
}
