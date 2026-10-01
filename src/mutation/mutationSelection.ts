import { localize } from '../i18n/core';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { pythonToolPath } from '../pipeline/pythonTools';
import { MutationEngineSelection } from './mutationExecution';
import { BUILTIN_MUTATION_OPERATOR_SET_VERSION } from './mutationResult';

export interface SelectedMutationEngine {
    requested: MutationEngineSelection;
    actual: MutationEngineSelection;
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
    if (typeof selected !== 'string' || !['builtin', 'mutatest', 'mutmut'].includes(selected)
        || typeof concurrency !== 'number' || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
        throw new AnalysisStageError('environment', 'mutation-preflight', localize('突變引擎或並行數設定無效；並行數須為 1 至 4。'));
    }
    const requested = selected as MutationEngineSelection;
    const base = { requested, actual: requested, workers: concurrency, executionBackend: 'isolated-unittest-v1' as const };
    if (requested === 'builtin') { return { ...base, operatorSetVersion: BUILTIN_MUTATION_OPERATOR_SET_VERSION }; }
    const result = await probe(['-B', pythonToolPath('externalMutation'), '--probe', requested]);
    let value: any;
    try { value = JSON.parse(result.stdout); } catch { /* Safe diagnostic below, no arbitrary tool output. */ }
    if (result.code !== 0 || !value || value.engine !== requested || value.supported !== true) {
        const reason = value && typeof value.diagnosticCode === 'string'
            && Object.prototype.hasOwnProperty.call(probeReasons, value.diagnosticCode) ? probeReasons[value.diagnosticCode] : undefined;
        throw new AnalysisStageError('environment', 'mutation-preflight',
            localize(reason || '外部突變引擎預檢失敗，請核對所選 Python、套件版本與平台。'),
            { requested, reasonCode: reason ? value.diagnosticCode : 'invalid-probe' });
    }
    if (requested !== 'mutatest' || value.operatorSetVersion !== 'mutatest-ast-3.1.0-v1'
        || value.engineVersion !== '3.1.0') {
        throw new AnalysisStageError('environment', 'mutation-preflight', localize('外部引擎版本不相容；目前 Mutatest 支援 3.1.0。'));
    }
    return { ...base, operatorSetVersion: value.operatorSetVersion, engineVersion: value.engineVersion };
}

export function mutationArguments(selection: SelectedMutationEngine, source: string, tests: string,
    target: string, className: string, stageSeconds: number): string[] {
    const args = [source, tests, '0', String(Math.min(5, stageSeconds)), target, className,
        String(stageSeconds), String(selection.workers)];
    return selection.actual === 'builtin'
        ? [pythonToolPath('mutation'), ...args, selection.operatorSetVersion]
        : [pythonToolPath('externalMutation'), selection.actual, ...args];
}
