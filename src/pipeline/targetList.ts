import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { existingRealPath } from '../utils/fileIdentity';
import { extractFunctionsWithAst } from '../utils/utils';
import { BatchScopeSelection, batchScopeFiles, canonicalScopeRoot, createBatchScopeSelection, deduplicateTargets } from './batchScope';

export const TARGET_LIST_VERSION = 'eval-screening-v1';

export interface TargetListItem {
    file: string;
    target: string;
}

export interface TargetListDocument {
    version: typeof TARGET_LIST_VERSION;
    targets: Record<string, string[]>;
}

export interface MissingTargetItem {
    file: string;
    target?: string;
    reason: 'invalid-path' | 'missing-file' | 'missing-function' | 'ambiguous-function' | 'scan-failed';
}

export interface TargetListImportResult {
    targets: TargetListItem[];
    missing: MissingTargetItem[];
}

export interface SavedTargetList {
    version: typeof TARGET_LIST_VERSION;
    items: TargetListItem[];
}

/** Deterministic case-insensitive alphabetical comparison with exact-case tie-breaker. */
export function compareCaseInsensitive(left: string, right: string): number {
    const lowerLeft = left.toLowerCase();
    const lowerRight = right.toLowerCase();
    if (lowerLeft !== lowerRight) {
        return lowerLeft < lowerRight ? -1 : 1;
    }
    return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeRelativeTargetFile(file: string): string | undefined {
    if (typeof file !== 'string') { return undefined; }
    const normalized = file.trim().replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || !normalized.endsWith('.py')) {
        return undefined;
    }
    const parts = normalized.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
        return undefined;
    }
    return normalized;
}

/** R1: Sort file list by project-relative path alphabetically (case-insensitive). */
export function sortRelativeFiles(files: readonly string[]): string[] {
    return [...files]
        .map(file => file.replace(/\\/g, '/'))
        .sort(compareCaseInsensitive);
}

/** R1: Sort function or Class.method names alphabetically (case-insensitive). */
export function sortFunctionNames(names: readonly string[]): string[] {
    return [...names].sort(compareCaseInsensitive);
}

/** R1: Sort targets by function name (case-insensitive), then by relative file path. */
export function compareTargetItems(left: TargetListItem, right: TargetListItem): number {
    const lowerLeft = left.target.toLowerCase();
    const lowerRight = right.target.toLowerCase();
    if (lowerLeft !== lowerRight) {
        return lowerLeft < lowerRight ? -1 : 1;
    }
    const fileCmp = compareCaseInsensitive(left.file.replace(/\\/g, '/'), right.file.replace(/\\/g, '/'));
    if (fileCmp !== 0) {
        return fileCmp;
    }
    return left.target < right.target ? -1 : left.target > right.target ? 1 : 0;
}

export function sortTargetItems<T extends TargetListItem>(items: readonly T[]): T[] {
    return [...items].sort(compareTargetItems);
}

export function targetItemIdentity(item: TargetListItem, platform: NodeJS.Platform = process.platform): string {
    const normalizedFile = item.file.replace(/\\/g, '/');
    const fileKey = platform === 'win32' ? normalizedFile.toLowerCase() : normalizedFile;
    return `${fileKey}\0${item.target}`;
}

/** R2: Deduplicate target list while preserving first-seen accumulation order. */
export function deduplicateTargetList(items: readonly TargetListItem[], platform: NodeJS.Platform = process.platform): TargetListItem[] {
    const seen = new Set<string>();
    const result: TargetListItem[] = [];
    for (const item of items) {
        if (!item || typeof item.file !== 'string' || typeof item.target !== 'string') { continue; }
        const file = normalizeRelativeTargetFile(item.file);
        const target = item.target.trim();
        if (!file || !target) { continue; }
        const normalized: TargetListItem = { file, target };
        const key = targetItemIdentity(normalized, platform);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(normalized);
        }
    }
    return result;
}

/** R2: Append checked functions from a file to the target list, keeping duplicates only once. */
export function addTargetsToList(
    existing: readonly TargetListItem[],
    additions: readonly TargetListItem[],
    platform: NodeJS.Platform = process.platform
): TargetListItem[] {
    return deduplicateTargetList([...existing, ...additions], platform);
}

/** R2: Remove a single target from the target list. */
export function removeTargetFromList(
    existing: readonly TargetListItem[],
    toRemove: TargetListItem,
    platform: NodeJS.Platform = process.platform
): TargetListItem[] {
    const removeKey = targetItemIdentity(toRemove, platform);
    return deduplicateTargetList(existing, platform).filter(item => targetItemIdentity(item, platform) !== removeKey);
}

/** R2: Clear all targets from the target list. */
export function clearTargetList(): TargetListItem[] {
    return [];
}

/** R4: Export target list to eval-screening-v1 JSON structure. */
export function exportTargetListToJson(items: readonly TargetListItem[]): TargetListDocument {
    const deduplicated = deduplicateTargetList(items);
    const targets: Record<string, string[]> = {};
    for (const item of deduplicated) {
        if (!Object.hasOwn(targets, item.file)) {
            targets[item.file] = [];
        }
        targets[item.file].push(item.target);
    }
    return {
        version: TARGET_LIST_VERSION,
        targets
    };
}

export function serializeTargetListJson(items: readonly TargetListItem[]): string {
    return JSON.stringify(exportTargetListToJson(items), null, 2) + '\n';
}

export function parseTargetListDocument(raw: string | unknown): Array<{ file: string; targets: string[] }> {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new Error('Invalid target list JSON');
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Target list document must be a JSON object');
    }
    const doc = parsed as Record<string, unknown>;
    if (doc.version !== TARGET_LIST_VERSION) {
        throw new Error(`Unsupported target list version: ${String(doc.version ?? 'missing')}`);
    }
    if (!doc.targets || typeof doc.targets !== 'object' || Array.isArray(doc.targets)) {
        throw new Error('Target list document is missing a valid targets map');
    }
    const entries: Array<{ file: string; targets: string[] }> = [];
    for (const [file, value] of Object.entries(doc.targets as Record<string, unknown>)) {
        if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
            throw new Error(`Target list entry for "${file}" must be an array of function names`);
        }
        entries.push({ file, targets: value.map(name => name.trim()).filter(Boolean) });
    }
    return entries;
}

export type FunctionInventoryResolver = (
    filePath: string
) => Promise<readonly string[] | { targets: readonly string[]; ambiguousTargets?: readonly string[] }>
    | readonly string[]
    | { targets: readonly string[]; ambiguousTargets?: readonly string[] };

export function defaultFunctionInventoryResolver(pythonExecutable?: string): FunctionInventoryResolver {
    return async (filePath: string) => {
        const infos = await extractFunctionsWithAst(filePath, pythonExecutable, true);
        const unique = deduplicateTargets(infos);
        return {
            targets: unique.targets.map(item => item.fullName),
            ambiguousTargets: unique.ambiguousTargets
        };
    };
}

/** R4: Import and validate a target list JSON against actual files and functions under root. */
export async function importTargetListFromJson(
    root: string,
    raw: string | unknown,
    discoverFunctions: FunctionInventoryResolver = defaultFunctionInventoryResolver()
): Promise<TargetListImportResult> {
    const canonicalRoot = canonicalScopeRoot(root);
    const entries = parseTargetListDocument(raw);
    const valid: TargetListItem[] = [];
    const missing: MissingTargetItem[] = [];

    for (const entry of entries) {
        const normalizedFile = normalizeRelativeTargetFile(entry.file);
        if (!normalizedFile) {
            if (entry.targets.length === 0) {
                missing.push({ file: entry.file, reason: 'invalid-path' });
            } else {
                for (const target of entry.targets) {
                    missing.push({ file: entry.file, target, reason: 'invalid-path' });
                }
            }
            continue;
        }

        const candidatePath = path.resolve(root, normalizedFile);
        if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
            if (entry.targets.length === 0) {
                missing.push({ file: normalizedFile, reason: 'missing-file' });
            } else {
                for (const target of entry.targets) {
                    missing.push({ file: normalizedFile, target, reason: 'missing-file' });
                }
            }
            continue;
        }

        let realFile: string;
        try {
            realFile = existingRealPath(candidatePath);
        } catch {
            for (const target of entry.targets) {
                missing.push({ file: normalizedFile, target, reason: 'missing-file' });
            }
            continue;
        }
        const canonicalCandidate = process.platform === 'win32' ? realFile.toLowerCase() : realFile;
        const relToRoot = path.relative(canonicalRoot, canonicalCandidate);
        if (!relToRoot || relToRoot === '..' || relToRoot.startsWith('..' + path.sep) || path.isAbsolute(relToRoot)) {
            for (const target of entry.targets) {
                missing.push({ file: normalizedFile, target, reason: 'invalid-path' });
            }
            continue;
        }
        const actualRelative = path.relative(existingRealPath(root), realFile).replace(/\\/g, '/');

        let discovered: readonly string[] | { targets: readonly string[]; ambiguousTargets?: readonly string[] };
        try {
            discovered = await discoverFunctions(realFile);
        } catch {
            if (entry.targets.length === 0) {
                missing.push({ file: actualRelative, reason: 'scan-failed' });
            } else {
                for (const target of entry.targets) {
                    missing.push({ file: actualRelative, target, reason: 'scan-failed' });
                }
            }
            continue;
        }

        const validNames = new Set('targets' in discovered ? discovered.targets : discovered);
        const ambiguousNames = new Set('targets' in discovered ? (discovered.ambiguousTargets ?? []) : []);

        for (const target of entry.targets) {
            if (ambiguousNames.has(target)) {
                missing.push({ file: actualRelative, target, reason: 'ambiguous-function' });
            } else if (!validNames.has(target)) {
                missing.push({ file: actualRelative, target, reason: 'missing-function' });
            } else {
                valid.push({ file: actualRelative, target });
            }
        }
    }

    return {
        targets: deduplicateTargetList(valid),
        missing
    };
}

/** R5: Workspace state key bound to canonical project root, matching batchScopeStateKey. */
export function targetListStateKey(root: string): string {
    return 'llmUnitTest.targetList.v1.' + createHash('sha256').update(canonicalScopeRoot(root)).digest('hex');
}

export function restoreSavedTargetList(raw: unknown): TargetListItem[] {
    if (!raw) { return []; }
    if (Array.isArray(raw)) {
        return deduplicateTargetList(raw as TargetListItem[]);
    }
    if (typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        if (Array.isArray(obj.items)) {
            return deduplicateTargetList(obj.items as TargetListItem[]);
        }
        if (obj.version === TARGET_LIST_VERSION && obj.targets && typeof obj.targets === 'object') {
            try {
                const entries = parseTargetListDocument(obj);
                return deduplicateTargetList(entries.flatMap(entry =>
                    entry.targets.map(target => ({ file: entry.file, target }))
                ));
            } catch {
                return [];
            }
        }
    }
    return [];
}

export function loadTargetListState(
    state: { get<T>(key: string): T | undefined },
    root: string
): TargetListItem[] {
    const key = targetListStateKey(root);
    return restoreSavedTargetList(state.get<SavedTargetList>(key));
}

export async function saveTargetListState(
    state: { update(key: string, value: unknown): Thenable<void> | Promise<void> },
    root: string,
    items: readonly TargetListItem[]
): Promise<TargetListItem[]> {
    const key = targetListStateKey(root);
    const deduplicated = deduplicateTargetList(items);
    const payload: SavedTargetList = {
        version: TARGET_LIST_VERSION,
        items: deduplicated
    };
    await state.update(key, payload);
    return deduplicated;
}

export function createExplicitTargetBatchScope(
    batchPath: string,
    discoveredFiles: readonly string[],
    targets: readonly TargetListItem[],
    checkCancelled?: () => void
): BatchScopeSelection | undefined {
    const existingTargetPaths: string[] = [];
    for (const item of targets) {
        checkCancelled?.();
        const candidate = path.resolve(batchPath, item.file);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            existingTargetPaths.push(candidate);
        }
    }
    const selectedRelative = batchScopeFiles(batchPath, existingTargetPaths);
    if (selectedRelative.length === 0) {
        return undefined;
    }
    const inventory = batchScopeFiles(batchPath, [...discoveredFiles, ...existingTargetPaths]);
    return createBatchScopeSelection(batchPath, inventory, selectedRelative);
}

export interface ResolveExplicitBatchTargetsOptions {
    batchPath: string;
    files: readonly string[];
    targets: readonly TargetListItem[];
    pythonExecutable?: string;
    hasDummyMarker?: (funcName: string) => boolean;
    checkCancelled?: () => void;
    onAstFailure?: (file: string) => void;
    onMissingTarget?: (file: string, target: string) => void;
}

export interface ResolvedExplicitBatchTargets {
    resolvedTargets: Array<{ file: string; rel: string; target: string }>;
    importTargets: Array<{ file: string; target: string }>;
}

export async function resolveExplicitBatchTargets(
    options: ResolveExplicitBatchTargetsOptions
): Promise<ResolvedExplicitBatchTargets> {
    const fileIdentity = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value).replace(/\\/g, '/');
    const realRoot = existingRealPath(options.batchPath);
    const discoveredFiles = new Map<string, { file: string; rel: string; available: Set<string> }>();
    const astFailedFiles = new Set<string>();
    const importTargets: Array<{ file: string; target: string }> = [];
    const isDummy = options.hasDummyMarker ?? (() => false);

    for (const file of options.files) {
        options.checkCancelled?.();
        const rel = path.relative(realRoot, existingRealPath(file)).replace(/\\/g, '/');
        let funcs;
        try {
            funcs = await extractFunctionsWithAst(file, options.pythonExecutable, true);
        } catch {
            options.checkCancelled?.();
            astFailedFiles.add(fileIdentity(rel));
            options.onAstFailure?.(file);
            continue;
        }
        options.checkCancelled?.();
        const unique = deduplicateTargets(funcs);
        const available = new Set([...unique.targets.map(func => func.fullName), ...unique.ambiguousTargets]);
        discoveredFiles.set(fileIdentity(rel), { file, rel, available });
        const selectedNames = new Set(options.targets.filter(item => fileIdentity(item.file) === fileIdentity(rel)).map(item => item.target));
        const importTarget = funcs.find(func => selectedNames.has(func.fullName) && !isDummy(func.fullName))
            ?? funcs.find(func => !isDummy(func.fullName));
        if (importTarget) {
            importTargets.push({ file, target: importTarget.fullName });
        }
    }

    const resolvedTargets: Array<{ file: string; rel: string; target: string }> = [];
    for (const item of options.targets) {
        options.checkCancelled?.();
        const key = fileIdentity(item.file);
        if (astFailedFiles.has(key)) {
            continue;
        }
        const entry = discoveredFiles.get(key);
        if (!entry || !entry.available.has(item.target)) {
            options.onMissingTarget?.(entry?.file ?? path.resolve(options.batchPath, item.file), item.target);
            continue;
        }
        resolvedTargets.push({ file: entry.file, rel: entry.rel, target: item.target });
    }

    return { resolvedTargets, importTargets };
}
