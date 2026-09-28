import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { createImportFixturePlan } from '../pipeline/importFixtures';

test('generic startup advice previews observed evidence, preserves mkdir rules and rechecks after confirmation', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-ui-'));
    const root = path.join(base, 'app'); fs.mkdirSync(root);
    const file = path.join(root, 'sample.py');
    const source = 'from pathlib import Path\nimport neutral_runtime as rt\nPath("no_folder").mkdir()\nrt.launch()\ndef target(): return 4\n';
    fs.writeFileSync(file, source);
    fs.writeFileSync(path.join(base, 'neutral_runtime.py'), 'from pathlib import Path\ndef launch():\n    Path("no_folder").mkdir()\n');
    const settings: Record<string, any> = { pythonPath: resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')),
        importFixtures: [{ file: 'sample.py', mkdir: true, configFiles: { 'sample.ini': '[test]\nvalue=1' } }], importFixtureRoot: root };
    const messages: any[] = [], previews: any[] = [];
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    let approve = false, changeSource = false, updates = 0, modelCalls = 0;
    const vscode = {
        ConfigurationTarget: { Global: 1 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], getConfiguration: () => ({
            get: (key: string, fallback: unknown) => settings[key] ?? fallback,
            update: async (key: string, value: unknown) => { updates++; settings[key] = value; }
        }), openTextDocument: async (file: string) => {
            if (path.basename(file) === 'setup_proposal.json') { previews.push(JSON.parse(fs.readFileSync(file, 'utf8'))); }
            return { file };
        } },
        window: { showTextDocument: async () => {}, showInformationMessage: async () => {},
            showWarningMessage: async (_message: string, _options: unknown, action: string) => {
                if (changeSource && action === '套用此清單並重新檢查') { fs.appendFileSync(file, '# changed\n'); }
                return approve ? action : undefined;
            } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async () => { modelCalls++; throw new Error('No model calls during import advice'); };
    try {
        const { ImportSetupController } = require('../environment/importSetupController');
        const controller = new ImportSetupController((message: unknown) => messages.push(message));
        const output = path.join(base, 'results');
        await controller.prepare(root, output);
        assert.equal(updates, 0, 'preview dismissal does not change settings');
        assert.equal(previews.length, 1);
        assert.equal(previews[0].evidence[0].kind, 'entry-point');
        assert.equal(previews[0].evidence[0].operation, 'neutral_runtime.launch');
        assert.equal(previews[0].evidence[0].line, 4);
        assert.match(previews[0].note, /不執行其副作用或 callback/);
        approve = true; changeSource = true;
        await controller.prepare(root, output);
        assert.equal(updates, 0, 'source changed after preview cannot be approved');
        fs.writeFileSync(file, source); changeSource = false;
        await controller.prepare(root, output);
        assert.equal(updates, 2);
        assert.deepEqual(settings.importFixtures, [{ file: 'sample.py', mkdir: true,
            configFiles: { 'sample.ini': '[test]\nvalue=1' }, entryPoints: ['neutral_runtime.launch'],
            entryPointLines: { 'neutral_runtime.launch': [4] },
            entryPointSourceHash: createHash('sha256').update(source).digest('hex') }]);
        assert.ok(messages.some(message => message.text?.includes('0 個受阻')));
        assert.equal(modelCalls, 0);
        assert.equal(fs.existsSync(path.join(root, 'no_folder')), false);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
        fs.writeFileSync(file, '\n' + source);
        assert.throws(() => createImportFixturePlan(root, settings.importFixtures, root), /來源已變更/);
        approve = false;
        await controller.prepare(root, output);
        assert.equal(updates, 2, 'a new source version requires a fresh approval');
        assert.deepEqual(previews.at(-1).expiredEntryPointSources, ['sample.py']);
        assert.equal(previews.at(-1).evidence[0].line, 5);
        approve = true;
        await controller.prepare(root, output);
        assert.equal(updates, 4);
        assert.deepEqual(settings.importFixtures[0].entryPointLines, { 'neutral_runtime.launch': [5] });
        assert.doesNotThrow(() => createImportFixturePlan(root, settings.importFixtures, root));
        controller.dispose();
    } finally { Module._load = originalLoad; globalThis.fetch = originalFetch; fs.rmSync(base, { recursive: true, force: true }); }
});
