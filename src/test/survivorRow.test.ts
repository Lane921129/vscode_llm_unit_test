import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getSurvivorRowPrompt, parseSurvivorRow, SURVIVOR_ROW_SYSTEM_PROMPT } from '../roles/qualityAnalyst';
import { runCaseTablePipeline } from '../pipeline/caseTable/runCaseTablePipeline';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const root = path.resolve(__dirname, '../..');
const python = resolvePythonExecutable(undefined, root);
const line = (fields: Record<string, string>) => JSON.stringify({ kwargs: '{}', mocks: '', requirement: '', ...fields });

test('getSurvivorRowPrompt formats single task prompt per section 5', () => {
    const prompt = getSurvivorRowPrompt({
        signature: 'calculate_bmi(weight_kg, height_cm)',
        methodKind: 'module',
        source: 'def calculate_bmi(weight_kg, height_cm):\n    return weight_kg / ((height_cm / 100) ** 2)\n',
        dependencies: [{ name: 'math.sqrt' }],
        survivor: {
            line: 2,
            original: 'return weight_kg / ((height_cm / 100) ** 2)',
            mutated: 'return weight_kg * ((height_cm / 100) ** 2)',
            description: 'Div to Mult'
        }
    });

    assert.equal(prompt.system, SURVIVOR_ROW_SYSTEM_PROMPT);
    assert.match(prompt.system, /propose one test input scenario that kills a surviving mutation/);
    assert.match(prompt.system, /Do not predict or state the expected result/);

    assert.match(prompt.user, /Target: calculate_bmi\(weight_kg, height_cm\)/);
    assert.match(prompt.user, /Module-level function/);
    assert.match(prompt.user, /Dependencies you may mock \(use exactly these names\):\s+- math\.sqrt/);
    assert.match(prompt.user, /Surviving mutant at line 2:/);
    assert.match(prompt.user, /Original:\s+return weight_kg \/ \(\(height_cm \/ 100\) \*\* 2\)/);
    assert.match(prompt.user, /Mutated:\s+return weight_kg \* \(\(height_cm \/ 100\) \*\* 2\)/);
    assert.match(prompt.user, /Note: Div to Mult/);
    assert.match(prompt.user, /Write exactly 1 line proposing an input scenario/);
    assert.match(prompt.user, /Output only that one JSON line, with no other text\./);
});

test('getSurvivorRowPrompt handles instance method signature with class name', () => {
    const prompt = getSurvivorRowPrompt({
        signature: 'grow(extra)',
        className: 'Box',
        methodKind: 'instance',
        source: 'class Box:\n    def grow(self, extra):\n        return self.size + extra\n',
        survivor: {
            line: 3,
            original: 'return self.size + extra',
            mutated: 'return self.size - extra'
        }
    });

    assert.match(prompt.user, /Target: grow\(extra\) \(method of class Box\)/);
    assert.match(prompt.user, /- \(none\)/);
});

test('parseSurvivorRow accepts valid JSON line and sets origin to quality-analyst', () => {
    const raw = '{"scenario":"input killing mutant","category":"boundary","args":"(70, 175)","kwargs":"{}","mocks":"","requirement":""}';
    const row = parseSurvivorRow(raw, { firstIndex: 5 });
    assert.ok(row);
    assert.equal(row.id, 'C5');
    assert.equal(row.origin, 'quality-analyst');
    assert.equal(row.scenario, 'input killing mutant');
    assert.equal(row.category, 'boundary');
    assert.equal(row.status, 'proposed');
    assert.deepEqual(row.call, { args: '(70, 175)', kwargs: '{}' });
});

test('parseSurvivorRow returns undefined for non-JSON or invalid input', () => {
    assert.equal(parseSurvivorRow('not a json object'), undefined);
    assert.equal(parseSurvivorRow(''), undefined);
    assert.equal(parseSurvivorRow('{"unknown_key": 123}'), undefined);
});

test('pipeline discards indistinguishable survivor row with survivor-row-indistinguishable', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-survivor-indist-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const sourceCode = [
        'def clamp_value(val: int, low: int, high: int) -> int:',
        '    if val < low:',
        '        return low',
        '    if val > high:',
        '        return high',
        '    return val',
        ''
    ].join('\n');
    fs.writeFileSync(path.join(project, 'clamp.py'), sourceCode, 'utf8');

    // C1: val=5, low=0, high=10 -> 5
    // C2: val=-1, low=0, high=10 -> 0
    // Quality Analyst proposes: val=-5, low=0, high=10 (still hits val < low, indistinguishable for high operator mutant)
    const replies = [
        [
            line({ scenario: 'normal value', category: 'normal', args: '(5, 0, 10)' }),
            line({ scenario: 'below low', category: 'boundary', args: '(-1, 0, 10)' })
        ].join('\n'),
        line({ scenario: 'further below low', category: 'boundary', args: '(-5, 0, 10)' }),
        line({ scenario: 'further below low 2', category: 'boundary', args: '(-6, 0, 10)' }),
        line({ scenario: 'further below low 3', category: 'boundary', args: '(-7, 0, 10)' })
    ];

    try {
        const result = await runCaseTablePipeline({
            filePath: path.join(project, 'clamp.py'), funcName: 'clamp_value', projectRoot: project,
            outputPath: path.join(directory, 'out'), sessionDate: 'survivor', pythonExecutable: python,
            specOracle: 'off', qualityAnalyst: true, log: () => undefined,
            mutation: { engine: 'builtin', workers: 2, stageSeconds: 60 },
            requestModel: async () => {
                const reply = replies.shift();
                if (!reply) { throw new Error('unexpected request'); }
                return reply;
            }
        });

        assert.equal(result.stage!.terminal, 'usable');
        const qualityRows = result.rows.filter(r => r.origin === 'quality-analyst');
        assert.ok(qualityRows.length > 0, 'Quality Analyst must have proposed at least one row');
        assert.ok(qualityRows.some(r => r.status === 'capture-failed' && r.reason === 'survivor-row-indistinguishable'),
            'Indistinguishable row must be marked capture-failed with reason survivor-row-indistinguishable');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('distinguishable survivor row improves mutation score and is merged', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-survivor-dist-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const sourceCode = [
        'def score_grade(pts: int) -> str:',
        '    if pts >= 90:',
        '        return "A"',
        '    if pts >= 80:',
        '        return "B"',
        '    return "C"',
        ''
    ].join('\n');
    fs.writeFileSync(path.join(project, 'grade.py'), sourceCode, 'utf8');

    // C1: pts=95 -> "A"
    // C2: pts=50 -> "C"
    // Surviving mutant on pts >= 80 (e.g. pts > 80, 80 to 81, return "B" to None)
    // Quality Analyst proposes: pts=80 -> "B" (distinguishable against pts > 80!)
    const replies = [
        [
            line({ scenario: 'high score', category: 'normal', args: '(95,)' }),
            line({ scenario: 'low score', category: 'normal', args: '(50,)' })
        ].join('\n'),
        line({ scenario: 'score 90 killing survivor on line 2', category: 'boundary', args: '(90,)' }),
        line({ scenario: 'extra survivor attempt', category: 'boundary', args: '(82,)' }),
        line({ scenario: 'extra survivor attempt 2', category: 'boundary', args: '(81,)' })
    ];

    try {
        const result = await runCaseTablePipeline({
            filePath: path.join(project, 'grade.py'), funcName: 'score_grade', projectRoot: project,
            outputPath: path.join(directory, 'out'), sessionDate: 'survivor', pythonExecutable: python,
            specOracle: 'off', qualityAnalyst: true, log: () => undefined,
            mutation: { engine: 'builtin', workers: 2, stageSeconds: 60 },
            requestModel: async () => {
                const reply = replies.shift();
                if (!reply) { throw new Error('unexpected request'); }
                return reply;
            }
        });

        assert.equal(result.stage!.terminal, 'usable');
        const qualityRows = result.rows.filter(r => r.origin === 'quality-analyst');
        assert.ok(qualityRows.length > 0, 'Quality Analyst proposed rows');
        const passedRow = qualityRows.find(r => r.status === 'test-passed');
        assert.ok(passedRow, 'Distinguishable row that improved mutation score reached test-passed');
        assert.equal(passedRow.oracleStatus, 'observed-unconfirmed');
        assert.deepEqual(passedRow.actual, { kind: 'return', value: "'A'" });

        const testFileContent = fs.readFileSync(result.stage!.testFile!, 'utf8');
        assert.match(testFileContent, /test_c3/, 'Merged test file must contain the new passing survivor row test');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('survivor rows stop at qualityNoImprovementLimit or max 3 attempts', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-survivor-cap-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const sourceCode = [
        'def check_sign(x: int) -> str:',
        '    if x > 0:',
        '        return "positive"',
        '    if x < 0:',
        '        return "negative"',
        '    return "zero"',
        ''
    ].join('\n');
    fs.writeFileSync(path.join(project, 'sign.py'), sourceCode, 'utf8');

    let qaRequests = 0;
    const replies = [
        line({ scenario: 'positive number', category: 'normal', args: '(10,)' }),
        // Indistinguishable attempts:
        line({ scenario: 'attempt 1', category: 'normal', args: '(20,)' }),
        line({ scenario: 'attempt 2', category: 'normal', args: '(30,)' }),
        line({ scenario: 'attempt 3', category: 'normal', args: '(40,)' }),
        line({ scenario: 'attempt 4', category: 'normal', args: '(50,)' })
    ];

    try {
        const result = await runCaseTablePipeline({
            filePath: path.join(project, 'sign.py'), funcName: 'check_sign', projectRoot: project,
            outputPath: path.join(directory, 'out'), sessionDate: 'survivor', pythonExecutable: python,
            specOracle: 'off', qualityAnalyst: true, log: () => undefined,
            mutation: { engine: 'builtin', workers: 2, stageSeconds: 60 },
            requestModel: async (_sys, user) => {
                if (/Surviving mutant at line/i.test(user)) {
                    qaRequests++;
                }
                const reply = replies.shift();
                if (!reply) { throw new Error('unexpected request'); }
                return reply;
            }
        });

        assert.equal(result.stage!.terminal, 'usable');
        assert.ok(qaRequests <= 3, `Quality Analyst requests must be at most 3, got ${qaRequests}`);
        const qualityRows = result.rows.filter(r => r.origin === 'quality-analyst');
        assert.ok(qualityRows.length <= 3, `Quality Analyst rows must be at most 3, got ${qualityRows.length}`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
