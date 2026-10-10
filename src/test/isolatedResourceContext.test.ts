import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createImportFixturePlan, withImportFixtures, type ImportFixturePlan } from '../pipeline/importFixtures';
import { buildIsolatedResourceContext, buildTargetIsolatedResourceContext, ISOLATED_RESOURCE_ROLE_RULE, isolatedResourceSystemRule,
    type IsolatedResourceSourceEvidence } from '../prompts/isolatedResourceContext';
import { SOURCE_VERSIONS_VERSION } from '../pipeline/sourceVersions';
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

function projectedFixture(operation: (value: { root: string; plan: ImportFixturePlan; evidence: IsolatedResourceSourceEvidence }) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-projection-'));
    try {
        const names = ['selected.py', 'settings.py', 'bridge.py', 'other/settings.py'];
        for (const name of names) {
            const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '# neutral source identity: ' + name + '\r\n');
        }
        const version = (file: string) => ({ file: path.join(root, file),
            hash: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') });
        const selected = version('selected.py'), settings = version('settings.py');
        const fixturePlan = createImportFixturePlan(root, [
            { file: 'settings.py', resourceSourceHash: settings.hash, resources: [{ kind: 'sqlite', path: 'owned.sqlite', tables: [{ name: 'items',
                columns: [{ name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true },
                    { name: 'label', type: 'TEXT', default: 'neutral default', notNull: true, unique: true }], unique: [['id', 'label']] }] }] },
            { file: 'other/settings.py', resourceSourceHash: version('other/settings.py').hash,
                resources: [{ kind: 'sqlite', path: 'unrelated.sqlite', tables: [{ name: 'unrelated', columns: [{ name: 'extra', type: 'TEXT' }] }] }] }
        ])!;
        operation({ root, plan: fixturePlan, evidence: { version: SOURCE_VERSIONS_VERSION, target: selected, sources: [selected, settings] } });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const resourceRecords = (context: string) => context.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));

test('verified loaded origins project whole related schema without changing the approved runtime plan', () => projectedFixture(({ plan, evidence }) => {
    const before = JSON.stringify(plan);
    const result = withImportFixtures(plan, () => buildTargetIsolatedResourceContext(plan, evidence));
    assert.equal(result.status, 'projected'); assert.equal(result.resourceCount, 1); assert.equal(result.complete, true);
    assert.equal(result.exceedsBudget, false);
    const records = resourceRecords(result.context);
    assert.equal(records[0].declaredBy, 'settings.py');
    assert.equal(records[0].sourceHash, plan.rules[0].sourceHash);
    assert.deepEqual(records[0].tables[0].columns, (plan.rules[0].resources![0] as any).tables[0].columns);
    assert.deepEqual(records[0].tables[0].unique, [['id', 'label']]);
    assert.ok(result.context.includes(plan.id));
    assert.doesNotMatch(result.context, /unrelated\.sqlite|other\/settings\.py/);
    assert.match(result.context, /future local or dynamic imports are outside this snapshot/);
    assert.equal(buildTargetIsolatedResourceContext(plan, evidence, result.context.length).exceedsBudget, false);
    assert.equal(buildTargetIsolatedResourceContext(plan, undefined, result.context.length).exceedsBudget, true,
        'excluding only proven unrelated resources leaves the complete required schema within a smaller budget');
    assert.equal(JSON.stringify(plan), before);
}));

test('projection retains exact shared resource declarations but does not conflate project and sibling scopes', () => projectedFixture(({ root, plan, evidence }) => {
    const bridge = { file: 'bridge.py', sourceHash: createHash('sha256').update(fs.readFileSync(path.join(root, 'bridge.py'))).digest('hex') };
    plan.rules.push({ ...bridge, resourceSourceHash: bridge.sourceHash, resources: [structuredClone(plan.rules[0].resources![0]),
        { kind: 'sqlite', path: 'owned.sqlite', scope: 'project-parent', tables: [] }] });
    const result = buildTargetIsolatedResourceContext(plan, evidence);
    assert.equal(result.status, 'projected'); assert.equal(result.resourceCount, 2);
    const records = resourceRecords(result.context);
    assert.deepEqual(records.map(record => record.declaredBy), ['settings.py', 'bridge.py']);
    assert.ok(records.every(record => record.scope === undefined));
    assert.deepEqual(records[0].tables, records[1].tables);
}));

test('resource source, target, dependency and loaded snapshot drift cannot authorize a projected prompt', () => projectedFixture(({ root, plan, evidence }) => {
    for (const name of ['selected.py', 'settings.py']) {
        const file = path.join(root, name), before = fs.readFileSync(file);
        fs.appendFileSync(file, '# drift\n');
        assert.equal(buildTargetIsolatedResourceContext(plan, evidence).status, 'source-drift');
        fs.writeFileSync(file, before);
    }
    const dependency = path.join(root, 'bridge.py');
    plan.rules[0].sourceDependencies = [{ file: 'bridge.py', sourceHash: createHash('sha256').update(fs.readFileSync(dependency)).digest('hex') }];
    fs.appendFileSync(dependency, '# drift\n');
    const result = buildTargetIsolatedResourceContext(plan, evidence);
    assert.equal(result.status, 'source-drift'); assert.equal(result.context, '');
    assert.equal(result.complete, false);
}));

test('a refreshed loaded snapshot cannot silently refresh the approved resource source version', () => projectedFixture(({ root, plan, evidence }) => {
    const file = path.join(root, 'settings.py'); fs.appendFileSync(file, '# newer than approval\n');
    const current = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const result = buildTargetIsolatedResourceContext(plan, { ...evidence,
        sources: evidence.sources.map(source => source.file === file ? { ...source, hash: current } : source) });
    assert.equal(result.status, 'source-drift'); assert.equal(result.context, '');
}));

test('missing closure stays explicitly unscoped while malformed or unbound target evidence is rejected', () => projectedFixture(({ root, plan, evidence }) => {
    const fallback = buildTargetIsolatedResourceContext(plan, undefined);
    assert.equal(fallback.status, 'unscoped'); assert.equal(fallback.resourceCount, 2);
    assert.match(fallback.context, /Resource relevance is unknown/);
    assert.equal(resourceRecords(fallback.context).length, 2);
    for (const changed of [
        { ...evidence, version: 'invented-version' },
        { ...evidence, target: { ...evidence.target, hash: 'f'.repeat(64) } },
        { ...evidence, sources: evidence.sources.slice(1) },
        { ...evidence, sources: [...evidence.sources, evidence.sources[0]] },
        { ...evidence, target: { ...evidence.target, file: path.join(root, '../outside.py') } }
    ]) {
        const invalid = buildTargetIsolatedResourceContext(plan, changed as IsolatedResourceSourceEvidence);
        assert.equal(invalid.status, 'invalid-evidence'); assert.equal(invalid.context, '');
    }
    assert.equal(buildTargetIsolatedResourceContext(undefined, evidence).context, '');
}));

test('required projected schemas survive a tiny budget intact and report overflow instead of truncating', () => projectedFixture(({ plan, evidence }) => {
    const result = buildTargetIsolatedResourceContext(plan, evidence, 100);
    assert.equal(result.exceedsBudget, true); assert.equal(result.complete, true);
    const records = resourceRecords(result.context);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].tables[0].columns, (plan.rules[0].resources![0] as any).tables[0].columns);
    assert.equal(records[0].tables[0].rowsStatus, 'withheld');
    assert.doesNotMatch(result.context, /Whole resource declarations omitted/);
    const full = buildTargetIsolatedResourceContext(plan, undefined, 100);
    assert.equal(full.exceedsBudget, true); assert.equal(resourceRecords(full.context).length, 2);
}));

test('projection privacy still covers unselected external paths and credential-bearing schemas', () => projectedFixture(({ plan, evidence }) => {
    const privatePath = process.platform === 'win32' ? 'C:\\NeutralPrivate\\Resource' : '/neutral-private/resource';
    plan.rules[1].resources!.push({ path: privatePath, scope: 'external-exact', kind: 'directory' });
    const db = plan.rules[0].resources![0]; if (db.kind !== 'sqlite') { return; }
    db.tables[0].rows = [{ id: 1, label: privatePath }];
    const result = buildTargetIsolatedResourceContext(plan, evidence);
    assert.equal(result.status, 'projected'); assert.equal(result.complete, true);
    assert.doesNotMatch(result.context, /NeutralPrivate|neutral-private/);
    assert.equal(resourceRecords(result.context)[0].tables[0].rowsStatus, 'withheld');
    db.tables[0].columns[1].default = 'neutral-secret-test';
    const withheld = buildTargetIsolatedResourceContext(plan, evidence, 6000, ['neutral-secret-test']);
    assert.equal(withheld.complete, false); assert.doesNotMatch(withheld.context, /neutral-secret-test/);
    assert.match(withheld.context, /Whole resource declarations omitted: 1; details are unknown/);
}));
