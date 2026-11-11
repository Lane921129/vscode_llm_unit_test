/**
 * Spec-oracle grading per architecture 1.3, used as the row stage's decideExpected hook.
 *
 * k independent predictions per row (each with at most one format correction),
 * compared in Python (3.3). Grades:
 *   spec-matched        consistent and equal to the captured outcome -> formal test, expected from spec
 *   spec-mismatch       consistent, different, every basis verified  -> NOT in formal tests; spec value goes to test_spec_mismatch.py
 *   needs-review        consistent, different, basis unverified      -> formal test with the observed value, listed for review
 *   prediction-unstable inconsistent or missing predictions          -> formal test with the observed value
 * Observed values are never used to correct a prediction.
 */
import { pythonToolPath } from '../pythonTools';
import { runSpawn } from '../../utils/processRunner';
import { CasePrediction, CaseRow } from './caseTable';
import { CaptureReport } from './rowExecution';
import { RowExpectation } from './rowToTest';
import { observedExpectation } from './runRowStage';
import { SpecSources, basisVerified } from './specSources';
import { SPEC_PREDICTION_COUNT, SPEC_PREDICTION_TEMPERATURE, SpecPrediction, getSpecPredictionCorrectionPrompt, getSpecPredictionPrompt, parseSpecPrediction } from '../../roles/specOracle';

export interface OracleComparison {
    parsed: boolean;
    consistent: boolean;
    matchesActual: boolean;
    actualLiteral: boolean;
}

export interface SpecDeciderOptions {
    spec: SpecSources;
    functionName: string;
    ask: (system: string, user: string, options: { role: 'analyst-spec' | 'analyst-spec-correction'; temperature?: number }) => Promise<string>;
    /** Test seam; defaults to python_scripts/case_oracle_compare.py. */
    compare?: (request: object) => Promise<OracleComparison>;
    python: string;
    k?: number;
}

export function createSpecDecider(options: SpecDeciderOptions) {
    const k = options.k ?? SPEC_PREDICTION_COUNT;
    const compare = options.compare ?? (async (request: object) => {
        const run = await runSpawn(options.python, ['-B', pythonToolPath('caseOracleCompare')], { timeout: 10000, input: JSON.stringify(request) });
        const report = JSON.parse(run.stdout);
        if (report.error) { throw new Error(`case-oracle-compare-failed: ${report.error}`); }
        return report as OracleComparison;
    });

    async function predictOnce(row: CaseRow): Promise<SpecPrediction | null> {
        const prompt = getSpecPredictionPrompt(options.spec, row, options.functionName);
        const first = await options.ask(prompt.system, prompt.user, { role: 'analyst-spec', temperature: SPEC_PREDICTION_TEMPERATURE });
        const parsed = parseSpecPrediction(first);
        if (parsed) { return parsed; }
        const correction = getSpecPredictionCorrectionPrompt(options.spec, row, options.functionName, first);
        return parseSpecPrediction(await options.ask(correction.system, correction.user, { role: 'analyst-spec-correction', temperature: SPEC_PREDICTION_TEMPERATURE }));
    }

    return async function decideExpected(row: CaseRow, capture: CaptureReport): Promise<{ row: CaseRow; expectation: RowExpectation | null }> {
        const predictions: SpecPrediction[] = [];
        let missing = false;
        for (let attempt = 0; attempt < k; attempt++) {
            const prediction = await predictOnce(row);
            if (prediction) { predictions.push(prediction); } else { missing = true; }
        }
        const recorded: CasePrediction[] = predictions.map(item => ({ ...item, basisVerified: basisVerified(item.basis, options.spec) }));
        const observed = observedExpectation({ ...row, predictions: recorded }, capture);
        if (missing) { return { row: { ...observed.row, oracleStatus: 'prediction-unstable' }, expectation: observed.expectation }; }
        const comparison = await compare({ actual: capture.actual, actualMro: capture.exception?.mro ?? [], predictions });
        if (!comparison.consistent) { return { row: { ...observed.row, oracleStatus: 'prediction-unstable' }, expectation: observed.expectation }; }
        if (!comparison.actualLiteral) { return observed; }
        if (comparison.matchesActual) {
            return { row: { ...observed.row, expected: { ...capture.actual!, source: 'spec', confirmedBySpec: true }, oracleStatus: 'spec-matched' },
                expectation: observed.expectation };
        }
        if (recorded.every(item => item.basisVerified)) {
            const spec = predictions[0];
            return { row: { ...observed.row, expected: { kind: spec.kind, value: spec.value, source: 'spec', confirmedBySpec: true },
                oracleStatus: 'spec-mismatch' }, expectation: null };
        }
        return { row: { ...observed.row, oracleStatus: 'needs-review' }, expectation: observed.expectation };
    };
}
