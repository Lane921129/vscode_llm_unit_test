import { toPythonAssertionLiteral } from './tier1Literals';

export interface Tier1TraceExample {
    args: string[];
    kwargs?: Record<string, string>;
    result?: string;
    result_type?: string;
    result_assertable?: boolean;
    call_assertable?: boolean;
    result_truncated?: boolean;
    result_collection_limit?: number;
    exception?: string;
}

function buildTraceCall(funcName: string, example: Tier1TraceExample): string {
    const kwargs = Object.entries(example.kwargs || {})
        .filter(([name]) => /^[A-Za-z_]\w*$/.test(name))
        .map(([name, value]) => `${name}=${value}`);
    return `${funcName}(${[...example.args, ...kwargs].join(', ')})`;
}

function buildTraceResultAssignment(funcCall: string, example: Tier1TraceExample): string[] {
    const expected = toPythonAssertionLiteral(example.result, example.result_type);
    const limit = Number.isSafeInteger(example.result_collection_limit) && (example.result_collection_limit || 0) > 0
        ? example.result_collection_limit
        : 100;
    if (example.result_type === 'generator') {
        const tracedValue = example.result_truncated
            ? `list(__import__('itertools').islice(${funcCall}, ${limit}))`
            : `list(${funcCall})`;
        return [`        result = ${tracedValue}`, `        self.assertEqual(result, ${expected})`];
    }
    if (example.result_type === 'async_generator') {
        const collection = example.result_truncated
            ? [
                '            values = []',
                `            async for item in ${funcCall}:`,
                '                values.append(item)',
                `                if len(values) >= ${limit}:`,
                '                    break',
                '            return values'
            ]
            : [`            return [item async for item in ${funcCall}]`];
        return [
            '        async def collect():',
            ...collection,
            "        result = __import__('asyncio').run(collect())",
            `        self.assertEqual(result, ${expected})`
        ];
    }
    const assertion = example.result === 'None' || example.result_type === 'NoneType'
        ? 'self.assertIsNone(result)'
        : `self.assertEqual(result, ${expected})`;
    return [`        result = ${funcCall}`, `        ${assertion}`];
}

/** Build Tier 1 tests deterministically from verified dynamic-trace facts. */
export function buildTier1TestMethods(
    funcName: string,
    examples: Tier1TraceExample[],
    errors: Tier1TraceExample[]
): string[] {
    const methods: string[] = [];

    examples.filter(example => example.call_assertable !== false && example.result_assertable !== false).forEach((example, index) => {
        const funcCall = buildTraceCall(funcName, example);
        methods.push([
            `    def test_case_${index + 1}(self):`,
            ...buildTraceResultAssignment(funcCall, example)
        ].join('\n'));
    });

    const assertableExamples = examples.filter(example => example.call_assertable !== false && example.result_assertable !== false);
    errors.filter(error => error.call_assertable !== false).forEach((error, index) => {
        const funcCall = buildTraceCall(funcName, error);
        const exception = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(error.exception || '')
            ? error.exception
            : 'Exception';
        methods.push([
            `    def test_case_${assertableExamples.length + index + 1}(self):`,
            `        with self.assertRaises(${exception}):`,
            `            ${funcCall}`
        ].join('\n'));
    });

    return methods;
}

/** Build deterministic assertions for an instance property getter. */
export function buildTier1PropertyTestMethods(
    propertyName: string,
    examples: Tier1TraceExample[],
    errors: Tier1TraceExample[],
    instanceName = 'self._instance'
): string[] {
    const propertyAccess = `${instanceName}.${propertyName}`;
    const methods: string[] = [];
    examples.filter(example => example.call_assertable !== false && example.result_assertable !== false).forEach((example, index) => {
        const assertion = example.result === 'None' || example.result_type === 'NoneType'
            ? 'self.assertIsNone(result)'
            : `self.assertEqual(result, ${toPythonAssertionLiteral(example.result, example.result_type)})`;
        methods.push([
            `    def test_case_${index + 1}(self):`,
            `        result = ${propertyAccess}`,
            `        ${assertion}`
        ].join('\n'));
    });
    const assertableExamples = examples.filter(example => example.call_assertable !== false && example.result_assertable !== false);
    errors.filter(error => error.call_assertable !== false).forEach((error, index) => {
        const exception = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(error.exception || '')
            ? error.exception
            : 'Exception';
        methods.push([
            `    def test_case_${assertableExamples.length + index + 1}(self):`,
            `        with self.assertRaises(${exception}):`,
            `            _ = ${propertyAccess}`
        ].join('\n'));
    });
    return methods;
}
