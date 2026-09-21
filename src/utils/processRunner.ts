import { spawn, ChildProcess } from 'node:child_process';
import { currentExecution } from '../pipeline/executionContext';
import { currentTargetBudget } from '../pipeline/targetBudget';

/** Kill only the child tree owned by this runner. */
export function killProcessTree(proc: ChildProcess): Promise<void> {
    if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) { return Promise.resolve(); }
    if (process.platform === 'win32') {
        return new Promise(resolve => {
            const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
                windowsHide: true, stdio: 'ignore', shell: false
            });
            killer.on('error', () => { proc.kill(); resolve(); });
            killer.on('close', code => {
                if (code !== 0) { proc.kill(); }
                resolve();
            });
        });
    } else {
        try { process.kill(-proc.pid, 'SIGKILL'); }
        catch { proc.kill('SIGKILL'); }
        return Promise.resolve();
    }
}

/** Argument-array execution with cancellation scoped to the originating run. */
export function runSpawn(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; input?: string }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const context = currentExecution();
    const budget = currentTargetBudget();
    return new Promise((resolve, reject) => {
        context?.throwIfCancelled();
        budget?.assertRemaining();
        const remaining = budget?.remainingMs() ?? Infinity;
        const requestedTimeout = options.timeout && options.timeout > 0 ? options.timeout : Infinity;
        const timeout = Math.min(requestedTimeout, remaining);
        const limitedByTarget = Boolean(budget) && remaining <= requestedTimeout;
        const proc = spawn(command, args, {
            cwd: options.cwd, env: options.env ?? process.env,
            detached: process.platform !== 'win32', shell: false, windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let terminationReason: Error | undefined;
        let terminationCleanup: Promise<void> | undefined;
        let release: (() => void) | undefined;
        let timer: NodeJS.Timeout | undefined;
        const cleanup = () => {
            if (timer) { clearTimeout(timer); }
            timer = undefined;
            release?.();
            release = undefined;
        };
        const terminate = (reason: Error) => {
            if (settled || terminationReason) { return; }
            terminationReason = reason;
            cleanup();
            // Wait for close before rejecting, so the caller cannot start its
            // next stage while this owned process tree is still being killed.
            terminationCleanup = killProcessTree(proc);
        };
        release = context?.onCancel(() => terminate(new Error('使用者強制中止')));
        if (!terminationReason && Number.isFinite(timeout)) {
            timer = setTimeout(() => terminate(limitedByTarget ? budget!.deadlineError()
                : new Error(`執行超時 (超過 ${timeout / 1000} 秒)`)), Math.max(1, timeout));
        }
        proc.stdout.on('data', data => { stdout += data.toString(); });
        proc.stderr.on('data', data => { stderr += data.toString(); });
        proc.stdin.on('error', error => {
            if ((error as NodeJS.ErrnoException).code !== 'EPIPE') { terminate(error); }
        });
        proc.on('error', error => { settled = true; cleanup(); reject(terminationReason || error); });
        proc.on('close', async code => {
            if (settled) { return; }
            settled = true;
            cleanup();
            await terminationCleanup;
            if (context?.cancelled) { reject(new Error('使用者強制中止')); }
            else if (terminationReason) { reject(terminationReason); }
            else { resolve({ stdout, stderr, code }); }
        });
        proc.stdin.end(options.input);
    });
}
