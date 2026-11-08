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

export interface SpecPrediction {
    kind: 'return' | 'raise';
    value: string;
    basis: string;
}

const SYSTEM = [
    'You predict what a Python function should do according to its specification.',
    'You cannot see the implementation. Use only the docstring, type annotations and requirements given.'
].join('\n');

function specLines(spec: SpecSources, row: CaseRow, functionName: string): string[] {
    const call = needsSetup(row.call) ? [`Inputs: ${row.call.needsSetup}`] : [`Call: ${functionName}(*${row.call.args}, **${row.call.kwargs})`];
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
        `Scenario: ${row.scenario}`,
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
