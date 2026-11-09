/**
 * Analyst-spec prompt for the v2 spec oracle (architecture 1.3, 3.1, 5).
 *
 * The prompt is blind by construction: it is built only from SpecSources
 * (signature, docstring, annotations, requirements) and the row's scenario and
 * inputs. It never receives the function body, traces, observed outcomes or
 * any "verified" wording; specPromptBlindness.test.ts enforces this.
 */
import { CaseRow, needsSetup } from '../pipeline/caseTable/caseTable';
import { SpecSources } from '../pipeline/caseTable/specSources';

/** Architecture 1.3: each row is predicted independently k = 3 times. */
export const SPEC_PREDICTION_COUNT = 3;
/** User-approved 2026-11-09: spec predictions sample at 0.7 so k answers are independent; other roles keep their settings. */
export const SPEC_PREDICTION_TEMPERATURE = 0.7;

export interface SpecPrediction {
    kind: 'return' | 'raise';
    value: string;
    basis: string;
}

const SYSTEM = [
    'You predict what a Python function should do according to its specification.',
    'You cannot see the implementation. Use only the docstring, type annotations and requirements given.'
].join('\n');

/** Split a literal's top level on `separator`, ignoring separators inside strings and brackets. */
function splitTopLevel(text: string, separator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | undefined;
    let escaped = false;
    let current = '';
    for (const character of text) {
        if (quote) {
            current += character;
            if (escaped) { escaped = false; } else if (character === '\\') { escaped = true; } else if (character === quote) { quote = undefined; }
            continue;
        }
        if (character === "'" || character === '"') { quote = character; }
        else if ('([{'.includes(character)) { depth += 1; }
        else if (')]}'.includes(character)) { depth -= 1; }
        else if (character === separator && depth === 0) { parts.push(current.trim()); current = ''; continue; }
        current += character;
    }
    if (current.trim()) { parts.push(current.trim()); }
    return parts;
}

/** Render a validated tuple/dict literal call as ordinary Python, e.g. `f(70, 1.75)` or `f(1, key='a')`. */
export function formatSpecCall(functionName: string, args: string, kwargs: string): string {
    const trimmedArgs = args.trim();
    const positional = trimmedArgs.startsWith('(') && trimmedArgs.endsWith(')') ? splitTopLevel(trimmedArgs.slice(1, -1), ',') : [trimmedArgs];
    const trimmedKwargs = kwargs.trim();
    const entries = trimmedKwargs.startsWith('{') && trimmedKwargs.endsWith('}') ? splitTopLevel(trimmedKwargs.slice(1, -1), ',') : [];
    const keywords: string[] = [];
    for (const entry of entries) {
        const [key, ...value] = splitTopLevel(entry, ':');
        const name = /^(['"])([A-Za-z_][A-Za-z0-9_]*)\1$/.exec(key ?? '');
        if (!name || !value.length) { return `${functionName}(${[...positional, `**${trimmedKwargs}`].filter(Boolean).join(', ')})`; }
        keywords.push(`${name[2]}=${value.join(':').trim()}`);
    }
    return `${functionName}(${[...positional, ...keywords].filter(Boolean).join(', ')})`;
}

function specLines(spec: SpecSources, row: CaseRow, functionName: string): string[] {
    // User-approved 2026-11-09: no scenario text, only the call, mocks and spec sources.
    const call = needsSetup(row.call) ? [`Inputs: ${row.call.needsSetup}`] : [`Call: ${formatSpecCall(functionName, row.call.args, row.call.kwargs)}`];
    return [
        `Function: ${spec.signature}`,
        '',
        'Docstring:',
        spec.docstring ?? '(none)',
        '',
        'Type annotations:',
        ...(spec.annotations.length || spec.returns
            ? [...spec.annotations.map(item => `- ${item.name}: ${item.annotation}`), ...(spec.returns ? [`- returns: ${spec.returns}`] : [])]
            : ['(none)']),
        '',
        'Requirements:',
        ...(spec.requirements.length ? spec.requirements.map(entry => `${entry.id}: ${entry.text}`) : ['(none)']),
        '',
        ...call,
        'Mocked dependencies:',
        ...(row.mocks.length ? row.mocks.map(mock => `- ${mock.dependency} ${mock.behavior === 'raise' ? 'raises' : 'returns'} ${mock.value}`) : ['(none)'])
    ];
}

const FORMAT = [
    'Answer with one JSON object on one line:',
    '- "expect": "return <Python literal>" or "raise <ExceptionName>"',
    '- "basis": the exact sentence from the docstring or a requirement that decides the answer',
    'Example:',
    '{"expect":"return 10","basis":"Values above high are clamped to high."}'
];

export function getSpecPredictionPrompt(spec: SpecSources, row: CaseRow, functionName: string): { system: string; user: string } {
    return { system: SYSTEM, user: [...specLines(spec, row, functionName), '', ...FORMAT, 'Output only that one JSON line.'].join('\n') };
}

/** Single format correction for an unusable prediction line. */
export function getSpecPredictionCorrectionPrompt(spec: SpecSources, row: CaseRow, functionName: string, previous: string): { system: string; user: string } {
    const shown = previous.length > 300 ? previous.slice(0, 300) : previous;
    return { system: SYSTEM, user: [...specLines(spec, row, functionName), '', `Your previous answer could not be used: ${shown}`,
        ...FORMAT, 'Output only one corrected JSON line.'].join('\n') };
}

const RETURN = /^return\s+([\s\S]+)$/;
const RAISE = /^raise\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/;

export function parseSpecPrediction(response: string): SpecPrediction | null {
    const line = response.split(/\r?\n/).map(item => item.trim()).find(item => item.startsWith('{'));
    if (!line) { return null; }
    let value: unknown;
    try { value = JSON.parse(line); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return null; }
    const { expect, basis } = value as Record<string, unknown>;
    if (typeof expect !== 'string' || typeof basis !== 'string' || !basis.trim()) { return null; }
    const raised = RAISE.exec(expect.trim());
    if (raised) { return { kind: 'raise', value: raised[1], basis: basis.trim() }; }
    const returned = RETURN.exec(expect.trim());
    return returned ? { kind: 'return', value: returned[1].trim(), basis: basis.trim() } : null;
}
