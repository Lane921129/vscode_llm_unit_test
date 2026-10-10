import { localize } from '../i18n/core';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestResourceSpec, resourceLeaseEnvironment, validateResourcePlanConflicts, validateTestResources } from './isolatedResources';

export const IMPORT_FIXTURE_ENV = 'LLM_UNIT_TEST_IMPORT_FIXTURES';
export interface ImportFixtureRule {
    file: string;
    mkdir?: boolean;
    configFiles?: Record<string, string>;
    entryPoints?: string[];
    entryPointLines?: Record<string, number[]>;
    entryPointSourceHash?: string;
    resources?: TestResourceSpec[];
    resourceSourceHash?: string;
    /** Source evidence used to resolve a proposed path/schema; expires on drift. */
    sourceDependencies?: Array<{ file: string; sourceHash: string }>;
    /** A fallback path was proved under a non-frozen Python interpreter. */
    pythonSourceMode?: true;
}
export interface ImportFixturePlan {
    schemaVersion: 'import-fixtures-v1';
    id: string;
    root: string;
    rules: Array<ImportFixtureRule & { sourceHash: string }>;
}
const storage = new AsyncLocalStorage<ImportFixturePlan | null>();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Saved approvals belong to exactly one root. Switching projects must neither
 * apply those approvals nor prevent an unrelated project from running unmocked.
 * A removed old project is still unrelated; it need not exist to be ignored.
 */
export function selectImportFixtureRules(root: string, input: unknown, boundRoot = ''): ImportFixtureRule[] {
    const canonical = (value: string) => {
        let resolved: string;
        try { resolved = fs.realpathSync(value); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            resolved = path.resolve(value);
        }
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (boundRoot && canonical(root) !== canonical(boundRoot)) { return []; }
    if (!Array.isArray(input) || input.length > 64) { throw new Error(localize("匯入測試設定必須是最多 64 筆的清單。")); }
    return input;
}

/** Only declarative test inputs; never rewrite a target or execute a setup script. */
export function createImportFixturePlan(root: string, input: unknown, boundRoot = ''): ImportFixturePlan | null {
    input = selectImportFixtureRules(root, input, boundRoot);
    if (!Array.isArray(input) || input.length > 64) { throw new Error(localize("匯入測試設定必須是最多 64 筆的清單。")); }
    if (!input.length) { return null; }
    root = fs.realpathSync(root);
    const seen = new Set<string>();
    const rules = input.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(localize("匯入測試設定格式錯誤。")); }
        const rule = value as ImportFixtureRule;
        if (Object.keys(rule).some(key => !['file', 'mkdir', 'configFiles', 'entryPoints', 'entryPointLines', 'entryPointSourceHash',
            'resources', 'resourceSourceHash', 'sourceDependencies', 'pythonSourceMode'].includes(key))
            || typeof rule.file !== 'string' || path.isAbsolute(rule.file) || !rule.file.endsWith('.py')
            || rule.file.split(/[\\/]/).some(part => !part || part === '..' || part === '.')
            || (rule.mkdir !== undefined && typeof rule.mkdir !== 'boolean')) { throw new Error(localize("匯入測試設定來源或操作無效。")); }
        const file = fs.realpathSync(path.join(root, rule.file));
        const relative = path.relative(root, file);
        if (relative.startsWith('..') || path.isAbsolute(relative) || seen.has(file.toLowerCase())) {
            throw new Error(localize("匯入測試設定來源重複或超出受測專案。"));
        }
        seen.add(file.toLowerCase());
        const configFiles = rule.configFiles ?? {};
        if (!configFiles || typeof configFiles !== 'object' || Array.isArray(configFiles) || Object.keys(configFiles).length > 8
            || Object.entries(configFiles).some(([name, content]) => !/^[\w.-]+\.ini$/i.test(name)
                || typeof content !== 'string' || content.length > 65536)) { throw new Error(localize("設定檔 fixture 必須是有限的 .ini 檔名與測試文字。")); }
        const entryPoints = rule.entryPoints ?? [];
        if (!Array.isArray(entryPoints) || entryPoints.length > 8 || entryPoints.some(name =>
            typeof name !== 'string' || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(name))) {
            throw new Error(localize("啟動入口 fixture 必須是明確的外部模組 callable。"));
        }
        const entryPointLines = rule.entryPointLines ?? {};
        if (!entryPointLines || typeof entryPointLines !== 'object' || Array.isArray(entryPointLines)
            || Object.keys(entryPointLines).length > 8 || Object.entries(entryPointLines).some(([name, lines]) =>
                !entryPoints.includes(name) || !Array.isArray(lines) || !lines.length || lines.length > 32
                || lines.some(line => !Number.isSafeInteger(line) || line < 1))) {
            throw new Error(localize("初始化替身行號必須綁定已宣告入口及有限的正整數來源行。"));
        }
        const sourceHash = hash(fs.readFileSync(file));
        const sourceDependencies = rule.sourceDependencies ?? [];
        if (!Array.isArray(sourceDependencies) || sourceDependencies.length > 64 || rule.pythonSourceMode !== undefined && rule.pythonSourceMode !== true) {
            throw new Error('Invalid isolated setup source evidence.');
        }
        const dependencyNames = new Set<string>();
        for (const dependency of sourceDependencies) {
            if (!dependency || typeof dependency !== 'object' || Object.keys(dependency).some(key => !['file', 'sourceHash'].includes(key))
                || typeof dependency.file !== 'string' || !dependency.file.endsWith('.py') || path.isAbsolute(dependency.file)
                || /[:\u0000-\u001f\u007f]/.test(dependency.file) || dependency.file.split(/[\\/]/).some(part => !part || part === '.' || part === '..')
                || typeof dependency.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(dependency.sourceHash)) {
                throw new Error('Invalid isolated setup source dependency.');
            }
            let current = root;
            for (const part of dependency.file.split(/[\\/]/)) {
                current = path.join(current, part);
                if (fs.lstatSync(current).isSymbolicLink()) { throw new Error('Isolated setup source dependency cannot be a link.'); }
            }
            const canonical = fs.realpathSync(current), key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
            if (dependencyNames.has(key) || hash(fs.readFileSync(canonical)) !== dependency.sourceHash) {
                throw new Error('Isolated setup source dependency changed; review the setup again.');
            }
            dependencyNames.add(key);
        }
        const resources = rule.resources === undefined ? [] : validateTestResources(rule.resources);
        if (resources.length && (typeof rule.resourceSourceHash !== 'string'
            || !/^[a-f0-9]{64}$/.test(rule.resourceSourceHash) || rule.resourceSourceHash !== sourceHash)
            || !resources.length && rule.resourceSourceHash !== undefined) {
            throw new Error('Isolated resource source approval is missing or expired; review the setup again.');
        }
        if (rule.entryPointSourceHash !== undefined && (typeof rule.entryPointSourceHash !== 'string'
            || !/^[a-f0-9]{64}$/.test(rule.entryPointSourceHash) || !Object.keys(entryPointLines).length)) {
            throw new Error(localize("初始化入口來源版本格式無效。"));
        }
        if (rule.entryPointSourceHash && rule.entryPointSourceHash !== sourceHash) {
            throw new Error(localize("初始化入口來源已變更；請使用「檢查模組載入／初始化設定」重新預覽，舊行號設定不可沿用。"));
        }
        return { file: relative.replace(/\\/g, '/'), sourceHash,
            mkdir: rule.mkdir === true, configFiles: { ...configFiles }, entryPoints: [...new Set(entryPoints)],
            ...(Object.keys(entryPointLines).length ? { entryPointLines: Object.fromEntries(Object.entries(entryPointLines)
                .map(([name, lines]) => [name, [...new Set(lines)].sort((a, b) => a - b)])) } : {}),
            ...(rule.entryPointSourceHash ? { entryPointSourceHash: rule.entryPointSourceHash } : {}),
            ...(sourceDependencies.length ? { sourceDependencies: structuredClone(sourceDependencies) } : {}),
            ...(rule.pythonSourceMode ? { pythonSourceMode: true as const } : {}),
            ...(resources.length ? { resources, resourceSourceHash: rule.resourceSourceHash } : {}) };
    });
    validateResourcePlanConflicts(rules, root);
    const body = { schemaVersion: 'import-fixtures-v1' as const, root, rules };
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, 'utf8') > 262144) { throw new Error(localize("匯入測試設定超過大小限制。")); }
    return { ...body, id: hash(encoded) };
}

/** Setup-only reset: expired line approvals are removed from the diagnostic run,
 * never silently rebound. Saving their replacement still needs a fresh preview. */
export function refreshEntryPointApprovals(root: string, input: ImportFixtureRule[], boundRoot = ''):
    { rules: ImportFixtureRule[]; expired: string[] } {
    if (!Array.isArray(input)) { throw new Error(localize("匯入測試設定必須是清單。")); }
    const rules = structuredClone(selectImportFixtureRules(root, input, boundRoot)), expired: string[] = [];
    for (const rule of rules) {
        if (!rule || typeof rule !== 'object' || rule.entryPointSourceHash === undefined) { continue; }
        const expected = rule.entryPointSourceHash;
        if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)
            || !rule.entryPointLines || !Object.keys(rule.entryPointLines).length) { throw new Error(localize("初始化入口來源版本格式無效。")); }
        const unbound = { ...rule }; delete unbound.entryPointSourceHash;
        const current = createImportFixturePlan(root, [unbound], boundRoot)!.rules[0].sourceHash;
        if (current === expected) { continue; }
        rule.entryPoints = rule.entryPoints?.filter(name => !Object.hasOwn(rule.entryPointLines!, name));
        delete rule.entryPointLines; delete rule.entryPointSourceHash;
        expired.push(rule.file);
    }
    createImportFixturePlan(root, rules, boundRoot);
    return { rules, expired };
}

export function currentImportFixtures(): ImportFixturePlan | undefined { return storage.getStore() || undefined; }
export function withImportFixtures<T>(plan: ImportFixturePlan | null, operation: () => T): T {
    return storage.run(plan, operation);
}
export function importFixtureEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const result = resourceLeaseEnvironment(base);
    // Host environment must not silently enable fixtures for an unconfigured run.
    delete result[IMPORT_FIXTURE_ENV];
    const plan = currentImportFixtures();
    if (plan) { result[IMPORT_FIXTURE_ENV] = JSON.stringify(plan); }
    return result;
}
