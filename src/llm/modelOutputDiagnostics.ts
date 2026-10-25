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
    const sensitive = containsCredential(text, privacy.knownSecrets) || sensitiveAssignment.test(text);
    let remaining = Math.min(1200, Math.floor(text.length / 2));
    const samples: ModelOutputPreview['samples'] = [];
    for (const [line, count] of unique) {
        if (samples.length === 6 || remaining <= 0) { break; }
        const normalized = line.replace(/\s+/g, ' ');
        const echo = normalized.length >= 8 && excluded.some(value => normalized.includes(value) || value.includes(normalized));
        const safe = sensitive ? WITHHELD_SENSITIVE_CONTENT : echo ? '[withheld-prompt-content]' : safeLine(line);
        const limit = Math.min(240, remaining);
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
