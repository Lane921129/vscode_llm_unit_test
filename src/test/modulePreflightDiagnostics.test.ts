import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { preflightFailureCacheSize, preflightTargetModule } from '../pipeline/modulePreflight';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';
import { TargetBudget } from '../pipeline/targetBudget';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { ProcessTimeoutError, runSpawn } from '../utils/processRunner';
import { inspectProjectImports } from '../environment/projectImportCheck';

test('tool failures retain only structured reason codes and never become cached import failures', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-tool-'));
    const file = path.join(directory, 'sample.py'), source = 'def target(): return 1\n';
    fs.writeFileSync(file, source);
    const runner = require('../utils/processRunner'), originalRun = runner.runSpawn;
    const sensitive = 'password=private-fixture https://private.invalid/path';
    const valid = { stdout: JSON.stringify({ ok: true, module: 'sample', importPaths: [directory],
        sourceVersionsVersion: 'loaded-project-sources-v1',
        sourceVersions: [{ file, hash: createHash('sha256').update(source).digest('hex') }] }), stderr: '', code: 0 };
    const cases = [
        { result: { code: 3, stdout: sensitive, stderr: sensitive }, code: 'process-failed', exitCode: 3 },
        { result: { code: null, stdout: sensitive, stderr: sensitive }, code: 'process-failed', exitCode: null },
        { result: { code: 0, stdout: sensitive, stderr: sensitive }, code: 'invalid-result' },
        ...['null', '[]', '{"ok":false}', '{"ok":"true"}', '{"ok":false,"stage":"module-import"}'].map(stdout =>
            ({ result: { code: 0, stdout, stderr: sensitive }, code: 'invalid-result' })),
        { result: { code: 0, stdout: '{"ok":true}', stderr: '' }, code: 'invalid-result', detailCode: 'missing-or-invalid-source-versions' },
        { error: new ProcessTimeoutError(15000), code: 'timeout' },
        { error: new Error('timeout ' + sensitive), code: 'process-failed' }
    ];
    try {
        for (const item of cases) {
            let attempts = 0;
            runner.runSpawn = async () => {
                if (++attempts > 1) { return valid; }
                if ('error' in item) { throw item.error; }
                return item.result;
            };
            await runInExecution(new ExecutionContext({}), async () => {
                await assert.rejects(preflightTargetModule('python', file, 'sample', [directory], directory), error => {
                    assert.ok(error instanceof AnalysisStageError);
                    assert.equal(error.stage, 'module-preflight'); assert.equal(error.category, 'environment');
                    assert.deepEqual(error.diagnostic, { schemaVersion: 'module-preflight-tool-diagnostic-v1', reasonCode: item.code,
                        ...('exitCode' in item ? { exitCode: item.exitCode } : {}),
                        ...('detailCode' in item ? { detailCode: item.detailCode } : {}) });
                    assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /private-fixture|private\.invalid|password|stderr/);
                    return true;
                });
                assert.equal(preflightFailureCacheSize(), 0);
                assert.equal((await preflightTargetModule('python', file, 'sample', [directory], directory)).ok, true);
            });
            assert.equal(attempts, 2);
        }
    } finally { runner.runSpawn = originalRun; fs.rmSync(directory, { recursive: true, force: true }); }
});

test('module import and resolution keep their category, stage and durable cache while cancellation and deadlines propagate', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-causes-'));
    const file = path.join(directory, 'sample.py'); fs.writeFileSync(file, 'def target(): return 1\n');
    const runner = require('../utils/processRunner'), originalRun = runner.runSpawn;
    try {
        for (const stage of ['module-import', 'module-resolution']) {
            let attempts = 0;
            const diagnostic = { exception_type: 'ModuleNotFoundError', missing_module: 'fixture_missing', message: 'missing fixture' };
            runner.runSpawn = async () => { attempts++; return { code: 0, stderr: '',
                stdout: JSON.stringify({ ok: false, stage, reason: 'missing fixture', diagnostic }) }; };
            await runInExecution(new ExecutionContext({}), async () => {
                for (let repeat = 0; repeat < 2; repeat++) {
                    await assert.rejects(preflightTargetModule('python', file, 'sample', [directory], directory), error => {
                        assert.ok(error instanceof AnalysisStageError);
                        assert.equal(error.stage, stage); assert.equal(error.category, 'environment');
                        assert.deepEqual(error.diagnostic, diagnostic); return true;
                    });
                }
                assert.equal(preflightFailureCacheSize(), 1);
            });
            assert.equal(attempts, 1);
        }
        const deadline = new TargetBudget().deadlineError();
        runner.runSpawn = async () => { throw deadline; };
        await assert.rejects(preflightTargetModule('python', file, 'sample', [directory], directory), error => error === deadline);
        const execution = new ExecutionContext({});
        runner.runSpawn = async () => { execution.cancel(); throw new ProcessTimeoutError(15000); };
        await runInExecution(execution, async () => {
            await assert.rejects(preflightTargetModule('python', file, 'sample', [directory], directory), error => {
                assert.ok(error instanceof Error); assert.equal(error instanceof AnalysisStageError, false);
                assert.match(error.message, /使用者強制中止|cancel/i); return true;
            });
            assert.equal(preflightFailureCacheSize(), 0);
        });
    } finally { runner.runSpawn = originalRun; fs.rmSync(directory, { recursive: true, force: true }); }
});

test('real runner timeouts have typed identity without classifying arbitrary timeout text', async () => {
    await assert.rejects(runSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 40 }), error => {
        assert.ok(error instanceof ProcessTimeoutError); assert.equal(error.timeoutMs, 40); return true;
    });
});

test('project preflight reports retain tool failure codes without raw process output', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-report-'));
    const file = path.join(directory, 'sample.py'); fs.writeFileSync(file, 'def target(): return 1\n');
    const runner = require('../utils/processRunner'), originalRun = runner.runSpawn;
    runner.runSpawn = async (_python: string, args: string[]) => args.some(arg => arg.endsWith('ast_extractor.py'))
        ? { code: 0, stdout: '{"file_imports":[],"dependencies":[]}', stderr: '' }
        : { code: 17, stdout: '', stderr: 'password=private-fixture https://private.invalid' };
    try {
        const output = path.join(directory, 'output');
        const result = await inspectProjectImports(directory, 'python', [{ file, target: 'target' }], output, []);
        assert.equal(result.rows[0].stage, 'module-preflight');
        assert.equal(result.rows[0].issue?.issue, 'process-failed');
        assert.equal(result.rows[0].diagnostic?.reasonCode, 'process-failed');
        assert.equal(result.rows[0].diagnostic?.exitCode, 17);
        for (const name of ['import_check.json', 'import_check.md']) {
            const report = fs.readFileSync(path.join(output, name), 'utf8');
            assert.match(report, /process-failed/);
            assert.doesNotMatch(report, /private-fixture|private\.invalid|password/);
        }
    } finally { runner.runSpawn = originalRun; fs.rmSync(directory, { recursive: true, force: true }); }
});
