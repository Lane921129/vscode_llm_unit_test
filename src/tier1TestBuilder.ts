import { toPythonAssertionLiteral } from './tier1Literals';

export interface Tier1TraceExample {
    args: string[];
    result?: string;
    result_type?: string;
    exception?: string;
}

/** Build Tier 1 tests deterministically from verified dynamic-trace facts. */
export function buildTier1TestMethods(
    funcName: string,
    examples: Tier1TraceExample[],
    errors: Tier1TraceExample[]
): string[] {
    const methods: string[] = [];

    examples.forEach((example, index) => {
        const funcCall = `${funcName}(${example.args.join(', ')})`;
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
        const funcCall = `${funcName}(${error.args.join(', ')})`;
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
