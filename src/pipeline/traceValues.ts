import { TraceInputSnapshot, TraceValueSnapshot } from './evidenceContracts';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const callFields = ['args', 'kwargs', 'constructor_args', 'constructor_kwargs'] as const;
const unavailableReasons = new Set(['snapshot-budget', 'integer-budget', 'non-finite-float', 'text-budget',
    'unsupported-type', 'cycle', 'shared-reference', 'collection-budget']);

/** Validate the actual trace_value_codec format, including bounded diagnostic sentinels. */
export function validTraceValueSnapshot(snapshot: unknown): snapshot is TraceValueSnapshot {
    if (!object(snapshot) || snapshot.schema_version !== 'trace-value-v1' || typeof snapshot.replayable !== 'boolean') { return false; }
    let nodes = 0;
    let unavailable = false;
    const hashable = (node: any): boolean => ['none', 'bool', 'int', 'float', 'str', 'bytes', 'unavailable'].includes(node.type)
        || ['tuple', 'frozenset'].includes(node.type) && node.items.every(hashable);
    const visit = (node: unknown, depth: number): boolean => {
        // The encoder may append one budget sentinel at each open collection after
        // exhausting its 512 normal nodes, and a sentinel at depth 9.
        if (!object(node) || ++nodes > 532 || depth > 9) { return false; }
        if (node.type === 'unavailable') {
            unavailable = true;
            return unavailableReasons.has(node.reason) && (node.python_type === undefined
                || typeof node.python_type === 'string' && node.python_type.length <= 4096);
        }
        if (depth > 8 || nodes > 512) { return false; }
        const value = node.value;
        switch (node.type) {
            case 'none': return value === undefined && node.items === undefined;
            case 'bool': return typeof value === 'boolean';
            case 'int': return typeof value === 'string' && value.length <= 4096 && /^-?(?:0|[1-9]\d*)$/.test(value)
                && BigInt(value).toString(2).replace('-', '').length <= 4096;
            case 'float': return typeof value === 'string' && value.length <= 40
                && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value));
            case 'str': return typeof value === 'string' && value.length <= 8192 && [...value].length <= 4096;
            case 'bytes': return typeof value === 'string' && value.length <= 8192 && /^(?:[0-9a-f]{2})*$/.test(value);
            case 'list': case 'tuple': case 'set': case 'frozenset': case 'dict': {
                if (!Array.isArray(node.items) || node.items.length > 101) { return false; }
                return node.items.every((child: unknown, index: number) => {
                    if (object(child) && child.type === 'unavailable') {
                        return (index < 100 || child.reason === 'collection-budget') && visit(child, depth + 1);
                    }
                    if (index >= 100) { return false; }
                    return node.type === 'dict' ? object(child) && visit(child.key, depth + 1) && hashable(child.key) && visit(child.value, depth + 1)
                        : visit(child, depth + 1) && (!['set', 'frozenset'].includes(node.type) || hashable(child));
                });
            }
            default: return false;
        }
    };
    return visit(snapshot.value, 0) && snapshot.replayable === !unavailable;
}

export function validTraceInputSnapshot(value: unknown, diagnostic = false): value is TraceInputSnapshot {
    if (!object(value)) { return false; }
    if (diagnostic && validTraceValueSnapshot(value.unavailable_input) && value.unavailable_input.replayable === false) { return true; }
    if (typeof value.replayable !== 'boolean' || !validTraceValueSnapshot(value.call_graph)
        || value.replayable !== value.call_graph.replayable || !callFields.every(key => validTraceValueSnapshot(value[key]))) { return false; }
    const graph = value.call_graph.value;
    if (graph.type !== 'dict' || !Array.isArray(graph.items)) { return false; }
    // Diagnostic call graphs may end in a collection-budget sentinel before
    // all four fields; retain those snapshots but never use them as inputs.
    if (!value.replayable) { return true; }
    if (graph.items.length !== 4) { return false; }
    const fields = new Map<string, unknown>();
    for (const pair of graph.items as unknown[]) {
        if (!object(pair) || pair.key?.type !== 'str' || !callFields.includes(pair.key.value)) { return false; }
        fields.set(pair.key.value, pair.value);
    }
    if (fields.size !== 4) { return false; }
    if (callFields.some(key => !value[key].replayable
        || JSON.stringify(fields.get(key)) !== JSON.stringify(value[key].value))) { return false; }
    return ['args', 'constructor_args'].every(key => ['list', 'tuple'].includes(value[key].value.type))
        && ['kwargs', 'constructor_kwargs'].every(key => value[key].value.type === 'dict');
}
