import {
    buildTier1InstanceSetup,
    buildObservedConstructorCall,
    buildTier1PropertyTestMethods,
    buildTier1TestMethods,
    Tier1ConstructorContext,
    Tier1TraceExample,
    traceExceptionReference
} from './tier1TestBuilder';

export type Tier1MethodKind = 'module' | 'instance' | 'static' | 'class' | 'property';

export interface Tier1TestFileInput {
    moduleName: string;
    functionName: string;
    examples: Tier1TraceExample[];
    errors: Tier1TraceExample[];
    className?: string | null;
    methodKind?: Tier1MethodKind;
    constructorParams?: string[];
    callerContexts?: Tier1ConstructorContext[];
    isAsync?: boolean;
}

export interface Tier1TestFileResult {
    code?: string;
    methodCount: number;
    missingConstructorFacts?: string[];
}

/**
 * Build the complete deterministic Tier 1 unittest file from verified Trace
 * facts. Both the extension and corpus tests use this function so a passing
 * test exercises the same class/property binding rules users receive.
 */
export function buildTier1TestFile(input: Tier1TestFileInput): Tier1TestFileResult {
    const exceptionImports = [...new Set(input.errors.filter(error => error.call_assertable !== false)
        .map(error => traceExceptionReference(error)?.importLine).filter((line): line is string => Boolean(line)))];
    const isProperty = input.methodKind === 'property';
    const methods = isProperty
        ? buildTier1PropertyTestMethods(input.functionName, input.examples, input.errors, 'self._instance', input.isAsync)
        : buildTier1TestMethods(input.functionName, input.examples, input.errors, input.isAsync);
    if (methods.length === 0) {
        return { methodCount: 0 };
    }

    const className = input.className || undefined;
    const directClassCall = className && (input.methodKind === 'static' || input.methodKind === 'class');
    const perObservationSetup = !!className && !directClassCall
        && [...input.examples, ...input.errors].some(example => example.input_before !== undefined);
    const verifiedSetup = className && !directClassCall
        ? buildTier1InstanceSetup(className, input.callerContexts)
        : null;
    const requiredConstructorParams = input.constructorParams || [];
    if (className && !directClassCall && !perObservationSetup && requiredConstructorParams.length > 0 && !verifiedSetup) {
        return { methodCount: methods.length, missingConstructorFacts: requiredConstructorParams };
    }

    if (!className) {
        return {
            methodCount: methods.length,
            code: [
                'import unittest',
                `from ${input.moduleName} import ${input.functionName}`,
                ...exceptionImports,
                '',
                `class TestTier1${input.functionName || 'Auto'}(unittest.TestCase):`,
                methods.join('\n\n'),
                '',
                "if __name__ == '__main__':",
                '    unittest.main()',
            ].join('\n')
        };
    }

    const setupBlock = directClassCall || perObservationSetup ? '' : (verifiedSetup || [
        '    def setUp(self):',
        `        self._instance = ${className}()`,
    ].join('\n'));
    const callPrefix = directClassCall
        ? `${className}.${input.functionName}(`
        : `self._instance.${input.functionName}(`;
    let sourceMethods = methods;
    if (perObservationSetup) {
        const observations = [
            ...input.examples.filter(example => example.call_assertable !== false && example.result_assertable !== false).map(example => ({ example, error: false })),
            ...input.errors.filter(error => error.call_assertable !== false && traceExceptionReference(error)).map(example => ({ example, error: true }))
        ];
        sourceMethods = [];
        for (const [index, observation] of observations.entries()) {
            const constructor = buildObservedConstructorCall(className, observation.example.input_before);
            if (!constructor) {
                return { methodCount: methods.length, missingConstructorFacts: requiredConstructorParams.length
                    ? requiredConstructorParams : ['verified per-observation constructor input'] };
            }
            const example = observation.error ? [] : [observation.example];
            const errors = observation.error ? [observation.example] : [];
            const method = (isProperty ? buildTier1PropertyTestMethods(input.functionName, example, errors, 'self._instance', input.isAsync)
                : buildTier1TestMethods(input.functionName, example, errors, input.isAsync))[0];
            const lines = method.split('\n');
            lines[0] = `    def test_case_${index + 1}(self):`;
            lines.splice(1, 0, `        self._instance = ${constructor}`);
            sourceMethods.push(lines.join('\n'));
        }
    }
    const boundMethods = isProperty ? sourceMethods : sourceMethods.map(method =>
        method.replace(new RegExp(`(?<![._])\\b${input.functionName}\\(`, 'g'), callPrefix)
    );
    return {
        methodCount: methods.length,
        code: [
            'import unittest',
            `from ${input.moduleName} import ${className}`,
            ...exceptionImports,
            '',
            `class TestTier1${input.functionName || 'Auto'}(unittest.TestCase):`,
            setupBlock,
            '',
            boundMethods.join('\n\n'),
            '',
            "if __name__ == '__main__':",
            '    unittest.main()',
        ].join('\n')
    };
}
