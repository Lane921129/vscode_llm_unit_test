import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { mergeSchemaProposals, SchemaProposal } from '../environment/schemaPlanning';
import { inspectProjectImports, verifyImportProposal } from '../environment/projectImportCheck';
import { createImportFixturePlan, ImportFixtureRule, withImportFixtures } from '../pipeline/importFixtures';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { runSpawn } from '../utils/processRunner';
import { getLanguage, setLanguage } from '../i18n/core';

const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const proposal = (file = 'sample.py', table = 'sample'): SchemaProposal => ({ file, sourceHash: 'a'.repeat(64),
    line: 5, connectionLine: 3, resource: { kind: 'sqlite', path: 'owned.sqlite' },
    table: { name: table, columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }] } });
const rule = (file = 'sample.py'): ImportFixtureRule => ({ file, resourceSourceHash: 'a'.repeat(64),
    resources: [{ kind: 'sqlite', path: 'owned.sqlite', tables: [] }] });

test('schema merging binds the full resource identity and never chooses another declared database', () => {
    const source = rule(), candidate = proposal();
    source.resources!.push({ kind: 'sqlite', path: 'other.sqlite', tables: [] });
    const merged = mergeSchemaProposals([source], [candidate]);
    assert.equal(merged.proposals.length, 1);
    assert.deepEqual(merged.proposals[0].resource, { kind: 'sqlite', path: 'owned.sqlite' });
    assert.equal((merged.proposedRules[0].resources![0] as any).tables.length, 1);
    assert.equal((merged.proposedRules[0].resources![1] as any).tables.length, 0);
    assert.equal((source.resources![0] as any).tables.length, 0, 'preview cannot mutate approved settings');
    for (const changed of [{ ...candidate, file: 'different.py' }, { ...candidate, sourceHash: 'b'.repeat(64) },
        { ...candidate, resource: { ...candidate.resource, scope: 'project-parent' as const } }]) {
        const rejected = mergeSchemaProposals([source], [changed]);
        assert.equal(rejected.proposals.length, 0);
        assert.equal(rejected.diagnostics[0].reason, 'undeclared-source-database');
    }
});

test('schema conflicts and shared aliases without independent source proof remain diagnostics', () => {
    const first = proposal(), changed = { ...first, line: 6, table: { name: 'sample', columns: [{ name: 'label', type: 'TEXT' as const }] } };
    const conflict = mergeSchemaProposals([rule()], [first, changed]);
    assert.equal(conflict.proposals.length, 0);
    assert.equal(conflict.diagnostics[0].reason, 'conflicting-literal-schema');
    const approved = rule(); (approved.resources![0] as any).tables = [{ ...changed.table, rows: [{ label: 'approved seed' }] }];
    const existing = mergeSchemaProposals([approved], [first]);
    assert.equal(existing.proposals.length, 0);
    assert.deepEqual(existing.proposedRules, [approved], 'existing schema and explicit seeds cannot be overwritten');
    assert.equal(existing.diagnostics[0].reason, 'existing-schema-conflict');
    const shared = mergeSchemaProposals([rule(), rule('consumer.py')], [first]);
    assert.equal(shared.proposals.length, 0);
    assert.equal(shared.diagnostics[0].reason, 'shared-resource-requires-explicit-schema');
    const both = mergeSchemaProposals([rule(), rule('consumer.py')], [first, proposal('consumer.py')]);
    assert.equal(both.proposals.length, 2);
    assert.deepEqual(both.proposals.map(p => p.file), ['sample.py', 'consumer.py']);
    assert.ok(both.proposedRules.every(r => r.resourceSourceHash === 'a'.repeat(64)));
});

function fixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-preview-')), root = path.join(base, 'app'); fs.mkdirSync(root);
    const file = path.join(root, 'sample.py'), originalDb = path.join(root, 'owned.sqlite');
    fs.writeFileSync(originalDb, 'original DB bytes must never be read or changed');
    fs.writeFileSync(file, `import sqlite3
from pathlib import Path
DB = Path(__file__).parent / "owned.sqlite"
Path("cache").mkdir(exist_ok=True)
def initialize():
    conn = sqlite3.connect(DB)
    conn.execute("CREATE TABLE IF NOT EXISTS sample (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE DEFAULT 'neutral', amount REAL DEFAULT 1.25)")
    conn.execute("INSERT INTO sample(code) VALUES ('must not seed')")
    raise RuntimeError("initializer must not execute")
def target():
    conn = sqlite3.connect(DB)
    conn.execute("INSERT INTO sample DEFAULT VALUES")
    result = conn.execute("SELECT id, code, amount, (SELECT count(*) FROM sample) FROM sample").fetchone()
    conn.close()
    return result
`);
    const rules: ImportFixtureRule[] = [{ file: 'sample.py', resourceSourceHash: digest(file),
        resources: [{ kind: 'sqlite', path: 'owned.sqlite', tables: [] }] }];
    return { base, root, file, originalDb, rules, targets: [{ file, target: 'target' }],
        python: resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')) };
}

test('controller previews literal schema once and every guarded worker starts with a fresh unseeded table', async () => {
    const f = fixture(), language = getLanguage();
    const settings: Record<string, any> = { pythonPath: f.python, importFixtureRoot: f.root, importFixtures: f.rules };
    const Module = require('module'), originalLoad = Module._load;
    let approvals = 0, updates = 0;
    const previews: any[] = [];
    const vscode = {
        ConfigurationTarget: { Global: 1 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: f.root } }], getConfiguration: () => ({
            get: (key: string, fallback: unknown) => settings[key] ?? fallback,
            update: async (key: string, value: unknown) => { updates++; settings[key] = value; }
        }), openTextDocument: async (file: string) => {
            if (path.basename(file) === 'setup_proposal.json') { previews.push(JSON.parse(fs.readFileSync(file, 'utf8'))); }
            return { file };
        } },
        window: { showTextDocument: async () => {}, showInformationMessage: async () => {},
            showWarningMessage: async (_message: string, _options: unknown, action: string) => {
                if (action) {
                    approvals++;
                    assert.equal(updates, 0);
                    assert.equal(previews.length, 1);
                    assert.equal(previews[0].schemaEvidence.length, 1);
                    assert.equal(previews[0].evidence.length, 1, 'directory and schema share the same approval');
                    assert.deepEqual(previews[0].schemaEvidence[0].resource, { path: 'owned.sqlite', kind: 'sqlite' });
                    assert.equal(previews[0].schemaEvidence[0].sourceHash, digest(f.file));
                    assert.equal(fs.existsSync(path.join(f.root, 'cache')), false);
                }
                return action;
            } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    try {
        setLanguage('en');
        const before = fs.readFileSync(f.file), dbBefore = fs.readFileSync(f.originalDb);
        const { ImportSetupController } = require('../environment/importSetupController');
        const ready = await new ImportSetupController(() => {}).prepare(f.root, path.join(f.base, 'reports'), f.targets);
        assert.equal(ready.status, 'ready'); assert.equal(approvals, 1); assert.equal(updates, 2);
        assert.deepEqual(ready.rows, [{ file: 'sample.py', status: 'loaded' }]);
        const planning = JSON.parse(fs.readFileSync(path.join(ready.directory, '1/import_check.json'), 'utf8'));
        assert.equal(planning.phase, 'planning'); assert.equal(planning.importsExecuted, false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(ready.directory, 'import_setup.json'), 'utf8')).checks[0].phase, 'planning');
        const report = fs.readFileSync(path.join(ready.directory, '1/import_check.md'), 'utf8');
        assert.match(report, /schema/i); assert.doesNotMatch(report, /[\u3400-\u9fff]/);
        const plan = createImportFixturePlan(f.root, settings.importFixtures, f.root)!;
        const script = `import sys, json
sys.path.insert(0, sys.argv[1])
from runtime_policy import guarded_runtime
sys.path.insert(0, sys.argv[2])
with guarded_runtime():
    import sample
    result = sample.target()
print(json.dumps(result))
`;
        const run = () => withImportFixtures(plan, () => runSpawn(f.python, ['-B', '-c', script,
            path.resolve(__dirname, '../../python_scripts'), f.root], { cwd: f.root, timeout: 15000 }));
        for (let i = 0; i < 2; i++) {
            const executed = await run();
            assert.equal(executed.code, 0, executed.stderr);
            assert.deepEqual(JSON.parse(executed.stdout), [1, 'neutral', 1.25, 1], 'fresh schema contains no inferred seed rows');
            assert.equal(executed.resourceLifecycle?.cleaned, true);
        }
        assert.deepEqual(fs.readFileSync(f.file), before); assert.deepEqual(fs.readFileSync(f.originalDb), dbBefore);
        assert.equal(fs.existsSync(path.join(f.root, 'cache')), false);
        fs.appendFileSync(f.file, '# schema source changed\n');
        const expired = await run();
        assert.notEqual(expired.code, 0, 'workers validate source identity, even after approval');
        assert.match(expired.stderr, /source changed|approval expired/i);
    } finally { Module._load = originalLoad; setLanguage(language); fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('schema source drift invalidates preview and unresolved path yields a useful report without choosing a database', async () => {
    const f = fixture();
    try {
        const planned = await inspectProjectImports(f.root, f.python, f.targets, path.join(f.base, 'plan'), f.rules, undefined, f.root, true);
        assert.equal(planned.schemaProposals?.length, 1); assert.doesNotThrow(() => verifyImportProposal(planned));
        fs.appendFileSync(f.file, '# drift\n');
        assert.throws(() => verifyImportProposal(planned), /changed|來源/i);
        fs.writeFileSync(f.file, 'import sqlite3\ndef target():\n    return 1\ndef initialize(path):\n'
            + '    conn = sqlite3.connect(path)\n    conn.execute("CREATE TABLE sample (id INTEGER)")\n');
        f.rules[0].resourceSourceHash = digest(f.file);
        const unresolved = await inspectProjectImports(f.root, f.python, f.targets, path.join(f.base, 'unresolved'), f.rules, undefined, f.root, true);
        assert.deepEqual(unresolved.rows, [{ file: 'sample.py', status: 'loaded' }]);
        assert.equal(unresolved.proposedPlan, null); assert.equal(unresolved.schemaProposals?.length, 0);
        assert.equal(unresolved.schemaDiagnostics?.[0].reason, 'dynamic-database-path');
        assert.match(fs.readFileSync(path.join(unresolved.directory, 'import_check.md'), 'utf8'), /dynamic-database-path/);
    } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a schema-only change still requires approval before module loading', async () => {
    const f = fixture();
    try {
        fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('Path("cache").mkdir(exist_ok=True)\n', ''));
        f.rules[0].resourceSourceHash = digest(f.file);
        const planned = await inspectProjectImports(f.root, f.python, f.targets, path.join(f.base, 'plan'), f.rules, undefined, f.root, true);
        assert.equal(planned.proposals.length, 0);
        assert.equal(planned.schemaProposals?.length, 1);
        assert.equal(planned.rows[0].stage, 'initialization-plan');
        assert.ok(planned.proposedPlan);
        assert.equal(JSON.parse(fs.readFileSync(path.join(planned.directory, 'import_check.json'), 'utf8')).importsExecuted, false);
        const checked = await inspectProjectImports(f.root, f.python, f.targets, path.join(f.base, 'checked'), planned.proposedRules, undefined, f.root, true);
        assert.deepEqual(checked.rows, [{ file: 'sample.py', status: 'loaded' }]);
        assert.equal(checked.proposedPlan, null); assert.equal(checked.schemaProposals?.length, 0);
    } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});
