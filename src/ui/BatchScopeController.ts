import * as vscode from 'vscode';
import { t } from '../i18n/core';
import { BatchScopeSelection, SavedBatchScope, batchScopeFiles, batchScopeItems, batchScopeStateKey,
    createBatchScopeSelection } from '../pipeline/batchScope';

interface ScopePick extends vscode.QuickPickItem { file: string }

/** One cancellable source preview; switching roots invalidates late picker responses. */
export class BatchScopeController {
    private revision = 0;
    private pending?: vscode.CancellationTokenSource;
    constructor(private readonly state: vscode.Memento) {}

    invalidate(): void { this.revision++; this.pending?.cancel(); this.pending?.dispose(); this.pending = undefined; }

    async preview(root: string, files: readonly string[]): Promise<BatchScopeSelection | undefined> {
        this.invalidate();
        const revision = this.revision;
        const inventory = batchScopeFiles(root, files);
        if (!inventory.length) { await vscode.window.showInformationMessage(t('ui.batchScopeEmpty')); return undefined; }
        const key = batchScopeStateKey(root);
        const saved = this.state.get<SavedBatchScope>(key);
        const items: ScopePick[] = batchScopeItems(inventory, saved).map(item => ({
            label: item.file, file: item.file, picked: item.selected,
            description: [item.added ? t('ui.batchScopeNew') : '', item.hint === 'backup' ? t('ui.batchScopeBackup')
                : item.hint === 'test-fixture' ? t('ui.batchScopeTestFixture') : ''].filter(Boolean).join(' · ')
        }));
        const token = new vscode.CancellationTokenSource(); this.pending = token;
        try {
            const picked = await vscode.window.showQuickPick(items, { canPickMany: true,
                title: t('ui.batchScopeTitle'), placeHolder: t('ui.batchScopeHint'), matchOnDescription: true }, token.token);
            if (revision !== this.revision || token.token.isCancellationRequested || !picked) { return undefined; }
            if (!picked.length) { await vscode.window.showWarningMessage(t('ui.batchScopeEmptySelection')); return undefined; }
            const selection = createBatchScopeSelection(root, inventory, picked.map(item => item.file));
            await this.state.update(key, { knownFiles: selection.knownFiles, selectedFiles: selection.selectedFiles });
            return revision === this.revision ? selection : undefined;
        } finally {
            if (this.pending === token) { this.pending = undefined; }
            token.dispose();
        }
    }
}
