import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImportFixtureRule } from '../pipeline/importFixtures';
import { mergeResourceSetupRules, newResourceSetupRule, readResourceSetupDraft, refreshResourceSetupDraft, ResourceSetupDraft } from '../environment/resourceSetup';

function workspace(): { root: string; draft: ResourceSetupDraft; first: ImportFixtureRule; second: ImportFixtureRule } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-merge-'));
    fs.writeFileSync(path.join(root, 'config.py'), 'VALUE = 1\n');
    fs.writeFileSync(path.join(root, 'other.py'), 'VALUE = 2\n');
    const first = newResourceSetupRule(root, path.join(root, 'config.py'));
    first.resources = [{ path: 'data', kind: 'directory' }];
    const second = newResourceSetupRule(root, path.join(root, 'other.py'));
    second.resources = [{ path: 'other-data', kind: 'directory' }];
    return { root, first, second, draft: { schemaVersion: 'isolated-resource-setup-v1', root, rules: [structuredClone(first)] } };
}

test('old resource draft preserves newer initialization approvals on the same source', () => {
    const { root, draft, first } = workspace();
    try {
        const saved = [{ ...first, entryPoints: ['vendor.launch'], entryPointLines: { 'vendor.launch': [1] },
            entryPointSourceHash: first.resourceSourceHash, mkdir: true, configFiles: { 'app.ini': '[test]\nmode=demo' } }];
        const before = structuredClone(saved);
        draft.rules[0].resources = [{ path: 'new-data', kind: 'directory' }];
        const merged = mergeResourceSetupRules(root, saved, root, draft);
        assert.deepEqual(merged[0], { ...saved[0], resources: draft.rules[0].resources });
        assert.deepEqual(saved, before, 'preview must not mutate saved approvals');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resource draft leaves unlisted sources and their resources intact', () => {
    const { root, draft, first, second } = workspace();
    try {
        const saved = [first, { ...second, entryPoints: ['external.initialize'], configFiles: { 'test.ini': '[test]' } }];
        const merged = mergeResourceSetupRules(root, saved, root, draft);
        assert.deepEqual(merged[1], saved[1]);
        assert.notEqual(merged[1], saved[1]);
        assert.deepEqual(merged[0].resources, draft.rules[0].resources);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('empty resource declaration revokes resources while preserving separate import approvals', () => {
    const { root, draft, first } = workspace();
    try {
        const saved = [{ ...first, mkdir: true, entryPoints: ['vendor.launch'], entryPointLines: { 'vendor.launch': [1] },
            entryPointSourceHash: first.resourceSourceHash }];
        draft.rules = [{ file: 'config.py', resources: [], resourceSourceHash: first.resourceSourceHash }];
        const normalized = readResourceSetupDraft(root, JSON.stringify(draft));
        assert.equal(normalized.draft.rules[0].resourceSourceHash, undefined);
        assert.equal(draft.rules[0].resourceSourceHash, first.resourceSourceHash, 'normalization is confined to the parsed preview');
        const merged = mergeResourceSetupRules(root, saved, root, draft);
        assert.equal(merged[0].resources, undefined);
        assert.equal(merged[0].resourceSourceHash, undefined);
        assert.equal(merged[0].mkdir, true);
        assert.deepEqual(merged[0].entryPointLines, saved[0].entryPointLines);
        assert.equal(merged[0].entryPointSourceHash, saved[0].entryPointSourceHash);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resource source reapproval withdraws stale line approvals without rebinding or mutating saved settings', () => {
    const { root, draft, first } = workspace();
    try {
        const saved = [{ ...first, entryPoints: ['vendor.launch', 'vendor.manual'],
            entryPointLines: { 'vendor.launch': [1] }, entryPointSourceHash: first.resourceSourceHash }];
        const before = structuredClone(saved);
        fs.appendFileSync(path.join(root, 'config.py'), 'VALUE = 3\n');
        assert.throws(() => mergeResourceSetupRules(root, saved, root, draft), /expired|source|來源/i);
        const refreshed = refreshResourceSetupDraft(root, JSON.stringify(draft));
        const merged = mergeResourceSetupRules(root, saved, root, refreshed);
        assert.notEqual(merged[0].resourceSourceHash, first.resourceSourceHash);
        assert.deepEqual(merged[0].resources, first.resources);
        assert.equal(merged[0].entryPointSourceHash, undefined);
        assert.equal(merged[0].entryPointLines, undefined);
        assert.deepEqual(merged[0].entryPoints, ['vendor.manual']);
        assert.deepEqual(saved, before, 'withdrawal is still an uncommitted preview');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('changing project roots cannot merge unrelated old import rules or resource approvals', () => {
    const { root, draft, first } = workspace();
    try {
        const saved = [{ file: 'absent-in-this-project.py', mkdir: true }];
        const merged = mergeResourceSetupRules(root, saved, path.dirname(root), draft);
        assert.deepEqual(merged, [first]);
        const polluted = { ...draft, rules: [{ ...first, entryPoints: ['vendor.injected'] }] };
        assert.throws(() => readResourceSetupDraft(root, JSON.stringify(polluted)), /invalid schema/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
