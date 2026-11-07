import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { currentTargetBudget } from '../pipeline/targetBudget';

const retryDelays = [20, 40, 80, 160] as const;
const retryCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

export interface AtomicRenameRetry {
    version: 'atomic-rename-retry-v1';
    destination: string;
    errorCode: string;
    nextAttempt: number;
    maximumAttempts: 5;
    delayMs: number;
    elapsedMs: number;
}
interface AtomicRenameOptions {
    platform?: NodeJS.Platform;
    rename?: typeof fs.renameSync;
    sleep?: (milliseconds: number) => void;
    now?: () => number;
    remainingMs?: () => number;
    journal?: (retry: AtomicRenameRetry) => void;
}

/** Four Windows-only backoffs mean five total attempts and 300ms planned waiting.
 * Neither the monotonic retry window nor the existing target deadline is renewed.
 */
export function renameAtomicSync(source: string, destination: string, options: AtomicRenameOptions = {}): void {
    const rename = options.rename ?? fs.renameSync;
    const now = options.now ?? (() => performance.now());
    const remaining = options.remainingMs ?? (() => currentTargetBudget()?.remainingMs() ?? Infinity);
    const sleep = options.sleep ?? (milliseconds => { Atomics.wait(sleeper, 0, 0, milliseconds); });
    const journal = options.journal ?? (retry => {
        // Append directly, never recursively publish function knowledge to log a retry.
        fs.appendFileSync(path.join(path.dirname(destination), 'journal_io_retries.jsonl'),
            JSON.stringify(retry) + '\n', 'utf8');
    });
    const started = now();
    for (let attempt = 0; ; attempt++) {
        try { rename(source, destination); return; }
        catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            const delay = retryDelays[attempt];
            if ((options.platform ?? process.platform) !== 'win32' || !code || !retryCodes.has(code)
                || delay === undefined || now() - started + delay >= 499 || remaining() <= delay) { throw error; }
            try {
                journal({ version: 'atomic-rename-retry-v1', destination: path.basename(destination),
                    errorCode: code, nextAttempt: attempt + 2, maximumAttempts: 5,
                    delayMs: delay, elapsedMs: Math.max(0, now() - started) });
            } catch { throw error; }
            if (now() - started + delay >= 499 || remaining() <= delay) { throw error; }
            sleep(delay);
            if (now() - started >= 499 || remaining() <= 0) { throw error; }
        }
    }
}
