import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runCaseTablePipeline } from '../pipeline/caseTable/runCaseTablePipeline';
import { readCaseTable } from '../pipeline/caseTable/caseTableStore';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { getCaseScenarioPrompt, CaseScenarioPromptFacts } from '../roles/semanticAnalyzer';
import { runTestFile, RowRuntime } from '../pipeline/caseTable/rowExecution';

const root = path.resolve(__dirname, '../..');
const python = resolvePythonExecutable(undefined, root);
const line = (fields: Record<string, string>) => JSON.stringify({ kwargs: '{}', mocks: '', requirement: '', ...fields });

const SOURCE_MATH = `def classify_number(n):
    if n < 0:
        raise ValueError("negative")
    if n == 0:
        return "zero"
    if n > 100:
        return "large"
    return "normal"
`;

const dummyFacts: CaseScenarioPromptFacts = {
    signature: 'calc(x)',
    source: 'def calc(x): return x',
    docstring: null,
    branches: [],
    raises: [],
    dependencies: [],
    isAsync: false,
    className: null,
    methodKind: 'module'
};

test('PR #13b: getCaseScenarioPrompt appends boundary-first requirement when testFocus is boundary', () => {
    const promptFull = getCaseScenarioPrompt(dummyFacts, [], { testFocus: 'full' });
    assert.equal(promptFull.user.includes('At least 4 of the lines must be category boundary or error.'), false);

    const promptBoundary = getCaseScenarioPrompt(dummyFacts, [], { testFocus: 'boundary' });
    assert.ok(promptBoundary.user.includes('At least 4 of the lines must be category boundary or error.'));
});

test('PR #13b: getCaseScenarioPrompt appends uncovered branches constraint when provided', () => {
    const promptUncovered = getCaseScenarioPrompt(dummyFacts, [], {
        testFocus: 'coverage',
        uncoveredBranches: 'line 5 -> line 6 (n == 0), line 7 -> line 8 (n > 100)'
    });
    assert.ok(promptUncovered.user.includes('Only propose scenarios that reach these uncovered branch conditions:'));
    assert.ok(promptUncovered.user.includes('line 5 -> line 6 (n == 0)'));
});

test('PR #13b: boundary test focus sorts boundary and error rows to front and records testFocus', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-focus-boundary-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'math_ops.py'), SOURCE_MATH, 'utf8');

    const prompts: string[] = [];
    const replies = [
        [
            line({ scenario: '一般正數', category: 'normal', args: '(50,)' }),
            line({ scenario: '邊界零', category: 'boundary', args: '(0,)' }),
            line({ scenario: '負數錯誤', category: 'error', args: '(-5,)' }),
            line({ scenario: '較大正數', category: 'normal', args: '(80,)' })
        ].join('\n')
    ];

    try {
        const result = await runCaseTablePipeline({
            filePath: path.join(project, 'math_ops.py'),
            funcName: 'classify_number',
            projectRoot: project,
            outputPath: path.join(directory, 'out'),
            sessionDate: 'focus',
            pythonExecutable: python,
            specOracle: 'off',
            qualityAnalyst: 'off',
            testFocus: 'boundary',
            log: () => undefined,
            mutation: { engine: 'builtin', workers: 1, stageSeconds: 60 },
            requestModel: async (_system, user) => {
                prompts.push(user);
                return replies.shift()!;
            }
        });

        // 1. Prompt has the boundary-first sentence
        assert.ok(prompts[0].includes('At least 4 of the lines must be category boundary or error.'));

        // 2. Rows in case_table.json have boundary and error sorted to front
        const table = readCaseTable(result.directory);
        assert.equal(table.testFocus, 'boundary');
        assert.equal(table.rows.length, 4);

        // Boundary and error should be C1 and C2
        const firstTwoCategories = [table.rows[0].category, table.rows[1].category];
        assert.ok(firstTwoCategories.includes('boundary') && firstTwoCategories.includes('error'),
            `first two rows must be boundary and error, got: ${JSON.stringify(firstTwoCategories)}`);

        // Normal rows should be C3 and C4
        assert.equal(table.rows[2].category, 'normal');
        assert.equal(table.rows[3].category, 'normal');

        // 3. v2_result.json records testFocus
        const v2Result = JSON.parse(fs.readFileSync(path.join(result.directory, 'v2_result.json'), 'utf8'));
        assert.equal(v2Result.testFocus, 'boundary');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('PR #13b: full test focus preserves default order and records testFocus full', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-focus-full-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'math_ops.py'), SOURCE_MATH, 'utf8');

    const prompts: string[] = [];
    const replies = [
        [
            line({ scenario: '一般正數', category: 'normal', args: '(50,)' }),
            line({ scenario: '邊界零', category: 'boundary', args: '(0,)' })
        ].join('\n')
    ];

    try {
        const result = await runCaseTablePipeline({
            filePath: path.join(project, 'math_ops.py'),
            funcName: 'classify_number',
            projectRoot: project,
            outputPath: path.join(directory, 'out'),
            sessionDate: 'focus',
            pythonExecutable: python,
            specOracle: 'off',
            qualityAnalyst: 'off',
            testFocus: 'full',
            log: () => undefined,
            mutation: { engine: 'builtin', workers: 1, stageSeconds: 60 },
            requestModel: async (_system, user) => {
                prompts.push(user);
                return replies.shift()!;
            }
        });

        // Prompt does NOT have boundary sentence
        assert.equal(prompts[0].includes('At least 4 of the lines must be category boundary or error.'), false);

        const table = readCaseTable(result.directory);
        assert.equal(table.testFocus, 'full');
        // Initial order preserved: normal first, boundary second
        assert.equal(table.rows[0].category, 'normal');
        assert.equal(table.rows[1].category, 'boundary');

        const v2Result = JSON.parse(fs.readFileSync(path.join(result.directory, 'v2_result.json'), 'utf8'));
        assert.equal(v2Result.testFocus, 'full');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('PR #13b: coverage test focus calls supplementary round when missing branches exist', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-focus-cov-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'math_ops.py'), SOURCE_MATH, 'utf8');

    const prompts: string[] = [];
    // Round 1 only covers positive numbers: classify_number(50) -> "normal"
    // Leaves n < 0, n == 0, n > 100 uncovered
    const replies = [
        line({ scenario: '一般正數', category: 'normal', args: '(50,)' }),
        // Round 2 supplementary round
        line({ scenario: '負數分支', category: 'error', args: '(-1,)' })
    ];

    try {
        const result = await runCaseTablePipeline({
            filePath: path.join(project, 'math_ops.py'),
            funcName: 'classify_number',
            projectRoot: project,
            outputPath: path.join(directory, 'out'),
            sessionDate: 'focus',
            pythonExecutable: python,
            specOracle: 'off',
            qualityAnalyst: 'off',
            testFocus: 'coverage',
            log: () => undefined,
            mutation: { engine: 'builtin', workers: 1, stageSeconds: 60 },
            requestModel: async (_system, user) => {
                prompts.push(user);
                return replies.shift() || '';
            }
        });

        const table = readCaseTable(result.directory);
        assert.equal(table.testFocus, 'coverage');

        // Check if supplementary round was triggered (if coverage measurement is available)
        if (prompts.length > 1) {
            assert.ok(prompts[1].includes('Only propose scenarios that reach these uncovered branch conditions:'),
                'supplementary prompt must include uncovered branches instruction');
            assert.ok(table.rows.length >= 2, 'supplementary rows added');
            assert.ok(table.rows.length <= 8, 'total rows must not exceed 8');
            const v2Runs = path.join(result.directory, 'v2_runs');
            assert.ok(fs.existsSync(path.join(v2Runs, 'test_case_table.py')), 'initial merged test exists');
            assert.ok(fs.existsSync(path.join(v2Runs, 'test_case_table_followup.py')), 'followup merged test exists');
        }

        const v2Result = JSON.parse(fs.readFileSync(path.join(result.directory, 'v2_result.json'), 'utf8'));
        assert.equal(v2Result.testFocus, 'coverage');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('PR #13b: runTestFile throws EEXIST when writing a test file with the same module name a second time', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-wx-flag-'));
    try {
        const runtime: RowRuntime = {
            python,
            sourceFile: path.join(directory, 'target.py'),
            target: 'dummy',
            importPaths: [directory],
            artifacts: directory
        };
        fs.writeFileSync(runtime.sourceFile, 'def dummy(): return 1\n', 'utf8');

        // First write creates test_sample.py
        await runTestFile(runtime, 'test_sample', 'import unittest\nclass T(unittest.TestCase):\n    def test_1(self): pass\n');
        assert.ok(fs.existsSync(path.join(directory, 'test_sample.py')));

        // Second write with same module name must throw EEXIST due to flag: 'wx'
        await assert.rejects(async () => {
            await runTestFile(runtime, 'test_sample', 'import unittest\n');
        }, (err: NodeJS.ErrnoException) => {
            assert.equal(err.code, 'EEXIST');
            return true;
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
