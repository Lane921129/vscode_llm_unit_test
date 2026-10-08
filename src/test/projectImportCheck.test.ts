import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectProjectImports, verifyImportProposal } from '../environment/projectImportCheck';
import { createImportFixturePlan } from '../pipeline/importFixtures';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';
import { preflightFailureCacheSize, preflightTargetModule } from '../pipeline/modulePreflight';
import { newResourceSetupRule } from '../environment/resourceSetup';
import { canonicalExternalResourcePath } from '../pipeline/isolatedResources';
import { getLanguage, setLanguage } from '../i18n/core';

test('observed absolute mkdir retains an exact external proposal without reading or writing original data', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'external-import-'));
    const root = path.join(base, 'selected', 'app'); fs.mkdirSync(root, { recursive: true });
    const external = canonicalExternalResourcePath(path.join(base, 'external', 'data'));
    fs.mkdirSync(external, { recursive: true }); fs.writeFileSync(path.join(external, 'existing.txt'), 'original must remain untouched');
    const file = path.join(root, 'sample.py');
    const source = 'from pathlib import Path\n' + `DATA = Path(${JSON.stringify(external)})\n`
        + 'DATA.mkdir(parents=True, exist_ok=True)\n'
        + 'assert not (DATA / "existing.txt").exists()\ndef target(): return DATA.is_dir()\n';
    fs.writeFileSync(file, source);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const language = getLanguage();
    try {
        setLanguage('en');
        const first = await inspectProjectImports(root, python, [{ file, target: 'target' }], path.join(base, 'r1'), []);
        assert.equal(first.rows[0].status, 'blocked');
        assert.equal(first.rows[0].suggestion?.resourceScope, 'external-exact');
        assert.equal(first.rows[0].suggestion?.resourcePath, external);
        assert.deepEqual(first.proposedRules[0].resources, [{ path: external, scope: 'external-exact', kind: 'directory' }]);
        const report = fs.readFileSync(path.join(base, 'r1', 'import_check.md'), 'utf8');
        assert.ok(report.includes('External absolute path ' + external));
        assert.ok(report.includes('neither read nor written'));
        verifyImportProposal(first);
        const second = await inspectProjectImports(root, python, [{ file, target: 'target' }], path.join(base, 'r2'), first.proposedRules);
        assert.equal(second.rows[0].status, 'loaded', JSON.stringify(second.rows));
        assert.equal(second.proposedPlan, null);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
        assert.deepEqual(fs.readdirSync(external), ['existing.txt']);
        assert.equal(fs.readFileSync(path.join(external, 'existing.txt'), 'utf8'), 'original must remain untouched');
    } finally { setLanguage(language); fs.rmSync(base, { recursive: true, force: true }); }
});

test('parent mkdir proposals remain separate from equal project paths and recheck without touching original data', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-import-'));
    const root = path.join(parent, 'app'); fs.mkdirSync(root);
    const file = path.join(root, 'sample.py');
    const source = 'from pathlib import Path\nDATA = Path(__file__).resolve().parent.parent / "SiblingData"\n'
        + 'DATA.mkdir(parents=True, exist_ok=True)\ndef target(): return DATA.is_dir()\n';
    fs.writeFileSync(file, source);
    const original = path.join(parent, 'SiblingData'); fs.mkdirSync(original);
    fs.writeFileSync(path.join(original, 'existing.txt'), 'must remain untouched');
    const rule = newResourceSetupRule(root, file);
    rule.resources = [{ path: 'SiblingData', kind: 'directory' }];
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    try {
        const first = await inspectProjectImports(root, python, [{ file, target: 'target' }], path.join(parent, 'r1'), [rule]);
        assert.equal(first.rows[0].status, 'blocked');
        assert.equal(first.rows[0].suggestion?.resourcePath, 'SiblingData');
        assert.equal(first.rows[0].suggestion?.resourceScope, 'project-parent');
        assert.deepEqual(first.proposedRules[0].resources, [{ path: 'SiblingData', kind: 'directory' },
            { path: 'SiblingData', scope: 'project-parent', kind: 'directory' }]);
        assert.match(fs.readFileSync(path.join(parent, 'r1/import_check.md'), 'utf8'), /專案父層邏輯路徑 \.\.\/SiblingData/);
        verifyImportProposal(first);
        const second = await inspectProjectImports(root, python, [{ file, target: 'target' }], path.join(parent, 'r2'), first.proposedRules);
        assert.equal(second.rows[0].status, 'loaded', JSON.stringify(second.rows));
        assert.equal(second.proposedPlan, null);
        assert.deepEqual(fs.readdirSync(original), ['existing.txt']);
        assert.equal(fs.readFileSync(path.join(original, 'existing.txt'), 'utf8'), 'must remain untouched');
        assert.equal(fs.existsSync(path.join(root, 'SiblingData')), false);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('mkdir that requires an absent directory does not receive a contradictory pre-created resource proposal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdir-absent-'));
    try {
        const file = path.join(root, 'sample.py');
        fs.writeFileSync(file, 'from pathlib import Path\nPath("data").mkdir()\ndef target(): return 1\n');
        const result = await inspectProjectImports(root, resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')),
            [{ file, target: 'target' }], path.join(root, 'output'), []);
        assert.equal(result.rows[0].status, 'blocked');
        assert.equal(result.rows[0].suggestion, undefined);
        assert.equal(result.proposedPlan, null);
        assert.deepEqual(result.proposedRules, []);
        assert.equal(fs.existsSync(path.join(root, 'data')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('after mkdir setup the next import exception is persisted with its type, message and source position', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-detail-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    try {
        const file = path.join(root, 'sample.py');
        const source = 'from pathlib import Path\nPath("must_not_exist").mkdir(exist_ok=True)\n'
            + 'raise ValueError("invalid setup mode")\ndef target():\n    return 1\n';
        fs.writeFileSync(file, source);
        const targets = [{ file, target: 'target' }];
        const first = await inspectProjectImports(root, python, targets, path.join(root, 'r1'), []);
        assert.equal(first.rows[0].issue?.kind, 'import-side-effect');
        const second = await inspectProjectImports(root, python, targets, path.join(root, 'r2'), first.proposedRules);
        const saved = JSON.parse(fs.readFileSync(path.join(root, 'r2/import_check.json'), 'utf8'));
        assert.equal(saved.blocked, 1);
        assert.ok(saved.fixtureId, 'setup applied but loading is still blocked');
        assert.deepEqual(saved.rows[0].diagnostic, { exceptionType: 'ValueError', message: 'invalid setup mode' });
        assert.deepEqual(saved.rows[0].issue.origin, { file: 'sample.py', line: 3 });
        const report = fs.readFileSync(path.join(root, 'r2/import_check.md'), 'utf8');
        assert.match(report, /逐模組診斷/);
        assert.match(report, /例外：ValueError/);
        assert.match(report, /原因：invalid setup mode/);
        assert.match(report, /位置：sample.py:3/);
        assert.equal(second.proposedPlan, null, 'unknown exceptions must not cause a guessed fixture');
        assert.equal(fs.readFileSync(file, 'utf8'), source);
        assert.equal(fs.existsSync(path.join(root, 'r2/must_not_exist')), false);

        fs.writeFileSync(file, 'raise AttributeError("module \'example_vendor\' has no attribute \'launch\'")\ndef target():\n    return 1\n');
        const api = await inspectProjectImports(root, python, targets, path.join(root, 'r3'), []);
        assert.equal(api.rows[0].issue?.issue, 'example_vendor.launch');
        assert.equal(api.proposedPlan, null);
        fs.writeFileSync(file, 'raise RuntimeError("password=private-value")\ndef target():\n    return 1\n');
        await inspectProjectImports(root, python, targets, path.join(root, 'r4'), []);
        for (const name of ['import_check.json', 'import_check.md']) {
            const text = fs.readFileSync(path.join(root, 'r4', name), 'utf8');
            assert.equal(text.includes('private-value'), false);
            assert.match(text, /RuntimeError/);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('shared import initialization is diagnosed, previewed and rechecked without source edits or invented APIs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-setup-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    try {
        const app = path.join(root, 'app'); fs.mkdirSync(app);
        const source = 'from pathlib import Path\nPath("must_not_exist").mkdir(exist_ok=True)\nSETTING = 3\n';
        fs.writeFileSync(path.join(app, 'config.py'), source);
        fs.writeFileSync(path.join(app, 'sample.py'), 'from config import SETTING\ndef target(value):\n    return value + SETTING\n');
        const targets = [{ file: path.join(app, 'sample.py'), target: 'target' }];
        const first = await runInExecution(new ExecutionContext({}), () => inspectProjectImports(root, python, [...targets, ...targets], path.join(root, 'r1'), []));
        assert.equal(first.rows.length, 1, 'one check per source file');
        assert.equal(first.rows[0].status, 'blocked');
        assert.equal(first.rows[0].issue?.kind, 'import-side-effect');
        assert.equal(first.proposedRules[0].file, 'app/config.py');
        assert.deepEqual(first.proposedRules[0].resources, [{ path: 'must_not_exist', kind: 'directory' }]);
        assert.match(first.proposedRules[0].resourceSourceHash!, /^[a-f0-9]{64}$/);
        verifyImportProposal(first);
        assert.equal(fs.existsSync(path.join(root, 'r1/must_not_exist')), false);
        const second = await runInExecution(new ExecutionContext({}), () => inspectProjectImports(root, python, targets, path.join(root, 'r2'), first.proposedRules, undefined, root));
        assert.equal(second.rows[0].status, 'loaded');
        assert.equal(fs.readFileSync(path.join(app, 'config.py'), 'utf8'), source);
        assert.equal(fs.existsSync(path.join(root, 'r2/must_not_exist')), false);
        assert.equal(createImportFixturePlan(app, [{ file: 'config.py', mkdir: true }], root), null);
        const switched = await inspectProjectImports(app, python,
            targets, path.join(root, 'switched'),
            [{ file: 'obsolete.py', mkdir: true }], undefined, root);
        assert.equal(switched.rows[0].status, 'blocked', 'switching roots cannot borrow an old mkdir approval');
        assert.equal(switched.rows[0].issue?.kind, 'import-side-effect');
        assert.ok(switched.proposedRules.every(rule => rule.file !== 'obsolete.py'));
        fs.appendFileSync(path.join(app, 'config.py'), '# changed\n');
        assert.throws(() => verifyImportProposal(first), /過期|變更|expired/);

        fs.writeFileSync(path.join(app, 'vendor.py'), 'version = "fixture"\n');
        fs.writeFileSync(path.join(app, 'api_case.py'), 'import vendor\nvendor.launch()\ndef target():\n    return 1\n');
        const incompatible = await inspectProjectImports(root, python, [{ file: path.join(app, 'api_case.py'), target: 'target' }], path.join(root, 'r3'), []);
        assert.equal(incompatible.rows[0].issue?.kind, 'dependency-api');
        assert.equal(incompatible.rows[0].issue?.issue, 'vendor.launch');
        assert.equal(incompatible.proposedPlan, null, 'never propose mocking an API that does not exist');
        fs.writeFileSync(path.join(app, 'missing.py'), 'import definitely_missing_dependency_for_fixture\ndef target():\n    return 1\n');
        const missing = await inspectProjectImports(root, python, [{ file: path.join(app, 'missing.py'), target: 'target' }], path.join(root, 'r4'), []);
        assert.equal(missing.rows[0].issue?.kind, 'missing-dependency');
        assert.equal(missing.proposedPlan, null);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an explicit recheck observes repaired dependency code in the same execution without clearing another execution', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-recheck-cache-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const runner = require('../utils/processRunner');
    const originalRun = runner.runSpawn;
    let preflights = 0;
    runner.runSpawn = (...args: any[]) => {
        if (args[1]?.some((argument: string) => path.basename(argument) === 'module_preflight.py')) { preflights++; }
        return originalRun(...args);
    };
    try {
        const file = path.join(root, 'sample.py');
        const dependency = path.join(root, 'helper.py');
        const targetSource = 'from helper import VALUE\ndef target():\n    return VALUE\n';
        fs.writeFileSync(file, targetSource);
        fs.writeFileSync(dependency, 'raise ValueError("initial dependency failure")\nVALUE = 1\n');
        const targets = [{ file, target: 'target' }];
        const current = new ExecutionContext({}), other = new ExecutionContext({});
        const direct = (directory: string) => preflightTargetModule(python, file, 'sample',
            [root, path.dirname(root), path.dirname(path.dirname(root)), root, directory], directory, [], root);
        await runInExecution(current, async () => {
            const directory = path.join(root, 'first');
            const check = await inspectProjectImports(root, python, [...targets, ...targets], directory, []);
            assert.equal(check.rows.length, 1, 'one explicit scan does not duplicate source loads');
            assert.equal(check.rows[0].status, 'blocked');
            assert.equal(preflightFailureCacheSize(), 1);
            const count = preflights;
            await assert.rejects(direct(directory), /initial dependency failure/);
            await assert.rejects(direct(directory), /initial dependency failure/);
            assert.equal(preflights, count, 'ordinary checks still reuse the current scan failure');
        });
        await runInExecution(other, async () => {
            const check = await inspectProjectImports(root, python, targets, path.join(root, 'other'), []);
            assert.equal(check.rows[0].status, 'blocked');
            assert.equal(preflightFailureCacheSize(), 1);
        });
        assert.equal(preflights, 2);
        fs.writeFileSync(dependency, 'VALUE = 1\n');
        await runInExecution(current, async () => {
            const check = await inspectProjectImports(root, python, targets, path.join(root, 'rechecked'), []);
            assert.equal(check.rows[0].status, 'loaded', 'same-execution explicit scan must reread repaired dependency code');
            assert.equal(preflightFailureCacheSize(), 0);
        });
        assert.equal(preflights, 3);
        await runInExecution(other, async () => {
            assert.equal(preflightFailureCacheSize(), 1, 'another execution retains its snapshot');
            await assert.rejects(direct(path.join(root, 'other')), /initial dependency failure/);
            assert.equal(preflights, 3, 'invalidating current execution does not clear another execution');
            const check = await inspectProjectImports(root, python, targets, path.join(root, 'other-rechecked'), []);
            assert.equal(check.rows[0].status, 'loaded', 'each explicit recheck refreshes its own snapshot');
        });
        assert.equal(preflights, 4);
        assert.equal(fs.readFileSync(file, 'utf8'), targetSource);
    } finally {
        runner.runSpawn = originalRun;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
