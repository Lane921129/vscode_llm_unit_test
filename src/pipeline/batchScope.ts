import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { existingRealPath } from '../utils/fileIdentity';
import { compareTargetItems, deduplicateTargetList, TargetListItem } from './targetList';

export interface SavedBatchScope { knownFiles: string[]; selectedFiles: string[] }
export interface BatchScopeSelection extends SavedBatchScope {
    root: string;
    excludedFiles: string[];
    scopeId: string;
}
export interface BatchScopeItem { file: string; selected: boolean; added: boolean; hint?: 'backup' | 'test-fixture' }
export interface BatchScopeTargetCandidate extends TargetListItem { selected: boolean }

export function canonicalScopeRoot(root: string): string {
    const canonical = existingRealPath(root);
    if (!fs.statSync(canonical).isDirectory()) { throw new Error('Invalid batch source root'); }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Resolve aliases once. Equal basenames in different source folders remain distinct. */
export function batchScopeFiles(root: string, files: readonly string[]): string[] {
    const canonical = canonicalScopeRoot(root);
    const selected = new Map<string, string>();
    for (const file of files) {
        const real = existingRealPath(file);
        const relative = path.relative(canonical, real);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
            || !real.endsWith('.py') || !fs.statSync(real).isFile()) { throw new Error('Batch source escapes selected root'); }
        const name = relative.replace(/\\/g, '/');
        const identity = process.platform === 'win32' ? name.toLowerCase() : name;
        if (!selected.has(identity)) { selected.set(identity, name); }
    }
    return [...selected.values()].sort();
}

export function batchScopeStateKey(root: string): string {
    return 'llmUnitTest.batchScope.v1.' + createHash('sha256').update(canonicalScopeRoot(root)).digest('hex');
}

export function batchScopeItems(files: readonly string[], saved?: SavedBatchScope): BatchScopeItem[] {
    const known = new Set(Array.isArray(saved?.knownFiles) ? saved.knownFiles : []);
    const selected = new Set(Array.isArray(saved?.selectedFiles) ? saved.selectedFiles : []);
    return files.map(file => {
        const parts = file.toLowerCase().split('/');
        const hint = parts.some(part => /(^|[ _.-])(backup|backups|bak)([ _.-]|$)/.test(part)) ? 'backup'
            : parts.some(part => /^(tests?|fixtures?|test_data)$/.test(part) || /^test_.+\.py$/.test(part) || /_test\.py$/.test(part))
                ? 'test-fixture' : undefined;
        return { file, selected: !known.has(file) || selected.has(file), added: !!saved && !known.has(file), hint };
    });
}

/** Accept only the displayed inventory; do not trust relative paths supplied by a view. */
export function createBatchScopeSelection(root: string, files: readonly string[], selectedFiles: readonly string[]): BatchScopeSelection {
    canonicalScopeRoot(root);
    const knownFiles = [...new Set(files)].sort();
    const selected = [...new Set(selectedFiles)].sort();
    if (knownFiles.some(file => path.isAbsolute(file) || file.includes('\\')
        || file.split('/').some(part => !part || part === '.' || part === '..') || !file.endsWith('.py'))
        || !selected.length || selected.some(file => !knownFiles.includes(file))) { throw new Error('Select at least one displayed Python source'); }
    // Execution/report provenance must keep the selected root's spelling. Canonical
    // identity is only for selection storage and containment (not sourcePath rewriting).
    const body = { root: path.resolve(root), knownFiles, selectedFiles: selected };
    return { ...body, excludedFiles: knownFiles.filter(file => !selected.includes(file)),
        scopeId: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

/** Called per canonical file. Multiple actual definitions cannot be resolved by name alone. */
export function deduplicateTargets<T extends { fullName: string }>(definitions: readonly T[]): {
    targets: T[]; ambiguousTargets: string[];
} {
    const grouped = new Map<string, T[]>();
    for (const target of definitions) {
        const group = grouped.get(target.fullName) || [];
        group.push(target); grouped.set(target.fullName, group);
    }
    return { targets: [...grouped.values()].filter(group => group.length === 1).map(group => group[0]),
        ambiguousTargets: [...grouped].filter(([, group]) => group.length > 1).map(([name]) => name) };
}

/** R3: Build sorted target candidates (default all selected) for files in the confirmed batch scope. */
export function buildBatchScopeTargetCandidates(
    selection: Pick<BatchScopeSelection, 'selectedFiles'>,
    fileFunctions: ReadonlyMap<string, readonly string[]> | Record<string, readonly string[]>
): BatchScopeTargetCandidate[] {
    const identity = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value).replace(/\\/g, '/');
    const selectedSet = new Map<string, string>();
    for (const file of selection.selectedFiles) {
        const normalized = file.replace(/\\/g, '/');
        selectedSet.set(identity(normalized), normalized);
    }
    const rawItems: TargetListItem[] = [];
    const entries = fileFunctions instanceof Map ? [...fileFunctions.entries()] : Object.entries(fileFunctions);
    for (const [rawFile, funcs] of entries) {
        const matchedFile = selectedSet.get(identity(rawFile));
        if (!matchedFile || !Array.isArray(funcs)) { continue; }
        for (const func of funcs) {
            if (typeof func === 'string' && func.trim()) {
                rawItems.push({ file: matchedFile, target: func.trim() });
            }
        }
    }
    const deduplicated = deduplicateTargetList(rawItems);
    return [...deduplicated]
        .sort(compareTargetItems)
        .map(item => ({ ...item, selected: true }));
}

/** R3: Filter batch scope candidates to checked functions within the confirmed batch scope. */
export function resolveBatchScopeTargets(
    selection: Pick<BatchScopeSelection, 'selectedFiles'>,
    candidates: readonly BatchScopeTargetCandidate[]
): TargetListItem[] {
    const identity = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value).replace(/\\/g, '/');
    const allowedFiles = new Set(selection.selectedFiles.map(identity));
    return deduplicateTargetList(
        candidates
            .filter(candidate => candidate.selected && allowedFiles.has(identity(candidate.file)))
            .map(candidate => ({ file: candidate.file, target: candidate.target }))
    );
}
