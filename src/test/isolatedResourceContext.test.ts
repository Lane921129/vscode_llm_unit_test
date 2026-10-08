import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { withImportFixtures, type ImportFixturePlan } from '../pipeline/importFixtures';
import { buildIsolatedResourceContext, ISOLATED_RESOURCE_ROLE_RULE, isolatedResourceSystemRule } from '../prompts/isolatedResourceContext';
import { getExecutionWriterSystemPrompt, getSystemPrompt, getTier1EvidenceBoundSystemPrompt, getTier3SystemPrompt } from '../roles/unittestWriter';
import { getSemanticAnalyzerSystemPrompt } from '../roles/semanticAnalyzer';
import { getTestReviewerSystemPrompt } from '../roles/testReviewer';
import { getBugFixerSystemPrompt } from '../roles/bugFixer';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

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
