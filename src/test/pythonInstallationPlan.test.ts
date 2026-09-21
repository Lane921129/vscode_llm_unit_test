import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vm from 'node:vm';
import { createPythonInstallationPlan, installationPlanFilesUnchanged, installationPlanReport } from '../environment/pythonInstallationPlan';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installation-plan-'));
    const requirements = path.join(root, 'requirements.txt');
    const tools = path.join(root, 'tools.txt');
    fs.writeFileSync(requirements, 'neutral_alpha==1.0\n'); fs.writeFileSync(tools, 'coverage>=7\n');
    return { root, requirements, options: { python: path.join(root, 'python'), virtual: true, target: root,
        projectRoot: root, missing: ['neutral_alpha'], requirements, toolRequirements: tools,
        needsTools: true, previouslyInstalled: [] }, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('requirements preview preserves names, extras, versions, includes and constraints without exposing private sources', async () => {
    const f = fixture();
    try {
        fs.writeFileSync(f.requirements, [
            'neutral_alpha[extra]==1.0; python_version >= "3.12"', '-r nested.txt', '-c constraints.txt',
            'neutral_remote @ https://example.invalid/PRIVATE_SOURCE_SENTINEL/wheel.whl',
            '--index-url https://user:PRIVATE_TOKEN_SENTINEL@example.invalid/simple',
            'https://example.invalid/PRIVATE_BARE_SENTINEL/pkg.whl'
        ].join('\n'));
        fs.writeFileSync(path.join(f.root, 'nested.txt'), 'neutral_beta>=2.0,<3 # local note\n');
        fs.writeFileSync(path.join(f.root, 'constraints.txt'), 'neutral_gamma==4\n');
        const plan = await createPythonInstallationPlan(f.options);
        assert.equal(plan.blockers.length, 0);
        assert.deepEqual(plan.declarations.map(item => item.package), ['coverage', 'neutral_alpha[extra]', 'neutral_beta', 'neutral_gamma', 'neutral_remote']);
        assert.equal(plan.declarations[1].version, '==1.0'); assert.equal(plan.declarations[1].conditional, true);
        assert.equal(plan.declarations[3].constraint, true);
        assert.equal(plan.files.length, 4); assert.equal(plan.operations.length, 2);
        assert.equal(installationPlanFilesUnchanged(plan), true);
        assert.doesNotMatch(JSON.stringify(plan), /PRIVATE_|https:|user:/);
        assert.doesNotMatch(installationPlanReport(plan, false), /PRIVATE_|https:/);
        fs.writeFileSync(path.join(f.root, 'constraints.txt'), 'neutral_gamma==5\n');
        assert.equal(installationPlanFilesUnchanged(plan), false);
    } finally { f.dispose(); }
});

test('missing, remote, cyclic and out-of-scope requirement references produce blockers instead of an incomplete approved list', async () => {
    const f = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'installation-other-'));
    try {
        const external = path.join(outside, 'private.txt'); fs.writeFileSync(external, 'PRIVATE_CONTENT_SENTINEL\n');
        for (const line of ['-r missing.txt', '-r https://example.invalid/PRIVATE_REMOTE_SENTINEL', '-r requirements.txt', `-r ${external}`]) {
            fs.writeFileSync(f.requirements, line);
            const plan = await createPythonInstallationPlan(f.options);
            assert.ok(plan.blockers.length, line); assert.doesNotMatch(JSON.stringify(plan), /PRIVATE_/);
        }
    } finally { f.dispose(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('preview buttons bind to one plan; dismissal, abort and blocked plans never approve installation', async () => {
    const f = fixture();
    const originalLoad = require('module')._load;
    const panels: any[] = [];
    const vscode = { ViewColumn: { Active: -1 }, window: { createWebviewPanel: (_type: string, _title: string, _column: number, options: any) => {
        const disposeListeners = new Set<() => void>();
        const messages = new Set<(message: unknown) => void>();
        const panel: any = { options, closed: false,
            webview: { html: '', onDidReceiveMessage: (listener: (message: unknown) => void) => {
                messages.add(listener); return { dispose: () => messages.delete(listener) };
            } },
            onDidDispose: (listener: () => void) => { disposeListeners.add(listener); return { dispose: () => disposeListeners.delete(listener) }; },
            dispose: () => { if (panel.closed) { return; } panel.closed = true; [...disposeListeners].forEach(listener => listener()); },
            emit: (message: unknown) => { [...messages].forEach(listener => listener(message)); },
            count: () => messages.size + disposeListeners.size
        };
        panels.push(panel); return panel;
    } } };
    require('module')._load = function (name: string, ...args: unknown[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    try {
        delete require.cache[require.resolve('../environment/pythonInstallationPreview')];
        const { confirmPythonInstallation, installationPreviewHtml } = require('../environment/pythonInstallationPreview');
        const plan = await createPythonInstallationPlan(f.options);
        const accepted = confirmPythonInstallation(plan);
        const first = panels.at(-1)!;
        assert.deepEqual(first.options.localResourceRoots, []);
        first.emit({ command: 'install', planId: 'stale-id' }); assert.equal(first.closed, false);
        first.emit({ command: 'install', planId: plan.id });
        assert.equal(await accepted, true); assert.equal(first.count(), 0);
        const dismissed = confirmPythonInstallation(plan); panels.at(-1)!.dispose();
        assert.equal(await dismissed, false); assert.equal(panels.at(-1)!.count(), 0);
        const cancelled = confirmPythonInstallation(plan); panels.at(-1)!.emit({ command: 'cancel', planId: plan.id });
        assert.equal(await cancelled, false);
        const abort = new AbortController();
        const pending = confirmPythonInstallation(plan, abort.signal); abort.abort();
        assert.equal(await pending, false); assert.equal(panels.at(-1)!.count(), 0);
        const before = panels.length;
        assert.equal(await confirmPythonInstallation(plan, abort.signal), false); assert.equal(panels.length, before);
        const blocked = { ...plan, blockers: ['請先補齊映射'] };
        const invalid = confirmPythonInstallation(blocked);
        assert.match(panels.at(-1)!.webview.html, /id="install" disabled/);
        panels.at(-1)!.emit({ command: 'install', planId: plan.id }); assert.equal(panels.at(-1)!.closed, false);
        panels.at(-1)!.dispose(); assert.equal(await invalid, false);
        const html = installationPreviewHtml({ ...plan, target: '<script>untrusted</script>', notes: ['<img src=x>'] }, 'fixed-nonce');
        assert.doesNotMatch(html, /<script>untrusted|<img src=x>/);
        assert.match(html, /default-src 'none'/);
        const script = html.match(/<script nonce="fixed-nonce">([\s\S]*?)<\/script>/)![1];
        const buttons: Record<string, { disabled: boolean; handler?: () => void; addEventListener: (_event: string, callback: () => void) => void }> = {};
        for (const id of ['install', 'cancel']) { buttons[id] = { disabled: false, addEventListener: (_event, handler) => { buttons[id].handler = handler; } }; }
        const posted: unknown[] = [];
        new vm.Script(script).runInNewContext({ acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posted.push(message) }),
            document: { getElementById: (id: string) => buttons[id] } });
        buttons.install.handler!(); buttons.cancel.handler!();
        assert.equal(buttons.install.disabled, true);
        assert.equal(JSON.stringify(posted), JSON.stringify([{ command: 'install', planId: plan.id }, { command: 'cancel', planId: plan.id }]));
    } finally {
        require('module')._load = originalLoad;
        delete require.cache[require.resolve('../environment/pythonInstallationPreview')];
        f.dispose();
    }
});
