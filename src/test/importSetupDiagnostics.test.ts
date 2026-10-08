import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { importSetupMessage, recheckReason, saveImportSetupSession } from '../environment/importSetupSession';
import type { ImportCheck, ImportCheckRow } from '../environment/projectImportCheck';

const observed = (file = 'sample.py', line = 38, operation = 'os.mkdir'): ImportCheckRow => ({
    file, status: 'blocked', stage: 'module-import',
    issue: { kind: 'import-side-effect', issue: operation, advice: 'fixture advice', origin: { file, line } },
    diagnostic: { exceptionType: 'TraceSafetyError', message: 'Blocked ' + operation }
});
const check = (directory: string, rows: ImportCheckRow[]): ImportCheck => ({
    root: path.dirname(directory), directory, python: 'python', rows, proposedRules: [], proposedPlan: null, proposals: []
});

test('an incomplete recheck stays blocked and links both rounds without substituting the previous cause', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-diagnostics-'));
    try {
        const first = check(path.join(directory, '1'), [observed(), observed('other.py'), observed('startup.py', 14, 'network connection')]);
        const second = check(path.join(directory, '2'), [
            { file: 'sample.py', status: 'blocked', stage: 'module-preflight',
                issue: { kind: 'other', issue: 'module-preflight', advice: 'unknown' } },
            observed('other.py'), { file: 'startup.py', status: 'loaded' }
        ]);
        for (const current of [first, second]) {
            fs.mkdirSync(current.directory);
            fs.writeFileSync(path.join(current.directory, 'import_check.json'), JSON.stringify({ rows: current.rows }));
        }
        const previousBytes = fs.readFileSync(path.join(first.directory, 'import_check.json'), 'utf8');
        const currentBytes = fs.readFileSync(path.join(second.directory, 'import_check.json'), 'utf8');
        const reason = recheckReason(first, second);
        assert.equal(reason, 'recheck-diagnostic-incomplete');
        const message = importSetupMessage(reason, second);
        assert.doesNotMatch(message, /下一個載入障礙|next loading blocker/i);
        const report = saveImportSetupSession(directory, [first, second], true, reason, message);
        const saved = JSON.parse(fs.readFileSync(path.join(directory, 'import_setup.json'), 'utf8'));
        assert.equal(saved.status, 'blocked'); assert.equal(saved.nextSetupAvailable, false);
        assert.deepEqual(saved.comparisons, [{ before: '1/import_check.json', after: '2/import_check.json', rows: [
            { file: 'sample.py', change: 'diagnostic-incomplete' }, { file: 'other.py', change: 'unchanged' },
            { file: 'startup.py', change: 'loaded' }
        ] }]);
        assert.equal(fs.readFileSync(path.join(first.directory, 'import_check.json'), 'utf8'), previousBytes);
        assert.equal(fs.readFileSync(path.join(second.directory, 'import_check.json'), 'utf8'), currentBytes);
        assert.equal(second.rows[0].diagnostic, undefined, 'old os.mkdir evidence must not become the current diagnostic');
        assert.match(fs.readFileSync(report, 'utf8'), /1\/import_check.md/);
        assert.match(fs.readFileSync(report, 'utf8'), /2\/import_check.md/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('only changed observed blocker identities count as new; lost metadata or changed prose does not', () => {
    const first = check('first', [observed()]);
    for (const row of [observed('sample.py', 39), observed('sample.py', 38, 'file read')]) {
        assert.equal(recheckReason(first, check('second', [row])), 'recheck-new-blockers');
    }
    const unchanged = structuredClone(first);
    assert.equal(recheckReason(first, unchanged), 'recheck-unchanged');
    const noOrigin = observed(); delete noOrigin.issue!.origin;
    const noDiagnostic = observed(); delete noDiagnostic.diagnostic;
    const changedMessage = observed(); changedMessage.diagnostic!.message = 'different process wording';
    const timeout: ImportCheckRow = { file: 'sample.py', status: 'blocked', stage: 'module-preflight',
        issue: { kind: 'other', issue: 'timeout', advice: 'check process' },
        diagnostic: { exceptionType: 'ModulePreflightToolError', message: 'timeout', reasonCode: 'timeout' } };
    for (const row of [noOrigin, noDiagnostic, changedMessage, timeout]) {
        assert.equal(recheckReason(first, check('second', [row])), 'recheck-diagnostic-incomplete');
    }
    assert.equal(recheckReason(check('first', [timeout]), first), 'recheck-diagnostic-incomplete',
        'recovering a diagnostic does not establish that the blocker itself is new');
    assert.equal(recheckReason(first, check('second', [{ file: 'sample.py', status: 'loaded' }])), 'recheck-ready');
    assert.equal(recheckReason(first, check('second', [])), 'no-targets');
});
