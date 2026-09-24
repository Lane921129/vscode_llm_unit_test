import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const IMPORT_FIXTURE_ENV = 'LLM_UNIT_TEST_IMPORT_FIXTURES';
export interface ImportFixtureRule {
    file: string;
    mkdir?: boolean;
    configFiles?: Record<string, string>;
    entryPoints?: string[];
}
export interface ImportFixturePlan {
    schemaVersion: 'import-fixtures-v1';
    id: string;
    root: string;
    rules: Array<ImportFixtureRule & { sourceHash: string }>;
}
const storage = new AsyncLocalStorage<ImportFixturePlan | null>();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Only declarative test inputs; never rewrite a target or execute a setup script. */
export function createImportFixturePlan(root: string, input: unknown, boundRoot = ''): ImportFixturePlan | null {
    if (!Array.isArray(input) || input.length > 64) { throw new Error('匯入測試設定必須是最多 64 筆的清單。'); }
    if (!input.length) { return null; }
    root = fs.realpathSync(root);
    if (boundRoot && fs.realpathSync(boundRoot) !== root) {
        throw new Error('匯入測試設定綁定另一個受測根目錄；請切回原專案，或使用「檢查模組載入／初始化設定」為此專案重新設定。');
    }
    const seen = new Set<string>();
    const rules = input.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('匯入測試設定格式錯誤。'); }
        const rule = value as ImportFixtureRule;
        if (Object.keys(rule).some(key => !['file', 'mkdir', 'configFiles', 'entryPoints'].includes(key))
            || typeof rule.file !== 'string' || path.isAbsolute(rule.file) || !rule.file.endsWith('.py')
            || rule.file.split(/[\\/]/).some(part => !part || part === '..' || part === '.')
            || (rule.mkdir !== undefined && typeof rule.mkdir !== 'boolean')) { throw new Error('匯入測試設定來源或操作無效。'); }
        const file = fs.realpathSync(path.join(root, rule.file));
        const relative = path.relative(root, file);
        if (relative.startsWith('..') || path.isAbsolute(relative) || seen.has(file.toLowerCase())) {
            throw new Error('匯入測試設定來源重複或超出受測專案。');
        }
        seen.add(file.toLowerCase());
        const configFiles = rule.configFiles ?? {};
        if (!configFiles || typeof configFiles !== 'object' || Array.isArray(configFiles) || Object.keys(configFiles).length > 8
            || Object.entries(configFiles).some(([name, content]) => !/^[\w.-]+\.ini$/i.test(name)
                || typeof content !== 'string' || content.length > 65536)) { throw new Error('設定檔 fixture 必須是有限的 .ini 檔名與測試文字。'); }
        const entryPoints = rule.entryPoints ?? [];
        if (!Array.isArray(entryPoints) || entryPoints.length > 8 || entryPoints.some(name =>
            typeof name !== 'string' || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(name))) {
            throw new Error('啟動入口 fixture 必須是明確的外部模組 callable。');
        }
        return { file: relative.replace(/\\/g, '/'), sourceHash: hash(fs.readFileSync(file)),
            mkdir: rule.mkdir === true, configFiles: { ...configFiles }, entryPoints: [...new Set(entryPoints)] };
    });
    const body = { schemaVersion: 'import-fixtures-v1' as const, root, rules };
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, 'utf8') > 262144) { throw new Error('匯入測試設定超過大小限制。'); }
    return { ...body, id: hash(encoded) };
}

export function currentImportFixtures(): ImportFixturePlan | undefined { return storage.getStore() || undefined; }
export function withImportFixtures<T>(plan: ImportFixturePlan | null, operation: () => T): T {
    return storage.run(plan, operation);
}
export function importFixtureEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const result = { ...base };
    // Host environment must not silently enable fixtures for an unconfigured run.
    delete result[IMPORT_FIXTURE_ENV];
    const plan = currentImportFixtures();
    if (plan) { result[IMPORT_FIXTURE_ENV] = JSON.stringify(plan); }
    return result;
}
