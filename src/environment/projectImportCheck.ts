import { localize } from '../i18n/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runSpawn } from '../utils/processRunner';
import { inferTargetImportModule } from '../utils/dependencyResolver';
import { pythonToolPath } from '../pipeline/pythonTools';
import { invalidateCurrentPreflightFailures, preflightTargetModule } from '../pipeline/modulePreflight';
import { createImportFixturePlan, ImportFixturePlan, ImportFixtureRule, selectImportFixtureRules, withImportFixtures } from '../pipeline/importFixtures';
import { throwIfExecutionCancelled } from '../pipeline/executionContext';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { describeImportIssue, ImportExceptionSummary, ImportIssue, summarizeImportException } from './importDiagnostics';
import { ImportInitializationCandidate, readInitializationCandidate } from './importSetupProposal';
import { resourceLogicalPath, resourceSpecKey } from '../pipeline/isolatedResources';

export interface ImportCheckTarget { file: string; target: string }
export interface ImportCheckRow {
    file: string; status: 'loaded' | 'blocked'; issue?: ImportIssue; stage?: string;
    diagnostic?: ImportExceptionSummary;
    suggestion?: ImportInitializationCandidate;
}
export interface ImportCheck {
    root: string; python: string; directory: string; rows: ImportCheckRow[];
    /** Actual plan used by this scan; older callers may omit it. */
    fixtureId?: string | null;
    proposedRules: ImportFixtureRule[]; proposedPlan: ImportFixturePlan | null;
    proposals: ImportInitializationCandidate[];
}
const sourceHash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** One guarded load per source file, before any model work; successful loads are not test passes. */
export async function inspectProjectImports(root: string, python: string, targets: ImportCheckTarget[], directory: string,
    rules: ImportFixtureRule[], log: (text: string) => void = () => {}, boundRoot = ''): Promise<ImportCheck> {
    root = fs.realpathSync(root);
    const selectedRules = selectImportFixtureRules(root, rules, boundRoot);
    if (rules.length && !selectedRules.length) { log(localize("[初始化設定] 本次未套用其他專案的設定；仍使用隔離預檢。")); }
    rules = selectedRules;
    const plan = createImportFixturePlan(root, rules, boundRoot);
    throwIfExecutionCancelled();
    // One explicit scan owns a fresh environment view. A dependency/package may
    // have been repaired without changing the target source or fixture plan.
    invalidateCurrentPreflightFailures();
    const result: ImportCheck = { root, python, directory, fixtureId: plan?.id || null,
        rows: [], proposedRules: structuredClone(rules), proposedPlan: null, proposals: [] };
    const proposedHashes = new Map<string, string>();
    fs.mkdirSync(directory, { recursive: true });
    const save = () => {
        const blocked = result.rows.filter(row => row.status === 'blocked');
        fs.writeFileSync(path.join(directory, 'import_check.json'), JSON.stringify({ schemaVersion: 'project-import-check-v1',
            root, python, fixtureId: plan?.id || null, rows: result.rows, blocked: blocked.length,
            note: 'Module loading only; not test execution or full project readiness.' }, null, 2));
        const cell = (text: string) => text.replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]<>|]/g, '\\$&');
        const details = blocked.flatMap((row, index) => [
            localize("### {0}. 受阻模組", index + 1), '',
            localize("    來源：{0}", row.file.replace(/[\r\n]/g, ' ')),
            localize("    階段：{0}", row.stage || 'unknown'),
            localize("    例外：{0}", row.diagnostic?.exceptionType || localize("未取得結構化例外")),
            localize("    原因：{0}", row.diagnostic?.message || row.issue?.issue || localize("未取得具體訊息")),
            ...(row.issue?.origin ? [localize("    位置：{0}:{1}", row.issue.origin.file, row.issue.origin.line)] : []),
            ...(row.suggestion ? [localize("    可預覽替身：{0}（{1}:{2}）", row.suggestion.operation, row.suggestion.file, row.suggestion.line),
                localize("    依據：模組頂層直接呼叫、回傳值未使用、實際呼叫鏈遭隔離阻擋。"),
                row.suggestion.resourcePath
                    ? row.suggestion.resourceScope === 'unc-virtual'
                        ? localize('    影響：網路樣式路徑 {0} 只在本機暫存區建立測試資源，不連線、不讀寫原共享位置；此設定不授予網路存取權限，每次執行後清理。', row.suggestion.resourcePath)
                        : row.suggestion.resourceScope === 'external-exact'
                        ? localize('    影響：外部絕對路徑 {0} 只映射至全新暫存目錄；不讀取或寫入原位置，每次執行後清理。', row.suggestion.resourcePath)
                        : row.suggestion.resourceScope === 'project-parent'
                        ? localize('    影響：專案父層邏輯路徑 {0} 將導向全新暫存目錄；不讀取或寫入原位置，每次執行後清理。',
                            resourceLogicalPath({ path: row.suggestion.resourcePath, scope: row.suggestion.resourceScope }))
                        : localize('    影響：將 {0} 導向本次建立的空白暫存目錄；不讀取正式資料，每次執行後清理。', row.suggestion.resourcePath)
                    : localize("    影響：略過此初始化呼叫；不驗證其真實副作用，須確認測試不依賴它建立的狀態。")] : []), '',
            cell(row.issue?.advice || localize("請核對直譯器及預檢工具是否正常執行。")), ''
        ]);
        fs.writeFileSync(path.join(directory, 'import_check.md'), [localize("# 模組載入預檢"), '',
            localize("受測根目錄：{0}", root), `Python：${python}`, '',
            localize("已檢查 {0} 個模組；載入受阻 {1} 個。載入成功不代表函式測試通過。", result.rows.length, blocked.length), '',
            localize("| 模組 | 預檢結果 | 原因 | 來源位置 | 處理方式 |"), '| --- | --- | --- | --- | --- |',
            ...result.rows.map(row => `| ${cell(row.file)} | ${row.status === 'loaded' ? localize("可載入，尚未測試") : localize("受阻／未完成")} | ${cell(row.issue?.issue || '')} | ${cell(row.issue?.origin ? `${row.issue.origin.file}:${row.issue.origin.line}` : '')} | ${cell(row.issue?.advice || '')} |`), '',
            ...(blocked.length ? [localize("## 逐模組診斷"), '', ...details] : []),
            localize("設定只使用明確宣告的暫存資源或初始化替身，不修改受測原檔，也不假造缺少的套件或 API。"),
            localize("所有建議均須預覽後確認；套用後重新檢查，可能發現下一個原先被遮住的障礙。"), ''].join('\n'));
    };
    save();
    await withImportFixtures(plan, async () => {
        const seen = new Set<string>();
        for (const target of targets) {
            throwIfExecutionCancelled();
            const file = fs.realpathSync(target.file);
            if (seen.has(file)) { continue; }
            seen.add(file);
            const relative = path.relative(root, file);
            if (relative.startsWith('..') || path.isAbsolute(relative)) { throw new Error(localize("預檢來源超出受測根目錄。")); }
            const row: ImportCheckRow = { file: relative.replace(/\\/g, '/'), status: 'loaded' };
            log(localize("[匯入預檢] {0}", row.file));
            try {
                const ast = await runSpawn(python, ['-B', pythonToolPath('ast'), file, target.target],
                    { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 15000 });
                const context = ast.code === 0 ? JSON.parse(ast.stdout) : null;
                if (!context || context.error || !Array.isArray(context.file_imports)) {
                    throw new AnalysisStageError('ast-trace', 'static-analysis', localize("AST 預檢未完成。"));
                }
                const parent = path.dirname(file);
                await preflightTargetModule(python, file, inferTargetImportModule(file, context.file_imports),
                    [parent, path.dirname(parent), path.dirname(path.dirname(parent)), root, directory], directory,
                    context.dependencies || [], root);
            } catch (error) {
                throwIfExecutionCancelled();
                row.status = 'blocked';
                row.stage = error instanceof AnalysisStageError ? error.stage : 'module-preflight';
                const diagnostic = error instanceof AnalysisStageError ? error.diagnostic : undefined;
                row.issue = describeImportIssue(diagnostic, row.stage);
                row.diagnostic = summarizeImportException(diagnostic);
                const observed = readInitializationCandidate(root, diagnostic);
                // A pre-created directory cannot satisfy mkdir(exist_ok=False),
                // and an unbound path must not silently receive a no-op mock.
                const proposal = observed?.kind === 'mkdir' && !observed.resourcePath ? undefined : observed;
                if (proposal) {
                    row.suggestion = proposal;
                    const candidate = fs.realpathSync(path.join(root, proposal.file));
                    let existing = result.proposedRules.find(rule => fs.realpathSync(path.join(root, rule.file)) === candidate);
                    const lines = existing?.entryPointLines?.[proposal.operation];
                    const proposedResource = { path: proposal.resourcePath || '',
                        ...(proposal.resourceScope ? { scope: proposal.resourceScope } : {}) };
                    const needed = proposal.kind === 'mkdir' ? !!proposal.resourcePath && !existing?.resources?.some(resource =>
                        resource.kind === 'directory' && (resourceSpecKey(resource) === resourceSpecKey(proposedResource)
                            || resourceSpecKey(proposedResource).startsWith(resourceSpecKey(resource) + '/')))
                        : !existing?.entryPoints?.includes(proposal.operation) || !!lines && !lines.includes(proposal.line);
                    if (needed) {
                        if (!existing) { existing = { file: proposal.file }; result.proposedRules.push(existing); }
                        if (proposal.kind === 'mkdir') {
                            existing.resources = [...(existing.resources || []), { ...proposedResource, kind: 'directory' }];
                            existing.resourceSourceHash = proposal.sourceHash;
                        }
                        else {
                            existing.entryPoints = [...new Set([...(existing.entryPoints || []), proposal.operation])];
                            existing.entryPointLines = { ...existing.entryPointLines,
                                [proposal.operation]: [...new Set([...(lines || []), proposal.line])].sort((a, b) => a - b) };
                            existing.entryPointSourceHash = proposal.sourceHash;
                        }
                        result.proposals.push(proposal);
                        proposedHashes.set(candidate, proposal.sourceHash);
                    }
                }
            }
            result.rows.push(row); save();
        }
    });
    if (proposedHashes.size) {
        result.proposedPlan = createImportFixturePlan(root, result.proposedRules);
        if ([...proposedHashes].some(([file, hash]) => sourceHash(file) !== hash)) {
            throw new Error(localize("來源在預檢期間改變；請重新檢查後再建立初始化設定。"));
        }
    }
    return result;
}

export function verifyImportProposal(check: ImportCheck): void {
    if (!check.proposedPlan || createImportFixturePlan(check.root, check.proposedRules)?.id !== check.proposedPlan.id) {
        throw new Error(localize("初始化建議已過期或來源已變更；請重新預檢。"));
    }
}
