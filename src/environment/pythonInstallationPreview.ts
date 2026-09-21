import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { PythonInstallationDecision, PythonInstallationPlan, validateInstallationMappings } from './pythonInstallationPlan';

export function installationPreviewHtml(plan: PythonInstallationPlan, nonce: string): string {
    const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
    const editable = plan.missing.some(item => item.mappingEditable);
    const rows = plan.missing.map((item, index) => `<tr><td>${escape(item.module)}</td><td>${item.mappingEditable
        ? `<label for="mapping-${index}">pip 套件名稱</label><input id="mapping-${index}" data-module="${escape(item.module)}" value="${escape(Object.hasOwn(plan.mappings, item.module) ? plan.mappings[item.module] : '')}" placeholder="請填入安裝名稱" autocomplete="off" spellcheck="false"><button class="use-import" data-input="mapping-${index}">使用此 import 名稱</button>`
        : escape(item.installation)}</td><td>${item.locations.map(escape).join('<br>') || '單檔載入預檢'}</td></tr>`).join('');
    const declarations = plan.declarations.map(item => `<tr><td>${escape(item.package + item.version)}</td><td>${item.constraint ? '版本限制；' : ''}${item.conditional ? '依 Python／平台條件' : '一般宣告'}</td><td>${escape(item.source)}</td></tr>`).join('');
    return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Python 相依安裝清單</title>
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;max-width:1100px;margin:auto}
h1{font-size:24px}h2{font-size:18px;margin-top:28px}p{line-height:1.7}table{width:100%;border-collapse:collapse;margin:12px 0}
th,td{padding:10px;text-align:left;border-bottom:1px solid var(--vscode-panel-border);overflow-wrap:anywhere}
code{overflow-wrap:anywhere}.meta,.notice{padding:14px;background:var(--vscode-textBlockQuote-background);border-radius:6px}
.blocker{border-left:4px solid var(--vscode-inputValidation-warningBorder);padding:12px}.actions{position:sticky;bottom:0;background:var(--vscode-editor-background);padding:16px 0;display:flex;gap:12px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:10px 18px;cursor:pointer}button:disabled{opacity:.5;cursor:default}
#cancel{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}li{margin:8px 0}
input{box-sizing:border-box;width:100%;min-width:180px;margin:6px 0;padding:8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}
.use-import{padding:6px 10px;font-size:12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.actions{flex-wrap:wrap}
#mapping-status{min-height:1.5em;color:var(--vscode-descriptionForeground)}
</style></head><body>
<h1>Python 相依安裝清單</h1><p>先確認下列項目。只有按下「確認並安裝」才會開始，這次不會建立新的虛擬環境。</p>
<div class="meta"><strong>安裝到這個 Python</strong><p><code>${escape(plan.python)}</code><br>${plan.virtual ? '既有虛擬環境' : '既有 Python 環境（未偵測為 venv）'}</p>
<strong>檢查範圍</strong><p><code>${escape(plan.target)}</code></p></div>
${plan.previouslyInstalled.length ? `<p>先前已完成：${plan.previouslyInstalled.map(escape).join('、')}。取消此清單會保留先前已安裝的套件。</p>` : ''}
${plan.blockers.length ? `<div class="blocker"><strong>請先完成以下項目</strong><ul>${plan.blockers.map(value => `<li>${escape(value)}</li>`).join('')}</ul></div>` : ''}
<h2>目前缺少的必要相依</h2>${rows ? `<table><thead><tr><th>Import</th><th>安裝依據／名稱</th><th>使用位置</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>目前沒有缺少的應用 import；本次準備測試工具相依。</p>'}
${editable ? '<p>安裝名稱可能與 import 不同。確認兩者相同時，可按「使用此 import 名稱」；填好後按「儲存名稱並更新清單」。名稱會記住供下次使用，儲存本身不會安裝套件。</p>' : ''}
<h2>將執行的安裝項目</h2>${plan.operations.length ? `<ul>${plan.operations.map(operation => `<li>${escape(operation.label)}</li>`).join('')}</ul>` : '<p>完成安裝名稱並更新清單後，這裡會列出安裝項目。</p>'}
${declarations ? `<h2>Requirements 直接宣告</h2><p>保留清單內原有版本與平台條件；不只處理第一個缺少的 import。</p><table><thead><tr><th>套件／版本</th><th>條件</th><th>來源清單</th></tr></thead><tbody>${declarations}</tbody></table>` : ''}
${plan.optionalMissing.length ? `<p>條件／可選缺項（不據此補裝）：${plan.optionalMissing.map(escape).join('、')}。</p>` : ''}
<div class="notice"><ul>${plan.notes.map(value => `<li>${escape(value)}</li>`).join('')}</ul></div>
<p id="mapping-status" role="status" aria-live="polite"></p>
<div class="actions">${editable ? '<button id="save-mappings">儲存名稱並更新清單</button>' : ''}<button id="install" ${plan.blockers.length ? 'disabled' : ''}>確認並安裝</button><button id="cancel">取消，不安裝此清單</button></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const inputs = Array.from(document.querySelectorAll('input[data-module]'));
const status = document.getElementById('mapping-status');
const save = document.getElementById('save-mappings');
let dirty = false;
const updateEditing = () => {
    dirty = inputs.some(input => input.value.trim() !== input.defaultValue.trim());
    document.getElementById('install').disabled = ${plan.blockers.length ? 'true' : 'false'} || dirty;
    status.textContent = dirty ? '名稱已修改，請先儲存並更新清單，再確認安裝。' : '';
};
inputs.forEach(input => input.addEventListener('input', updateEditing));
document.querySelectorAll('.use-import').forEach(button => button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.input);
    input.value = input.dataset.module;
    updateEditing();
}));
if (save) save.addEventListener('click', () => {
    const mappings = {};
    inputs.forEach(input => { const value = input.value.trim(); if (value && value !== input.defaultValue.trim()) mappings[input.dataset.module] = value; });
    if (!Object.keys(mappings).length) { status.textContent = '請先填入或修改要安裝的套件名稱。'; return; }
    save.disabled = true;
    status.textContent = '正在檢查並儲存名稱…';
    vscode.postMessage({command:'updateMappings', planId:'${plan.id}', mappings});
});
window.addEventListener('message', event => {
    if (event.data?.command === 'mappingError') {
        status.textContent = event.data.text;
        if (save) save.disabled = false;
    }
});
document.getElementById('install').addEventListener('click', () => {
    if (dirty) return;
    document.getElementById('install').disabled = true;
    vscode.postMessage({command:'install', planId:'${plan.id}'});
});
document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({command:'cancel', planId:'${plan.id}'}));
</script></body></html>`;
}

/** Every panel approves only its own immutable plan; closing or cancellation never installs. */
export async function confirmPythonInstallation(plan: PythonInstallationPlan, signal?: AbortSignal): Promise<PythonInstallationDecision> {
    if (signal?.aborted) { return false; }
    const panel = vscode.window.createWebviewPanel('llmUnitTest.installationPlan', 'Python 相依安裝清單',
        vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    return new Promise<PythonInstallationDecision>(resolve => {
        let settled = false;
        const subscriptions: vscode.Disposable[] = [];
        const finish = (decision: PythonInstallationDecision) => {
            if (settled) { return; }
            settled = true;
            signal?.removeEventListener('abort', abort);
            subscriptions.forEach(subscription => subscription.dispose());
            panel.dispose(); resolve(decision);
        };
        const abort = () => finish(false);
        subscriptions.push(panel.onDidDispose(() => finish(false)), panel.webview.onDidReceiveMessage(message => {
            if (message?.planId !== plan.id) { return; }
            if (message.command === 'cancel') { finish(false); }
            else if (message.command === 'updateMappings' && !signal?.aborted) {
                const mappings = validateInstallationMappings(plan, message.mappings);
                if (mappings) { finish({ mappings }); }
                else { void panel.webview.postMessage({ command: 'mappingError',
                    text: '請填寫本清單的單一 pip 套件名稱；不接受網址、路徑或指令參數。' }); }
            }
            else if (message.command === 'install' && !plan.blockers.length && !signal?.aborted) { finish(true); }
        }));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { finish(false); return; }
        panel.webview.html = installationPreviewHtml(plan, randomBytes(18).toString('hex'));
    });
}
