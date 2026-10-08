import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { localize } from '../i18n/core';
import { pythonEnvironmentActivity } from './pythonEnvironmentSetup';
import { createImportFixturePlan, ImportFixtureRule, selectImportFixtureRules } from '../pipeline/importFixtures';
import { externalExactResourcePaths, mergeResourceSetupRules, newResourceSetupRule, projectParentResourcePaths, readResourceSetupDraft, refreshResourceSetupDraft, resourceSetupCounts, uncVirtualResourcePaths } from './resourceSetup';

/** Drafts live with reports. Explicit apply saves the previewed host configuration. */
export async function configureTestResources(projectRoot?: string, outputPath?: string): Promise<boolean> {
    if (vscode.workspace.isTrusted === false) { await vscode.window.showWarningMessage(localize('請先信任此工作區，再執行隔離匯入預檢。')); return false; }
    const rootInput = projectRoot || vscode.workspace.getConfiguration('llmUnitTest').get<string>('projectPath', '');
    if (!rootInput || !fs.existsSync(rootInput) || !fs.statSync(rootInput).isDirectory()) {
        await vscode.window.showWarningMessage(localize('請先選擇受測專案資料夾。')); return false;
    }
    const release = pythonEnvironmentActivity.acquire('setup');
    if (!release) { await vscode.window.showInformationMessage(localize('請等待目前分析或環境準備完成。')); return false; }
    try {
        const root = fs.realpathSync(rootInput);
        const config = vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri.file(root));
        const directory = path.join(outputPath || config.get<string>('outputPath', '') || os.tmpdir(), 'resource_setup');
        const draftPath = path.join(directory, createHash('sha256').update(root).digest('hex').slice(0, 16) + '.json');
        const edit = localize('新增／編輯隔離資源清單');
        const apply = localize('套用已儲存清單並重新預檢');
        const refresh = localize('更新來源版本供重新預覽');
        const action = await vscode.window.showQuickPick(fs.existsSync(draftPath) ? [edit, apply, refresh] : [edit], {
            placeHolder: localize('先編輯並儲存清單，再回到此處套用；不會讀取正式資料庫。')
        });
        if (!action) { return false; }
        if (action === edit) {
            if (!fs.existsSync(draftPath)) {
                const selected = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(root), canSelectMany: false,
                    filters: { Python: ['py'] }, openLabel: localize('選擇使用資源的來源檔') });
                if (!selected?.length) { return false; }
                const rules: ImportFixtureRule[] = selectImportFixtureRules(root, config.get<ImportFixtureRule[]>('importFixtures', []), config.get('importFixtureRoot', ''))
                    .filter(item => item.resources?.length).map(item => ({ file: item.file, resources: structuredClone(item.resources),
                        resourceSourceHash: item.resourceSourceHash }));
                const rule = newResourceSetupRule(root, selected[0].fsPath);
                const existing = rules.find(item => item.file === rule.file);
                if (existing) {
                    existing.resources ??= [];
                    // Preserve prior approvals: editing a draft must not silently refresh an expired hash.
                    existing.resourceSourceHash ??= rule.resourceSourceHash;
                } else { rules.push(rule); }
                fs.mkdirSync(directory, { recursive: true });
                fs.writeFileSync(draftPath, JSON.stringify({ schemaVersion: 'isolated-resource-setup-v1', root, rules }, null, 2), { flag: 'wx' });
            }
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(draftPath), { preview: false });
            await vscode.window.showInformationMessage(localize('在 resources 加入目錄、文字設定或 SQLite 表格與測試資料。儲存後再次按「隔離測試資源」套用；格式見 docs/isolated-test-resources.md。'));
            return false;
        }
        const document = vscode.workspace.textDocuments?.find(doc => doc.uri.fsPath === draftPath);
        if (document?.isDirty) { throw new Error(localize('請先儲存隔離資源清單，再套用。')); }
        const previewText = fs.readFileSync(draftPath, 'utf8');
        if (action === refresh) {
            const refreshed = refreshResourceSetupDraft(root, previewText);
            fs.writeFileSync(draftPath, JSON.stringify(refreshed, null, 2), 'utf8');
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(draftPath), { preview: false });
            await vscode.window.showInformationMessage(localize('草稿已核對目前來源版本，資源內容不變；尚未套用。請檢查後再選擇「套用已儲存清單並重新預檢」。'));
            return false;
        }
        const { draft } = readResourceSetupDraft(root, previewText);
        const beforeRules = config.get<ImportFixtureRule[]>('importFixtures', []);
        const beforeRoot = config.get<string>('importFixtureRoot', '');
        const mergedRules = mergeResourceSetupRules(root, beforeRules, beforeRoot, draft);
        const plan = createImportFixturePlan(root, mergedRules, root);
        const count = resourceSetupCounts(mergedRules);
        const parentResources = projectParentResourcePaths(mergedRules);
        const externalResources = externalExactResourcePaths(mergedRules);
        const uncResources = uncVirtualResourcePaths(mergedRules);
        const revokedEntries = selectImportFixtureRules(root, beforeRules, beforeRoot).filter(rule => rule.entryPointSourceHash
            && !mergedRules.find(item => item.file === rule.file)?.entryPointSourceHash).map(rule => rule.file);
        const previewPath = draftPath.replace(/\.json$/, '.preview.json');
        fs.writeFileSync(previewPath, JSON.stringify({ root, planId: plan?.id || null, revokedEntryPointSources: revokedEntries,
            counts: count, rules: mergedRules }, null, 2), 'utf8');
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(previewPath), { preview: true });
        const confirm = localize('確認套用隔離資源');
        const approved = await vscode.window.showWarningMessage(localize(
            '將建立 {0} 個暫存目錄、{1} 個測試文字檔、{2} 個 SQLite（{3} 個資料表、{4} 筆測試資料）。每次執行與突變獨立建立並清理；不匯入正式資料。',
            count.directories, count.files, count.databases, count.tables, count.rows)
            + (parentResources.length ? '\n' + localize('專案父層資源：{0}。這些邏輯路徑將導向全新暫存資源；不讀取或寫入原位置。', parentResources.join(', ')) : '')
            + externalResources.map(resource => '\n' + localize('外部絕對路徑：{0}。只映射至全新暫存資源；不讀取或寫入原位置。', resource)).join('')
            + uncResources.map(resource => '\n' + localize('網路樣式路徑：{0}。只在本機暫存區建立測試資源，不連線、不讀寫原共享位置；此確認不授予網路存取權限。', resource)).join('')
            + (revokedEntries.length ? '\n' + localize('以下來源的舊初始化入口批准會撤銷，重新預檢後才可另行核准：{0}', revokedEntries.join(', ')) : ''),
            { modal: true }, confirm);
        if (approved !== confirm) { return false; }
        const current = vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri.file(root));
        if (fs.readFileSync(draftPath, 'utf8') !== previewText
            || JSON.stringify(current.get('importFixtures', [])) !== JSON.stringify(beforeRules)
            || current.get('importFixtureRoot', '') !== beforeRoot
            || createImportFixturePlan(root, mergeResourceSetupRules(root, beforeRules, beforeRoot,
                readResourceSetupDraft(root, previewText).draft), root)?.id !== plan?.id) {
            throw new Error(localize('設定在預覽期間改變；請重新檢查。'));
        }
        await current.update('importFixtureRoot', root, vscode.ConfigurationTarget.Global);
        try { await current.update('importFixtures', mergedRules, vscode.ConfigurationTarget.Global); }
        catch (error) { await current.update('importFixtureRoot', beforeRoot || undefined, vscode.ConfigurationTarget.Global); throw error; }
        const saved = vscode.workspace.getConfiguration('llmUnitTest', vscode.Uri.file(root));
        if (createImportFixturePlan(root, saved.get('importFixtures', []), saved.get('importFixtureRoot', ''))?.id !== plan?.id) {
            throw new Error(localize('工作區設定覆蓋了已儲存設定，尚未生效；請核對 importFixtures 與 importFixtureRoot。'));
        }
        return true;
    } catch (error) {
        await vscode.window.showWarningMessage(localize('隔離資源設定未套用：{0}', error instanceof Error ? error.message : String(error)));
        return false;
    } finally { release(); }
}
