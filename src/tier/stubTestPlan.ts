import { buildTier1InstanceSetup, Tier1ConstructorContext } from './tier1TestBuilder';

export interface StubTestPlan {
    importLine: string;
    setupBlock: string;
    callLine: string;
}

/**
 * Build a deterministic smoke-test invocation without inventing constructor
 * values.  The fast path is allowed only for inert bodies, but it must still
 * call the selected Python binding correctly.
 */
export function buildStubTestPlan(
    moduleName: string,
    methodName: string,
    methodArgs: string[],
    className?: string,
    methodKind: 'module' | 'instance' | 'static' | 'class' | 'property' = 'module',
    requiredConstructorParams: string[] = [],
    callerContexts?: Tier1ConstructorContext[]
): StubTestPlan | null {
    const callArgs = methodArgs.map(() => 'None').join(', ');
    if (!className) {
        return {
            importLine: `from ${moduleName} import ${methodName}`,
            setupBlock: '',
            callLine: `result = ${methodName}(${callArgs})`
        };
    }

    const directClassCall = methodKind === 'static' || methodKind === 'class';
    if (directClassCall) {
        return {
            importLine: `from ${moduleName} import ${className}`,
            setupBlock: '',
            callLine: `result = ${className}.${methodName}(${callArgs})`
        };
    }

    const verifiedSetup = buildTier1InstanceSetup(className, callerContexts);
    if (requiredConstructorParams.length > 0 && !verifiedSetup) {
        return null;
    }
    const setupBlock = verifiedSetup || [
        '    def setUp(self):',
        `        self._instance = ${className}()`,
    ].join('\n');
    return {
        importLine: `from ${moduleName} import ${className}`,
        setupBlock,
        callLine: methodKind === 'property'
            ? `result = self._instance.${methodName}`
            : `result = self._instance.${methodName}(${callArgs})`
    };
}
