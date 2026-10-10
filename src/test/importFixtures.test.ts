import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createImportFixturePlan, currentImportFixtures, importFixtureEnvironment, withImportFixtures,
    IMPORT_FIXTURE_ENV } from '../pipeline/importFixtures';
import { runSpawn } from '../utils/processRunner';

test('cross-file schema evidence participates in plan identity and refuses drift or traversal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-dependency-'));
    try {
        fs.writeFileSync(path.join(root, 'sample.py'), 'value = 1\n');
        const dependency = path.join(root, 'settings.py'); fs.writeFileSync(dependency, 'DB = "neutral.sqlite"\n');
        const sourceHash = createHash('sha256').update(fs.readFileSync(dependency)).digest('hex');
        const rule = { file: 'sample.py', sourceDependencies: [{ file: 'settings.py', sourceHash }], pythonSourceMode: true as const };
        const plan = createImportFixturePlan(root, [rule])!;
        assert.notEqual(plan.id, createImportFixturePlan(root, [{ file: 'sample.py' }])!.id);
        assert.equal(plan.rules[0].pythonSourceMode, true);
        assert.throws(() => createImportFixturePlan(root, [{ ...rule, sourceDependencies: [{ file: '../outside.py', sourceHash }] }]), /dependency/);
        fs.appendFileSync(dependency, '# changed\n');
        assert.throws(() => createImportFixturePlan(root, [rule]), /dependency changed/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('import setup binds source content, isolates concurrent runs and reaches workers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-fixtures-'));
    try {
        fs.writeFileSync(path.join(root, 'sample.py'), 'value = 1\n');
        const first = createImportFixturePlan(root, [{ file: 'sample.py', mkdir: true }])!;
        fs.writeFileSync(path.join(root, 'sample.py'), 'value = 2\n');
        const second = createImportFixturePlan(root, [{ file: 'sample.py', mkdir: true }])!;
        assert.equal(createImportFixturePlan(root, [{ file: 'missing.py', mkdir: true }], path.join(root, 'old-project')), null);
        assert.throws(() => createImportFixturePlan(root, [{ file: 'missing.py', mkdir: true }], root));
        assert.notEqual(first.id, second.id);
        const results = await Promise.all([first, second].map(plan => withImportFixtures(plan, async () => {
            const result = await runSpawn(process.execPath, ['-e', `process.stdout.write(process.env.${IMPORT_FIXTURE_ENV} || '')`], {});
            assert.equal(currentImportFixtures()?.id, plan.id);
            return JSON.parse(result.stdout).id;
        })));
        assert.deepEqual(results, [first.id, second.id]);
        assert.equal(currentImportFixtures(), undefined);
        assert.equal(importFixtureEnvironment({ [IMPORT_FIXTURE_ENV]: 'untrusted inherited setup' })[IMPORT_FIXTURE_ENV], undefined);
        assert.throws(() => createImportFixturePlan(root, [{ file: '../sample.py', mkdir: true }]));
        assert.throws(() => createImportFixturePlan(root, [{ file: 'sample.py', entryPoints: ['invalid expression()'] }]));
        assert.throws(() => createImportFixturePlan(root, [{ file: 'sample.py', configFiles: { '../outside.ini': '' } }]));
        assert.throws(() => createImportFixturePlan(root, [{ file: 'sample.py', entryPointLines: { 'vendor.start': [1] } }]));
        for (const lines of [[], [0], [1.5], ['1']]) {
            assert.throws(() => createImportFixturePlan(root, [{ file: 'sample.py', entryPoints: ['vendor.start'], entryPointLines: { 'vendor.start': lines } }]));
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
