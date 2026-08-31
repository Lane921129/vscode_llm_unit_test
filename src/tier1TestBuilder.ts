import { toPythonAssertionLiteral } from './tier1Literals';

export interface Tier1TraceExample {
    args: string[];
    kwargs?: Record<string, string>;
    result?: string;
    result_type?: string;
    exception?: string;
}

function buildTraceCall(funcName: string, example: Tier1TraceExample): string {
    const kwargs = Object.entries(example.kwargs || {})
        .filter(([name]) => /^[A-Za-z_]\w*$/.test(name))
        .map(([name, value]) => `${name}=${value}`);
    return `${funcName}(${[...example.args, ...kwargs].join(', ')})`;
}

/** Build Tier 1 tests deterministically from verified dynamic-trace facts. */
export function buildTier1TestMethods(
    funcName: string,
    examples: Tier1TraceExample[],
    errors: Tier1TraceExample[]
): string[] {
    const methods: string[] = [];

    examples.forEach((example, index) => {
        const funcCall = buildTraceCall(funcName, example);
        const assertion = example.result === 'None' || example.result_type === 'NoneType'
            ? 'self.assertIsNone(result)'
            : `self.assertEqual(result, ${toPythonAssertionLiteral(example.result, example.result_type)})`;
        methods.push([
            `    def test_case_${index + 1}(self):`,
            `        result = ${funcCall}`,
            `        ${assertion}`
        ].join('\n'));
    });

    errors.forEach((error, index) => {
        const funcCall = buildTraceCall(funcName, error);
        const exception = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(error.exception || '')
            ? error.exception
            : 'Exception';
        methods.push([
            `    def test_case_${examples.length + index + 1}(self):`,
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
    examples.forEach((example, index) => {
        const assertion = example.result === 'None' || example.result_type === 'NoneType'
            ? 'self.assertIsNone(result)'
            : `self.assertEqual(result, ${toPythonAssertionLiteral(example.result, example.result_type)})`;
        methods.push([
            `    def test_case_${index + 1}(self):`,
            `        result = ${propertyAccess}`,
            `        ${assertion}`
        ].join('\n'));
    });
    errors.forEach((error, index) => {
        const exception = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(error.exception || '')
            ? error.exception
            : 'Exception';
        methods.push([
            `    def test_case_${examples.length + index + 1}(self):`,
            `        with self.assertRaises(${exception}):`,
            `            _ = ${propertyAccess}`
        ].join('\n'));
    });
    return methods;
}
