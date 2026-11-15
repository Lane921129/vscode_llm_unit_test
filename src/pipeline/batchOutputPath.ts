import * as path from 'node:path';
import { localize } from '../i18n/core';
import { AnalysisStageError } from '../utils/executionFailureCategory';

export const OUTPUT_PATH_LIMIT = 250;
export const TEMP_PATH_ALLOWANCE = 60;
// Include the existing v1 loop nesting. These are estimates, never output names.
export const LONGEST_V1_ARTIFACT = 'loop/_run/executable_baseline.pending.json';
export const LONGEST_V2_ARTIFACT = 'case_table_rejections.json';
interface PathTarget { file: string; target: string }
interface PathOptions {
    batchDirectory: string;
    pipelineVersion?: string;
    targets?: readonly PathTarget[];
    platform?: NodeJS.Platform;
}
const label = (value: string, limit: number): string => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(0, limit).replace(/[. ]+$/g, '') || 'result';

/** Same label bounds and eight-character hashes as analysisOutput; no directory is created. */
export function estimateBatchOutputPath(options: PathOptions) {
    const platform = options.platform ?? process.platform;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const targetPaths = options.targets?.map(item => paths.join(`${label(paths.basename(item.file, '.py'), 16)}_00000000`,
        `${label(item.target, 20)}_00000000`));
    const longestTarget = targetPaths?.length ? targetPaths.reduce((a, b) => a.length >= b.length ? a : b)
        : paths.join('s'.repeat(25), 't'.repeat(29));
    const longestArtifact = options.pipelineVersion === 'v2-case-table' ? LONGEST_V2_ARTIFACT : LONGEST_V1_ARTIFACT;
    const estimatedLength = paths.resolve(options.batchDirectory, longestTarget, longestArtifact).length + TEMP_PATH_ALLOWANCE;
    return { estimatedLength, limit: OUTPUT_PATH_LIMIT, temporaryAllowance: TEMP_PATH_ALLOWANCE,
        longestTargetLength: longestTarget.length, longestArtifact, platform,
        blocked: platform === 'win32' && estimatedLength > OUTPUT_PATH_LIMIT };
}

export function preflightBatchOutputPath(options: PathOptions, log: (text: string) => void) {
    const result = estimateBatchOutputPath(options);
    const message = localize('批次輸出路徑估算：{0} 字；上限 {1} 字（含 60 字暫存餘裕）。建議將輸出資料夾改短，例如 C:\\r。',
        result.estimatedLength, result.limit);
    log(message);
    if (result.blocked) {
        throw new AnalysisStageError('tool', 'output-path-preflight', message, { reasonCode: 'output-path-too-long', ...result });
    }
    return result;
}

/** If the older reservation guard would reject before inventory, surface the same diagnostic first.
 * Otherwise the authoritative check uses the discovered target names before batch.start(). */
export function preflightBatchReservation(batchDirectory: string, pipelineVersion: string | undefined, log: (text: string) => void): void {
    if (process.platform === 'win32' && path.resolve(batchDirectory).length + 104 > 240) {
        preflightBatchOutputPath({ batchDirectory, pipelineVersion }, log);
    }
}
