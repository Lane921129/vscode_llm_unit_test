import { spawn, ChildProcess } from 'node:child_process';
import { currentExecution } from '../pipeline/executionContext';

/** Kill only the child tree owned by this runner. */
export function killProcessTree(proc: ChildProcess): void {
    if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) { return; }
    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
            windowsHide: true, stdio: 'ignore', shell: false
        });
        killer.on('error', () => { proc.kill(); });
        killer.on('close', code => {
            if (code !== 0) { proc.kill(); }
        });
    } else {
        try { process.kill(-proc.pid, 'SIGKILL'); }
        catch { proc.kill('SIGKILL'); }
    }
}

/** Argument-array execution with cancellation scoped to the originating run. */
export function runSpawn(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; input?: string }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const context = currentExecution();
    return new Promise((resolve, reject) => {
        context?.throwIfCancelled();
        const proc = spawn(command, args, {
            cwd: options.cwd, env: options.env ?? process.env,
            detached: process.platform !== 'win32', shell: false, windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        const release = context?.onCancel(() => { killProcessTree(proc); });
        const timer = options.timeout ? setTimeout(() => {
            killProcessTree(proc);
            reject(new Error(`執行超時 (超過 ${options.timeout! / 1000} 秒)`));
        }, options.timeout) : undefined;
        const cleanup = () => {
            if (timer) { clearTimeout(timer); }
            release?.();
        };
        proc.stdout.on('data', data => { stdout += data.toString(); });
        proc.stderr.on('data', data => { stderr += data.toString(); });
        proc.stdin.on('error', error => {
            if ((error as NodeJS.ErrnoException).code !== 'EPIPE') { reject(error); }
        });
        proc.on('error', error => { cleanup(); reject(error); });
        proc.on('close', code => {
            cleanup();
            if (context?.cancelled) { reject(new Error('使用者強制中止')); }
            else { resolve({ stdout, stderr, code }); }
        });
        proc.stdin.end(options.input);
    });
}
