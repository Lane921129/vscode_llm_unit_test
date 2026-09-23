import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createImportFixturePlan, currentImportFixtures, importFixtureEnvironment, withImportFixtures,
    IMPORT_FIXTURE_ENV } from '../pipeline/importFixtures';
import { runSpawn } from '../utils/processRunner';

test('import setup binds source content, isolates concurrent runs and reaches workers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-fixtures-'));
    try {
        fs.writeFileSync(path.join(root, 'sample.py'), 'value = 1\n');
        const first = createImportFixturePlan(root, [{ file: 'sample.py', mkdir: true }])!;
        fs.writeFileSync(path.join(root, 'sample.py'), 'value = 2\n');
        const second = createImportFixturePlan(root, [{ file: 'sample.py', mkdir: true }])!;
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
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
