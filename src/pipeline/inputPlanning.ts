import type { TraceValueSnapshot } from './evidenceContracts';
import { validTraceValueSnapshot } from './traceValues';

export type TypeShape =
    | { kind: 'scalar'; name: 'int' | 'float' | 'bool' | 'str' | 'bytes' | 'none' }
    | { kind: 'literal'; values: TraceValueSnapshot[] }
    | { kind: 'union'; members: TypeShape[] }
    | { kind: 'list' | 'set' | 'frozenset'; element: TypeShape }
    | { kind: 'tuple'; variadic: true; element: TypeShape }
    | { kind: 'tuple'; variadic: false; elements: TypeShape[] }
    | { kind: 'dict'; key: TypeShape; value: TypeShape }
    | { kind: 'unknown'; reason: string; name?: string };

export interface InputPlanSummary {
    schema_version: 'input-plan-v1'; type_shape_version: 'type-shape-v1';
    status: 'ready' | 'partial' | 'needs-input'; generated_cases: number;
    parameter_shapes: Record<string, TypeShape>;
    /** null identifies a plan-wide diagnostic, rather than a particular parameter. */
    diagnostics: Array<{ parameter: string | null; code: 'needs-input' | 'needs-fixture' | 'budget-exceeded'; reason: string }>;
    limits: Record<string, number>; stats: Record<string, number>;
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1000000;

/** Type trees are input hints only; they never establish return-value facts. */
export function validTypeShape(raw: unknown): raw is TypeShape {
    let nodes = 0;
    const visit = (value: unknown, depth: number): boolean => {
        if (++nodes > 512 || depth > 12 || !object(value)) { return false; }
        const many = (children: unknown): boolean => Array.isArray(children) && children.length <= 32
            && children.every(child => visit(child, depth + 1));
        switch (value.kind) {
            case 'scalar': return ['int', 'float', 'bool', 'str', 'bytes', 'none'].includes(value.name);
            case 'unknown': return text(value.reason) && (!('name' in value) || text(value.name));
            case 'literal': return Array.isArray(value.values) && value.values.length > 0 && value.values.length <= 32
                && value.values.every((item: unknown) => validTraceValueSnapshot(item) && item.replayable);
            case 'union': return Array.isArray(value.members) && value.members.length > 0 && many(value.members);
            case 'list': case 'set': case 'frozenset': return visit(value.element, depth + 1);
            case 'tuple': return value.variadic === true ? visit(value.element, depth + 1)
                : value.variadic === false && many(value.elements);
            case 'dict': return visit(value.key, depth + 1) && visit(value.value, depth + 1);
            default: return false;
        }
    };
    return visit(raw, 0);
}

export function validInputPlan(raw: unknown): raw is InputPlanSummary {
    const counters = (value: unknown): boolean => object(value) && Object.keys(value).length <= 24
        && Object.values(value).every(count);
    return object(raw) && raw.schema_version === 'input-plan-v1' && raw.type_shape_version === 'type-shape-v1'
        && ['ready', 'partial', 'needs-input'].includes(raw.status) && count(raw.generated_cases)
        && object(raw.parameter_shapes) && Object.keys(raw.parameter_shapes).length <= 64
        && Object.values(raw.parameter_shapes).every(validTypeShape)
        && Array.isArray(raw.diagnostics) && raw.diagnostics.length <= 128
        && raw.diagnostics.every((item: unknown) => object(item) && (item.parameter === null || text(item.parameter)) && text(item.reason)
            && ['needs-input', 'needs-fixture', 'budget-exceeded'].includes(item.code))
        && counters(raw.limits) && counters(raw.stats);
}
