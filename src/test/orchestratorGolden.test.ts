import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest, ollamaRuntimeMetadataFixture } from './ollamaRequestFixture';
import { getLanguage, setLanguage } from '../i18n/core';

const repo = path.resolve(__dirname, '../..');
// Compare against an independently recorded baseline before publishing repository fixtures.
const fixtures = process.env.ORCHESTRATOR_GOLDEN_FIXTURES
    ? path.resolve(process.env.ORCHESTRATOR_GOLDEN_FIXTURES) : path.join(repo, 'test/fixtures/golden');
const fence = (code: string) => '```python\n' + code + '\n```';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const transportHashes = new Map<string, string>();
const executionIds = new Map<string, string>();
const probeRunIds = new Map<string, string>();
function canonicalRunId(id: string, probe = false): string {
    const ids = probe ? probeRunIds : executionIds;
    if (!ids.has(id)) { ids.set(id, `<${probe ? 'PROBE_RUN' : 'RUN'}_${ids.size + 1}>`); }
    return ids.get(id)!;
}
interface GoldenRequest { role: string; sequence: number; promptHash: string }
const serializeGolden = (value: unknown): string => JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
        : item, 2) + '\n';
const simpleSource = 'def target(value):\n    return value + 1\n';
const simpleTest = (target: string) => `import unittest\nfrom sample import ${target}\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(${target}(2), 3)\n`;
const bmiCases = [
    [17, 100, 17, '體重過輕'], [18.49, 100, 18.49, '體重過輕'],
    [18.5, 100, 18.5, '健康體位'], [20, 100, 20, '健康體位'], [23.99, 100, 23.99, '健康體位'],
    [24, 100, 24, '體重過重'], [25, 100, 25, '體重過重'], [26.99, 100, 26.99, '體重過重'],
    [27, 100, 27, '肥胖'], [30, 100, 30, '肥胖'], [0, 100, 0, '體重過輕'],
    [-1, -1, -10000, '體重過輕'], [85, 190, 23.55, '健康體位'],
    [80, 180, 24.69, '體重過重'], [40, 150, 17.78, '體重過輕'], [100, 170, 34.6, '肥胖']
] as const;

/** Tool prose can be truncated before paths are normalized; retain its diagnostic shape only. */
function summarizeMutantOutput(output: string) {
    const exceptions = [...output.matchAll(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*):(?:[ \t]|$)/gm)];
    return { hasOutput: output.length > 0, lastException: exceptions.at(-1)?.[1] ?? null };
}

/** Explicit volatile fields only: statuses, reasons, scores and counts are never elided. */
function normalize(value: unknown, root: string, key = ''): unknown {
    if (value === null) { return value; }
    if (key === 'pythonExecutable' && typeof value === 'string' && path.isAbsolute(value)) { return '<PYTHON>'; }
    if ((key === 'run_id' || key === 'observationRunId') && typeof value === 'string') { return canonicalRunId(value, true); }
    if (key === 'buildArtifactHash') { return '<BUILD_HASH>'; }
    if (/^(?:time|at|startedAt|finishedAt|updatedAt|createdAt|timestamp|buildTimestamp|deadline|.*DeadlineAt|deadlineMs|.*DurationMs|.*ElapsedMs|.*WaitMs|responseReadMs|elapsedMs|durationMs|duration_ms|remaining.*Ms|planningMs|caseMs|allocated_timeout_seconds|effective_timeout_seconds|totalTimeoutSeconds)$/i.test(key)) {
        return '<TIME>';
    }
    if (typeof value === 'string') {
        if (key === 'requestBodyHash' && transportHashes.has(value)) { return transportHashes.get(value); }
        let text = value;
        for (const [location, replacement] of [[root, '<ROOT>'], [repo, '<REPO>']]) {
            for (const spelling of process.platform === 'win32' ? [location, location.toLowerCase()] : [location]) {
                text = text.replaceAll(spelling.replace(/\\/g, '\\\\'), replacement)
                    .replaceAll(spelling, replacement).replaceAll(spelling.replace(/\\/g, '/'), replacement);
            }
        }
        text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, id => canonicalRunId(id.toLowerCase()))
            .replace(/probe-([a-f0-9]{20})-(\d+)-[a-f0-9]{20}/g,
                (_match, id: string, index: string) => `probe-${canonicalRunId(id, true)}-${index}`)
            .replace(/((?:\\?")observationRunId(?:\\?")\s*:\s*(?:\\?"))([a-f0-9]{20})((?:\\?"))/g,
                (_match, prefix: string, id: string, suffix: string) => prefix + canonicalRunId(id, true) + suffix)
            .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g, '<TIME>')
            .replace(/Ran (\d+) tests? in [\d.]+s/g, 'Ran $1 tests in <TIME>s')
            .replace(/Measurement time for this round: [\d.]+ seconds\./g, 'Measurement time for this round: <TIME> seconds.')
            .replace(/(?<!\d)\d{4}_\d\d_\d\d_\d\d_\d\d(?!\d)/g, '<SESSION_TIME>')
            .replace(/\b\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\b/g, '<TIME>');
        text = text.replace(/(?:[A-Za-z]:[\\/][^"'\n<>]*[\\/]|\/[^"'\n<>]*\/)?llm_unit_mutation_[a-z0-9_]+/g, '<MUTATION_ROOT>')
            .replace(/[A-Za-z_]*mutation_[a-z0-9_]{8}/g, '<MUTATION_ROOT>')
            .replace(/(?:[a-z_]*_)?[a-z0-9_]{8}(?=[\\/]+mutant_\d{4})/g, '<MUTATION_ROOT>');
        text = text.replace(/(<ROOT>|<REPO>|<MUTATION_ROOT>)([\\/][^\s"'<>]*)/g,
            (_match, prefix: string, suffix: string) => prefix + suffix.replace(/\\+/g, '/'));
        let durationTable = false, coverageTable = false;
        text = text.split('\n').map(line => {
            if (/^Name +Stmts +Miss\b/.test(line)) { coverageTable = true; return line.trim().replace(/ +/g, ' '); }
            if (coverageTable) {
                if (/^-+\r?$/.test(line)) { return '<COVERAGE_SEPARATOR>'; }
                const row = /^(.*?)( +\d+ +\d+(?: +\d+ +\d+)? +\d+%(?: +.*)?)\r?$/.exec(line);
                if (row) {
                    if (row[1] === 'TOTAL') { coverageTable = false; }
                    return row[1] + ' ' + row[2].trim().replace(/ +/g, ' ');
                }
                coverageTable = false;
            }
            if (line === '| Location | Mutation | Tests reporting failures | Duration (ms) |') { durationTable = true; }
            else if (!line.startsWith('|')) { durationTable = false; }
            return durationTable && /^\| \d+:\d+ \|/.test(line) ? line.replace(/\| [\d.]+ \|$/, '| <TIME> |') : line;
        }).join('\n');
        return text;
    }
    if (Array.isArray(value)) { return value.map(item => normalize(item, root, key === 'mutants' ? '<mutant>' : '')); }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        let scopeId: string | undefined;
        if (Object.hasOwn(record, 'scopeId')) {
            assert.equal(typeof record.root, 'string', 'scope hash requires its original root');
            assert.ok(path.isAbsolute(record.root as string));
            assert.ok(Array.isArray(record.knownFiles) && record.knownFiles.every(file => typeof file === 'string'));
            assert.ok(Array.isArray(record.selectedFiles) && record.selectedFiles.every(file => typeof file === 'string'));
            const body = { root: path.resolve(record.root as string), knownFiles: record.knownFiles, selectedFiles: record.selectedFiles };
            assert.equal(record.scopeId, hash(JSON.stringify(body)), 'scopeId must authenticate the unmodified scope body');
            scopeId = hash(JSON.stringify({ ...body, root: normalize(body.root, root) }));
        }
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([name, item]) => [name, name === 'scopeId' && scopeId !== undefined ? scopeId
                : key === '<mutant>' && name === 'output' && typeof item === 'string'
                ? summarizeMutantOutput(item) : normalize(item, root, name)]));
    }
    return value;
}

test('golden normalization retains decisions, counts, quality and configured limits', () => {
    const evidence = { terminalStatus: 'failed', reasonCode: 'invalid-edit-python', score: 79.5, methods: 3,
        modelRequests: 7, transportAttempts: 9, timeoutMs: 600000, configuredMutantTimeoutSeconds: 5,
        time: '2026-11-04T00:00:00.000Z', duration_ms: 0.123, mutationScore: null };
    assert.deepEqual(normalize(evidence, '<unused>'), { ...evidence, time: '<TIME>', duration_ms: '<TIME>' });
    for (const encode of [(text: string) => text, JSON.stringify]) {
        probeRunIds.clear();
        const first = normalize(encode('{"observationRunId":"' + 'a'.repeat(20) + '"}'), '<unused>');
        probeRunIds.clear();
        assert.equal(first, normalize(encode('{"observationRunId":"' + 'b'.repeat(20) + '"}'), '<unused>'));
    }
    assert.equal(serializeGolden({ a: 1, b: 2 }), serializeGolden({ b: 2, a: 1 }));
    assert.notEqual(serializeGolden([1, 2]), serializeGolden([2, 1]), 'request and event array order must remain significant');
    probeRunIds.clear();
    assert.notEqual(normalize(`probe-${'a'.repeat(20)}-0-${'c'.repeat(20)}`, '<unused>'),
        normalize(`probe-${'b'.repeat(20)}-0-${'c'.repeat(20)}`, '<unused>'), 'independent probe runs must not collapse');
    if (process.platform === 'win32') {
        assert.equal(normalize('d:\\golden\\project\\sample.py', 'D:\\Golden\\project'), '<ROOT>/sample.py');
    }
});

test('golden normalization summarizes only mutant prose and preserves mutation evidence', () => {
    const mutant = { status: 'KILLED', line: 12, column: 4, killed: true, output: '' };
    const run = (output: string) => ({ output: 'ordinary output stays verbatim', mutation: {
        score: 87.5, counts: { selected: 8, executed: 8, killed: 7, survived: 1 },
        mutants: [{ ...mutant, output }]
    } });
    const first = run('Traceback (most recent call last):\n  File "C:/short/mutant.py", line 12\nValueError: inner\n\nAssertionError: expected value\n');
    const second = run('Traceback (most recent call last):\n  File "D:/much/longer/temporary/path/mutant.py", line 12\nAssertionError: different truncated details...\n');
    const expected = { ...first, mutation: { ...first.mutation,
        mutants: [{ ...mutant, output: { hasOutput: true, lastException: 'AssertionError' } }] } };
    assert.deepEqual(normalize(first, '<unused>'), expected);
    assert.deepEqual(normalize(second, '<unused>'), expected);
    assert.deepEqual(summarizeMutantOutput(''), { hasOutput: false, lastException: null });
    assert.deepEqual(summarizeMutantOutput('tool diagnostic without an exception'), { hasOutput: true, lastException: null });
    assert.notDeepEqual(normalize(run('TypeError: wrong type'), '<unused>'), expected);
    assert.notDeepEqual(normalize({ ...first, mutation: { ...first.mutation, score: 75 } }, '<unused>'), expected);
    assert.notDeepEqual(normalize({ ...first, mutation: { ...first.mutation,
        mutants: [{ ...mutant, status: 'SURVIVED' }] } }, '<unused>'), expected);
});

test('golden scope normalization authenticates raw identity and preserves complete selections', () => {
    const firstRoot = path.resolve('first-copy'), secondRoot = path.resolve('second-copy');
    const scope = (root: string, knownFiles = ['a.py', 'b.py'], selectedFiles = ['a.py']) => {
        const body = { root, knownFiles, selectedFiles };
        return { ...body, excludedFiles: knownFiles.filter(file => !selectedFiles.includes(file)), scopeId: hash(JSON.stringify(body)) };
    };
    const first = scope(firstRoot);
    assert.deepEqual(normalize(first, firstRoot), normalize(scope(secondRoot), secondRoot));
    assert.throws(() => normalize({ ...first, root: secondRoot }, secondRoot), /unmodified scope body/);
    assert.throws(() => normalize({ ...first, selectedFiles: ['b.py'] }, firstRoot), /unmodified scope body/);
    assert.notDeepEqual(normalize(first, firstRoot), normalize(scope(firstRoot, ['a.py', 'b.py'], ['b.py']), firstRoot));
    assert.notDeepEqual(normalize(first, firstRoot), normalize(scope(firstRoot, ['a.py', 'b.py', 'c.py']), firstRoot));
    assert.notDeepEqual(normalize(first, firstRoot), normalize(scope(path.join(firstRoot, 'nested')), firstRoot));
});

test('golden coverage normalization removes path-sized padding but keeps all measurements', () => {
    const report = (padding: number, missed = 4) => 'before  spaces\nName' + ' '.repeat(padding)
        + 'Stmts   Miss Branch BrPart  Cover   Missing\r\n' + '-'.repeat(padding + 45)
        + `\r\n<ROOT>/bmi.py      11      ${missed}      6      2    53%   15, 18-21\r\n`
        + 'loop1_test.py' + ' '.repeat(padding) + '5      0      0      0   100%\r\n'
        + '-'.repeat(padding + 45) + '\r\nTOTAL' + ' '.repeat(padding) + '16      4      6      2    64%\r\nafter  spaces';
    const normalized = String(normalize(report(40), '<unused>'));
    assert.equal(normalized, normalize(report(30), '<unused>'));
    assert.notEqual(normalized, normalize(report(30, 5), '<unused>'));
    assert.ok(normalized.includes('<ROOT>/bmi.py 11 4 6 2 53% 15, 18-21'));
    assert.ok(normalized.startsWith('before  spaces\n'));
    assert.ok(normalized.endsWith('after  spaces'));
});

function snapshot(output: string, root: string, requests: GoldenRequest[]) {
    const artifacts: Record<string, unknown> = {};
    const roles: string[] = [];
    const names = new Set(['final_report.md', 'function_knowledge.json',
        'role_events.jsonl', 'run_manifest.json', 'batch_manifest.json', 'batch_events.jsonl']);
    for (const relative of fs.readdirSync(output, { recursive: true }).map(String).sort()) {
        if (!names.has(path.basename(relative))) { continue; }
        const text = fs.readFileSync(path.join(output, relative), 'utf8');
        const parsed = relative.endsWith('.jsonl') ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
            : relative.endsWith('.json') ? JSON.parse(text) : text;
        if (path.basename(relative) === 'role_events.jsonl') {
            roles.push(...parsed.filter((event: any) => event.stage === 'model-request' && event.status === 'timing'
                && event.detail?.version === 'model-request-timing-v1' && event.detail.kind === 'transport').map((event: any) => event.detail.role));
        }
        artifacts[String(normalize(relative.replace(/\\/g, '/'), root))] = normalize(parsed, root);
    }
    assert.equal(roles.length, requests.length, 'every wire request must have exactly one journal transport role');
    return { artifacts, requests: requests.map((request, index) => ({ ...request, role: roles[index] })) };
}

// fs.cpSync terminates this Windows Node runtime on these Unicode paths. Keep
// failure preservation to explicit, exclusive regular-file copies instead.
function copyScenarioFiles(source: string, destination: string): void {
    fs.mkdirSync(destination);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        assert.ok(!entry.isSymbolicLink(), 'Golden output must not contain links');
        const from = path.join(source, entry.name), to = path.join(destination, entry.name);
        if (entry.isDirectory()) { copyScenarioFiles(from, to); }
        else { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); }
    }
}

test('golden failure preservation copies nested Unicode artifacts without changing bytes', () => {
    const parent = path.join(repo, 'log');
    const directory = fs.mkdtempSync(path.join(parent, 'golden-copy-test-'));
    try {
        const source = path.join(directory, 'source'), destination = path.join(directory, 'saved');
        fs.mkdirSync(path.join(source, '執行資料'), { recursive: true });
        const bytes = Buffer.from('失敗證據\n\u0000', 'utf8');
        fs.writeFileSync(path.join(source, '執行資料', '結果.json'), bytes);
        copyScenarioFiles(source, destination);
        assert.deepEqual(fs.readFileSync(path.join(destination, '執行資料', '結果.json')), bytes);
        assert.deepEqual(fs.readFileSync(path.join(source, '執行資料', '結果.json')), bytes);
        assert.throws(() => copyScenarioFiles(source, destination), { code: 'EEXIST' });
    } finally {
        assert.equal(path.dirname(directory), parent);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function scenarioDiagnostics(output: string, writers: number, requests: GoldenRequest[]) {
    const knowledge: unknown[] = [], events: unknown[] = [];
    if (fs.existsSync(output)) {
        for (const relative of fs.readdirSync(output, { recursive: true }).map(String).sort()) {
            if (path.basename(relative) === 'function_knowledge.json') {
                const value = JSON.parse(fs.readFileSync(path.join(output, relative), 'utf8'));
                knowledge.push({ terminalStatus: value.terminalStatus, lastFailure: value.lastFailure });
            } else if (path.basename(relative) === 'role_events.jsonl') {
                events.push(...fs.readFileSync(path.join(output, relative), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
            }
        }
    }
    return { writers, requests: requests.map(({ role, sequence }) => ({ role, sequence })), knowledge, lastEvents: events.slice(-10) };
}

test('orchestrator golden: five public-command paths with real guarded Python and mutation', async t => {
    const names = ['full', 'execution', 'writer-failure', 'stub', 'batch'];
    const selected = process.env.ORCHESTRATOR_GOLDEN_SCENARIO;
    assert.ok(!selected || names.includes(selected), 'Unknown ORCHESTRATOR_GOLDEN_SCENARIO');
    // A fixed, exclusively created test-owned root keeps path-derived evidence
    // hashes stable. Concurrent invocations fail instead of sharing artifacts.
    const root = path.join(repo, 'log/golden-runtime');
    fs.mkdirSync(root);
    const temp = path.join(root, 'tmp');
    fs.mkdirSync(temp);
    const originalTemp = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR'].map(key => [key, process.env[key]]));
    for (const key of Object.keys(originalTemp)) { process.env[key] = temp; }
    const python = resolvePythonExecutable(undefined, repo);
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const originalLanguage = getLanguage();
    const crypto = require('node:crypto'), originalUuid = crypto.randomUUID;
    let nextRun = 0;
    crypto.randomUUID = () => `00000000-0000-4000-8000-${(++nextRun).toString(16).padStart(12, '0')}`;
    const handlers = new Map<string, (...args: any[]) => any>();
    const settings: Record<string, unknown> = { pythonPath: python, projectPath: root, language: 'en', requireRoleQualification: false };
    let scenario = '', writers = 0;
    let renameFailures: unknown[] = [];
    const nativeFs = require('node:fs'), originalRename = nativeFs.renameSync;
    nativeFs.renameSync = (...args: any[]) => {
        try { return originalRename(...args); }
        catch (error) {
            renameFailures.push({ from: String(args[0]), to: String(args[1]),
                code: (error as NodeJS.ErrnoException).code, error: String(error) });
            throw error;
        }
    };
    let requests: GoldenRequest[] = [];
    const logs: string[] = [];
    const vscode = {
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: { text?: string }) => { if (message.text) { logs.push(message.text); } return true; } }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {},
        showQuickPick: async (items: any[]) => items.filter(item => item.picked) },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return { dispose() {} }; } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName: 'golden-fixture' });
        if (metadata) { return metadata; }
        const wire = String(options?.body);
        const request = readOllamaRoleRequest(JSON.parse(wire));
        transportHashes.set(hash(wire), hash(String(normalize(wire, root))));
        const role = request.roleInstructions.includes('dependency_behaviors') ? 'analyst'
            : /You are the (?:test|Python unittest) Reviewer/.test(request.roleInstructions) ? 'reviewer'
                : request.roleInstructions.includes('Analyst after successful') ? 'quality' : 'writer';
        requests.push({ role, sequence: requests.length + 1,
            promptHash: hash(String(normalize(request.roleInstructions + '\n' + request.prompt, root))) });
        let response: string;
        if (role === 'analyst') {
            response = '{"dependency_behaviors":[],"test_strategy":{"approach":"Exercise the target using supplied same-input observations and preserve the executed seed."}}';
        } else if (role === 'reviewer') { response = '{"findings":[]}'; }
        else if (role === 'quality') { response = '{"tasks":[]}'; }
        else {
            writers++;
            if (scenario === 'writer-failure' || scenario === 'batch' && request.prompt.includes('first')) {
                response = writers === 1 ? 'I will explain the steps instead of returning Python.' : 'The requested revision is still unavailable.';
            } else if (scenario === 'full') {
                if (writers === 1) {
                    response = fence('import unittest\nfrom bmi import calculate_bmi\nclass Cases(unittest.TestCase):\n    def test_seed(self):\n        self.assertEqual(calculate_bmi(50, 160), (19.53, "健康體位"))\n');
                } else {
                    const reminder = [...request.prompt.matchAll(/WRITER_FOCUS_CASE_FACTS_V1\n([^\n]+)/g)].at(-1);
                    const signature = request.prompt.match(/REQUIRED NEW METHOD SIGNATURE \(body must be authored by you\):\ndef (test_[a-zA-Z0-9_]+)\(self\):\s*$/)?.[1];
                    if (reminder) {
                        const bound = JSON.parse(reminder[1]);
                        response = fence(`def ${signature || `test_focus_${writers}`}(self):\n`
                            + bound.cases.map((item: { targetCall: string; observedResult: string }) =>
                                `    self.assertEqual(${item.targetCall}, ${item.observedResult})`).join('\n') + '\n');
                    } else {
                        response = fence(`def test_remaining_${writers}(self):\n` + bmiCases.map(([weight, height, bmi, status]) =>
                            `    self.assertEqual(calculate_bmi(${weight}, ${height}), (${bmi}, ${JSON.stringify(status)}))`).join('\n') + '\n');
                    }
                }
            } else {
                const target = scenario === 'batch' ? request.prompt.includes('second') ? 'second' : 'third' : 'target';
                response = fence(simpleTest(target));
            }
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop' }), { status: 200 });
    };
    try {
        setLanguage('en');
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'golden-fixture',
            paramSize: '13B', contextLength: 32768, effectiveRuntimeContextTokens: 16384, runtimeContextSource: 'ollama-num-ctx' });
        for (const name of names.filter(name => !selected || name === selected)) {
            await t.test(name, async () => {
                scenario = name; writers = 0; requests = []; transportHashes.clear(); executionIds.clear(); probeRunIds.clear(); nextRun = 0;
                renameFailures = [];
                const started = performance.now();
                const output = path.join(root, 'results', name);
                try {
                const source = name === 'full' ? fs.readFileSync(path.join(repo, 'test/test_mut/bmi.py'), 'utf8').replace(/\r\n/g, '\n')
                    : name === 'stub' ? 'def target():\n    pass\n'
                        : name === 'batch' ? ['first', 'second', 'third'].map(target => simpleSource.replace('target', target)).join('\n') : simpleSource;
                const file = path.join(root, name === 'full' ? 'bmi.py' : 'sample.py');
                fs.writeFileSync(file, source);
                if (name !== 'full') { fs.rmSync(path.join(root, 'bmi.py'), { force: true }); }
                if (name === 'full') {
                    const built = spawnSync(python, ['-B', path.join(repo, 'python_scripts/probe_fixture_builder.py'),
                        '--root', root, '--file', file, '--target', 'calculate_bmi'], {
                        input: JSON.stringify({ cases: [[50, 160], ...bmiCases.map(([w, h]) => [w, h])].map(args => ({ args_literals: JSON.stringify(args) })) }),
                        encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
                    });
                    assert.equal(built.status, 0, built.stderr);
                    fs.writeFileSync(path.join(root, 'trace-inputs.json'), built.stdout);
                    settings.probeInputFile = 'trace-inputs.json';
                } else { delete settings.probeInputFile; }
                await handlers.get(name === 'batch' ? 'llm-unit-test.runBatchAnalysis' : 'llm-unit-test.runCaptureAndTest')!({
                    envType: 'local', modelName: 'golden-fixture', requireRoleQualification: false,
                    filePath: file, batchPath: root, funcName: name === 'full' ? 'calculate_bmi' : 'target',
                    outputPath: output, sessionDate: 'golden', promptStrategy: name === 'full' ? 'tier2' : 'tier1',
                    validationMode: name === 'full' || name === 'stub' ? 'full' : 'execution',
                    mutationEngine: 'builtin', mutationWorkers: 4, maxLoops: 4, timeoutSeconds: 60, mutpyTimeout: 120
                });
                assert.ok(fs.existsSync(output), logs.join('\n'));
                const actual = snapshot(output, root, requests);
                const knowledge = Object.entries(actual.artifacts).filter(([key]) => key.endsWith('function_knowledge.json'))
                    .map(([, value]) => value as { terminalStatus: string });
                if (name === 'full') {
                    const events = Object.entries(actual.artifacts).filter(([key]) => key.endsWith('role_events.jsonl')).flatMap(([, value]) => value as any[]);
                    assert.equal(knowledge[0]?.terminalStatus, 'passed', JSON.stringify({ requests,
                        failures: events.filter(e => /invalid|rejected|failed|error/.test(e.status)).map(e => [e.stage, e.status, e.detail]),
                        terminal: knowledge.map(item => ({ terminalStatus: item.terminalStatus, lastFailure: (item as any).lastFailure })) }));
                    const measured = knowledge[0] as typeof knowledge[0] & { mutation: { engine: string; counts: { selected: number; executed: number } } };
                    assert.equal(measured.mutation.engine, 'builtin');
                    assert.ok(measured.mutation.counts.selected > 0);
                    assert.equal(measured.mutation.counts.executed, measured.mutation.counts.selected);
                }
                if (name === 'execution') { assert.equal(knowledge[0]?.terminalStatus, 'execution-passed'); }
                if (name === 'writer-failure') {
                    const diagnostic = JSON.stringify({ ...scenarioDiagnostics(output, writers, requests), renameFailures, logs: logs.slice(-30) });
                    assert.equal(knowledge[0]?.terminalStatus, 'failed', diagnostic);
                    assert.ok(writers >= 2, diagnostic);
                }
                if (name === 'stub') { assert.equal(requests.length, 0); assert.equal(knowledge[0]?.terminalStatus, 'stub-smoke-generated'); }
                if (name === 'batch') {
                    const batch = Object.entries(actual.artifacts).find(([key]) => key.endsWith('batch_manifest.json'))![1] as { targets: { terminalStatus: string }[] };
                    assert.deepEqual(batch.targets.map(item => item.terminalStatus), ['failed', 'execution-passed', 'execution-passed']);
                }
                assert.equal(fs.readFileSync(file, 'utf8'), source);
                const expected = path.join(fixtures, name + '.json');
                if (process.env.UPDATE_ORCHESTRATOR_GOLDEN === '1') {
                    fs.mkdirSync(fixtures, { recursive: true }); fs.writeFileSync(expected, serializeGolden(actual));
                } else {
                    const serialized = serializeGolden(actual);
                    const previous = serializeGolden(JSON.parse(fs.readFileSync(expected, 'utf8')));
                    if (serialized !== previous) {
                        fs.writeFileSync(path.join(repo, 'log', `golden-${name}-actual.json`), serialized);
                    }
                    assert.equal(hash(serialized), hash(previous), `${name}: golden changed; compare test/fixtures/golden/${name}.json with log/golden-${name}-actual.json before any intentional update`);
                }
                console.log('GOLDEN_SCENARIO_RESULT ' + JSON.stringify({ scenario: name, status: 'passed', writers, elapsedMs: performance.now() - started }));
                } catch (error) {
                    const archive = path.join(repo, 'log', `golden-failure-${name}`);
                    fs.mkdirSync(archive, { recursive: true });
                    let attempt = 1;
                    while (fs.existsSync(path.join(archive, `run-${attempt}`))) { attempt++; }
                    const destination = path.join(archive, `run-${attempt}`);
                    fs.mkdirSync(destination);
                    const diagnostic = { ...scenarioDiagnostics(output, writers, requests), renameFailures, logs: logs.slice(-30), scenario: name,
                        status: 'failed', elapsedMs: performance.now() - started, error: String(error) };
                    fs.writeFileSync(path.join(destination, 'diagnostic.json'), JSON.stringify(diagnostic, null, 2));
                    if (fs.existsSync(output)) { copyScenarioFiles(output, path.join(destination, 'results')); }
                    console.log('GOLDEN_SCENARIO_RESULT ' + JSON.stringify({ scenario: name, status: 'failed', writers, elapsedMs: diagnostic.elapsedMs, archive: destination }));
                    throw error;
                }
            });
        }
    } finally {
        for (const [key, value] of Object.entries(originalTemp)) {
            if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
        }
        Module._load = originalLoad; globalThis.fetch = originalFetch; crypto.randomUUID = originalUuid; setLanguage(originalLanguage);
        nativeFs.renameSync = originalRename;
        assert.equal(fs.realpathSync(path.dirname(root)), fs.realpathSync(path.join(repo, 'log')));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
