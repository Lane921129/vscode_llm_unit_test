import * as assert from 'assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';
import { TargetBudget, runWithTargetBudget } from '../pipeline/targetBudget';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { runSpawn } from '../utils/processRunner';

const python = path.resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');

test('cancelling an old Python process does not terminate a replacement process', async () => {
    const oldRun = new ExecutionContext(null);
    const newRun = new ExecutionContext(null);
    const oldProcess = runInExecution(oldRun, () => runSpawn(python, [
        '-B', '-c', 'import time; time.sleep(30)'
    ], { timeout: 5000 }));
    const rejected = assert.rejects(oldProcess, /中止/);
    const newProcess = runInExecution(newRun, () => runSpawn(python, [
        '-B', '-c', 'import sys; print(sys.stdin.read())'
    ], { input: 'replacement remains active', timeout: 5000 }));
    oldRun.cancel();
    await rejected;
    const result = await newProcess;
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /replacement remains active/);
});

test('cancelled contexts cannot launch another subprocess', async () => {
    const context = new ExecutionContext(null);
    context.cancel();
    await assert.rejects(runInExecution(context, () => runSpawn(python, ['-B', '-c', 'pass'], {})), /中止/);
});

test('runner preserves nonzero output and rejects a timed-out child', async () => {
    const result = await runSpawn(python, ['-B', '-c', 'import sys; print("failure evidence", file=sys.stderr); sys.exit(7)'], {});
    assert.strictEqual(result.code, 7);
    assert.match(result.stderr, /failure evidence/);
    await assert.rejects(runSpawn(python, ['-B', '-c', 'import time; time.sleep(30)'], { timeout: 100 }), /超時/);
});

test('expired target budgets cannot start a subprocess and local limits still apply', async () => {
    let now = 0;
    const budget = new TargetBudget({ timeoutMs: 10, now: () => now });
    await runWithTargetBudget(budget, async () => {
        now = 10;
        await assert.rejects(runSpawn(process.execPath, ['-e', 'process.exit(0)'], {}), (error: unknown) =>
            error instanceof AnalysisStageError && error.stage === 'target-budget' && error.category === 'timeout');
    });
    await runWithTargetBudget(new TargetBudget({ timeoutMs: 5000 }), async () => {
        await assert.rejects(runSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 }), /超時/);
    });
});

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        // Reparented POSIX children can briefly remain as already-dead zombies.
        if (process.platform === 'linux' && /\nState:\s+Z/.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))) { return false; }
        return true;
    } catch { return false; }
}

for (const mode of ['deadline', 'cancel'] as const) {
    test(`${mode} terminates only the owned process tree before rejecting`, async () => {
        const prefix = path.join(os.tmpdir(), 'target-budget-tree-');
        const directory = fs.mkdtempSync(prefix);
        const pidPath = path.join(directory, 'owned.json');
        const execution = new ExecutionContext(null);
        let pids: { parent: number; child: number } | undefined;
        const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
            const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
            fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid}));
            setInterval(()=>{},1000);`;
        const budget = new TargetBudget({ timeoutMs: mode === 'deadline' ? 1800 : 5000 });
        const owned = runInExecution(execution, () => runWithTargetBudget(budget, () =>
            runSpawn(process.execPath, ['-e', script, pidPath], { timeout: 10000 })));
        const rejected = assert.rejects(owned, (error: unknown) => mode === 'cancel' ? /中止/.test(String(error))
            : error instanceof AnalysisStageError && error.stage === 'target-budget' && error.category === 'timeout');
        const independent = runSpawn(process.execPath, ['-e', 'setTimeout(()=>console.log("independent target survived"),2000)'], { timeout: 8000 });
        try {
            for (let attempt = 0; attempt < 100 && !fs.existsSync(pidPath); attempt++) { await delay(10); }
            assert.ok(fs.existsSync(pidPath), 'owned tree must start before the cancellation/deadline test');
            pids = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
            if (mode === 'cancel') { execution.cancel(); }
            await rejected;
            assert.equal(processAlive(pids!.parent), false);
            assert.equal(processAlive(pids!.child), false);
            const result = await independent;
            assert.equal(result.code, 0, result.stderr);
            assert.match(result.stdout, /independent target survived/);
        } finally {
            execution.cancel();
            await rejected;
            await independent;
            for (const pid of pids ? [pids.parent, pids.child] : []) {
                if (processAlive(pid)) { process.kill(pid, 'SIGKILL'); }
            }
            assert.ok(directory.startsWith(prefix));
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
