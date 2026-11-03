import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupCallerSetupsForPrompt, buildCompactWriterContext, buildWriterRevisionContext } from '../prompts/compactWriterContext';
import { callerForPrompt } from '../pipeline/probeInputs';
import { buildTargetIsolatedResourceContext } from '../prompts/isolatedResourceContext';
import type { ImportFixturePlan } from '../pipeline/importFixtures';
import type { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';

const evidence: WriterEvidenceBundleV3 = { schemaVersion: 'writer-evidence-v3', sourceHash: 'a'.repeat(64), semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'a'.repeat(64), ids: [], selectedRules: [],
        guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance'] };

test('caller grouping preserves every source site and separates different setup or diagnostic facts', () => {
    const callers = Array.from({ length: 33 }, (_, i) => ({ caller_file: 'sample.py', caller_func: `caller_${i}`, line: i + 1,
        args: ['1'], kwargs: { label: "'one'" }, constructor_args: ['2'] }));
    const different = { ...callers[0], caller_func: 'different', args: ['True'] };
    const diagnostic = { ...callers[0], caller_func: 'unknown', trace_input: {},
        trace_input_diagnostic: { reason: 'unreplayable-input' } };
    const input = [...callers, different, diagnostic], before = JSON.stringify(input);
    const grouped = groupCallerSetupsForPrompt(input);
    assert.equal(grouped.length, 3);
    const expanded = grouped.flatMap(({ call_sites, ...facts }) => (call_sites as Record<string, unknown>[])
        .map(site => ({ ...site, ...facts })));
    assert.deepEqual(expanded, input.map(callerForPrompt));
    assert.equal(JSON.stringify(input), before);
    assert.ok(JSON.stringify(grouped).length < JSON.stringify(input.map(callerForPrompt)).length * 0.65);
    assert.equal(grouped[2].input_status, 'diagnostic');
    for (const prompt of [buildCompactWriterContext, buildWriterRevisionContext]) {
        const text = prompt({ module: 'sample', name: 'target', source: 'def target(value):\n    return value\n',
            context: { callerContexts: input }, evidence, budgetTokens: 10000 });
        for (const caller of input) { assert.ok(text.includes(caller.caller_func)); }
        assert.ok(text.includes('"input_status":"diagnostic"'));
        assert.ok(text.includes('not execution results'));
    }
});

const plan = (): ImportFixturePlan => ({ schemaVersion: 'import-fixtures-v1', root: '/neutral/source', id: 'a'.repeat(64),
    rules: [0, 1, 2].map(index => ({ file: `owner_${index}.py`, sourceHash: String(index).repeat(64),
        resources: [{ kind: 'sqlite', path: `state_${index}.sqlite`, tables: [{ name: 'items', columns: [
            { name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true },
            { name: 'label', type: 'TEXT', notNull: true, unique: true, default: 'neutral' }
        ], unique: [['id', 'label']], rows: [{ id: 1, label: index === 2 ? 'different' : 'same' }] }] }] })) });

const records = (text: string) => text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
function expandTables(items: any[]) {
    return items.map((item: any) => ({ ...item, tables: item.tables.map((table: any) => {
        if (!table.same_complete_schema_as) { return table; }
        const match = /^resource\[(\d+)\]\.tables\[(\d+)\]$/.exec(table.same_complete_schema_as)!;
        const original = items[Number(match[1]) - 1].tables[Number(match[2])];
        assert.equal(original.same_complete_schema_as, undefined);
        const { rows: _rows, rowCount: _count, rowsStatus: _status, ...schema } = original;
        const { same_complete_schema_as: _reference, ...local } = table;
        return { ...schema, ...local };
    }) }));
}

test('resource table references retain exact schema, distinct seeds and every independent owner', () => {
    const input = plan(), before = JSON.stringify(input);
    const output = buildTargetIsolatedResourceContext(input, undefined, 50000);
    const items = records(output.context), expanded = expandTables(items);
    assert.equal(output.complete, true);
    assert.equal(output.resourceCount, 3);
    assert.ok(items[1].tables[0].same_complete_schema_as);
    assert.ok(items[2].tables[0].same_complete_schema_as);
    assert.notDeepEqual(items[1].tables[0].rows, items[2].tables[0].rows);
    input.rules.forEach((rule, index) => {
        assert.equal(expanded[index].declaredBy, rule.file);
        assert.equal(expanded[index].sourceHash, rule.sourceHash);
        assert.equal(expanded[index].path, rule.resources![0].path);
        const resource = rule.resources![0];
        assert.equal(resource.kind, 'sqlite');
        if (resource.kind === 'sqlite') {
            assert.deepEqual(expanded[index].tables[0], { ...resource.tables[0], rowCount: 1, rowsStatus: 'complete' });
        }
    });
    assert.equal(JSON.stringify(input), before);
    assert.ok(output.context.includes('separate and fresh'));
});

test('referenced withheld rows remain unknown and constraints are never omitted for a small prompt budget', () => {
    const output = buildTargetIsolatedResourceContext(plan(), undefined, 0);
    const expanded = expandTables(records(output.context));
    assert.equal(output.complete, true);
    assert.equal(output.exceedsBudget, true);
    for (const item of expanded) {
        const table = item.tables[0];
        assert.equal(table.rowsStatus, 'withheld');
        assert.equal(table.rowCount, 1);
        assert.equal(table.rows, undefined);
        assert.deepEqual(table.unique, [['id', 'label']]);
        assert.equal(table.columns[0].autoIncrement, true);
        assert.equal(table.columns[1].default, 'neutral');
    }
});

test('different column constraints remain independent schema definitions', () => {
    const input = plan();
    const second = input.rules[1].resources![0], third = input.rules[2].resources![0];
    assert.equal(second.kind, 'sqlite'); assert.equal(third.kind, 'sqlite');
    if (second.kind !== 'sqlite' || third.kind !== 'sqlite') { return; }
    second.tables[0].columns[1].notNull = false;
    third.tables[0].columns[1].default = null;
    const output = records(buildTargetIsolatedResourceContext(input, undefined, 50000).context);
    for (const item of output) { assert.equal(item.tables[0].same_complete_schema_as, undefined); }
    assert.equal(output[1].tables[0].columns[1].notNull, false);
    assert.equal(output[2].tables[0].columns[1].default, null);
});
