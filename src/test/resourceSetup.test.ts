import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { newResourceSetupRule, readResourceSetupDraft, refreshResourceSetupDraft, resourceSetupCounts } from '../environment/resourceSetup';
import { readInitializationCandidate } from '../environment/importSetupProposal';

test('resource drafts bind exact project/source/seed and never refresh an expired approval', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-draft-'));
    try {
        const file = path.join(root, 'config.py'); fs.writeFileSync(file, 'VALUE = 1\n');
        const rule = newResourceSetupRule(root, file);
        rule.resources = [{ path: 'data', kind: 'directory' }, { path: 'config.ini', kind: 'text', text: '[test]\nmode=demo' },
            { path: 'data/test.db', kind: 'sqlite', tables: [{ name: 'items', columns: [{ name: 'value', type: 'INTEGER' }], rows: [{ value: 3 }] }] }];
        const draft = { schemaVersion: 'isolated-resource-setup-v1', root, rules: [rule] };
        const read = () => readResourceSetupDraft(root, JSON.stringify(draft));
        const first = read().plan!.id;
        assert.deepEqual(resourceSetupCounts([rule]), { directories: 1, files: 1, databases: 1, tables: 1, rows: 1 });
        (rule.resources[2] as Extract<NonNullable<typeof rule.resources>[number], { kind: 'sqlite' }>).tables[0].rows![0].value = 4;
        assert.notEqual(read().plan!.id, first, 'changing seed invalidates prior evidence');
        const candidate = { schemaVersion: 'import-initialization-candidate-v1', kind: 'mkdir', file: 'config.py', line: 1,
            sourceHash: rule.resourceSourceHash, operation: 'pathlib.Path.mkdir', evidence: 'blocked-direct-module-call',
            returnValue: 'discarded', resourcePath: 'data' };
        const advise = (change: object) => readInitializationCandidate(root, { exception_type: 'TraceSafetyError', initialization_candidate: { ...candidate, ...change } });
        assert.equal(advise({})?.resourcePath, 'data');
        for (const resourcePath of ['../data', '/data', 'C:/data', 'data\\child', 'source.py']) {
            assert.equal(advise({ resourcePath }), undefined);
        }
        assert.equal(advise({ kind: 'entry-point' }), undefined);
        fs.appendFileSync(file, 'VALUE = 2\n');
        assert.throws(read, /approval|來源|source/i);
        const refreshed = refreshResourceSetupDraft(root, JSON.stringify(draft));
        assert.notEqual(refreshed.rules[0].resourceSourceHash, rule.resourceSourceHash);
        assert.deepEqual(refreshed.rules[0].resources, rule.resources);
        assert.doesNotThrow(() => readResourceSetupDraft(root, JSON.stringify(refreshed)));
        assert.throws(read, /approval|來源|source/i, 'refresh only changes the preview, never the original approval');
        assert.throws(() => newResourceSetupRule(root, __filename), /inside/);
        assert.throws(() => readResourceSetupDraft(path.dirname(root), JSON.stringify(draft)), /different project/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
