import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getSurvivorRowPrompt, parseSurvivorRow, SURVIVOR_ROW_SYSTEM_PROMPT, SURVIVOR_TESTED_INPUT_LIMIT, SurvivorTestedInput } from '../roles/qualityAnalyst';
import { caseDependencyLines, caseTargetLines, getCaseScenarioPrompt } from '../roles/semanticAnalyzer';
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

    assert.ok(prompt.user.includes('Target: grow(extra)\nMethod of class Box (instance method; args exclude self)'));
    assert.ok(prompt.user.includes('Dependencies you may mock (use exactly these names):\n(none) - leave "mocks" empty'));
});

test('the survivor prompt describes the target and dependencies with the same helper as the scenario prompt', () => {
    const base = { signature: 'grow(extra)', className: 'Box', methodKind: 'instance' as const, isAsync: false, source: 'def grow(self, extra):\n    return extra\n',
        dependencies: [{ name: 'math.sqrt' }] };
    for (const facts of [base, { ...base, methodKind: 'class' as const }, { ...base, methodKind: 'static' as const },
        { ...base, className: null, methodKind: 'module' as const, isAsync: true, dependencies: [] }]) {
        const survivor = getSurvivorRowPrompt({ ...facts, className: facts.className ?? undefined,
            survivor: { line: 2, original: 'return extra', mutated: 'return None' } }).user;
        const scenario = getCaseScenarioPrompt({ ...facts, docstring: null, branches: [], raises: [] }, []).user;
        const shared = [...caseTargetLines(facts), '', ...caseDependencyLines(facts.dependencies)].join('\n');
        assert.ok(survivor.startsWith(shared), `survivor prompt starts with the shared lines for ${facts.methodKind}`);
        assert.ok(scenario.includes(caseTargetLines(facts).join('\n')) && scenario.includes(caseDependencyLines(facts.dependencies).join('\n')));
    }
    const async = getSurvivorRowPrompt({ ...base, className: undefined, methodKind: 'module', isAsync: true, survivor: { line: 1, original: 'a', mutated: 'b' } }).user;
    assert.match(async, /^Target: async grow\(extra\)\nModule-level function/);
});

test('the survivor prompt numbers source lines as in the file and lists at most 12 tested inputs without results', () => {
    const tested: SurvivorTestedInput[] = Array.from({ length: SURVIVOR_TESTED_INPUT_LIMIT + 1 }, (_value, index): SurvivorTestedInput => ({
        call: { args: `(${index}, 0, 10)`, kwargs: '{}' }, mocks: index === 0 ? [{ dependency: 'clock.now', behavior: 'raise', value: 'OSError' }] : [] }));
    tested[1] = { call: { needsSetup: 'a list with three items' }, mocks: [{ dependency: 'db.get', behavior: 'return', value: "{'k': 'v'}" }] };
    const prompt = getSurvivorRowPrompt({ signature: 'clamp(val, low, high)', source: 'def clamp(val, low, high):\n    if val < low:\n        return low\n    return val',
        startLine: 9, survivor: { line: 10, original: 'if val < low:', mutated: 'if val <= low:' }, testedInputs: tested }).user;
    assert.ok(prompt.includes('```python\n 9: def clamp(val, low, high):\n10:     if val < low:\n11:         return low\n12:     return val\n```'));
    assert.ok(prompt.includes('Surviving mutant at line 10:'));
    const listed = prompt.split('\n').filter(item => item.startsWith('{"args"'));
    assert.equal(listed.length, SURVIVOR_TESTED_INPUT_LIMIT);
    assert.equal(listed[0], JSON.stringify({ args: '(0, 0, 10)', kwargs: '{}', mocks: 'clock.now -> raise OSError' }));
    assert.equal(listed[1], JSON.stringify({ args: '<needs-setup: a list with three items>', kwargs: '{}', mocks: "db.get -> {'k': 'v'}" }));
    assert.ok(!prompt.includes('(12, 0, 10)'), 'the 13th input is not listed');
    assert.ok(prompt.includes('Propose an input that is different from all of these.'));
    assert.doesNotMatch(prompt, /expected|actual/i);
    assert.doesNotMatch(prompt, /input distinguishing original and mutant/);
    const none = getSurvivorRowPrompt({ signature: 'f()', source: 'def f():\n    return 1', survivor: { line: 2, original: 'return 1', mutated: 'return 2' } }).user;
    assert.doesNotMatch(none, /Inputs already used/);
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
        const result = await runCaseTablePipeline({ caseTableReview: 'off',
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
        const findings = JSON.parse(fs.readFileSync(path.join(result.directory, 'design.json'), 'utf8')).findings;
        assert.ok(findings.length > 0);
        assert.ok(findings.every((finding: any) => finding.line > 0 && finding.original && finding.mutated && finding.rowIds.length > 0));
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
        const result = await runCaseTablePipeline({ caseTableReview: 'off',
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
        const result = await runCaseTablePipeline({ caseTableReview: 'off',
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

async function runClamp(name: string, qualityReplies: string[]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `v2-survivor-${name}-`));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'clamp.py'), ['def clamp_value(val: int, low: int, high: int) -> int:', '    if val < low:', '        return low',
        '    if val > high:', '        return high', '    return val', ''].join('\n'), 'utf8');
    const replies = [[line({ scenario: 'normal value', category: 'normal', args: '(5, 0, 10)' }),
        line({ scenario: 'below low', category: 'boundary', args: '(-1, 0, 10)' })].join('\n'), ...qualityReplies];
    const prompts: string[] = [];
    try {
        const result = await runCaseTablePipeline({ caseTableReview: 'off',
            filePath: path.join(project, 'clamp.py'), funcName: 'clamp_value', projectRoot: project,
            outputPath: path.join(directory, 'out'), sessionDate: 'survivor', pythonExecutable: python,
            specOracle: 'off', qualityAnalyst: true, log: () => undefined,
            mutation: { engine: 'builtin', workers: 2, stageSeconds: 60 },
            requestModel: async (_system, user) => {
                prompts.push(user);
                const reply = replies.shift();
                if (reply === undefined) { throw new Error('unexpected request'); }
                return reply;
            }
        });
        const findings = JSON.parse(fs.readFileSync(path.join(result.directory, 'design.json'), 'utf8')).findings;
        return { result, prompts, findings, remaining: replies.length };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('a survivor row repeating an existing input is rejected without capture and never becomes a design finding', async () => {
    const duplicate = line({ scenario: 'same normal value again', category: 'normal', args: '(5, 0, 10)' });
    const { result, prompts, findings, remaining } = await runClamp('dup', [duplicate, duplicate, duplicate]);
    assert.equal(remaining, 0);
    assert.equal(prompts.length, 4, 'one scenario request and three survivor attempts');
    assert.ok(prompts[1].includes(JSON.stringify({ args: '(5, 0, 10)', kwargs: '{}', mocks: '' })), 'passing inputs are listed');
    assert.ok(prompts[1].includes(JSON.stringify({ args: '(-1, 0, 10)', kwargs: '{}', mocks: '' })));
    assert.deepEqual(result.rows.filter(row => row.origin === 'quality-analyst'), []);
    assert.deepEqual(findings, []);
    assert.equal(result.stage!.terminal, 'usable');
});

test('a malformed survivor line is re-asked once and the corrected row proceeds; a second failure counts as no improvement', async () => {
    const malformed = JSON.stringify({ scenario: 'value above high', category: 'outlier', args: '(11, 0, 10)', kwargs: '{}', mocks: '', requirement: '' });
    const corrected = line({ scenario: 'value above high', category: 'boundary', args: '(11, 0, 10)' });
    const { result, prompts, remaining } = await runClamp('fix', [malformed, corrected, malformed, malformed, malformed, malformed]);
    assert.equal(remaining, 0);
    assert.ok(prompts[2].includes('This scenario line could not be used:\n' + malformed));
    assert.ok(prompts[2].includes('Problem: "category" is not one of the allowed values (key "category").'));
    assert.ok(prompts[2].startsWith('Target: clamp_value(val: int, low: int, high: int) -> int\nModule-level function'));
    assert.equal(prompts.filter(prompt => prompt.includes('This scenario line could not be used:')).length, 3, 'exactly one correction per attempt');
    const quality = result.rows.filter(row => row.origin === 'quality-analyst');
    assert.equal(quality.length, 1);
    assert.deepEqual([quality[0].call, quality[0].category], [{ args: '(11, 0, 10)', kwargs: '{}' }, 'boundary']);
    assert.notEqual(quality[0].status, 'invalid');
});

test('a survivor row that fails case_row_validator is recorded invalid and never captured', async () => {
    const tooMany = line({ scenario: 'four arguments', category: 'error', args: '(1, 2, 3, 4)' });
    const { result, findings } = await runClamp('invalid', [tooMany, tooMany.replace('four', 'still four'), tooMany.replace('four', 'again four')]);
    const quality = result.rows.filter(row => row.origin === 'quality-analyst');
    assert.ok(quality.length >= 1);
    for (const row of quality) {
        assert.equal(row.status, 'invalid');
        assert.equal(row.reason, 'signature-mismatch');
        assert.equal(row.actual, undefined, 'no capture ran');
    }
    assert.deepEqual(findings, []);
});
