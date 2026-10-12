import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { writeBatchPreflightSnapshot } from '../pipeline/batchPreflightSnapshot';
import { withLanguage, setLanguage, getLanguage } from '../i18n/core';

test('the batch retains its final safe diagnosis without depending on an external setup directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-preflight-copy-'));
    try {
        const report = writeBatchPreflightSnapshot(directory, { actualImports: true, fixtureId: 'fixture-v1', rows: [
            { file: 'ready.py', status: 'loaded' },
            { file: 'blocked.py', status: 'blocked', stage: 'module-import',
                issue: { kind: 'import-side-effect', issue: 'initialization blocked', advice: 'prepare a controlled fixture' } }
        ] });
        const stored = JSON.parse(fs.readFileSync(path.join(directory, 'preflight', 'final_import_check.json'), 'utf8'));
        assert.equal(stored.actualImports, true);
        assert.equal(stored.rows.length, 2);
        assert.equal(stored.rows[1].issue.issue, 'initialization blocked');
        const markdown = fs.readFileSync(report, 'utf8');
        assert.ok(markdown.includes('blocked.py'));
        assert.ok(markdown.includes('prepare a controlled fixture'));
        assert.ok(!markdown.includes('import_setup.md'));
        const previous = getLanguage();
        setLanguage('en');
        try { withLanguage(() => writeBatchPreflightSnapshot(directory, { actualImports: true, fixtureId: 'fixture-v1', rows: [
            { file: 'ready.py', status: 'loaded' }
        ] })); } finally { setLanguage(previous); }
        const english = fs.readFileSync(report, 'utf8');
        assert.match(english, /Actual import check: Yes/);
        assert.equal(/[\u3400-\u9fff]/u.test(english), false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
