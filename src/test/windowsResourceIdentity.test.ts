import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inspectProjectImports, verifyImportProposal } from '../environment/projectImportCheck';
import { createImportFixturePlan, withImportFixtures } from '../pipeline/importFixtures';
import { existingRealPath } from '../utils/fileIdentity';
import { canonicalExternalResourcePath } from '../pipeline/isolatedResources';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { runSpawn } from '../utils/processRunner';
import { buildTargetIsolatedResourceContext, type IsolatedResourceSourceEvidence } from '../prompts/isolatedResourceContext';
import { SOURCE_VERSIONS_VERSION } from '../pipeline/sourceVersions';
import { batchScopeFiles, batchScopeStateKey, createBatchScopeSelection } from '../pipeline/batchScope';
import { captureBatchSetupScope } from '../pipeline/batchSetupContinuity';
import type { ImportSetupResult } from '../environment/importSetupController';

test('Windows short and long source roots share approved parent resources and isolated SQLite schema',
    { skip: process.platform !== 'win32' }, async t => {
        const base = existingRealPath(fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-resource-long-directory-')));
        const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
        try {
            // Use a real filesystem alias, never mock realpath to manufacture proof.
            const shortPath = (location: string) => execFileSync(python, ['-c',
                'import ctypes,sys; b=ctypes.create_unicode_buffer(32768); n=ctypes.windll.kernel32.GetShortPathNameW(sys.argv[1],b,len(b)); print(b.value if n else "")',
                location], { encoding: 'utf8' }).trim();
            const short = shortPath(base);
            if (!short || short.toLowerCase() === base.toLowerCase()) {
                t.skip('The test volume does not provide an 8.3 alias.'); return;
            }
            const root = path.join(base, 'app'), shortRoot = path.join(short, 'app'); fs.mkdirSync(root);
            const file = path.join(root, 'sample.py'), shortFile = path.join(shortRoot, 'sample.py');
            const source = `import sqlite3
from pathlib import Path
DATA = Path(__file__).parent.parent / "SiblingData"
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / "owned.sqlite"
def initialize():
    conn = sqlite3.connect(DB)
    conn.execute("CREATE TABLE IF NOT EXISTS sample (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL UNIQUE DEFAULT 'neutral')")
    raise RuntimeError("initializer must not execute")
def target():
    conn = sqlite3.connect(DB)
    conn.execute("INSERT INTO sample DEFAULT VALUES")
    result = conn.execute("SELECT id, label FROM sample").fetchall()
    conn.close()
    return result
`;
            fs.writeFileSync(file, source);
            const original = path.join(base, 'SiblingData'); fs.mkdirSync(original);
            const originalDb = path.join(original, 'owned.sqlite');
            fs.writeFileSync(originalDb, 'original database must never be opened');
            const planned = await inspectProjectImports(shortRoot, python, [{ file, target: 'target' }],
                path.join(base, 'preview'), [], undefined, root, true);
            assert.equal(planned.rows[0].stage, 'initialization-plan');
            assert.equal(planned.proposals.length, 1);
            assert.equal(planned.proposals[0].resourceScope, 'project-parent');
            assert.equal(planned.schemaProposals?.length, 1);
            verifyImportProposal(planned);
            const plan = createImportFixturePlan(shortRoot, planned.proposedRules, root)!;
            assert.equal(plan.root, root);
            assert.deepEqual(plan, createImportFixturePlan(root, planned.proposedRules, shortRoot));
            const loaded = await inspectProjectImports(root, python, [{ file: shortFile, target: 'target' }],
                path.join(base, 'confirmed'), planned.proposedRules, undefined, shortRoot, true);
            assert.deepEqual(loaded.rows.map(row => row.status), ['loaded']);
            assert.equal(loaded.schemaProposals?.length || 0, 0);
            const hash = createHash('sha256').update(source).digest('hex');
            const longEvidence: IsolatedResourceSourceEvidence = { version: SOURCE_VERSIONS_VERSION, target: { file, hash }, sources: [{ file, hash }] };
            const shortEvidence = { ...longEvidence, target: { file: shortFile, hash }, sources: [{ file: shortFile, hash }] };
            const resourceContext = buildTargetIsolatedResourceContext(plan, longEvidence);
            assert.equal(resourceContext.status, 'projected');
            assert.ok(resourceContext.resourceCount > 0);
            assert.deepEqual(buildTargetIsolatedResourceContext(plan, shortEvidence), resourceContext);
            assert.deepEqual(buildTargetIsolatedResourceContext({ ...plan, root: shortRoot }, longEvidence), resourceContext);
            assert.equal(batchScopeStateKey(shortRoot), batchScopeStateKey(root));
            assert.deepEqual(batchScopeFiles(shortRoot, [file, shortFile]), ['sample.py']);
            assert.deepEqual(batchScopeFiles(root, [shortFile]), ['sample.py']);
            const scope = createBatchScopeSelection(shortRoot, ['sample.py'], ['sample.py']);
            assert.equal(scope.root, shortRoot, 'report provenance retains the selected root spelling');
            const scopeGuard = captureBatchSetupScope(scope, python);
            const result: ImportSetupResult = { status: 'ready', fixtureId: plan.id, root, python,
                targets: [{ file, target: 'target' }], rows: [{ file: 'sample.py', status: 'loaded' }], applied: true };
            scopeGuard.verify(result, [{ file: shortFile, target: 'target' }], python);
            scopeGuard.verify({ ...result, root: shortRoot, targets: [{ file: shortFile, target: 'target' }] },
                [{ file, target: 'target' }], python);
            assert.throws(() => scopeGuard.verify({ ...result, targets: [{ file, target: 'other' }] },
                [{ file: shortFile, target: 'target' }], python), /批次停止/);
            const script = 'import sys,json\nsys.path.insert(0,sys.argv[1])\nfrom runtime_policy import guarded_runtime\n'
                + 'sys.path.insert(0,sys.argv[2])\nwith guarded_runtime():\n    import sample\n    value=sample.target()\nprint(json.dumps(value))\n';
            for (let attempt = 0; attempt < 2; attempt++) {
                const executed = await withImportFixtures(plan, () => runSpawn(python, ['-B', '-c', script,
                    path.resolve(__dirname, '../../python_scripts'), attempt === 0 ? shortRoot : root], { cwd: shortRoot, timeout: 15000 }));
                assert.equal(executed.code, 0, executed.stderr);
                assert.deepEqual(JSON.parse(executed.stdout), [[1, 'neutral']], 'each worker has a new approved seed');
                assert.equal(executed.resourceLifecycle?.cleaned, true);
            }
            // Register the long generated filename, then import it through the
            // short source root: alias normalization must never grant app I/O.
            const generated = path.join(root, 'neutral_generated_test_case.py');
            fs.writeFileSync(generated, 'import sqlite3\ndef direct(): return sqlite3.connect("../SiblingData/owned.sqlite")\n');
            const negative = 'import sys\nsys.path.insert(0,sys.argv[1])\n'
                + 'from runtime_policy import guarded_runtime, RuntimePolicyError\n'
                + 'from isolated_resources import set_generated_test_file\n'
                + 'set_generated_test_file(sys.argv[3])\nsys.path.insert(0,sys.argv[2])\n'
                + 'import importlib.util,importlib.machinery\nspec=importlib.util.spec_from_file_location("generated",sys.argv[4],loader=importlib.machinery.SourceFileLoader("generated",sys.argv[4]))\n'
                + 'generated=importlib.util.module_from_spec(spec)\n'
                + 'try:\n    with guarded_runtime():\n        spec.loader.exec_module(generated)\n        print("generated-loaded")\n        generated.direct()\n'
                + 'except RuntimePolicyError: print("blocked")\nelse: raise AssertionError("generated I/O allowed")\n';
            const blocked = await withImportFixtures(plan, () => runSpawn(python, ['-B', '-c', negative,
                path.resolve(__dirname, '../../python_scripts'), shortRoot, generated, shortPath(generated)], { cwd: shortRoot, timeout: 15000 }));
            assert.equal(blocked.code, 0, blocked.stderr); assert.match(blocked.stdout, /generated-loaded/); assert.match(blocked.stdout, /blocked/);
            assert.equal(blocked.resourceLifecycle?.cleaned, true);
            assert.throws(() => canonicalExternalResourcePath(shortRoot), /Invalid/,
                'unproved external 8.3 addresses must not bypass source overlap protection');
            assert.equal(fs.readFileSync(file, 'utf8'), source);
            assert.equal(fs.readFileSync(originalDb, 'utf8'), 'original database must never be opened');
            assert.deepEqual(fs.readdirSync(original), ['owned.sqlite']);
            const dependency = path.join(root, 'dependency.py'); fs.writeFileSync(dependency, 'VALUE = 1\n');
            const dependencyHash = createHash('sha256').update(fs.readFileSync(dependency)).digest('hex');
            const linked = path.join(root, 'linked'); fs.symlinkSync(base, linked, 'junction');
            try {
                assert.throws(() => createImportFixturePlan(shortRoot, [{ file: 'sample.py',
                    sourceDependencies: [{ file: 'linked/app/dependency.py', sourceHash: dependencyHash }] }]), /link/);
            } finally { fs.unlinkSync(linked); }
            fs.appendFileSync(file, '# source changed\n');
            assert.throws(() => createImportFixturePlan(shortRoot, planned.proposedRules, root), /expired|changed/);
            assert.equal(buildTargetIsolatedResourceContext(plan, shortEvidence).status, 'source-drift');
            assert.throws(() => scopeGuard.verify(result, [{ file: shortFile, target: 'target' }], python), /批次停止/);
        } finally { fs.rmSync(base, { recursive: true, force: true }); }
    });
