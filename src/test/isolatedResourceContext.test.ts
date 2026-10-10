import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { withImportFixtures, type ImportFixturePlan } from '../pipeline/importFixtures';
import { buildIsolatedResourceContext, ISOLATED_RESOURCE_ROLE_RULE, isolatedResourceSystemRule } from '../prompts/isolatedResourceContext';
import { getExecutionWriterSystemPrompt, getSystemPrompt, getTier1EvidenceBoundSystemPrompt, getTier3SystemPrompt } from '../roles/unittestWriter';
import { getSemanticAnalyzerSystemPrompt } from '../roles/semanticAnalyzer';
import { getTestReviewerSystemPrompt } from '../roles/testReviewer';
import { getBugFixerSystemPrompt } from '../roles/bugFixer';
import { validateUnittestStructure } from '../validation/generatedTestValidator';
import { canonicalExternalResourcePath, canonicalUncResourcePath } from '../pipeline/isolatedResources';

const plan = (): ImportFixturePlan => ({ schemaVersion: 'import-fixtures-v1', id: 'a'.repeat(64), root: '/private/application',
    rules: [{ file: 'settings.py', sourceHash: 'b'.repeat(64), resourceSourceHash: 'b'.repeat(64), resources: [
        { path: 'data/items.db', kind: 'sqlite', tables: [{ name: 'items', columns: [
            { name: 'id', type: 'INTEGER', primaryKey: true }, { name: 'label', type: 'TEXT' }
        ], rows: [{ id: 1, label: 'test item' }] }] },
        { path: 'data/settings.ini', kind: 'text', text: 'private configuration text' }
    ] }] });

test('resource context binds schema and complete bounded seeds without original roots or text content', () => {
    const context = buildIsolatedResourceContext(plan());
    assert.match(context, /a{64}/);
    assert.match(context, /b{64}/);
    assert.match(context, /"rowCount":1,"rowsStatus":"complete","rows":\[\{"id":1,"label":"test item"\}\]/);
    assert.match(context, /"textHash":"[a-f0-9]{64}"/);
    assert.ok(!context.includes('/private/application'));
    assert.ok(!context.includes('private configuration text'));
    assert.match(context, /setup facts, not execution results/);
    assert.equal(buildIsolatedResourceContext(undefined), '');
});

test('resource prompts preserve declared defaults, autoincrement and composite uniqueness with withheld rows', () => {
    const value = plan(); const db = value.rules[0].resources![0];
    assert.equal(db.kind, 'sqlite');
    if (db.kind !== 'sqlite') { return; }
    db.tables[0].columns[0].autoIncrement = true;
    Object.assign(db.tables[0].columns[1], { default: 'literal default', unique: true });
    db.tables[0].unique = [['id', 'label']];
    db.tables[0].rows![0].label = 'synthetic-secret-value';
    const context = buildIsolatedResourceContext(value, 6000, ['synthetic-secret-value']);
    assert.match(context, /"autoIncrement":true/);
    assert.match(context, /"default":"literal default"/);
    assert.match(context, /"unique":true/);
    assert.match(context, /"unique":\[\["id","label"\]\]/);
    assert.match(context, /"rowsStatus":"withheld"/);
    assert.doesNotMatch(context, /synthetic-secret-value/);
});

test('resource context withholds a whole credential seed and never treats omitted rows as empty', () => {
    const value = plan(), secret = 'synthetic-secret-value-for-test';
    const db = value.rules[0].resources![0];
    assert.equal(db.kind, 'sqlite');
    if (db.kind === 'sqlite') { db.tables[0].rows![0].label = secret; }
    const context = buildIsolatedResourceContext(value, 6000, [secret]);
    assert.ok(!context.includes(secret));
    assert.match(context, /"rowCount":1,"rowsStatus":"withheld"/);
    assert.ok(!context.includes('"rows":[]'));
});

test('resource prompt keeps the logical scope so equal sibling and project names cannot be confused', () => {
    const value = plan();
    value.rules[0].resources = [{ path: 'data/items.db', kind: 'sqlite', tables: [] },
        { path: 'data/items.db', scope: 'project-parent', kind: 'sqlite', tables: [] }];
    const records = buildIsolatedResourceContext(value).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.equal(records[0].scope, undefined);
    assert.equal(records[1].scope, 'project-parent');
    assert.equal(records[0].path, records[1].path);
    assert.ok(!JSON.stringify(records).includes('/private/application'));
});

test('external resource context uses stable aliases and hashes without adding the original path', () => {
    const value = plan();
    const original = process.platform === 'win32' ? 'C:\\NeutralExternal\\PrivateData' : '/neutral-external/PrivateData';
    value.rules[0].resources = [{ path: original, scope: 'external-exact', kind: 'directory' }];
    const context = buildIsolatedResourceContext(value);
    const records = context.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const pathHash = createHash('sha256').update('external-exact:' + canonicalExternalResourcePath(original)).digest('hex');
    assert.equal(records.length, 1);
    assert.equal(records[0].scope, 'external-exact');
    assert.equal(records[0].path, undefined);
    assert.equal(records[0].pathAlias, `external-${pathHash.slice(0, 16)}`);
    assert.equal(records[0].pathHash, pathHash);
    assert.doesNotMatch(context, /PrivateData|privatedata|NeutralExternal|neutral-external/);
    assert.match(context, /never use the alias as a literal path or an expected value/);
    if (process.platform === 'win32') {
        value.rules[0].resources[0].path = original.replace(/\\/g, '/').toUpperCase();
        assert.equal(buildIsolatedResourceContext(value), context);
    }
    assert.equal(value.rules[0].resources[0].kind, 'directory', 'the private runtime plan is not rewritten');
});

test('resource context withholds seed rows that repeat an approved external path', () => {
    const value = plan();
    const original = process.platform === 'win32' ? 'C:\\NeutralExternal\\PrivateData' : '/neutral-external/PrivateData';
    value.rules[0].resources!.push({ path: original, scope: 'external-exact', kind: 'directory' });
    const db = value.rules[0].resources![0]; assert.equal(db.kind, 'sqlite');
    if (db.kind === 'sqlite') { db.tables[0].rows![0].label = 'configured path: ' + original; }
    const context = buildIsolatedResourceContext(value);
    assert.doesNotMatch(context, /PrivateData|privatedata|NeutralExternal|neutral-external/);
    assert.match(context, /"rowCount":1,"rowsStatus":"withheld"/);
    assert.ok(!context.includes('"rows":[]'), 'withheld path-bearing rows are unknown, not an empty seed');
    const compact = buildIsolatedResourceContext(value, 1800);
    assert.ok(compact.length <= 1800);
    for (const line of compact.split('\n').filter(item => item.startsWith('{'))) { assert.doesNotThrow(() => JSON.parse(line)); }
});

test('UNC virtual context exposes only scope-bound aliases and grants no network I/O', {
    skip: process.platform !== 'win32'
}, () => {
    const value = plan(), original = '\\\\Neutral-Server\\TestShare\\';
    value.rules[0].resources = [{ path: original, scope: 'unc-virtual', kind: 'directory' }];
    const context = buildIsolatedResourceContext(value);
    const records = context.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const canonical = canonicalUncResourcePath(original);
    const pathHash = createHash('sha256').update('unc-virtual:' + canonical).digest('hex');
    assert.equal(records.length, 1);
    assert.equal(records[0].scope, 'unc-virtual');
    assert.equal(records[0].path, undefined);
    assert.equal(records[0].pathHash, pathHash);
    assert.equal(records[0].pathAlias, `unc-${pathHash.slice(0, 16)}`);
    assert.notEqual(pathHash, createHash('sha256').update(canonical).digest('hex'), 'the hash binds its namespace');
    assert.doesNotMatch(context, /neutral-server|testshare/i);
    assert.match(context, /grants no network connection or remote I\/O/);
    assert.match(context, /never use the alias as a literal path or expected value/);
    value.rules[0].resources[0].path = '//NEUTRAL-SERVER/TESTSHARE';
    assert.equal(buildIsolatedResourceContext(value), context);
    assert.equal(value.rules[0].resources[0].path, '//NEUTRAL-SERVER/TESTSHARE', 'the runtime declaration is not rewritten');
});

test('UNC path-bearing seed rows stay withheld across native and escaped spellings', {
    skip: process.platform !== 'win32'
}, () => {
    const value = plan(), original = '\\\\Neutral-Server\\TestShare';
    value.rules[0].resources!.push({ path: original, scope: 'unc-virtual', kind: 'directory' });
    const db = value.rules[0].resources![0]; assert.equal(db.kind, 'sqlite');
    for (const spelling of [original + '\\child', '//NEUTRAL-SERVER/TESTSHARE/child', JSON.stringify(original + '\\child')]) {
        if (db.kind === 'sqlite') { db.tables[0].rows![0].label = 'configured path: ' + spelling; }
        const context = buildIsolatedResourceContext(value);
        assert.doesNotMatch(context, /neutral-server|testshare/i);
        assert.match(context, /"rowCount":1,"rowsStatus":"withheld"/);
        assert.ok(!context.includes('"rows":[]'), 'unknown rows must not be represented as empty');
        if (db.kind === 'sqlite') { assert.equal(db.tables[0].rows![0].label, 'configured path: ' + spelling); }
    }
    const compact = buildIsolatedResourceContext(value, 1800);
    assert.ok(compact.length <= 1800);
    for (const line of compact.split('\n').filter(item => item.startsWith('{'))) { assert.doesNotThrow(() => JSON.parse(line)); }
});

test('resource prompt budgets omit complete records without cutting schema or seed values', () => {
    const value = plan(), db = value.rules[0].resources![0];
    if (db.kind === 'sqlite') { db.tables[0].rows![0].label = 'x'.repeat(10000); }
    const context = buildIsolatedResourceContext(value, 1800);
    assert.ok(context.length <= 1800);
    assert.ok(!context.includes('x'.repeat(30)));
    for (const line of context.split('\n').filter(item => item.startsWith('{'))) { assert.doesNotThrow(() => JSON.parse(line)); }
    assert.equal(buildIsolatedResourceContext(value, 100), '');
});

test('resource role guidance is scoped and bounded; ordinary functions and qualification probes are unchanged', () => {
    const prompts = () => [getExecutionWriterSystemPrompt(), getSystemPrompt(1, 'small'), getSystemPrompt(1, 'large'),
        getTier1EvidenceBoundSystemPrompt(), getTier3SystemPrompt(), getSemanticAnalyzerSystemPrompt(),
        getTestReviewerSystemPrompt(), getBugFixerSystemPrompt()];
    const ordinary = prompts();
    assert.equal(isolatedResourceSystemRule(), '');
    for (const prompt of ordinary) {
        assert.ok(!prompt.includes('HOST_ISOLATED_RESOURCE_CONTEXT'));
        assert.ok(!prompt.includes(ISOLATED_RESOURCE_ROLE_RULE));
    }
    const importOnly = plan(); delete importOnly.rules[0].resources; delete importOnly.rules[0].resourceSourceHash;
    assert.deepEqual(withImportFixtures(importOnly, prompts), ordinary);
    withImportFixtures(plan(), () => {
        const shortRule = isolatedResourceSystemRule();
        assert.ok(shortRule.length > 0 && shortRule.length < 200);
        for (const [index, prompt] of prompts().entries()) {
            assert.ok(prompt.includes(shortRule));
            assert.ok(!prompt.includes(ISOLATED_RESOURCE_ROLE_RULE), 'full resource rules belong to the user context only');
            assert.ok(prompt.length <= ordinary[index].length + 300, 'resource guidance must remain a small system addition');
        }
        assert.ok(getTestReviewerSystemPrompt().length < 3000);
        assert.equal(buildIsolatedResourceContext(plan()).split(ISOLATED_RESOURCE_ROLE_RULE).length - 1, 1);
    });
    assert.deepEqual(prompts(), ordinary, 'resource settings cannot leak into later qualification or pure-function prompts');
    assert.match(getTestReviewerSystemPrompt(), /ONE findings array/);
});

test('host resource support does not allow generated tests to perform direct file or SQLite I/O', () => {
    for (const unsafe of ['open("data/settings.ini").read()', 'sqlite3.connect("data/items.db")']) {
        const code = `import unittest\nimport sqlite3\nfrom sample import target\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        ${unsafe}\n        self.assertEqual(target(), 1)\n`;
        assert.equal(validateUnittestStructure(code, 'target', 'sample').valid, false);
    }
    const code = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(target(), 1)\n';
    assert.equal(validateUnittestStructure(code, 'target', 'sample').valid, true);
});
