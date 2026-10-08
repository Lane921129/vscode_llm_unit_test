import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getLanguage, localize, setLanguage } from '../i18n/core';
import { createImportFixturePlan } from '../pipeline/importFixtures';
import { canonicalExternalResourcePath } from '../pipeline/isolatedResources';
import type { ResourceSetupDraft } from '../environment/resourceSetup';

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const source = 'import neutral_runtime as runtime\nruntime.launch()\ndef target(): return 4\n';
const editLabel = '新增／編輯隔離資源清單';
const applyLabel = '套用已儲存清單並重新預檢';
const refreshLabel = '更新來源版本供重新預覽';

test('resource setup UI preserves drafts, explicit consent and source-bound approvals', async t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-setup-ui-'));
    const Module = require('module'), originalLoad = Module._load, originalLanguage = getLanguage();
    let root = '', file = '', action = editLabel, approve = false, updates = 0, confirmations = 0;
    let settings: Record<string, any> = {}, beforeConfirmation: (() => void) | undefined;
    const documents: Array<{ uri: { fsPath: string }; isDirty: boolean }> = [];
    const warnings: string[] = [], opened: string[] = [];
    const vscode = {
        ConfigurationTarget: { Global: 1 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: {
            isTrusted: true, textDocuments: documents,
            getConfiguration: (_section: string, uri: { fsPath: string }) => {
                assert.equal(uri.fsPath, root);
                return {
                    get: (key: string, fallback: unknown) => structuredClone(settings[key] ?? fallback),
                    update: async (key: string, value: unknown, target: number) => {
                        assert.equal(target, 1); updates++; settings[key] = structuredClone(value);
                    }
                };
            },
            openTextDocument: async (fsPath: string) => {
                assert.ok(fs.existsSync(fsPath)); opened.push(fsPath);
                let document = documents.find(item => item.uri.fsPath === fsPath);
                if (!document) { document = { uri: { fsPath }, isDirty: false }; documents.push(document); }
                return document;
            }
        },
        window: {
            showQuickPick: async (items: string[]) => { assert.ok(items.includes(action)); return action; },
            showOpenDialog: async (options: { defaultUri: { fsPath: string } }) => {
                assert.equal(options.defaultUri.fsPath, root); return [{ fsPath: file }];
            },
            showTextDocument: async () => {}, showInformationMessage: async () => {},
            showWarningMessage: async (message: string, options?: { modal?: boolean }, confirm?: string) => {
                warnings.push(message);
                if (!options?.modal) { return undefined; }
                confirmations++; beforeConfirmation?.(); return approve ? confirm : undefined;
            }
        }
    };
    Module._load = function(name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    setLanguage('zh-tw');
    try {
        const { configureTestResources } = require('../environment/resourceSetupController');
        const fixture = async (name: string) => {
            root = path.join(base, name, 'app'); fs.mkdirSync(root, { recursive: true });
            file = path.join(root, 'sample.py'); fs.writeFileSync(file, source);
            settings = { importFixtureRoot: root, importFixtures: [{ file: 'sample.py', mkdir: true,
                configFiles: { 'existing.ini': '[test]\nvalue=1' }, entryPoints: ['neutral_runtime.launch'],
                entryPointLines: { 'neutral_runtime.launch': [2] }, entryPointSourceHash: digest(source) }] };
            const initial = structuredClone(settings);
            action = editLabel; approve = false; updates = 0; confirmations = 0; beforeConfirmation = undefined;
            documents.length = 0; warnings.length = 0; opened.length = 0;
            const output = path.join(base, name, 'results');
            assert.equal(await configureTestResources(root, output), false);
            assert.equal(updates, 0); assert.deepEqual(settings, initial);
            const directory = path.join(output, 'resource_setup');
            const drafts = fs.readdirSync(directory); assert.equal(drafts.length, 1);
            const draftPath = path.join(directory, drafts[0]);
            const draft: ResourceSetupDraft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
            assert.equal(draft.schemaVersion, 'isolated-resource-setup-v1');
            assert.equal(draft.root, root); assert.equal(draft.rules[0].file, 'sample.py');
            assert.equal(draft.rules[0].resourceSourceHash, digest(source));
            assert.deepEqual(draft.rules[0].resources, []);
            const saveResources = () => {
                draft.rules[0].resources = [{ path: 'data', kind: 'directory' },
                    { path: 'data/settings.txt', kind: 'text', text: 'fixture seed' },
                    { path: 'data/test.sqlite', kind: 'sqlite', tables: [{ name: 'entries',
                        columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }], rows: [{ id: 1 }] }] }];
                fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2)); action = applyLabel;
            };
            return { output, draftPath, draft, initial, saveResources, apply: () => configureTestResources(root, output) };
        };
        await t.test('creating or reopening the editable draft does not persist any approval', async () => {
            const f = await fixture('edit');
            const saved = fs.readFileSync(f.draftPath, 'utf8');
            assert.equal(await f.apply(), false);
            assert.equal(updates, 0); assert.equal(confirmations, 0);
            assert.equal(fs.readFileSync(f.draftPath, 'utf8'), saved);
            assert.equal(fs.readFileSync(file, 'utf8'), source);
            assert.deepEqual(fs.readdirSync(root), ['sample.py']);
        });
        await t.test('saving a declaration and declining the preview leaves settings unchanged', async () => {
            const f = await fixture('decline'); f.saveResources();
            assert.equal(await f.apply(), false);
            assert.equal(confirmations, 1); assert.equal(updates, 0); assert.deepEqual(settings, f.initial);
            const preview = JSON.parse(fs.readFileSync(f.draftPath.replace(/\.json$/, '.preview.json'), 'utf8'));
            assert.deepEqual(preview.counts, { directories: 1, files: 1, databases: 1, tables: 1, rows: 1 });
            assert.equal(preview.rules[0].resourceSourceHash, digest(source));
            assert.equal(fs.existsSync(path.join(root, 'data')), false);
        });
        await t.test('confirmed apply merges the current import approvals and validates the saved plan', async () => {
            const f = await fixture('accept'); f.saveResources();
            settings.importFixtures[0].configFiles['newer.ini'] = '[test]\nnewer=1';
            const currentRule = structuredClone(settings.importFixtures[0]);
            approve = true;
            assert.equal(await f.apply(), true);
            assert.equal(confirmations, 1); assert.equal(updates, 2);
            assert.equal(settings.importFixtureRoot, root);
            assert.deepEqual(settings.importFixtures[0], { ...currentRule, resources: f.draft.rules[0].resources,
                resourceSourceHash: digest(source) });
            assert.doesNotThrow(() => createImportFixturePlan(root, settings.importFixtures, settings.importFixtureRoot));
            assert.equal(fs.readFileSync(file, 'utf8'), source);
            assert.deepEqual(fs.readdirSync(root), ['sample.py']);
        });
        await t.test('a parent-scoped manual seed is explicitly previewed and saved without creating the original path', async () => {
            const f = await fixture('parent-scope'); f.saveResources();
            f.draft.rules[0].resources = [{ path: 'SiblingData', scope: 'project-parent', kind: 'directory' },
                { path: 'SiblingData/test.sqlite', scope: 'project-parent', kind: 'sqlite', tables: [] }];
            fs.writeFileSync(f.draftPath, JSON.stringify(f.draft, null, 2));
            approve = true;
            assert.equal(await f.apply(), true);
            assert.equal(confirmations, 1); assert.equal(updates, 2);
            assert.ok(warnings.some(message => message.includes('專案父層資源：../SiblingData')
                && message.includes('不讀取或寫入原位置')));
            assert.deepEqual(settings.importFixtures[0].resources, f.draft.rules[0].resources);
            assert.equal(fs.existsSync(path.join(path.dirname(root), 'SiblingData')), false);
            assert.equal(fs.readFileSync(file, 'utf8'), source);
        });
        for (const outcome of ['confirm', 'decline', 'source-changed', 'settings-changed'] as const) {
            await t.test(`external exact manual resources retain explicit consent: ${outcome}`, async () => {
                const f = await fixture('external-' + outcome); f.saveResources();
                const external = canonicalExternalResourcePath(path.join(base, 'external', outcome));
                f.draft.rules[0].resources = [{ path: external, scope: 'external-exact', kind: 'directory' },
                    { path: external + '/seed.txt', scope: 'external-exact', kind: 'text', text: 'explicit test seed' }];
                fs.writeFileSync(f.draftPath, JSON.stringify(f.draft, null, 2));
                approve = outcome !== 'decline';
                if (outcome === 'source-changed') { beforeConfirmation = () => fs.appendFileSync(file, '# changed after preview\n'); }
                if (outcome === 'settings-changed') { beforeConfirmation = () => { settings.importFixtures[0].mkdir = false; }; }
                const english = outcome === 'decline';
                if (english) { setLanguage('en'); action = localize(applyLabel); }
                try {
                    assert.equal(await f.apply(), outcome === 'confirm');
                    assert.equal(confirmations, 1); assert.equal(updates, outcome === 'confirm' ? 2 : 0);
                    const confirmation = warnings[0];
                    for (const exact of [external, external + '/seed.txt']) {
                        assert.ok(confirmation.split('\n').some(line => line.includes(exact)
                            && line.includes(english ? 'neither read nor written' : '不讀取或寫入原位置')));
                    }
                    if (english) { assert.doesNotMatch(confirmation.replaceAll(external, ''), /[\u3400-\u9fff]/); }
                    const preview = JSON.parse(fs.readFileSync(f.draftPath.replace(/\.json$/, '.preview.json'), 'utf8'));
                    assert.deepEqual(preview.rules[0].resources, f.draft.rules[0].resources);
                    if (outcome === 'confirm') { assert.deepEqual(settings.importFixtures[0].resources, f.draft.rules[0].resources); }
                    else { assert.equal(settings.importFixtures[0].resources, undefined); }
                    assert.equal(fs.existsSync(external), false, 'preview and approval cannot create the original external resource');
                    if (outcome !== 'source-changed') { assert.equal(fs.readFileSync(file, 'utf8'), source); }
                } finally { setLanguage('zh-tw'); }
            });
        }
        for (const changed of ['source', 'settings', 'saved draft'] as const) {
            await t.test(`a ${changed} change during the preview cannot be applied`, async () => {
                const f = await fixture(changed.replace(' ', '-')); f.saveResources(); approve = true;
                beforeConfirmation = () => {
                    if (changed === 'source') { fs.appendFileSync(file, '# changed after preview\n'); }
                    else if (changed === 'settings') {
                        settings.importFixtures = [{ ...settings.importFixtures[0], configFiles: { 'external.ini': '[new]\nvalue=2' } }];
                    } else { fs.writeFileSync(f.draftPath, fs.readFileSync(f.draftPath, 'utf8') + '\n'); }
                };
                assert.equal(await f.apply(), false);
                assert.equal(confirmations, 1); assert.equal(updates, 0);
                assert.ok(warnings.some(message => message.startsWith('隔離資源設定未套用：')));
                assert.equal(settings.importFixtures[0].resources, undefined);
            });
        }
        await t.test('a dirty draft cannot be applied or silently refreshed', async () => {
            const f = await fixture('dirty'); f.saveResources(); approve = true;
            documents.find(document => document.uri.fsPath === f.draftPath)!.isDirty = true;
            const original = fs.readFileSync(f.draftPath, 'utf8');
            assert.equal(await f.apply(), false);
            action = refreshLabel;
            assert.equal(await f.apply(), false);
            assert.equal(updates, 0); assert.equal(confirmations, 0);
            assert.equal(fs.readFileSync(f.draftPath, 'utf8'), original);
            assert.ok(warnings.some(message => message.includes('請先儲存隔離資源清單')));
        });
        await t.test('refresh changes only the draft; applying later discloses revoked stale entry-point approvals', async () => {
            const f = await fixture('refresh'); f.saveResources();
            fs.appendFileSync(file, '# new reviewed source version\n');
            action = refreshLabel;
            assert.equal(await f.apply(), false);
            const refreshed: ResourceSetupDraft = JSON.parse(fs.readFileSync(f.draftPath, 'utf8'));
            assert.equal(refreshed.rules[0].resourceSourceHash, digest(fs.readFileSync(file, 'utf8')));
            assert.notEqual(refreshed.rules[0].resourceSourceHash, f.draft.rules[0].resourceSourceHash);
            assert.deepEqual(refreshed.rules[0].resources, f.draft.rules[0].resources);
            assert.equal(updates, 0); assert.deepEqual(settings, f.initial);
            action = applyLabel;
            assert.equal(await f.apply(), false);
            assert.equal(updates, 0);
            const preview = JSON.parse(fs.readFileSync(f.draftPath.replace(/\.json$/, '.preview.json'), 'utf8'));
            assert.deepEqual(preview.revokedEntryPointSources, ['sample.py']);
            assert.equal(preview.rules[0].entryPointSourceHash, undefined);
            assert.deepEqual(preview.rules[0].configFiles, f.initial.importFixtures[0].configFiles);
            assert.ok(warnings.some(message => message.includes('舊初始化入口批准會撤銷')));
            approve = true;
            assert.equal(await f.apply(), true);
            assert.equal(updates, 2);
            assert.equal(settings.importFixtures[0].entryPointSourceHash, undefined);
            assert.equal(settings.importFixtures[0].resourceSourceHash, refreshed.rules[0].resourceSourceHash);
        });
        await t.test('a draft bound to another project cannot reach confirmation or update settings', async () => {
            const f = await fixture('wrong-root'); f.saveResources();
            const other = path.join(base, 'unrelated'); fs.mkdirSync(other);
            fs.writeFileSync(f.draftPath, JSON.stringify({ ...f.draft, root: other })); approve = true;
            assert.equal(await f.apply(), false);
            assert.equal(confirmations, 0); assert.equal(updates, 0); assert.deepEqual(settings, f.initial);
        });
    } finally {
        Module._load = originalLoad; setLanguage(originalLanguage);
        fs.rmSync(base, { recursive: true, force: true });
    }
});
