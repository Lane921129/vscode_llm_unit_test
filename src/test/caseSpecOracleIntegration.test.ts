import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runCaseTablePipeline, SpecOracleSetting } from '../pipeline/caseTable/runCaseTablePipeline';
import { readCaseTable } from '../pipeline/caseTable/caseTableStore';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const root = path.resolve(__dirname, '../..');
const python = resolvePythonExecutable(undefined, root);
const line = (fields: Record<string, string>) => JSON.stringify({ kwargs: '{}', mocks: '', requirement: '', ...fields });
const DOCSTRING = 'Return value, but never more than high.\n\n    Values equal to high are returned unchanged.\n    ';
const buggy = (doc: boolean) => `def clamp(value, high=10):\n${doc ? `    """${DOCSTRING}"""\n` : ''}    if value >= high:\n        return high - 1\n    return value\n`;
const scenario = [line({ scenario: 'value below high', category: 'normal', args: '(5,)' }),
    line({ scenario: 'value equal to high', category: 'boundary', args: '(10,)' })].join('\n');
const spec = (expect: string, basis: string) => JSON.stringify({ expect, basis });
const callOf: Record<string, string> = { 'value below high': 'clamp(5)', 'value equal to high': 'clamp(10)' };

async function run(source: string, specReplies: Record<string, string[]>, setting: SpecOracleSetting = 'auto') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-spec-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'limits.py'), source, 'utf8');
    const specPrompts: string[] = [];
    let scenarioRequests = 0;
    try {
        const result = await runCaseTablePipeline({
            filePath: path.join(project, 'limits.py'), funcName: 'clamp', projectRoot: project, outputPath: path.join(directory, 'out'),
            sessionDate: 'spec', pythonExecutable: python, specOracle: setting, log: () => undefined,
            mutation: { engine: 'builtin', workers: 1, stageSeconds: 60 },
            requestModel: async (system, user, options) => {
                assert.deepEqual(options, system.startsWith('You predict') ? { temperature: 0.7 } : undefined,
                    'only spec predictions carry a temperature (0.7)');
                if (system.startsWith('You predict')) {
                    specPrompts.push(system + '\n' + user);
                    assert.ok(!/Scenario:|value below high|value equal to high/.test(user), 'spec prompts carry no scenario text');
                    const key = Object.keys(specReplies).find(name => user.includes(`Call: ${callOf[name]}`))!;
                    const reply = specReplies[key].shift();
                    if (reply === undefined) { throw new Error(`no spec reply for ${key}`); }
                    return reply;
                }
                scenarioRequests += 1;
                return scenario;
            }
        });
        const files = (name: string) => fs.existsSync(path.join(result.directory, name)) ? fs.readFileSync(path.join(result.directory, name), 'utf8') : null;
        return { result, specPrompts, scenarioRequests, files, table: readCaseTable(result.directory),
            formal: fs.readFileSync(result.stage!.testFile!, 'utf8') };
    } finally { setTimeout(() => fs.rmSync(directory, { recursive: true, force: true }), 0); }
}

test('a boundary bug is listed as spec-mismatch and kept out of the formal tests; prompts stay blind', async () => {
    const sentence = 'Values equal to high are returned unchanged.';
    const { result, specPrompts, files, table, formal } = await run(buggy(true), {
        'value below high': Array(3).fill(spec('return 5', 'Return value, but never more than high.')),
        'value equal to high': Array(3).fill(spec('return 10', sentence))
    });
    assert.equal(specPrompts.length, 6, 'k = 3 independent predictions per row');
    for (const prompt of specPrompts) {
        assert.ok(!prompt.includes('high - 1') && !prompt.includes('value >= high'), 'no function body in the spec prompt');
        assert.ok(!/\b9\b/.test(prompt) && !/verified|已驗證/i.test(prompt));
    }
    assert.deepEqual(table.rows.map(row => [row.id, row.status, row.oracleStatus]), [['C1', 'test-passed', 'spec-matched'], ['C2', 'captured', 'spec-mismatch']]);
    assert.deepEqual(table.rows[1].expected, { kind: 'return', value: '10', source: 'spec', confirmedBySpec: true });
    assert.deepEqual(table.rows[1].actual, { kind: 'return', value: '9' });
    assert.ok(formal.includes('def test_c1') && !formal.includes('def test_c2'), 'spec-mismatch rows are not in the formal test file');
    assert.match(files('test_spec_mismatch.py')!, /def test_c2[\s\S]*self\.assertEqual\(result, 10\)/);
    const report = JSON.parse(files('spec_mismatch.json')!);
    assert.equal(report.specMismatch.length, 1);
    assert.equal(report.specMismatch[0].predictions[0].basisVerified, true);
    assert.equal(result.specMismatch!.specMismatchCount, 1);
    assert.equal(JSON.parse(files('function_knowledge.json')!).specMismatchCount, 1);
    assert.equal(result.stage!.terminal, 'usable');
});

test('an unverifiable basis becomes needs-review with the observed value; disagreeing predictions are unstable', async () => {
    const { table, files, formal } = await run(buggy(true), {
        'value below high': [spec('return 5', 'Return value, but never more than high.'), spec('return 6', 'Return value, but never more than high.'),
            spec('return 5', 'Return value, but never more than high.')],
        'value equal to high': Array(3).fill(spec('return 10', 'The name clamp suggests it.'))
    });
    assert.deepEqual(table.rows.map(row => [row.id, row.status, row.oracleStatus]), [['C1', 'test-passed', 'prediction-unstable'], ['C2', 'test-passed', 'needs-review']]);
    assert.deepEqual(table.rows[1].expected, { kind: 'return', value: '9', source: 'observed', confirmedBySpec: false });
    assert.match(formal, /def test_c2[\s\S]*self\.assertEqual\(result, 9\)/);
    assert.equal(JSON.parse(files('spec_mismatch.json')!).needsReview.length, 1);
    assert.equal(files('test_spec_mismatch.py'), null);
});

test('without a docstring, or with specOracle off, no spec prediction is requested at all', async () => {
    const noDoc = await run(buggy(false), {});
    assert.equal(noDoc.specPrompts.length, 0);
    assert.equal(noDoc.result.specOracleUsed, false);
    assert.ok(noDoc.table.rows.every(row => row.oracleStatus === 'observed-unconfirmed'));
    const off = await run(buggy(true), {}, 'off');
    assert.equal(off.specPrompts.length, 0);
    assert.equal(off.scenarioRequests, 1);
    assert.ok(off.table.rows.every(row => row.oracleStatus === 'observed-unconfirmed'));
});
