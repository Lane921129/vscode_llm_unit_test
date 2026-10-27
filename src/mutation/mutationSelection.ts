import { localize } from '../i18n/core';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { pythonToolPath } from '../pipeline/pythonTools';
import { MutationEngineSelection, ExternalMutationEngine } from './mutationExecution';
import { BUILTIN_MUTATION_OPERATOR_SET_VERSION } from './mutationResult';

export interface SelectedMutationEngine {
    requested: MutationEngineSelection;
    actual: 'builtin' | ExternalMutationEngine;
    workers: number;
    operatorSetVersion: string;
    engineVersion?: string;
    executionBackend: 'isolated-unittest-v1';
}

const probeReasons: Record<string, string> = {
    'package-missing': '所選 Python 尚未安裝此外部引擎。請先在同一環境執行 python -m pip install --no-deps mutatest==3.1.0，再重新執行。',
    'unsupported-version': '外部引擎版本不相容；目前 Mutatest 支援 3.1.0。',
    'unsupported-platform': '此外部引擎尚不支援目前平台。',
    'adapter-unavailable': 'Mutmut 的隔離整合尚未完成；請選擇內建或 Mutatest。',
    'self-check-failed': '外部引擎自我檢查未通過；未開始模型請求。'
};

/** A user-selected backend is never silently replaced by another engine. */
export async function selectMutationEngine(engine: unknown, workers: unknown,
    probe: (args: string[]) => Promise<{ code: number | null; stdout: string }>): Promise<SelectedMutationEngine> {
    const selected = engine ?? 'builtin';
    const concurrency = workers ?? 2;
    if (typeof selected !== 'string' || !['builtin', 'mutatest', 'mutmut', 'auto'].includes(selected)
        || typeof concurrency !== 'number' || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
        throw new AnalysisStageError('environment', 'mutation-preflight', localize('突變引擎或並行數設定無效；並行數須為 1 至 4。'));
    }
    const requested = selected as MutationEngineSelection;
    const base = { requested, workers: concurrency, executionBackend: 'isolated-unittest-v1' as const };
    if (requested === 'builtin') { return { ...base, actual: 'builtin', operatorSetVersion: BUILTIN_MUTATION_OPERATOR_SET_VERSION }; }

    const readProbe = async (engine: ExternalMutationEngine) => {
        // Cancellation, deadline and process failures are not evidence that an
        // adapter is unavailable. Preserve them instead of starting more work.
        const result = await probe(['-B', pythonToolPath('externalMutation'), '--probe', engine]);
        let value: any;
        try { value = JSON.parse(result.stdout); } catch { /* Only fixed diagnostics leave this boundary. */ }
        if (result.code !== 0 || !value || value.schemaVersion !== 'external-mutation-probe-v1'
            || value.engine !== engine || typeof value.supported !== 'boolean') {
            throw new AnalysisStageError('environment', 'mutation-preflight',
                localize('外部突變引擎預檢失敗，請核對所選 Python、套件版本與平台。'),
                { requested, reasonCode: 'invalid-probe' });
        }
        return value;
    };
    // Keep automatic and explicit authorization on the same current adapter
    // contract. Historical/readable versions and arbitrary mutmut labels do
    // not establish an implemented, verified execution backend.
    const supported = (engine: ExternalMutationEngine, value: any) => engine === 'mutatest'
        && value.supported === true && value.operatorSetVersion === 'mutatest-ast-3.1.0-v2' && value.engineVersion === '3.1.0';
    if (requested === 'auto') {
        for (const engine of ['mutatest', 'mutmut'] as const) {
            const value = await readProbe(engine);
            if (supported(engine, value)) {
                return { ...base, actual: engine, operatorSetVersion: value.operatorSetVersion, engineVersion: value.engineVersion };
            }
        }
        return { ...base, actual: 'builtin', operatorSetVersion: BUILTIN_MUTATION_OPERATOR_SET_VERSION };
    }
    const value = await readProbe(requested);
    if (value.supported !== true) {
        const reason = value && typeof value.diagnosticCode === 'string'
            && Object.prototype.hasOwnProperty.call(probeReasons, value.diagnosticCode) ? probeReasons[value.diagnosticCode] : undefined;
        throw new AnalysisStageError('environment', 'mutation-preflight',
            localize(reason || '外部突變引擎預檢失敗，請核對所選 Python、套件版本與平台。'),
            { requested, reasonCode: reason ? value.diagnosticCode : 'invalid-probe' });
    }
    if (!supported(requested, value)) {
        throw new AnalysisStageError('environment', 'mutation-preflight', localize('外部引擎版本不相容；目前 Mutatest 支援 3.1.0。'));
    }
    return { ...base, actual: requested, operatorSetVersion: value.operatorSetVersion, engineVersion: value.engineVersion };
}

export function mutationArguments(selection: SelectedMutationEngine, source: string, tests: string,
    target: string, className: string, stageSeconds: number): string[] {
    const args = [source, tests, '0', String(Math.min(5, stageSeconds)), target, className,
        String(stageSeconds), String(selection.workers)];
    const execution = selection.actual === 'builtin'
        ? [pythonToolPath('mutation'), ...args, selection.operatorSetVersion]
        : [pythonToolPath('externalMutation'), selection.actual, ...args];
    // Builtin function-body trials may defer the selected body until after the
    // unchanged module has initialized. Mutatest still measures its own copies.
    return selection.actual === 'builtin' && target && !className && !target.includes('.')
        ? [...execution, '--activate-functions'] : execution;
}
