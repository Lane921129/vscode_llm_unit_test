import type { SemanticAnalysis } from '../prompts/semanticAnalyzerPrompt';

export interface SemanticTraceParameter {
    name: string;
    kind: 'positional_only' | 'positional_or_keyword' | 'keyword_only' | 'var_positional' | 'var_keyword';
    required: boolean;
    default?: string | null;
}

export interface SemanticTraceInput {
    args: unknown[];
    kwargs: Record<string, unknown>;
}

type SafeScalar = string | number | boolean | null;

const MAX_VALUES_PER_PARAMETER = 4;
const MAX_CANDIDATE_CALLS = 12;

/**
 * Parse only a tiny, JSON-compatible subset of Python literal repr syntax.
 * Model text is never evaluated: composite literals, expressions, calls, and
 * escape-heavy strings stay suggestions for the Writer instead of Trace input.
 */
export function parseSafeSemanticScalar(value: string): SafeScalar | undefined {
    const source = value.trim();
    if (!source || source.length > 200) {return undefined;}
    if (source === 'None') {return null;}
    if (source === 'True') {return true;}
    if (source === 'False') {return false;}
    if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(source)) {
        const number = Number(source);
        return Number.isFinite(number) ? number : undefined;
    }
    if (source.startsWith('"') && source.endsWith('"')) {
        try {
            const decoded = JSON.parse(source);
            return typeof decoded === 'string' && decoded.length <= 160 ? decoded : undefined;
        } catch {
            return undefined;
        }
    }
    if (source.startsWith("'") && source.endsWith("'")) {
        const inner = source.slice(1, -1);
        // Supporting plain single-quoted repr values covers normal Python AST
        // literals without implementing an evaluator or escape interpreter.
        return !/[\\\r\n']/.test(inner) && inner.length <= 160 ? inner : undefined;
    }
    return undefined;
}

function uniqueScalars(values: SafeScalar[]): SafeScalar[] {
    const seen = new Set<string>();
    return values.filter(value => {
        const key = JSON.stringify(value);
        if (seen.has(key)) {return false;}
        seen.add(key);
        return true;
    });
}

function inputKey(input: SemanticTraceInput): string {
    return JSON.stringify({ args: input.args, kwargs: input.kwargs });
}

/**
 * Turn analyzer-proposed scalar boundaries into bounded, complete calls. A
 * call is emitted only when every required non-variadic parameter has either a
 * safely parsed suggestion or a source default. Dynamic Trace still executes
 * every call and is the sole source of result/exception assertions.
 */
export function buildSemanticTraceCandidates(
    analysis: Pick<SemanticAnalysis, 'test_strategy'>,
    signature: readonly SemanticTraceParameter[] | undefined
): SemanticTraceInput[] {
    if (!signature || signature.length === 0) {return [];}
    const fixedParameters = signature.filter(parameter =>
        parameter.kind === 'positional_only'
        || parameter.kind === 'positional_or_keyword'
        || parameter.kind === 'keyword_only'
    );
    if (fixedParameters.length === 0 || signature.some(parameter =>
        parameter.required && (parameter.kind === 'var_positional' || parameter.kind === 'var_keyword')
    )) {
        return [];
    }

    const suggestions = new Map<string, SafeScalar[]>();
    for (const hint of analysis.test_strategy.input_hints || []) {
        const parameter = fixedParameters.find(candidate => candidate.name === hint.param_name);
        if (!parameter) {continue;}
        const parsed = uniqueScalars(
            [...hint.boundary_inputs, ...hint.invalid_inputs]
                .map(parseSafeSemanticScalar)
                .filter((value): value is SafeScalar => value !== undefined)
        ).slice(0, MAX_VALUES_PER_PARAMETER);
        if (parsed.length > 0) {
            suggestions.set(parameter.name, parsed);
        }
    }

    const baseline = new Map<string, SafeScalar>();
    for (const parameter of fixedParameters) {
        const suggested = suggestions.get(parameter.name);
        if (suggested?.length) {
            baseline.set(parameter.name, suggested[0]);
            continue;
        }
        const defaultValue = typeof parameter.default === 'string'
            ? parseSafeSemanticScalar(parameter.default)
            : undefined;
        if (defaultValue !== undefined) {
            baseline.set(parameter.name, defaultValue);
            continue;
        }
        if (parameter.required || parameter.kind === 'positional_only') {
            return [];
        }
    }

    const materialize = (values: ReadonlyMap<string, SafeScalar>): SemanticTraceInput => {
        const args = fixedParameters
            .filter(parameter => parameter.kind === 'positional_only')
            .map(parameter => values.get(parameter.name));
        const kwargs: Record<string, unknown> = {};
        for (const parameter of fixedParameters) {
            if (parameter.kind === 'positional_only') {continue;}
            const value = values.get(parameter.name);
            if (value !== undefined) {kwargs[parameter.name] = value;}
        }
        return { args, kwargs };
    };

    const candidates = [materialize(baseline)];
    for (const parameter of fixedParameters) {
        for (const value of suggestions.get(parameter.name) || []) {
            const values = new Map(baseline);
            values.set(parameter.name, value);
            candidates.push(materialize(values));
        }
    }
    const seen = new Set<string>();
    return candidates.filter(candidate => {
        const key = inputKey(candidate);
        if (seen.has(key)) {return false;}
        seen.add(key);
        return true;
    }).slice(0, MAX_CANDIDATE_CALLS);
}
