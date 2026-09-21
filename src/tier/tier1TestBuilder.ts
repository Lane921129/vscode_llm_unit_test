import { toPythonAssertionLiteral } from './tier1Literals';
import { hasVerifiedConstructorInput, traceValuePythonLiteral, typedCallFields, typedDictionaryEntries } from '../pipeline/probeInputs';
import { TraceInputSnapshot, TraceValue } from '../pipeline/evidenceContracts';
import { validTraceInputSnapshot } from '../pipeline/traceValues';

export interface Tier1TraceExample {
    input_before?: TraceInputSnapshot;
    args: string[];
    kwargs?: Record<string, string>;
    result?: string;
    result_type?: string;
    result_assertable?: boolean;
    call_assertable?: boolean;
    result_truncated?: boolean;
    result_collection_limit?: number;
    exception?: string;
    exception_module?: string;
    exception_qualname?: string;
}

function constructorExpression(className: string, argsValue: TraceValue, kwargsValue: TraceValue): string {
    const args = argsValue.items!.map(value => traceValuePythonLiteral(value as TraceValue)!);
    const keywords = typedDictionaryEntries(kwargsValue)!;
    const reserved = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
    if (keywords.every(item => typeof item.key.value === 'string' && /^[A-Za-z_]\w*$/.test(item.key.value) && !reserved.has(item.key.value))) {
        args.push(...keywords.map(item => `${item.key.value}=${traceValuePythonLiteral(item.value)}`));
    } else if (keywords.length) { args.push(`**${traceValuePythonLiteral(kwargsValue)}`); }
    return `${className}(${args.join(', ')})`;
}

/** Replay this observation's actual pre-constructor values, never another caller's setup. */
export function buildObservedConstructorCall(className: string, before: TraceInputSnapshot | undefined): string | null {
    return validTraceInputSnapshot(before) && before.replayable
        ? constructorExpression(className, before.constructor_args!.value, before.constructor_kwargs!.value) : null;
}

const builtinExceptions = new Set(('BaseException Exception ArithmeticError AssertionError AttributeError '
    + 'BufferError EOFError ImportError ModuleNotFoundError LookupError IndexError KeyError MemoryError '
    + 'NameError UnboundLocalError OSError BlockingIOError ChildProcessError ConnectionError BrokenPipeError '
    + 'ConnectionAbortedError ConnectionRefusedError ConnectionResetError FileExistsError FileNotFoundError '
    + 'InterruptedError IsADirectoryError NotADirectoryError PermissionError ProcessLookupError TimeoutError '
    + 'ReferenceError RuntimeError NotImplementedError RecursionError StopIteration StopAsyncIteration '
    + 'SyntaxError IndentationError TabError SystemError TypeError ValueError UnicodeError UnicodeDecodeError '
    + 'UnicodeEncodeError UnicodeTranslateError ZeroDivisionError OverflowError FloatingPointError').split(' '));

/** Never guess an unknown exception name or broaden it to Exception. */
export function traceExceptionReference(error: Tier1TraceExample): { expression: string; importLine?: string } | undefined {
    const module = error.exception_module;
    const name = error.exception_qualname || error.exception;
    if ((!module || module === 'builtins') && name && builtinExceptions.has(name)) {
        return { expression: name };
    }
    const dottedName = /^[\p{L}_][\p{L}\p{N}\p{M}_]*(?:\.[\p{L}_][\p{L}\p{N}\p{M}_]*)*$/u;
    if (module && name && dottedName.test(module) && dottedName.test(name)) {
        return { expression: `${module}.${name}`, importLine: `import ${module}` };
    }
    return undefined;
}

/**
 * Static caller facts for a selected instance method. Source spellings are
 * emitted by the Python AST scanner only after their corresponding values
 * pass literal evaluation, so generated Tier 1 setup never needs to guess a
 * constructor contract.
 */
export interface Tier1ConstructorContext {
    trace_input?: unknown;
    trace_constructor_args?: unknown[] | null;
    trace_constructor_kwargs?: Record<string, unknown> | null;
    constructor_args?: string[] | null;
    constructor_kwargs?: Record<string, string> | null;
}

/** Return a target-class constructor expression from verified caller literals. */
export function buildVerifiedConstructorCall(
    className: string,
    callerContexts: Tier1ConstructorContext[] | undefined
): string | null {
    const context = (callerContexts || []).find(hasVerifiedConstructorInput);
    if (!context) {
        return null;
    }
    if (Object.prototype.hasOwnProperty.call(context, 'trace_input')) {
        const values = typedCallFields(context.trace_input)!;
        // Keyword unpacking also supports literal string keys that cannot be
        // written as Python identifiers, while retaining their insertion order.
        return constructorExpression(className, values.constructor_args!, values.constructor_kwargs!);
    }
    const kwargs = Object.entries(context.constructor_kwargs || {})
        .filter(([name]) => /^[A-Za-z_]\w*$/.test(name))
        .map(([name, value]) => `${name}=${value}`);
    const args = [...(context.constructor_args || []), ...kwargs].join(', ');
    return `${className}(${args})`;
}

/** Build an instance setup block from verified caller constructor literals. */
export function buildTier1InstanceSetup(
    className: string,
    callerContexts: Tier1ConstructorContext[] | undefined
): string | null {
    const constructorCall = buildVerifiedConstructorCall(className, callerContexts);
    return constructorCall ? `    def setUp(self):\n        self._instance = ${constructorCall}` : null;
}

function buildTraceCall(funcName: string, example: Tier1TraceExample): string {
    if (validTraceInputSnapshot(example.input_before) && example.input_before.replayable) {
        return constructorExpression(funcName, example.input_before.args!.value, example.input_before.kwargs!.value);
    }
    const kwargs = Object.entries(example.kwargs || {})
        .filter(([name]) => /^[A-Za-z_]\w*$/.test(name))
        .map(([name, value]) => `${name}=${value}`);
    return `${funcName}(${[...example.args, ...kwargs].join(', ')})`;
}

function helperAlias(expression: string, base: string): string {
    let alias = base;
    while (expression.includes(alias)) { alias += '_'; }
    return alias;
}

function buildTraceResultAssignment(funcCall: string, example: Tier1TraceExample, isAsync = false): string[] {
    const asyncio = helperAlias(funcCall, '_trace_asyncio');
    const expected = toPythonAssertionLiteral(example.result, example.result_type);
    const limit = Number.isSafeInteger(example.result_collection_limit) && (example.result_collection_limit || 0) > 0
        ? example.result_collection_limit
        : 100;
    if (example.result_type === 'generator') {
        const itertools = helperAlias(funcCall, '_trace_itertools');
        const tracedValue = example.result_truncated
            ? `list(${itertools}.islice(${funcCall}, ${limit}))`
            : `list(${funcCall})`;
        return [...(example.result_truncated ? [`        import itertools as ${itertools}`] : []),
            `        result = ${tracedValue}`, `        self.assertEqual(result, ${expected})`];
    }
    if (example.result_type === 'async_generator') {
        const collect = helperAlias(funcCall, '_trace_collect');
        const collection = example.result_truncated
            ? [
                '            values = []',
                '            async for item in _trace_source:',
                '                values.append(item)',
                `                if len(values) >= ${limit}:`,
                '                    break',
                '            return values'
            ]
            : ['            return [item async for item in _trace_source]'];
        return [
            `        import asyncio as ${asyncio}`,
            `        async def ${collect}(_trace_source):`,
            ...collection,
            `        result = ${asyncio}.run(${collect}(${funcCall}))`,
            `        self.assertEqual(result, ${expected})`
        ];
    }
    const executedCall = isAsync ? `${asyncio}.run(${funcCall})` : funcCall;
    const assertion = example.result === 'None' || example.result_type === 'NoneType'
        ? 'self.assertIsNone(result)'
        : `self.assertEqual(result, ${expected})`;
    return [...(isAsync ? [`        import asyncio as ${asyncio}`] : []), `        result = ${executedCall}`, `        ${assertion}`];
}

/** Build Tier 1 tests deterministically from verified dynamic-trace facts. */
export function buildTier1TestMethods(
    funcName: string,
    examples: Tier1TraceExample[],
    errors: Tier1TraceExample[],
    isAsync = false
): string[] {
    const methods: string[] = [];

    const assertableExamples = examples.filter(example => example.call_assertable !== false && example.result_assertable !== false);
    assertableExamples.forEach((example, index) => {
        const funcCall = buildTraceCall(funcName, example);
        methods.push([
            `    def test_case_${index + 1}(self):`,
            ...buildTraceResultAssignment(funcCall, example, isAsync)
        ].join('\n'));
    });
    errors.filter(error => error.call_assertable !== false && traceExceptionReference(error)).forEach((error, index) => {
        const funcCall = buildTraceCall(funcName, error);
        const exception = traceExceptionReference(error)!.expression;
        const asyncio = helperAlias(funcCall, '_trace_asyncio');
        methods.push([
            `    def test_case_${assertableExamples.length + index + 1}(self):`,
            ...(isAsync ? [`        import asyncio as ${asyncio}`] : []),
            `        with self.assertRaises(${exception}):`,
            `            ${isAsync ? `${asyncio}.run(${funcCall})` : funcCall}`
        ].join('\n'));
    });

    return methods;
}

/** Build deterministic assertions for an instance property getter. */
export function buildTier1PropertyTestMethods(
    propertyName: string,
    examples: Tier1TraceExample[],
    errors: Tier1TraceExample[],
    instanceName = 'self._instance',
    isAsync = false
): string[] {
    const propertyAccess = `${instanceName}.${propertyName}`;
    const asyncio = helperAlias(propertyAccess, '_trace_asyncio');
    const executedAccess = isAsync ? `${asyncio}.run(${propertyAccess})` : propertyAccess;
    const methods: string[] = [];
    const assertableExamples = examples.filter(example => example.call_assertable !== false && example.result_assertable !== false);
    assertableExamples.forEach((example, index) => {
        const assertion = example.result === 'None' || example.result_type === 'NoneType'
            ? 'self.assertIsNone(result)'
            : `self.assertEqual(result, ${toPythonAssertionLiteral(example.result, example.result_type)})`;
        methods.push([
            `    def test_case_${index + 1}(self):`,
            ...(isAsync ? [`        import asyncio as ${asyncio}`] : []),
            `        result = ${executedAccess}`,
            `        ${assertion}`
        ].join('\n'));
    });
    errors.filter(error => error.call_assertable !== false && traceExceptionReference(error)).forEach((error, index) => {
        const exception = traceExceptionReference(error)!.expression;
        methods.push([
            `    def test_case_${assertableExamples.length + index + 1}(self):`,
            ...(isAsync ? [`        import asyncio as ${asyncio}`] : []),
            `        with self.assertRaises(${exception}):`,
            `            _ = ${executedAccess}`
        ].join('\n'));
    });
    return methods;
}
