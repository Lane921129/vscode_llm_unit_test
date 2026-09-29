import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectProjectImports, verifyImportProposal } from '../environment/projectImportCheck';
import { createImportFixturePlan } from '../pipeline/importFixtures';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';

test('after mkdir setup the next import exception is persisted with its type, message and source position', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-detail-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    try {
        const file = path.join(root, 'sample.py');
        const source = 'from pathlib import Path\nPath("must_not_exist").mkdir()\n'
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
        const source = 'from pathlib import Path\nPath("must_not_exist").mkdir()\nSETTING = 3\n';
        fs.writeFileSync(path.join(app, 'config.py'), source);
        fs.writeFileSync(path.join(app, 'sample.py'), 'from config import SETTING\ndef target(value):\n    return value + SETTING\n');
        const targets = [{ file: path.join(app, 'sample.py'), target: 'target' }];
        const first = await runInExecution(new ExecutionContext({}), () => inspectProjectImports(root, python, [...targets, ...targets], path.join(root, 'r1'), []));
        assert.equal(first.rows.length, 1, 'one check per source file');
        assert.equal(first.rows[0].status, 'blocked');
        assert.equal(first.rows[0].issue?.kind, 'import-side-effect');
        assert.deepEqual(first.proposedRules, [{ file: 'app/config.py', mkdir: true }]);
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
        assert.throws(() => verifyImportProposal(first), /過期|變更/);

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
