import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { localize } from '../i18n/core';
import { runSpawn } from '../utils/processRunner';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { pythonToolPath } from '../pipeline/pythonTools';
import { throwIfExecutionCancelled } from '../pipeline/executionContext';
import { createImportFixturePlan, ImportFixtureRule, selectImportFixtureRules } from '../pipeline/importFixtures';
import { resourceSpecKey } from '../pipeline/isolatedResources';
import { inspectProjectImports, ImportCheck, ImportCheckTarget, verifyImportProposal } from './projectImportCheck';
import { ImportInitializationCandidate, readPlannedInitializationCandidate } from './importSetupProposal';
import { planSqliteSchemas } from './schemaPlanning';

export interface InitializationSource { file: string; sourceHash: string }
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceIdentity = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
const invalidPlan = () => new AnalysisStageError('environment', 'initialization-plan',
    localize('初始化靜態規劃未完成；尚未載入受測模組，請查看規劃診斷。'));

function sourceFile(root: string, file: unknown): string {
    if (typeof file !== 'string' || !file.endsWith('.py') || file.length > 1000
        || /[:\u0000-\u001f\u007f]/.test(file) || path.isAbsolute(file)
        || file.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) { throw invalidPlan(); }
    let current = root;
    for (const part of file.split(/[\\/]/)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) { throw invalidPlan(); }
    }
    const canonical = fs.realpathSync(current);
    if (sourceIdentity(canonical) !== sourceIdentity(current)) { throw invalidPlan(); }
    return canonical;
}

export function verifyInitializationSources(root: string, sources: InitializationSource[]): void {
    for (const source of sources) {
        if (hash(sourceFile(root, source.file)) !== source.sourceHash) {
            throw new Error(localize('來源在預檢期間改變；請重新檢查後再建立初始化設定。'));
        }
    }
}

/** Merge only source-bound, explicit candidates. Existing approvals remain intact. */
export function mergeInitializationProposal(rules: ImportFixtureRule[], proposal: ImportInitializationCandidate): boolean {
    let existing = rules.find(rule => sourceIdentity(rule.file.replace(/\\/g, '/')) === sourceIdentity(proposal.file));
    const lines = existing?.entryPointLines?.[proposal.operation];
    const resource = { path: proposal.resourcePath || '', ...(proposal.resourceScope ? { scope: proposal.resourceScope } : {}) };
    const needed = proposal.kind === 'mkdir' ? !!proposal.resourcePath && !existing?.resources?.some(item =>
        item.kind === 'directory' && (resourceSpecKey(item) === resourceSpecKey(resource)
            || resourceSpecKey(resource).startsWith(resourceSpecKey(item) + '/')))
        : !existing?.entryPoints?.includes(proposal.operation) || !!lines && !lines.includes(proposal.line);
    if (!needed) { return false; }
    if (!existing) { existing = { file: proposal.file }; rules.push(existing); }
    if (proposal.kind === 'mkdir') {
        existing.resources = [...(existing.resources || []), { ...resource, kind: 'directory' }];
        existing.resourceSourceHash = proposal.sourceHash;
    } else {
        existing.entryPoints = [...new Set([...(existing.entryPoints || []), proposal.operation])];
        existing.entryPointLines = { ...existing.entryPointLines,
            [proposal.operation]: [...new Set([...(lines || []), proposal.line])].sort((a, b) => a - b) };
        existing.entryPointSourceHash = proposal.sourceHash;
    }
    return true;
}

/** Collect static proposals, optionally observe unresolved directories under the existing guard, then confirm together. */
export async function inspectPreparedProjectImports(root: string, python: string, targets: ImportCheckTarget[], directory: string,
    rules: ImportFixtureRule[], log: (text: string) => void = () => {}, boundRoot = ''): Promise<ImportCheck> {
    root = fs.realpathSync(root);
    const selected = selectImportFixtureRules(root, rules, boundRoot);
    const actual = createImportFixturePlan(root, selected, boundRoot);
    const files = [...new Set(targets.map(target => sourceFile(root, path.relative(root, path.resolve(target.file)).replace(/\\/g, '/'))))];
    for (const file of files) { sourceFile(root, path.relative(root, file).replace(/\\/g, '/')); }
    if (!files.length) { return inspectProjectImports(root, python, targets, directory, rules, log, boundRoot); }
    log(localize('[初始化規劃] 載入前彙整目錄與啟動入口；不執行受測程式。'));
    fs.mkdirSync(directory, { recursive: true });
    const toolResult = await runSpawn(python, ['-B', pythonToolPath('initializationPlan')], {
        input: JSON.stringify({ root, files }), timeout: 15000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    throwIfExecutionCancelled();
    let value: any;
    try { value = toolResult.code === 0 ? JSON.parse(toolResult.stdout) : undefined; } catch { throw invalidPlan(); }
    if (value?.schemaVersion !== 'import-initialization-plan-v1' || typeof value.complete !== 'boolean'
        || !Array.isArray(value.sources) || value.sources.length > 64
        || !Array.isArray(value.candidates) || value.candidates.length > 256
        || !Array.isArray(value.diagnostics) || value.diagnostics.length > 256) { throw invalidPlan(); }
    const sources: InitializationSource[] = [], seen = new Set<string>();
    for (const source of value.sources) {
        const file = sourceFile(root, source?.file);
        if (seen.has(sourceIdentity(file)) || typeof source.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceHash)) { throw invalidPlan(); }
        seen.add(sourceIdentity(file)); sources.push({ file: path.relative(root, file).replace(/\\/g, '/'), sourceHash: source.sourceHash });
    }
    const diagnostics = value.diagnostics.map((item: any) => {
        if (typeof item?.reason !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(item.reason)
            || typeof item.file !== 'string' || item.file.length > 1000
            || item.file !== '.' && (path.isAbsolute(item.file) || /[:\u0000-\u001f\u007f]/.test(item.file)
                || item.file.split(/[\\/]/).some((part: string) => !part || part === '.' || part === '..'))
            || item.line !== undefined && (!Number.isSafeInteger(item.line) || item.line < 1)) { throw invalidPlan(); }
        return { file: item.file, reason: item.reason, ...(item.line ? { line: item.line } : {}) };
    });
    verifyInitializationSources(root, sources);
    if (!value.complete || files.some(file => !seen.has(sourceIdentity(file)))) {
        fs.writeFileSync(path.join(directory, 'initialization_plan.json'), JSON.stringify({
            schemaVersion: value.schemaVersion, complete: false, sources, proposals: [], diagnostics
        }, null, 2));
        throw invalidPlan();
    }
    // Unresolved paths cannot be guessed. One ordinary guarded observation may
    // supply an exact receiver; it uses ONLY the already approved fixture plan.
    // Merge its evidence with static startup proposals before asking the user.
    const observed = diagnostics.some((item: { reason: string }) => item.reason === 'dynamic-directory')
        ? await inspectProjectImports(root, python, targets, directory, rules, log, boundRoot) : undefined;
    verifyInitializationSources(root, sources);
    let proposedRules = structuredClone(observed?.proposedRules || selected);
    const proposals: ImportInitializationCandidate[] = [...(observed?.proposals || [])];
    for (const raw of value.candidates) {
        const proposal = readPlannedInitializationCandidate(root, raw);
        if (!proposal || !sources.some(source => sourceIdentity(source.file) === sourceIdentity(proposal.file)
            && source.sourceHash === proposal.sourceHash)) { throw invalidPlan(); }
        if (mergeInitializationProposal(proposedRules, proposal)) { proposals.push(proposal); }
    }
    const schema = await planSqliteSchemas(root, python, sources, proposedRules, directory);
    proposedRules = schema.proposedRules;
    const cell = (text: string) => text.replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]<>|]/g, '\\$&');
    const schemaReport = [
        ...(schema.proposals.length || schema.diagnostics.length ? ['',
            localize('SQLite schema 提案只採用可保真表示的明確 DDL；批准後每個 worker 建立全新資料庫，不執行應用程式初始化或複製正式資料。'),
            '[schema_plan.json](schema_plan.json)', ''] : []),
        ...schema.proposals.map(proposal => `- ${cell(proposal.file)}:${proposal.line} — sqlite-schema / ${cell(proposal.table.name)}`),
        ...schema.diagnostics.map(item => `- ${cell(item.file)}${item.line ? ':' + item.line : ''} — `
            + localize('SQLite schema 診斷：{0}；請在同一來源宣告精確資料庫資源，或提供可保真表示的結構化 schema。', item.reason)), ''
    ];
    fs.writeFileSync(path.join(directory, 'initialization_plan.json'), JSON.stringify({
        schemaVersion: value.schemaVersion, complete: value.complete, sources, proposals, diagnostics,
        schemaProposals: schema.proposals, schemaDiagnostics: schema.diagnostics,
        guardedObservation: !!observed,
        note: 'Static proposals and observed blockers retain distinct evidence; no proposed settings were applied.'
    }, null, 2));
    if (!proposals.length && !schema.proposals.length) {
        const check = observed || await inspectProjectImports(root, python, targets, directory, rules, log, boundRoot);
        verifyInitializationSources(root, sources);
        check.initializationSources = sources;
        check.schemaProposals = schema.proposals; check.schemaDiagnostics = schema.diagnostics;
        if (schema.diagnostics.length) { fs.appendFileSync(path.join(directory, 'import_check.md'), schemaReport.join('\n')); }
        return check;
    }
    const check: ImportCheck = { root, python, directory, fixtureId: actual?.id || null,
        planningSources: sources, proposedRules, proposedPlan: createImportFixturePlan(root, proposedRules), proposals,
        schemaProposals: schema.proposals, schemaDiagnostics: schema.diagnostics,
        rows: files.map(file => ({ file: path.relative(root, file).replace(/\\/g, '/'), status: 'blocked',
            stage: 'initialization-plan', issue: { kind: 'other', issue: 'setup-confirmation-required',
                advice: observed ? localize('初始化清單待確認；已完成一次隔離診斷，尚未套用新設定。')
                    : localize('初始化清單待確認；尚未執行模組載入。') } })) };
    verifyImportProposal(check);
    if (observed) {
        for (const extension of ['json', 'md']) {
            fs.copyFileSync(path.join(directory, `import_check.${extension}`), path.join(directory, `observed_import_check.${extension}`));
        }
    }
    fs.writeFileSync(path.join(directory, 'import_check.json'), JSON.stringify({
        schemaVersion: 'project-import-check-v1', root, python, fixtureId: check.fixtureId,
        rows: check.rows, blocked: check.rows.length, phase: 'planning', importsExecuted: !!observed,
        ...(observed ? { observationReport: 'observed_import_check.json' } : {}),
        note: 'Awaiting confirmation; planning rows are not observed module import failures.'
    }, null, 2));
    fs.writeFileSync(path.join(directory, 'import_check.md'), [localize('# 載入前初始化清單'), '',
        observed ? localize('初始化清單待確認；已完成一次隔離診斷，尚未套用新設定。')
            : localize('初始化清單待確認；尚未執行模組載入。'), '',
        localize('已彙整 {0} 個初始化項目；確認後先建立暫存資源與入口替身，再檢查模組載入。', proposals.length + schema.proposals.length), '',
        ...proposals.map(proposal => `- ${proposal.file.replace(/[\\`*_[\]<>|]/g, '\\$&')}:${proposal.line} — ${proposal.kind} / ${proposal.operation}`), '',
        ...schemaReport,
        ...(observed ? ['[observed_import_check.md](observed_import_check.md)', ''] : []),
        localize('靜態候選不是已觀測錯誤；動態路徑、未知呼叫與資料庫 schema 仍須明確證據。'), ''
    ].join('\n'));
    return check;
}
