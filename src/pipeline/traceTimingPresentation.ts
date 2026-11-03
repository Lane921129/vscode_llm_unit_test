import { getLanguage } from '../i18n/core';
import { redactCredentialStrings } from './artifactSafety';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (zh: string, en: string): string => getLanguage() === 'en' ? en : zh;
const unknown = (): string => text('未知', 'unknown');
const numeric = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : unknown();
const cell = (value: unknown, maximum = 128): string => {
    if (typeof value !== 'string' || !value.trim()) { return unknown(); }
    return String(redactCredentialStrings(value)).slice(0, maximum).replace(/[\r\n\u0000-\u001f]+/g, ' ')
        .replace(/[&<>|`\[\]]/g, char => `&#${char.charCodeAt(0)};`);
};
const reason = (value: unknown): string => typeof value === 'string' && /^[a-z][a-z0-9_-]*(?::[a-z0-9_-]+)?$/.test(value)
    ? cell(value, 96) : unknown();
const planningStatuses = new Set(['completed', 'failed', 'timeout', 'worker_error']);
const caseStatuses = new Set(['returned', 'raised', 'blocked', 'setup_error', 'timeout', 'not_started', 'worker_error']);

/** Safe timing-only projection. It never reads inputs, outputs, traceback or provider text. */
export function renderTraceTiming(state: Record<string, unknown>, target: string): string {
    const sourceContext = object(state.sourceContext) ? state.sourceContext : {};
    const bundle = object(state.writerEvidenceBundle) ? state.writerEvidenceBundle : {};
    const candidates: Array<[string, unknown]> = [
        [text('初始目標 Trace', 'Initial target Trace'), state.initialTargetObservations],
        [text('補充目標 Trace', 'Supplemental target Trace'), state.supplementalTargetObservations],
        [text('初始目標 Trace', 'Initial target Trace'), bundle.initialTargetObservations],
        [text('補充目標 Trace', 'Supplemental target Trace'), bundle.supplementalTargetObservations],
        [text('來源語境 Trace', 'Source-context Trace'), sourceContext.traceResult]
    ];
    const seen = new Set<string>();
    const sections: string[] = [];
    for (const [phase, value] of candidates) {
        if (!object(value) || value.func_name !== target || typeof value.run_id !== 'string' || !value.run_id
            || value.run_id.length > 1024 || seen.has(value.run_id)) { continue; }
        seen.add(value.run_id);
        const planning = object(value.planning) ? value.planning : {};
        const timing = object(value.trace_timing) && value.trace_timing.version === 'trace-startup-budget-v1' ? value.trace_timing : {};
        const requested = object(timing.requestedTraceTiming) ? timing.requestedTraceTiming : {};
        sections.push(`#### ${phase}`, '', text('| 項目 | 狀態 | 已量測耗時（ms） |', '| Item | Status | Measured duration (ms) |'),
            '| --- | --- | --- |',
            `| ${text('整體 Trace', 'Entire Trace')} | ${value.complete === true ? text('紀錄完整', 'records complete')
                : value.complete === false ? text('紀錄不完整', 'records incomplete') : unknown()} | ${numeric(value.duration_ms)} |`,
            `| ${text('輸入規劃', 'Input planning')} | ${planningStatuses.has(planning.status) ? planning.status : unknown()} | ${numeric(planning.duration_ms)} |`, '',
            text('| 時間上限 | 使用者設定（秒） | 宿主實際分配（秒） |', '| Time allowance | User setting (s) | Host allocation (s) |'),
            '| --- | --- | --- |',
            `| ${text('整體 Trace', 'Entire Trace')} | ${numeric(requested.totalTimeoutSeconds)} | ${numeric(timing.totalTimeoutSeconds)} |`,
            `| ${text('輸入規劃', 'Input planning')} | ${numeric(requested.planningTimeoutSeconds)} | ${numeric(timing.planningTimeoutSeconds)} |`,
            `| ${text('單案例', 'Each case')} | ${numeric(requested.caseTimeoutSeconds)} | ${numeric(timing.caseTimeoutSeconds)} |`,
            `| ${text('外層程序（包含清理額度）', 'Outer process (including cleanup allowance)')} | ${unknown()} | ${typeof timing.outerTimeoutMs === 'number'
                && Number.isFinite(timing.outerTimeoutMs) && timing.outerTimeoutMs >= 0 ? numeric(timing.outerTimeoutMs / 1000) : unknown()} |`, '',
            text('| 案例 | 狀態 | 已量測耗時（ms） | 原因碼 |', '| Case | Status | Measured duration (ms) | Reason code |'),
            '| --- | --- | --- | --- |');
        const cases = Array.isArray(value.cases) ? value.cases.filter(object) : [];
        if (!cases.length) { sections.push(`| ${unknown()} | ${unknown()} | ${unknown()} | ${unknown()} |`); }
        for (const item of cases) {
            sections.push(`| ${cell(item.case_id)} | ${caseStatuses.has(item.status) ? item.status : unknown()} | ${numeric(item.duration_ms)} | ${reason(item.reason)} |`);
        }
        sections.push('');
    }
    if (!sections.length) { return ''; }
    return [text('### Trace 耗時與時間上限', '### Trace duration and time allowances'), '',
        text('以下為受控 Python 輸入規劃與案例執行，並非 LLM 思考時間。宿主分配上限仍受原目標期限約束；未知值不補成零，耗時與狀態不代表測試或突變通過。',
            'These records describe controlled Python input planning and case execution, not LLM thinking time. Host allowances remain within the original target deadline. Unknown values are not replaced with zero; timings and statuses do not certify tests or mutation.'),
        '', ...sections].join('\n');
}
