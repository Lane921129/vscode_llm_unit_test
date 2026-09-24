import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runSpawn } from '../utils/processRunner';
import { inferTargetImportModule } from '../utils/dependencyResolver';
import { pythonToolPath } from '../pipeline/pythonTools';
import { preflightTargetModule } from '../pipeline/modulePreflight';
import { createImportFixturePlan, ImportFixturePlan, ImportFixtureRule, withImportFixtures } from '../pipeline/importFixtures';
import { throwIfExecutionCancelled } from '../pipeline/executionContext';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { describeImportIssue, ImportIssue } from './importDiagnostics';

export interface ImportCheckTarget { file: string; target: string }
export interface ImportCheckRow { file: string; status: 'loaded' | 'blocked'; issue?: ImportIssue; stage?: string }
export interface ImportCheck {
    root: string; python: string; directory: string; rows: ImportCheckRow[];
    proposedRules: ImportFixtureRule[]; proposedPlan: ImportFixturePlan | null;
}
const sourceHash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** One guarded load per source file, before any model work; successful loads are not test passes. */
export async function inspectProjectImports(root: string, python: string, targets: ImportCheckTarget[], directory: string,
    rules: ImportFixtureRule[], log: (text: string) => void = () => {}, boundRoot = ''): Promise<ImportCheck> {
    root = fs.realpathSync(root);
    const plan = createImportFixturePlan(root, rules, boundRoot);
    const result: ImportCheck = { root, python, directory, rows: [], proposedRules: structuredClone(rules), proposedPlan: null };
    const proposedHashes = new Map<string, string>();
    fs.mkdirSync(directory, { recursive: true });
    const save = () => {
        const blocked = result.rows.filter(row => row.status === 'blocked');
        fs.writeFileSync(path.join(directory, 'import_check.json'), JSON.stringify({ schemaVersion: 'project-import-check-v1',
            root, python, fixtureId: plan?.id || null, rows: result.rows, blocked: blocked.length,
            note: 'Module loading only; not test execution or full project readiness.' }, null, 2));
        const cell = (text: string) => text.replace(/[|\r\n]/g, ' ');
        fs.writeFileSync(path.join(directory, 'import_check.md'), ['# 模組載入預檢', '',
            `受測根目錄：${root}`, `Python：${python}`, '',
            `已檢查 ${result.rows.length} 個模組；載入受阻 ${blocked.length} 個。載入成功不代表函式測試通過。`, '',
            '| 模組 | 預檢結果 | 原因 | 處理方式 |', '| --- | --- | --- | --- |',
            ...result.rows.map(row => `| ${cell(row.file)} | ${row.status === 'loaded' ? '可載入，尚未測試' : '受阻／未完成'} | ${cell(row.issue?.issue || '')} | ${cell(row.issue?.advice || '')} |`), '',
            '設定只模擬明確宣告的初始化，不修改受測原檔，也不假造缺少的套件或 API。',
            '所有建議均須預覽後確認；套用後重新檢查，可能發現下一個原先被遮住的障礙。', ''].join('\n'));
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
            if (relative.startsWith('..') || path.isAbsolute(relative)) { throw new Error('預檢來源超出受測根目錄。'); }
            const row: ImportCheckRow = { file: relative.replace(/\\/g, '/'), status: 'loaded' };
            log(`[匯入預檢] ${row.file}`);
            try {
                const ast = await runSpawn(python, ['-B', pythonToolPath('ast'), file, target.target],
                    { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 15000 });
                const context = ast.code === 0 ? JSON.parse(ast.stdout) : null;
                if (!context || context.error || !Array.isArray(context.file_imports)) {
                    throw new AnalysisStageError('ast-trace', 'static-analysis', 'AST 預檢未完成。');
                }
                const parent = path.dirname(file);
                await preflightTargetModule(python, file, inferTargetImportModule(file, context.file_imports),
                    [parent, path.dirname(parent), path.dirname(path.dirname(parent)), root, directory], directory,
                    context.dependencies || [], root);
            } catch (error) {
                throwIfExecutionCancelled();
                row.status = 'blocked';
                row.stage = error instanceof AnalysisStageError ? error.stage : 'module-preflight';
                row.issue = describeImportIssue(error instanceof AnalysisStageError ? error.diagnostic : undefined, row.stage);
                const origin = row.issue.origin;
                if (row.issue.kind === 'import-side-effect' && row.issue.issue === 'os.mkdir' && origin) {
                    const candidate = fs.realpathSync(path.join(root, origin.file));
                    const within = path.relative(root, candidate);
                    if (!within.startsWith('..') && !path.isAbsolute(within) && within.endsWith('.py')) {
                        const existing = result.proposedRules.find(rule => fs.realpathSync(path.join(root, rule.file)) === candidate);
                        if (!existing?.mkdir) {
                            if (existing) { existing.mkdir = true; }
                            else { result.proposedRules.push({ file: within.replace(/\\/g, '/'), mkdir: true }); }
                            proposedHashes.set(candidate, sourceHash(candidate));
                        }
                    }
                }
            }
            result.rows.push(row); save();
        }
    });
    if (proposedHashes.size) {
        result.proposedPlan = createImportFixturePlan(root, result.proposedRules);
        if ([...proposedHashes].some(([file, hash]) => sourceHash(file) !== hash)) {
            throw new Error('來源在預檢期間改變；請重新檢查後再建立初始化設定。');
        }
    }
    return result;
}

export function verifyImportProposal(check: ImportCheck): void {
    if (!check.proposedPlan || createImportFixturePlan(check.root, check.proposedRules)?.id !== check.proposedPlan.id) {
        throw new Error('初始化建議已過期或來源已變更；請重新預檢。');
    }
}
