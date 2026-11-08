/**
 * Host-written unittest methods for case-table rows (architecture section 4 row 7).
 *
 * The program writes the whole method: patches, call and assertion. Only rows
 * that need setup carry model-written setup lines (getRowSetupPrompt). The
 * expected value comes from row.expected (observed in PR #7, spec in PR #8).
 * tier1TestFileBuilder is not reused: it builds from trace facts and has no
 * mock support, while every row here may patch dependencies.
 */
import { CaseRow, needsSetup } from './caseTable';
import { CaseTableDependency } from './caseTableFacts';

export interface ExceptionReference {
    kind: 'builtin' | 'module';
    path: string;
}

export interface RowTestContext {
    moduleName: string;
    target: string;
    methodKind: 'module' | 'instance' | 'static' | 'class';
    isAsync: boolean;
    dependencies: readonly CaseTableDependency[];
}

export interface RowExpectation {
    kind: 'return' | 'raise';
    /** Python literal for return; exception class name for raise. */
    value: string;
    /** How the test names the raised class; null falls back to Exception plus a name check. */
    exceptionReference?: ExceptionReference | null;
}

export const ROW_TEST_CLASS = 'TestCaseTable';
const PYTHON_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function rowTestMethodName(row: Pick<CaseRow, 'id'>): string {
    return `test_${row.id.toLowerCase()}`;
}

function docstring(row: CaseRow): string {
    const text = `${row.id} ${row.category}: ${row.scenario}`.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"').replace(/\s+/g, ' ');
    return `"""${text}"""`;
}

function exceptionExpression(name: string): string {
    if (!PYTHON_NAME.test(name)) { throw new Error(`row-test-invalid-exception: ${name}`); }
    return name.includes('.') ? `target_module.${name}` : name;
}

function patchLines(row: CaseRow, context: RowTestContext): { open: string[]; configure: string[] } {
    const byName = new Map(context.dependencies.map(dependency => [dependency.name, dependency]));
    const roots = new Map<string, { variable: string; create: boolean }>();
    const configure: string[] = [];
    for (const entry of row.mocks) {
        const dependency = byName.get(entry.dependency);
        if (!dependency) { throw new Error(`row-test-unknown-dependency: ${entry.dependency}`); }
        if (!roots.has(dependency.patch)) { roots.set(dependency.patch, { variable: `mock_${roots.size}`, create: Boolean(dependency.create) }); }
        const root = roots.get(dependency.patch)!;
        const chain = dependency.chain.map(step => step === '()' ? '.return_value' : `.${step}`).join('');
        const assigned = entry.behavior === 'raise' ? `side_effect = ${exceptionExpression(entry.value)}` : `return_value = ${entry.value}`;
        configure.push(`${root.variable}${chain}.${assigned}`);
    }
    const open = [...roots.entries()].map(([patch, root]) => {
        const parts = patch.split('.');
        const parent = parts.length > 1 ? `target_module.${parts.slice(0, -1).join('.')}` : 'target_module';
        return `mock.patch.object(${parent}, '${parts[parts.length - 1]}'${root.create ? ', create=True' : ''}) as ${root.variable}`;
    });
    return { open, configure };
}

function callExpression(row: CaseRow, context: RowTestContext): string {
    const parts = context.target.split('.');
    const receiver = context.methodKind === 'instance' ? `instance.${parts[parts.length - 1]}` : `target_module.${context.target}`;
    const call = needsSetup(row.call) ? `${receiver}(*args, **kwargs)` : `${receiver}(*${row.call.args}, **${row.call.kwargs})`;
    return context.isAsync ? `asyncio.run(${call})` : call;
}

/** One complete test method (4-space class indentation). `setup` is the row's model-written setup, if any. */
export function buildRowTestMethod(row: CaseRow, context: RowTestContext, expected: RowExpectation, setup?: string): string {
    if (needsSetup(row.call) && !setup) { throw new Error(`row-test-setup-required: ${row.id}`); }
    if (context.methodKind === 'instance' && !setup) { throw new Error(`row-test-instance-required: ${row.id}`); }
    const body: string[] = [];
    const indent = (lines: string[], depth: number) => lines.map(line => line ? ' '.repeat(depth) + line : line);
    if (setup) { body.push(...setup.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\s+$/, ''))); }
    const { open, configure } = patchLines(row, context);
    const call = callExpression(row, context);
    const inner: string[] = [...configure];
    let assertion: string[] = [];
    if (expected.kind === 'raise') {
        const reference = expected.exceptionReference;
        const exception = reference ? (reference.kind === 'builtin' ? exceptionExpression(reference.path) : `target_module.${reference.path}`) : 'Exception';
        if (reference && !PYTHON_NAME.test(reference.path)) { throw new Error(`row-test-invalid-exception: ${reference.path}`); }
        inner.push(`with self.assertRaises(${exception})${reference ? '' : ' as raised'}:`, `    ${call}`);
        if (!reference) { assertion = [`self.assertEqual(type(raised.exception).__name__, ${JSON.stringify(expected.value)})`]; }
    } else {
        inner.push(`result = ${call}`);
        assertion = [`self.assertEqual(result, ${expected.value})`];
    }
    if (open.length) {
        body.push(`with ${open.join(', ')}:`, ...indent(inner, 4));
    } else {
        body.push(...inner);
    }
    body.push(...assertion);
    return [`    def ${rowTestMethodName(row)}(self):`, `        ${docstring(row)}`, ...indent(body, 8)].join('\n');
}

export function buildCaseTableTestFile(context: RowTestContext, methods: readonly string[]): string {
    if (!PYTHON_NAME.test(context.moduleName) || context.moduleName.includes('.')) {
        throw new Error(`row-test-invalid-module: ${context.moduleName}`);
    }
    return [
        'import unittest',
        'from unittest import mock',
        ...(context.isAsync ? ['import asyncio'] : []),
        `import ${context.moduleName} as target_module`,
        '',
        '',
        `class ${ROW_TEST_CLASS}(unittest.TestCase):`,
        methods.length ? methods.join('\n\n') : '    pass',
        '',
        '',
        "if __name__ == '__main__':",
        '    unittest.main()',
        ''
    ].join('\n');
}
