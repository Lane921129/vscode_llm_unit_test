/**
 * spec_mismatch.json / spec_mismatch.md and test_spec_mismatch.py (architecture 4 rows 8 and 13).
 * Spec-mismatch rows never enter the formal test file; their spec values are written to
 * test_spec_mismatch.py, which is expected to fail today and is not mutation-tested.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CaseRow, needsSetup } from './caseTable';
import { buildCaseTableTestFile, buildRowTestMethod, RowTestContext } from './rowToTest';

export const SPEC_MISMATCH_TEST_FILE = 'test_spec_mismatch.py';
const BUILTIN_EXCEPTIONS = new Set(['ArithmeticError', 'AssertionError', 'AttributeError', 'Exception', 'FileNotFoundError', 'ImportError',
    'IndexError', 'KeyError', 'LookupError', 'NotImplementedError', 'OSError', 'OverflowError', 'PermissionError', 'RecursionError',
    'RuntimeError', 'StopIteration', 'TimeoutError', 'TypeError', 'UnicodeError', 'ValueError', 'ZeroDivisionError']);

export interface SpecMismatchSummary {
    specMismatchCount: number;
    needsReviewCount: number;
    testFile: string | null;
}

function input(row: CaseRow): string {
    return needsSetup(row.call) ? `<needs-setup: ${row.call.needsSetup}>` : `${row.call.args} ${row.call.kwargs}`;
}

export function writeSpecMismatchArtifacts(directory: string, target: string, rows: readonly CaseRow[], context: RowTestContext,
    setups: ReadonlyMap<string, string>): SpecMismatchSummary {
    const mismatches = rows.filter(row => row.oracleStatus === 'spec-mismatch');
    const review = rows.filter(row => row.oracleStatus === 'needs-review');
    const entry = (row: CaseRow) => ({ id: row.id, scenario: row.scenario, category: row.category, input: input(row),
        requirementId: row.requirementId ?? null, specExpected: row.oracleStatus === 'spec-mismatch' ? row.expected ?? null : null,
        predictions: row.predictions ?? [], actual: row.actual ?? null, oracleStatus: row.oracleStatus });
    fs.writeFileSync(path.join(directory, 'spec_mismatch.json'), JSON.stringify({ version: 'spec-mismatch-v1', target,
        specMismatch: mismatches.map(entry), needsReview: review.map(entry) }, null, 2) + '\n', 'utf8');
    const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const table = (list: CaseRow[], specColumn: boolean) => list.length ? [
        `| Row | Scenario | Input | ${specColumn ? 'Spec expects' : 'Predicted'} | Basis | Actual |`, '| --- | --- | --- | --- | --- | --- |',
        ...list.map(row => {
            const predicted = specColumn ? row.expected : row.predictions?.[0];
            return `| ${row.id} | ${cell(row.scenario)} | \`${cell(input(row))}\` | ${predicted ? `${predicted.kind} ${cell(predicted.value)}` : '-'} | `
                + `${cell(row.predictions?.[0]?.basis ?? '-')}${row.predictions?.length && row.predictions.every(item => item.basisVerified) ? '' : ' (unverified)'} | `
                + `${row.actual ? `${row.actual.kind} ${cell(row.actual.value)}` : '-'} |`;
        })] : ['(none)'];
    fs.writeFileSync(path.join(directory, 'spec_mismatch.md'), [
        `# Spec mismatch: ${target}`, '',
        'Rows where every prediction agreed, the quoted basis exists in the specification, and the real result differs.',
        'These rows are not in the formal tests; their spec values are in test_spec_mismatch.py.', '',
        ...table(mismatches, true), '', '## Needs manual review', '',
        'Predictions agreed but the basis could not be found in the docstring or requirements; the formal test uses the observed value.', '',
        ...table(review, false), ''
    ].join('\n'), 'utf8');
    let testFile: string | null = null;
    const methods = mismatches.filter(row => row.expected && (!needsSetup(row.call) || setups.has(row.id)) && (context.methodKind !== 'instance' || setups.has(row.id)))
        .map(row => buildRowTestMethod(row, context, { kind: row.expected!.kind, value: row.expected!.value,
            exceptionReference: row.expected!.kind === 'raise' && BUILTIN_EXCEPTIONS.has(row.expected!.value)
                ? { kind: 'builtin', path: row.expected!.value } : null }, setups.get(row.id)));
    if (methods.length) {
        testFile = path.join(directory, SPEC_MISMATCH_TEST_FILE);
        fs.writeFileSync(testFile, buildCaseTableTestFile(context, methods), 'utf8');
    }
    return { specMismatchCount: mismatches.length, needsReviewCount: review.length, testFile };
}
