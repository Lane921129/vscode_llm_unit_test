import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DependencyInventory } from './dependencyInventory';

export interface PythonInstallationPlan {
    id: string; python: string; virtual: boolean; target: string;
    missing: { module: string; installation: string; locations: string[]; mappingEditable?: boolean }[];
    declarations: { package: string; version: string; conditional: boolean; source: string; constraint: boolean }[];
    optionalMissing: string[]; notes: string[]; blockers: string[]; previouslyInstalled: string[];
    operations: { args: string[]; cwd: string; label: string }[];
    mappings: Record<string, string>;
    files: { path: string; realPath: string; hash: string }[];
}

export type PythonInstallationDecision = boolean | { mappings: Record<string, string> };

/** Only explicit edits for this plan's editable imports may be saved. Never accept pip arguments or URLs. */
export function validateInstallationMappings(plan: PythonInstallationPlan, value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
    const entries = Object.entries(value);
    const editable = new Set(plan.missing.filter(item => item.mappingEditable).map(item => item.module));
    if (!entries.length || entries.length > editable.size) { return undefined; }
    const result: Record<string, string> = {};
    for (const [module, name] of entries) {
        if (!editable.has(module) || typeof name !== 'string' || !safeName(name.trim())) { return undefined; }
        result[module] = name.trim();
    }
    return result;
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const safeName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)
    && !/^(?:AIza|AQ\.|sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_.-]{20,}$/.test(name);
const within = (root: string, file: string) => {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

/** Display declarations without copying source URLs, credentials, environment values or arbitrary lines. */
function readDeclarations(plan: PythonInstallationPlan, entry: string, root: string, label: string): void {
    const active = new Set<string>(), seen = new Set<string>();
    let bytes = 0;
    const visit = (file: string, constraint: boolean, depth: number) => {
        try {
            const real = fs.realpathSync(file);
            const realRoot = fs.realpathSync(root);
            if (!within(realRoot, real)) {
                plan.blockers.push('requirements 引用了專案範圍外的清單，請改用專案內的相依清單後重新檢查。'); return;
            }
            if (active.has(real)) { plan.blockers.push('requirements 清單有循環引用，請先修正。'); return; }
            const key = JSON.stringify([real, constraint]);
            if (seen.has(key)) { return; }
            if (depth > 8 || seen.size >= 64) { plan.blockers.push('requirements 引用過多，無法完成安裝清單。'); return; }
            seen.add(key); active.add(real);
            const size = fs.statSync(real).size;
            bytes += size;
            if (bytes > 1024 * 1024) { plan.blockers.push('requirements 清單過大，無法完成預覽。'); return; }
            const data = fs.readFileSync(real);
            plan.files.push({ path: file, realPath: real, hash: hash(data) });
            const source = label + '：' + path.relative(realRoot, real);
            for (const raw of data.toString('utf8').replace(/^\uFEFF/, '').replace(/\\\r?\n/g, '').split(/\r?\n/)) {
                const line = raw.replace(/\s+#.*$/, '').trim();
                if (!line || line.startsWith('#')) { continue; }
                const include = line.match(/^(?:--(requirement|constraint)(?:\s+|=)|-([rc])\s*)(.+)$/);
                if (include) {
                    const value = include[3].replace(/^(['"])(.*)\1$/, '$2');
                    if (/^[\w+.-]+:\/\//.test(value) || /\$\{|[\r\n\0]/.test(value)) {
                        plan.blockers.push('requirements 引用了遠端或動態清單，請先改為本機清單再預覽。'); continue;
                    }
                    visit(path.resolve(path.dirname(real), value), constraint || include[1] === 'constraint' || include[2] === 'c', depth + 1);
                    continue;
                }
                const declaration = /^[\w+.-]+:\/\//.test(line) ? undefined
                    : line.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)(\[[A-Za-z0-9_., -]+\])?\s*(.*)$/);
                if (declaration && safeName(declaration[1])) {
                    const tail = declaration[3].split(';', 1)[0].trim();
                    // Versions are deliberately narrow; URLs and custom source expressions stay hidden.
                    const version = /^(?:(?:===|==|~=|!=|<=|>=|<|>)\s*[0-9][A-Za-z0-9.*+!_-]*\s*,?\s*)*$/.test(tail) ? tail : '';
                    plan.declarations.push({ package: declaration[1] + (declaration[2] || ''), version,
                        conditional: line.includes(';'), source, constraint });
                    if (tail && !version) { plan.notes.push('部分宣告使用外部來源或進階格式，來源內容不顯示，安裝仍依原 requirements。'); }
                } else {
                    plan.notes.push('清單包含套件來源設定、本機套件或進階宣告；內容不顯示，安裝仍依原 requirements。');
                }
            }
            active.delete(real);
        } catch { plan.blockers.push('無法讀取 requirements 或其引用清單，請檢查檔案是否存在及讀取權限。'); }
    };
    visit(entry, false, 0);
}

export async function createPythonInstallationPlan(options: {
    python: string; virtual: boolean; target: string; projectRoot: string; missing: string[];
    inventory?: DependencyInventory; requirements?: string; toolRequirements: string; needsTools: boolean;
    packageName?: (missing: string) => Promise<string | undefined>; previouslyInstalled: string[];
}): Promise<PythonInstallationPlan> {
    const plan: PythonInstallationPlan = { id: '', python: options.python, virtual: options.virtual, target: options.target,
        missing: [], declarations: [], optionalMissing: options.inventory?.optionalMissing || [], notes: [], blockers: [],
        previouslyInstalled: [...options.previouslyInstalled], operations: [], mappings: {}, files: [] };
    for (const module of options.missing) {
        const locations = options.inventory?.imports.filter(item => item.kind === 'external' && item.module.split('.')[0] === module)
            .flatMap(item => item.references.map(ref => `${ref.file}:${ref.line}`)) || [];
        let installation = '依專案 requirements';
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(module)) {
            plan.blockers.push('缺少的模組名稱無法可靠對應外部套件，請檢查相依宣告。');
        } else if (!options.requirements) {
            const name = await options.packageName?.(module);
            if (!name) {
                installation = '尚未設定安裝名稱';
                plan.blockers.push('請在下方填寫安裝名稱並更新清單，或補充 requirements／llmUnitTest.packageMappings。');
            } else if (!safeName(name)) {
                installation = '安裝名稱無效';
                plan.blockers.push('安裝名稱必須是單一套件名稱，不接受網址、路徑或 pip 引數。');
            } else {
                installation = name;
                plan.mappings[module] = name;
                if (!plan.operations.some(operation => operation.args.length === 1 && operation.args[0] === name)) {
                    plan.operations.push({ args: [name], cwd: options.projectRoot, label: name });
                }
            }
        }
        plan.missing.push({ module, installation, locations: [...new Set(locations)],
            mappingEditable: !options.requirements && /^[A-Za-z][A-Za-z0-9_]*$/.test(module) });
    }
    if (options.requirements && options.missing.length) {
        plan.operations.push({ args: ['-r', options.requirements], cwd: path.dirname(options.requirements), label: '專案 requirements' });
    }
    if (options.needsTools) {
        plan.operations.push({ args: ['-r', options.toolRequirements, ...options.requirements ? ['-r', options.requirements] : []],
            cwd: options.projectRoot, label: '測試工具相依' });
        readDeclarations(plan, options.toolRequirements, path.dirname(options.toolRequirements), '測試工具');
    }
    if (options.requirements && (options.missing.length || options.needsTools)) {
        readDeclarations(plan, options.requirements, options.projectRoot, '專案');
    }
    plan.notes.push('這是直接宣告與已知缺項清單，並非 pip 最終解析結果。安裝可能補入間接相依或調整既有版本；條件宣告由 pip 依 Python／平台判定。');
    plan.notes = [...new Set(plan.notes)]; plan.blockers = [...new Set(plan.blockers)];
    plan.id = hash(JSON.stringify(plan));
    return plan;
}

export function installationPlanFilesUnchanged(plan: PythonInstallationPlan): boolean {
    return plan.files.every(file => {
        try { return fs.realpathSync(file.path) === file.realPath && hash(fs.readFileSync(file.path)) === file.hash; }
        catch { return false; }
    });
}

export function installationPlanReport(plan: PythonInstallationPlan, approved: boolean, mappingsUpdated = false): string {
    const cell = (value: string) => value.replace(/[&<>|`\r\n\[\]]/g, char => `&#${char.charCodeAt(0)};`);
    return ['## Python 安裝清單', '', `確認狀態：${mappingsUpdated ? '已儲存安裝名稱，重新產生清單；此清單未執行安裝' : approved ? '已確認此清單（安裝結果以本次終態為準）' : '未確認／取消，未執行此清單'}。`,
        `Python：${cell(plan.python)}`, `檢查範圍：${cell(plan.target)}`, '',
        ...plan.blockers.map(value => '- ' + cell(value)),
        '| 缺少的 import | 安裝依據 | 使用位置 |', '| --- | --- | --- |',
        ...plan.missing.map(item => `| ${cell(item.module)} | ${cell(item.installation)} | ${item.locations.map(cell).join('<br>') || '單檔載入預檢'} |`), '',
        '| Requirements 宣告 | 條件 | 來源 |', '| --- | --- | --- |',
        ...plan.declarations.map(item => `| ${cell(item.package + item.version)} | ${item.constraint ? '版本限制；' : ''}${item.conditional ? '依環境條件' : '一般宣告'} | ${cell(item.source)} |`), '',
        `本清單前已完成：${plan.previouslyInstalled.map(cell).join('、') || '無'}。`,
        `條件／可選缺項（不據此補裝）：${plan.optionalMissing.map(cell).join('、') || '無'}。`,
        ...plan.notes.map(value => '- ' + cell(value)), ''].join('\n');
}
