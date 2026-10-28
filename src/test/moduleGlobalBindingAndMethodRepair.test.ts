import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pythonToolPath } from '../pipeline/pythonTools';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { getUserPrompt } from '../roles/unittestWriter';
import { validateTestCandidate, CandidateValidationError } from '../pipeline/testCandidatePipeline';
import { planWriterMethodEdits, applyWriterMethodEdits } from '../validation/writerMethodEdits';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));

test('AST extractor distinguishes literal-constant from existing-object, object-reference and rebound globals', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-globals-'));
    try {
        const file = path.join(tempDir, 'sample.py');
        const source = [
            'CONFIG_PORT = 8080',
            'DATABASE_CONN = create_connection("db://localhost")',
            'CONN_ALIAS = DATABASE_CONN',
            'REBOUND_VAR = "first"',
            'REBOUND_VAR = "second"',
            'def target():',
            '    return DATABASE_CONN.ping(CONFIG_PORT), CONN_ALIAS, REBOUND_VAR'
        ].join('\n');
        fs.writeFileSync(file, source, 'utf8');

        const run = spawnSync(python, ['-B', pythonToolPath('ast'), file, 'target'], {
            encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        assert.equal(run.status, 0, run.stderr);
        const context = JSON.parse(run.stdout);

        const globals: Array<{ name: string; kind: string; binding_kind: string; code: string; initialization_callee?: string }> =
            context.referenced_globals;
        assert.ok(Array.isArray(globals));

        const port = globals.find(g => g.name === 'CONFIG_PORT');
        assert.ok(port, 'CONFIG_PORT should be referenced');
        assert.equal(port.binding_kind, 'literal-constant');

        const conn = globals.find(g => g.name === 'DATABASE_CONN');
        assert.ok(conn, 'DATABASE_CONN should be referenced');
        assert.equal(conn.binding_kind, 'existing-object');
        assert.equal(conn.initialization_callee, 'create_connection');
        assert.equal(globals.find(g => g.name === 'CONN_ALIAS')?.binding_kind, 'object-reference');
        assert.equal(globals.find(g => g.name === 'REBOUND_VAR')?.binding_kind, 'unknown');

        const prompt = getUserPrompt('sample.py', 'target', context.code, 'small', context, undefined, 2000, '');

        // Existing objects must have explicit guidance and not be categorized as plain constants
        assert.match(prompt, /- Referenced module call-result bindings \(initialized at module scope/);
        assert.match(prompt, /DATABASE_CONN \(initialized as `DATABASE_CONN = create_connection\("db:\/\/localhost"\)` in module; do not re-initialize in test\)/);

        // Constant must be categorized under constants
        assert.match(prompt, /- Referenced immutable literal initializers[^\n]+\n\s+- CONFIG_PORT = 8080/);

        // DATABASE_CONN must not be under constants
        const constantsSection = prompt.split('- Referenced immutable literal initializers')[1]?.split('- Referenced module call-result bindings')[0] || '';
        assert.doesNotMatch(constantsSection, /DATABASE_CONN/);

        const legacyPrompt = getUserPrompt('sample.py', 'target', context.code, 'small', { ...context,
            referenced_globals: [{ name: 'LEGACY', code: 'LEGACY = make_value()' }] }, undefined, 2000, '');
        assert.match(legacyPrompt, /Referenced module globals \(dynamic or rebound; verify in source\)/);
        assert.doesNotMatch(legacyPrompt, /Referenced immutable literal initializers|Referenced module call-result bindings/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('validate_test_bindings reports line and method for definite name failure', () => {
    const code = [
        'import unittest',
        'from sample import target',
        'class TestCases(unittest.TestCase):',
        '    def test_first(self):',
        '        unresolved_call = create_engine("db://")',
        '        self.assertIsNone(target())',
    ].join('\n');

    const result = spawnSync(python, ['-B', pythonToolPath('bindings'), '--payload'], {
        encoding: 'utf8', timeout: 10000, input: JSON.stringify({
            code,
            context: { module: 'sample', target: 'target', dependencies: {}, source: 'def target(): pass\n' }
        }),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.valid, false);
    assert.match(parsed.reason, /Writer binding repair: create_engine is undefined or read before its local binding in test_first/);
    assert.equal(parsed.method, 'test_first');
    assert.equal(parsed.className, 'TestCases');
    assert.equal(parsed.line, 4);
});

test('Writer revision producing an identical candidate immediately stops with 没有有效修改', async () => {
    const candidate = [
        'import unittest',
        'class TestSample(unittest.TestCase):',
        '    def test_run(self):',
        '        self.assertEqual(1, 1)'
    ].join('\n');

    let revisionCount = 0;
    const rejections: unknown[][] = [];

    await assert.rejects(async () => {
        await validateTestCandidate(candidate, {
            validate: async () => 'name error',
            review: async () => ({ issues: [] }),
            execute: async () => ({ ok: false, out: 'failed', qualityGaps: [] }),
            revise: async () => {
                revisionCount++;
                return candidate; // Return the exact same code
            },
            rejectedCandidate: (...args) => { rejections.push(args); },
            checkCancelled: () => {},
            event: () => {}
        }, 3);
    }, (error: unknown) => {
        assert.ok(error instanceof CandidateValidationError);
        assert.match((error as Error).message, /沒有有效修改：測試修訂產生了相同候選，停止重複修復。/);
        return true;
    });

    // Must not loop multiple times; stops at revision 1
    assert.equal(revisionCount, 1);
    assert.equal(rejections.some(r => r[3] === 'repeated-candidate'), true);
});

test('AST method edit plan uses current rejected candidate as baseline and detects no-method-change', async () => {
    const baseline = [
        'import unittest',
        'class TestCases(unittest.TestCase):',
        '    def test_first(self):',
        '        self.assertEqual(1, 1)',
        '    def test_second(self):',
        '        self.assertEqual(2, 2)'
    ].join('\n');

    // Locate test_second (line 5)
    const plan = await planWriterMethodEdits({
        baseline,
        lineRefs: [5],
        python
    });

    assert.equal(plan.ok, true);
    if (!plan.ok) { return; }

    assert.equal(plan.methods.length, 1);
    assert.equal(plan.methods[0].name, 'test_second');

    // Replacing test_second with updated assertions
    const replacement = [
        'class TestCases(unittest.TestCase):',
        '    def test_second(self):',
        '        self.assertEqual(2 + 0, 2)'
    ].join('\n');

    const applied = await applyWriterMethodEdits({
        baseline,
        lineRefs: [5],
        plan,
        response: replacement,
        python
    });

    assert.equal(applied.ok, true);
    if (!applied.ok) { return; }
    assert.match(applied.code, /self\.assertEqual\(2 \+ 0, 2\)/);
    assert.match(applied.code, /def test_first/); // test_first preserved untouched!

    // If response does not change method AST, it reports edit-no-method-change
    const unchangedApplied = await applyWriterMethodEdits({
        baseline,
        lineRefs: [5],
        plan,
        response: [
            'class TestCases(unittest.TestCase):',
            '    def test_second(self):',
            '        self.assertEqual(2, 2)'
        ].join('\n'),
        python
    });

    assert.equal(unchangedApplied.ok, false);
    if (unchangedApplied.ok === false) {
        assert.equal(unchangedApplied.reasonCode, 'edit-no-method-change');
    }
});
