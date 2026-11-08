/**
 * v2 row stage (PR #7): setup -> capture -> host-written method -> per-method run
 * -> single-row fix -> merged file -> mutation -> terminal tier.
 *
 * Expected values are observed in PR #7 (oracleStatus observed-unconfirmed);
 * PR #8 inserts spec prediction before the method is written. Terminal tiers
 * follow architecture 1.2: usable / failed (quality-passed arrives with PR #9).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CaseRow, needsSetup, transitionCaseRow } from './caseTable';
import { CaseTableFacts } from './caseTableFacts';
import { buildCaseTableTestFile, buildRowTestMethod, RowExpectation, RowTestContext, rowTestMethodName } from './rowToTest';
import { captureRow, CaptureReport, measureMutation, MutationMeasurement, RowRuntime, runTestFile, sameAssertionExpectations } from './rowExecution';
import { getRowSetupPrompt, parseRowSetupResponse } from '../../roles/unittestWriter';
import { getRowFixPrompt, parseRowFixResponse, ROW_FIX_MAX_ATTEMPTS } from '../../roles/bugFixer';

export type RowStageTerminal = 'usable' | 'failed';
export const CASE_TABLE_TEST_FILE = 'test_case_table.py';

export interface RowStageOptions {
    runtime: RowRuntime;
    facts: CaseTableFacts;
    rows: CaseRow[];
    ask: (system: string, user: string) => Promise<string>;
    mutation: { engine: unknown; workers: unknown; stageSeconds: number };
    log: (text: string) => void;
    /** PR #8 hook: decide the expected value after capture; default keeps the observed outcome. */
    decideExpected?: (row: CaseRow, capture: CaptureReport) => Promise<{ row: CaseRow; expectation: RowExpectation | null }>;
}

export interface RowStageResult {
    rows: CaseRow[];
    terminal: RowStageTerminal;
    reasonCode: string;
    testFile?: string;
    mutation?: MutationMeasurement;
    passingMethods: number;
    /** Model-written setup per row id (needed again for test_spec_mismatch.py). */
    setups: Map<string, string>;
}

export function rowTestContext(runtime: RowRuntime, facts: CaseTableFacts): RowTestContext {
    return { moduleName: path.basename(runtime.sourceFile, '.py'), target: runtime.target,
        methodKind: facts.methodKind, isAsync: facts.isAsync, dependencies: facts.dependencies };
}

export function observedExpectation(row: CaseRow, capture: CaptureReport): { row: CaseRow; expectation: RowExpectation } {
    const actual = capture.actual!;
    return {
        row: { ...row, actual, expected: { ...actual, source: 'observed', confirmedBySpec: false }, oracleStatus: 'observed-unconfirmed' },
        expectation: { ...actual, exceptionReference: capture.exception?.reference ?? null }
    };
}

export async function runRowStage(options: RowStageOptions): Promise<RowStageResult> {
    const { runtime, facts } = options;
    fs.mkdirSync(runtime.artifacts, { recursive: true });
    const context = rowTestContext(runtime, facts);
    const rows = [...options.rows];
    const passing = new Map<string, string>();
    const setups = new Map<string, string>();
    for (let index = 0; index < rows.length; index++) {
        let row = rows[index];
        if (row.status !== 'proposed') { continue; }
        let setup: string | undefined;
        if (needsSetup(row.call) || facts.methodKind === 'instance') {
            const description = needsSetup(row.call) ? row.call.needsSetup
                : `an instance of ${facts.className ?? 'the class'} for this scenario; use args = ${row.call.args} and kwargs = ${row.call.kwargs}`;
            const prompt = getRowSetupPrompt({ signature: facts.signature, className: facts.className, methodKind: facts.methodKind,
                targetName: runtime.target, source: facts.source, scenario: row.scenario, setupDescription: description });
            setup = parseRowSetupResponse(await options.ask(prompt.system, prompt.user)) ?? undefined;
            if (!setup) { rows[index] = transitionCaseRow(row, 'capture-failed', 'setup-unavailable'); continue; }
            setups.set(row.id, setup);
        }
        const capture = await captureRow(runtime, needsSetup(row.call)
            ? { id: row.id, setup, mocks: row.mocks }
            : { id: row.id, args: row.call.args, kwargs: row.call.kwargs, ...(setup ? { setup } : {}), mocks: row.mocks }, facts.dependencies);
        if (capture.status !== 'captured' || !capture.actual) {
            rows[index] = transitionCaseRow(row, 'capture-failed', capture.reason || 'capture-failed');
            continue;
        }
        row = transitionCaseRow(row, 'captured');
        const decided = options.decideExpected ? await options.decideExpected(row, capture) : observedExpectation(row, capture);
        row = decided.row;
        if (!decided.expectation) { rows[index] = row; continue; }
        let method = buildRowTestMethod(row, context, decided.expectation, setup);
        row = { ...transitionCaseRow(row, 'test-generated'), testMethod: rowTestMethodName(row) };
        let attempt = 0;
        let run = await runTestFile(runtime, `row_${row.id.toLowerCase()}_0_test`, buildCaseTableTestFile(context, [method]));
        while (!(run.passed && run.targetObserved) && attempt < ROW_FIX_MAX_ATTEMPTS) {
            attempt += 1;
            const prompt = getRowFixPrompt({ signature: facts.signature, scenario: row.scenario, methodName: row.testMethod!,
                method, error: run.error || 'The test did not call the function under test.' });
            const fixed = parseRowFixResponse(await options.ask(prompt.system, prompt.user), row.testMethod!);
            if (!fixed || !(await sameAssertionExpectations(runtime, method, fixed, row.testMethod!))) {
                options.log(`[v2] ${row.id}: fix ${attempt} rejected (method missing or expected value changed).`);
                continue;
            }
            method = fixed;
            run = await runTestFile(runtime, `row_${row.id.toLowerCase()}_${attempt}_test`, buildCaseTableTestFile(context, [method]));
        }
        if (run.passed && run.targetObserved) {
            passing.set(row.id, method);
            rows[index] = transitionCaseRow(row, 'test-passed');
        } else {
            rows[index] = transitionCaseRow(row, 'test-failed', run.passed ? 'target-not-called' : 'test-failed');
        }
    }
    if (!passing.size) { return { rows, terminal: 'failed', reasonCode: 'no-passing-row-tests', passingMethods: 0, setups }; }
    const merged = buildCaseTableTestFile(context, rows.filter(row => passing.has(row.id)).map(row => passing.get(row.id)!));
    const mergedRun = await runTestFile(runtime, path.basename(CASE_TABLE_TEST_FILE, '.py'), merged);
    if (!(mergedRun.passed && mergedRun.targetObserved)) {
        return { rows, terminal: 'failed', reasonCode: 'merged-test-failed', testFile: mergedRun.testFile, passingMethods: passing.size, setups };
    }
    const mutation = await measureMutation(runtime, mergedRun.testFile, { ...options.mutation, className: facts.className ?? '' });
    options.log(`[v2] ${passing.size} passing row tests; mutation score ${mutation.score ?? 'unavailable'}.`);
    return mutation.score === null
        ? { rows, terminal: 'failed', reasonCode: 'mutation-unmeasured', testFile: mergedRun.testFile, mutation, passingMethods: passing.size, setups }
        : { rows, terminal: 'usable', reasonCode: 'usable', testFile: mergedRun.testFile, mutation, passingMethods: passing.size, setups };
}
