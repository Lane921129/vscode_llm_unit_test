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
import { CaseRow, needsSetup, nextCaseRowIndex, transitionCaseRow } from './caseTable';
import { CaseTableFacts } from './caseTableFacts';
import { TestFocus } from '../testFocus';
import { buildCaseTableTestFile, buildRowTestMethod, RowExpectation, RowTestContext, rowTestMethodName } from './rowToTest';
import { captureRow, captureSurvivorRow, CaptureReport, CoverageMeasurement, fixPreservesContract, measureCoverage, measureMutation, MutationMeasurement, RowRuntime, runTestFile, validateRowSetup } from './rowExecution';
import { getRowSetupPrompt, parseRowSetupResponse } from '../../roles/unittestWriter';
import { getRowFixPrompt, parseRowFixResponse, ROW_FIX_MAX_ATTEMPTS } from '../../roles/bugFixer';
import { getSurvivorRowPrompt, parseSurvivorRow } from '../../roles/qualityAnalyst';
import { currentStopPolicy } from '../stopPolicy';

export type RowStageTerminal = 'usable' | 'failed';
export const CASE_TABLE_TEST_FILE = 'test_case_table.py';

export interface RowStageOptions {
    runtime: RowRuntime;
    facts: CaseTableFacts;
    rows: CaseRow[];
    ask: (system: string, user: string, options: { role: 'writer-row-setup' | 'bug-fixer-row' | 'analyst-spec' | 'analyst-spec-correction' | 'quality-analyst';
        temperature?: number }) => Promise<string>;
    mutation: { engine: unknown; workers: unknown; stageSeconds: number };
    log: (text: string) => void;
    /** PR #10: whether to run Quality Analyst survivor loop (default true). */
    qualityAnalyst?: boolean;
    /** PR #13b: test focus (e.g. mutation increases survivor attempts from 3 to 6). */
    testFocus?: TestFocus;
    /** Preserved passing row methods when running supplementary rows. */
    initialPassing?: ReadonlyMap<string, string>;
    initialSetups?: ReadonlyMap<string, string>;
    /** PR #13b: file suffix for followup/supplementary rounds (e.g. '_followup'). */
    fileSuffix?: string;
    /** PR #8 hook: decide the expected value after capture; default keeps the observed outcome. */
    decideExpected?: (row: CaseRow, capture: CaptureReport) => Promise<{ row: CaseRow; expectation: RowExpectation | null }>;
}

export interface RowStageResult {
    rows: CaseRow[];
    terminal: RowStageTerminal;
    reasonCode: string;
    testFile?: string;
    mutation?: MutationMeasurement;
    /** Line/branch coverage of the merged formal test file; never decides the tier. */
    coverage?: CoverageMeasurement;
    passingMethods: number;
    /** Model-written setup per row id (needed again for test_spec_mismatch.py). */
    setups: Map<string, string>;
    passing?: Map<string, string>;
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
    const suffix = options.fileSuffix ?? '';
    const callees = [facts.methodKind === 'instance' ? `instance.${runtime.target.split('.').pop()}` : `target_module.${runtime.target}`];
    const rows = [...options.rows];
    const passing = new Map<string, string>(options.initialPassing);
    const setups = new Map<string, string>(options.initialSetups);
    for (let index = 0; index < rows.length; index++) {
        let row = rows[index];
        if (row.status !== 'proposed') { continue; }
        let setup: string | undefined;
        if (needsSetup(row.call) || facts.methodKind === 'instance') {
            const description = needsSetup(row.call) ? row.call.needsSetup
                : `an instance of ${facts.className ?? 'the class'} for this scenario; use args = ${row.call.args} and kwargs = ${row.call.kwargs}`;
            const prompt = getRowSetupPrompt({ signature: facts.signature, className: facts.className, methodKind: facts.methodKind,
                targetName: runtime.target, source: facts.source, scenario: row.scenario, setupDescription: description });
            setup = parseRowSetupResponse(await options.ask(prompt.system, prompt.user, { role: 'writer-row-setup' })) ?? undefined;
            if (!setup) { rows[index] = transitionCaseRow(row, 'capture-failed', 'setup-unavailable'); continue; }
            if (!await validateRowSetup(runtime, setup, row.id)) {
                rows[index] = transitionCaseRow(row, 'capture-failed', 'setup-forbidden-mutation');
                continue;
            }
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
        let run = await runTestFile(runtime, `row_${row.id.toLowerCase()}_0_test${suffix}`, buildCaseTableTestFile(context, [method]), false, row.id);
        while (!(run.passed && run.targetObserved) && attempt < ROW_FIX_MAX_ATTEMPTS) {
            attempt += 1;
            const prompt = getRowFixPrompt({ signature: facts.signature, scenario: row.scenario, methodName: row.testMethod!,
                method, error: run.error || 'The test did not call the function under test.' });
            const fixed = parseRowFixResponse(await options.ask(prompt.system, prompt.user, { role: 'bug-fixer-row' }), row.testMethod!);
            const verdict = fixed ? await fixPreservesContract(runtime, method, fixed, row.testMethod!, callees)
                : { accepted: false, violations: ['method-missing'] };
            if (!verdict.accepted) {
                options.log(`[v2] ${row.id}: fix ${attempt} rejected (${verdict.violations.join(', ')}).`);
                continue;
            }
            method = fixed!;
            run = await runTestFile(runtime, `row_${row.id.toLowerCase()}_${attempt}_test${suffix}`, buildCaseTableTestFile(context, [method]), false, row.id);
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
    const mergedModuleName = `${path.basename(CASE_TABLE_TEST_FILE, '.py')}${suffix}`;
    const mergedRun = await runTestFile(runtime, mergedModuleName, merged);
    if (!(mergedRun.passed && mergedRun.targetObserved)) {
        return { rows, terminal: 'failed', reasonCode: 'merged-test-failed', testFile: mergedRun.testFile, passingMethods: passing.size, setups };
    }
    const coverage = await measureCoverage(runtime, merged);
    const mutation = await measureMutation(runtime, mergedRun.testFile, { ...options.mutation, className: facts.className ?? '' });
    options.log(`[v2] ${passing.size} passing row tests; line coverage ${coverage.available ? `${coverage.linePercent}%` : `unavailable (${coverage.reasonCode})`}; `
        + `mutation score ${mutation.score ?? 'unavailable'}.`);
    if (mutation.score === null) {
        return { rows, terminal: 'failed', reasonCode: 'mutation-unmeasured', testFile: mergedRun.testFile, mutation, coverage, passingMethods: passing.size, setups };
    }

    let currentMutation = mutation;
    let currentMerged = merged;
    let currentMergedRun = mergedRun;
    let currentCoverage = coverage;

    const survivors = currentMutation.run?.mutants.filter(m => m.status === 'SURVIVED') ?? [];
    if (options.qualityAnalyst !== false && survivors.length > 0) {
        const stopPolicy = currentStopPolicy();
        const qualityNoImprovementLimit = stopPolicy?.settings.qualityNoImprovementLimit ?? 3;
        const maxAttempts = options.testFocus === 'mutation' ? 6 : 3;
        let attempts = 0;
        let noImprovementCount = 0;
        const attemptedIds = new Set<string>();

        while (attempts < maxAttempts && noImprovementCount < qualityNoImprovementLimit) {
            const remainingSurvivors = (currentMutation.run?.mutants.filter(m => m.status === 'SURVIVED') ?? [])
                .filter(m => !attemptedIds.has(m.id));
            if (!remainingSurvivors.length) { break; }
            const survivor = remainingSurvivors[0];
            attemptedIds.add(survivor.id);
            attempts += 1;

            options.log(`[v2] Quality Analyst targeting surviving mutant at line ${survivor.line} (${survivor.from} -> ${survivor.to}, attempt ${attempts}/${maxAttempts}).`);
            const prompt = getSurvivorRowPrompt({
                signature: facts.signature,
                className: facts.className ?? undefined,
                methodKind: facts.methodKind,
                source: facts.source,
                dependencies: facts.dependencies,
                survivor: {
                    line: survivor.line,
                    original: survivor.codeChange?.before ?? `${survivor.from} (line ${survivor.line})`,
                    mutated: survivor.codeChange?.after ?? `${survivor.to} (line ${survivor.line})`
                }
            });
            let reply: string;
            try {
                reply = await options.ask(prompt.system, prompt.user, { role: 'quality-analyst' });
            } catch (askError) {
                options.log(`[v2] Quality Analyst request failed: ${(askError as Error)?.message}`);
                noImprovementCount += 1;
                continue;
            }
            const candidateRow = parseSurvivorRow(reply, { firstIndex: nextCaseRowIndex(rows) });
            if (!candidateRow) {
                options.log(`[v2] Quality Analyst response could not be parsed as a case row.`);
                noImprovementCount += 1;
                continue;
            }
            let row = candidateRow;
            rows.push(row);
            const rowIndex = rows.length - 1;

            let setup: string | undefined;
            if (needsSetup(row.call) || facts.methodKind === 'instance') {
                const description = needsSetup(row.call) ? row.call.needsSetup
                    : `an instance of ${facts.className ?? 'the class'} for this scenario; use args = ${row.call.args} and kwargs = ${row.call.kwargs}`;
                const setupPrompt = getRowSetupPrompt({ signature: facts.signature, className: facts.className, methodKind: facts.methodKind,
                    targetName: runtime.target, source: facts.source, scenario: row.scenario, setupDescription: description });
                setup = parseRowSetupResponse(await options.ask(setupPrompt.system, setupPrompt.user, { role: 'writer-row-setup' })) ?? undefined;
                if (!setup) {
                    rows[rowIndex] = transitionCaseRow(row, 'capture-failed', 'setup-unavailable');
                    noImprovementCount += 1;
                    continue;
                }
                if (!await validateRowSetup(runtime, setup, row.id)) {
                    rows[rowIndex] = transitionCaseRow(row, 'capture-failed', 'setup-forbidden-mutation');
                    noImprovementCount += 1;
                    continue;
                }
                setups.set(row.id, setup);
            }

            const dualCapture = await captureSurvivorRow(runtime, needsSetup(row.call)
                ? { id: row.id, setup, mocks: row.mocks }
                : { id: row.id, args: row.call.args, kwargs: row.call.kwargs, ...(setup ? { setup } : {}), mocks: row.mocks },
                survivor, facts.dependencies);

            if (!dualCapture.distinguishable || dualCapture.status !== 'distinguishable') {
                const reason = dualCapture.reason || (dualCapture.status === 'indistinguishable' ? 'survivor-row-indistinguishable' : 'capture-failed');
                options.log(`[v2] Quality Analyst row ${row.id} not distinguishable (${reason}).`);
                rows[rowIndex] = transitionCaseRow(row, 'capture-failed', reason);
                noImprovementCount += 1;
                continue;
            }

            row = transitionCaseRow(row, 'captured');
            const decided = options.decideExpected ? await options.decideExpected(row, dualCapture.clean) : observedExpectation(row, dualCapture.clean);
            row = decided.row;
            if (!decided.expectation) {
                rows[rowIndex] = row;
                noImprovementCount += 1;
                continue;
            }

            let method = buildRowTestMethod(row, context, decided.expectation, setup);
            row = { ...transitionCaseRow(row, 'test-generated'), testMethod: rowTestMethodName(row) };
            let attempt = 0;
            let run = await runTestFile(runtime, `row_${row.id.toLowerCase()}_0_test${suffix}`, buildCaseTableTestFile(context, [method]), false, row.id);
            while (!(run.passed && run.targetObserved) && attempt < ROW_FIX_MAX_ATTEMPTS) {
                attempt += 1;
                const fixPrompt = getRowFixPrompt({ signature: facts.signature, scenario: row.scenario, methodName: row.testMethod!,
                    method, error: run.error || 'The test did not call the function under test.' });
                const fixed = parseRowFixResponse(await options.ask(fixPrompt.system, fixPrompt.user, { role: 'bug-fixer-row' }), row.testMethod!);
                const verdict = fixed ? await fixPreservesContract(runtime, method, fixed, row.testMethod!, callees)
                    : { accepted: false, violations: ['method-missing'] };
                if (!verdict.accepted) {
                    options.log(`[v2] ${row.id}: fix ${attempt} rejected (${verdict.violations.join(', ')}).`);
                    continue;
                }
                method = fixed!;
                run = await runTestFile(runtime, `row_${row.id.toLowerCase()}_${attempt}_test${suffix}`, buildCaseTableTestFile(context, [method]), false, row.id);
            }

            if (!(run.passed && run.targetObserved)) {
                rows[rowIndex] = transitionCaseRow(row, 'test-failed', run.passed ? 'target-not-called' : 'test-failed');
                noImprovementCount += 1;
                continue;
            }

            rows[rowIndex] = transitionCaseRow(row, 'test-passed');
            passing.set(row.id, method);
            if (setup) { setups.set(row.id, setup); }

            // Candidate merged test run to check mutation score improvement
            const candidateMerged = buildCaseTableTestFile(context, rows.filter(r => passing.has(r.id)).map(r => passing.get(r.id)!));
            const candidateRun = await runTestFile(runtime, `test_candidate_${row.id.toLowerCase()}${suffix}`, candidateMerged, false, row.id);
            if (!(candidateRun.passed && candidateRun.targetObserved)) {
                options.log(`[v2] Candidate merged test for survivor row ${row.id} failed; reverting.`);
                passing.delete(row.id);
                noImprovementCount += 1;
                continue;
            }

            const candidateMutation = await measureMutation(runtime, candidateRun.testFile, { ...options.mutation, className: facts.className ?? '' });
            if (candidateMutation.score !== null && (currentMutation.score === null || candidateMutation.score > currentMutation.score)) {
                options.log(`[v2] Survivor row ${row.id} improved mutation score from ${currentMutation.score} to ${candidateMutation.score}.`);
                currentMutation = candidateMutation;
                currentMerged = candidateMerged;
                currentMergedRun = candidateRun;
                currentCoverage = await measureCoverage(runtime, candidateMerged);
                noImprovementCount = 0;
            } else {
                options.log(`[v2] Survivor row ${row.id} did not improve mutation score (${candidateMutation.score} <= ${currentMutation.score}); retaining baseline.`);
                passing.delete(row.id);
                noImprovementCount += 1;
            }
        }
    }

    // Ensure the final test file contains the accepted tests
    const finalTestFileName = `${path.basename(CASE_TABLE_TEST_FILE, '.py')}${suffix}.py`;
    fs.writeFileSync(path.join(runtime.artifacts, finalTestFileName), currentMerged, 'utf8');

    return {
        rows,
        terminal: 'usable',
        reasonCode: 'usable',
        testFile: path.join(runtime.artifacts, finalTestFileName),
        mutation: currentMutation,
        coverage: currentCoverage,
        passingMethods: passing.size,
        setups,
        passing
    };
}
