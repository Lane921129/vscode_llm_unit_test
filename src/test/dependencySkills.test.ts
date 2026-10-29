import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadTestSkills } from '../skills/catalog';
import { dependencySkillBindings } from '../skills/dependencyFacts';
import { inferTestRuleIdsFromCode, getTestRuleCards } from '../prompts/testRuleLibrary';
import { dispatchTestRules } from '../pipeline/testRuleDispatcher';
import { sourceSetupCallGuidance } from '../prompts/dependencyMockContract';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const root = path.resolve(__dirname, '../..');
function extract(source: string): any {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-facts-'));
    try {
        const file = path.join(dir, 'subject.py'); fs.writeFileSync(file, source);
        const result = spawnSync(resolvePythonExecutable(undefined, root),
            ['-B', path.join(root, 'python_scripts/ast_extractor.py'), file, 'target'], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        const context = JSON.parse(result.stdout); assert.ok(!context.error, result.stdout); return context;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('source-backed skill selection follows module factory arguments without using application names', () => {
    const context = extract('from sqlalchemy import create_engine as make\nRESOURCE = make("not-opened")\nimport storage\ndef target():\n    storage.metadata.create_all(bind=RESOURCE)\n');
    const selection = dispatchTestRules(context.code, context);
    assert.ok(selection.ids.includes('database_state_isolation'));
    const card = selection.selectedRules.find(item => item.ruleId === 'database_state_isolation')!;
    assert.equal(card.skillVersion, 1);
    assert.match(card.triggerFacts.join('\n'), /RESOURCE <- sqlalchemy.create_engine/);
    const prompt = sourceSetupCallGuidance('subject', context);
    assert.match(prompt, /DEPENDENCY_FIXTURE_PLAN_V1/);
    assert.match(prompt, /"source":"RESOURCE","scope":"module-global","name":"bind","lookupModule":"subject"|"name":"bind","source":"RESOURCE","scope":"module-global","lookupModule":"subject"/);
    assert.match(prompt, /Call setup storage.metadata.create_all: bind: subject.RESOURCE/);
    assert.match(prompt, /"lookupExpression":"subject.storage.metadata.create_all"/);
    assert.match(prompt, /An assertIsNone alone does not verify those effects/);
    assert.ok(prompt.indexOf('DEPENDENCY_FIXTURE_PLAN_V1') < prompt.indexOf('SOURCE CALL SETUP'));
});

test('HTTP skill covers module client factories and keeps async protocol guidance', () => {
    const context = extract('import httpx as net\nCLIENT = net.AsyncClient()\nasync def target():\n    response = await CLIENT.get("/")\n    return response.json()\n');
    const ids = inferTestRuleIdsFromCode(context.code, context);
    assert.ok(ids.includes('http_client_mocking'));
    assert.ok(ids.includes('async_coroutine_testing'));
    assert.match(sourceSetupCallGuidance('subject', context), /"lookupExpression":"subject.CLIENT.get"/);
    assert.match(getTestRuleCards(ids).map(card => card.rules.join('\n')).join('\n'), /unawaited.*async with/);
});

test('an HTTP URL is not division and a proven client open is not a file operation', () => {
    const context = extract('import urllib.request as net\nCLIENT = net.build_opener()\ndef target():\n    return CLIENT.open("https://unit.invalid/item").read()\n');
    const ids = inferTestRuleIdsFromCode(context.code, context);
    assert.ok(ids.includes('http_client_mocking'));
    assert.ok(!ids.includes('zero_division'));
    assert.ok(!ids.includes('file_io_mocking'));
    const mixed = { ...context, calls: [...context.calls, 'open'], code: context.code + '\n    open(path)' };
    assert.ok(inferTestRuleIdsFromCode(mixed.code, mixed).includes('file_io_mocking'));
    assert.ok(inferTestRuleIdsFromCode('def target(x):\n    return x / 2').includes('zero_division'));
});

test('irrelevant imports and stale, partial, shadowed or malformed facts do not select a skill', () => {
    const unused = extract('import httpx\nimport sqlalchemy\ndef target():\n    return 1\n');
    assert.ok(!inferTestRuleIdsFromCode(unused.code, unused).includes('database_state_isolation'));
    assert.ok(!inferTestRuleIdsFromCode(unused.code, unused).includes('http_client_mocking'));
    const context = extract('import httpx\nCLIENT = httpx.Client()\ndef target():\n    return CLIENT.get("/")\n');
    for (const mutation of ['hash', 'partial', 'permission', 'duplicate', 'identity']) {
        const copy = structuredClone(context), facts = copy.dependency_skill_facts;
        if (mutation === 'hash') { facts.targetSourceHash = '0'.repeat(64); }
        if (mutation === 'partial') { facts.status = 'unsupported'; }
        if (mutation === 'permission') { facts.patchAuthorization = true; }
        if (mutation === 'duplicate') { facts.bindings.push(facts.bindings[0]); }
        if (mutation === 'identity') { facts.target = 'other'; }
        assert.deepEqual(dependencySkillBindings(copy), [], mutation);
        assert.ok(!inferTestRuleIdsFromCode(copy.code, copy).includes('http_client_mocking'), mutation);
    }
});

test('installed skill assets are versioned text, with no arbitrary Python or path execution', () => {
    const installed = loadTestSkills();
    assert.equal(installed.length, 26);
    for (const id of ['numeric_calculation', 'database_state_isolation', 'http_client_mocking', 'mock_external_dependency']) {
        assert.ok(installed.some(card => card.id === id));
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
    try {
        const base = { id: 'sample', version: 1, title: 'Sample', trigger_hint: 'Source', file: 'sample.txt' };
        fs.writeFileSync(path.join(dir, 'sample.txt'), 'A controlled instruction.\n');
        const write = (items: any[]) => fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ schemaVersion: 'test-skill-catalog-v1', skills: items }));
        write([base]); assert.equal(loadTestSkills(dir)[0].rules[0], 'A controlled instruction.');
        for (const file of ['../sample.txt', 'sample.py', 'C:\\sample.txt']) {
            write([{ ...base, file }]); assert.throws(() => loadTestSkills(dir), /Invalid test skill record/);
        }
        write([base, base]); assert.throws(() => loadTestSkills(dir), /Invalid test skill record/);
        write([base]); fs.writeFileSync(path.join(dir, 'sample.txt'), 'x'.repeat(16385));
        assert.throws(() => loadTestSkills(dir), /Invalid test skill asset/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
