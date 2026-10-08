import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { externalExactResourcePaths, newResourceSetupRule, readResourceSetupDraft, refreshResourceSetupDraft, resourceSetupCounts } from '../environment/resourceSetup';
import { readInitializationCandidate } from '../environment/importSetupProposal';
import { canonicalExternalResourcePath } from '../pipeline/isolatedResources';

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
        assert.deepEqual(advise({ resourceScope: 'project-parent' }), { ...candidate, resourceScope: 'project-parent' });
        for (const resourceScope of ['project', 'absolute', null]) {
            assert.equal(advise({ resourceScope }), undefined);
        }
        assert.equal(advise({ resourceScope: 'project-parent', resourcePath: undefined }), undefined);
        assert.equal(advise({ resourceScope: 'project-parent', resourcePath: path.basename(root) }), undefined);
        assert.equal(advise({ resourceScope: 'project-parent', resourcePath: path.basename(root) + '/data' }), undefined);
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

test('manual resource drafts preserve parent scope and do not conflate equal in-project names', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-scopes-'));
    const root = path.join(parent, 'app'); fs.mkdirSync(root);
    const file = path.join(root, 'settings.py'); fs.writeFileSync(file, 'VALUE = 1\n');
    try {
        const rule = newResourceSetupRule(root, file);
        rule.resources = [{ path: 'data', kind: 'directory' }, { path: 'data', scope: 'project-parent', kind: 'directory' },
            { path: 'data/seed.txt', kind: 'text', text: 'inside' },
            { path: 'data/seed.txt', scope: 'project-parent', kind: 'text', text: 'outside' }];
        const draft = { schemaVersion: 'isolated-resource-setup-v1', root, rules: [rule] };
        const plan = readResourceSetupDraft(root, JSON.stringify(draft)).plan!;
        assert.deepEqual(plan.rules[0].resources, rule.resources);
        assert.deepEqual(resourceSetupCounts([rule]), { directories: 2, files: 2, databases: 0, tables: 0, rows: 0 });
        assert.equal(fs.existsSync(path.join(parent, 'data')), false);
        assert.equal(fs.existsSync(path.join(root, 'data')), false);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('external exact candidates and manual drafts retain the approved absolute mapping and source version', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'external-resource-draft-'));
    const root = path.join(base, 'selected', 'app'); fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'settings.py'); fs.writeFileSync(file, 'VALUE = 1\n');
    const exact = canonicalExternalResourcePath(path.join(base, 'external', 'data'));
    try {
        const rule = newResourceSetupRule(root, file);
        const candidate = { schemaVersion: 'import-initialization-candidate-v1', kind: 'mkdir', file: 'settings.py', line: 1,
            sourceHash: rule.resourceSourceHash, operation: 'pathlib.Path.mkdir', evidence: 'blocked-direct-module-call',
            returnValue: 'discarded', resourceScope: 'external-exact', resourcePath: exact };
        const advise = (change: object = {}) => readInitializationCandidate(root,
            { exception_type: 'TraceSafetyError', initialization_candidate: { ...candidate, ...change } });
        assert.deepEqual(advise(), candidate);
        for (const resourcePath of ['data', '../data', root, path.dirname(root)]) {
            assert.equal(advise({ resourcePath }), undefined);
        }
        assert.equal(advise({ resourcePath: undefined }), undefined);
        assert.equal(advise({ kind: 'entry-point' }), undefined);
        rule.resources = [{ path: exact, scope: 'external-exact', kind: 'directory' },
            { path: exact + '/seed.txt', scope: 'external-exact', kind: 'text', text: 'explicit seed' }];
        const draft = { schemaVersion: 'isolated-resource-setup-v1', root, rules: [rule] };
        assert.deepEqual(readResourceSetupDraft(root, JSON.stringify(draft)).plan!.rules[0].resources, rule.resources);
        assert.deepEqual(externalExactResourcePaths([rule]), [exact, exact + '/seed.txt']);
        fs.appendFileSync(file, '# newer source\n');
        assert.equal(advise(), undefined);
        assert.throws(() => readResourceSetupDraft(root, JSON.stringify(draft)), /approval|來源|source/i);
        assert.equal(fs.existsSync(exact), false);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
