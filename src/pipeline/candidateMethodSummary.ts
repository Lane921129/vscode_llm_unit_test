import * as fs from 'node:fs';
import * as path from 'node:path';
import { localize } from '../i18n/core';

interface MethodIdentity { id: string; fingerprint: string }
interface MethodCount { count: number | null; incomplete: boolean }
export interface MethodCandidateRow {
    codeHash: string; loop: number; phase: 'generated' | 'merged' | 'observed' | 'unknown';
    methods: number | null; added: number | null; status: 'inventoried' | 'accepted' | 'rejected' | 'retained';
}
export interface CandidateMethodSummary {
    generated: MethodCount; added: MethodCount; rejected: MethodCount; retained: MethodCount;
    candidates: MethodCandidateRow[]; omittedCandidates: number;
}
export interface CandidateMethodIdentity { runId: string; sourceHash: string; target: string; retainedCodeHash?: string }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const unknownCount = (): MethodCount => ({ count: null, incomplete: true });
const unknownSummary = (): CandidateMethodSummary => ({ generated: unknownCount(), added: unknownCount(),
    rejected: unknownCount(), retained: unknownCount(), candidates: [], omittedCandidates: 0 });
const methodKey = (method: MethodIdentity): string => JSON.stringify([method.id, method.fingerprint]);
function methods(value: unknown): MethodIdentity[] | undefined {
    if (!Array.isArray(value) || value.length > 256 || value.some(item => !object(item)
        || typeof item.id !== 'string' || item.id.length > 256 || !item.id || /[\r\n\0]/.test(item.id)
        || !digest(item.fingerprint)) || new Set(value.map(item => item.id)).size !== value.length) { return undefined; }
    return value.map(item => ({ id: item.id, fingerprint: item.fingerprint }));
}

/** Counts are evidence about AST method versions, never provider replies, attempts or test success. */
export function summarizeCandidateMethods(events: unknown[], identity: CandidateMethodIdentity, loop?: number): CandidateMethodSummary {
    if (events.length > 4096 || !identity.runId || !identity.target || !digest(identity.sourceHash)
        || events.some(event => !object(event) || event.runId !== identity.runId || event.sourceHash !== identity.sourceHash
            || !Number.isSafeInteger(event.loop) || event.loop < 0
            || (object(event.detail) && event.detail.target !== undefined && event.detail.target !== identity.target)
            || (object(event.detail) && ['candidate-methods', 'candidate-artifact'].includes(event.stage)
                && ((event.detail.runId !== undefined && event.detail.runId !== identity.runId)
                    || (event.detail.sourceHash !== undefined && event.detail.sourceHash !== identity.sourceHash))))) {
        return unknownSummary();
    }
    const inventories = new Map<string, MethodIdentity[]>();
    const rows = new Map<string, MethodCandidateRow>();
    const generated = new Set<string>(), added = new Set<string>(), rejected = new Set<string>();
    let generatedSeen = false, generatedIncomplete = false, addedSeen = false, addedIncomplete = false;
    let rejectedSeen = false, rejectedIncomplete = false;
    const selectedEvents = events.filter(event => loop === undefined || (event as any).loop === loop) as Record<string, any>[];
    // Keep inventories from the whole run for matching a rejected/retained hash, but count only selected rounds.
    for (const event of events as Record<string, any>[]) {
        const detail = object(event.detail) ? event.detail : {};
        if (!digest(detail.codeHash)) { continue; }
        const inventory = event.stage === 'candidate-methods' && event.status === 'inventoried'
            && detail.schemaVersion === 'candidate-methods-v1' ? methods(detail.methods)
            : event.stage === 'scenarios' && event.status === 'observed' ? methods(detail.scenarios) : undefined;
        if (!inventory) { continue; }
        const previous = inventories.get(detail.codeHash);
        if (previous && JSON.stringify(previous) !== JSON.stringify(inventory)) { return unknownSummary(); }
        inventories.set(detail.codeHash, inventory);
    }
    const rowFor = (event: Record<string, any>, hash: string, phase: MethodCandidateRow['phase']): MethodCandidateRow => {
        const key = `${event.loop}:${hash}:${phase}`;
        if (!rows.has(key)) { rows.set(key, { codeHash: hash, loop: event.loop, phase,
            methods: inventories.get(hash)?.length ?? null, added: null, status: 'inventoried' }); }
        return rows.get(key)!;
    };
    for (const event of selectedEvents) {
        const detail = object(event.detail) ? event.detail : {};
        if (event.stage !== 'candidate-methods' || !digest(detail.codeHash)) { continue; }
        const phase = detail.phase === 'generated' || detail.phase === 'merged' ? detail.phase : 'unknown';
        const row = rowFor(event, detail.codeHash, phase);
        if (phase !== 'generated') { continue; }
        const inventory = event.status === 'inventoried' && detail.schemaVersion === 'candidate-methods-v1'
            ? methods(detail.methods) : inventories.get(detail.codeHash);
        generatedSeen = true;
        if (!inventory) { generatedIncomplete = true; addedIncomplete = true; continue; }
        for (const method of inventory) { generated.add(methodKey(method)); }
        const baseline = digest(detail.baselineCodeHash) ? methods(detail.baselineMethods) : undefined;
        if (!baseline) { addedIncomplete = true; continue; }
        addedSeen = true;
        const existing = new Set(baseline.map(method => method.id));
        const additions = inventory.filter(method => !existing.has(method.id));
        row.added = additions.length;
        for (const method of additions) { added.add(methodKey(method)); }
    }
    const accepted = new Set<string>(), rejectedHashes = new Set<string>();
    for (const event of selectedEvents) {
        const detail = object(event.detail) ? event.detail : {};
        if (event.stage === 'candidate-artifact' && event.status === 'rejected') {
            rejectedSeen = true;
            if (!digest(detail.codeHash)) { rejectedIncomplete = true; continue; }
            rejectedHashes.add(detail.codeHash);
            const inventory = inventories.get(detail.codeHash);
            if (inventory) { for (const method of inventory) { rejected.add(methodKey(method)); } }
            else { rejectedIncomplete = true; }
            if (![...rows.values()].some(row => row.codeHash === detail.codeHash && row.loop === event.loop)) {
                rowFor(event, detail.codeHash, 'unknown');
            }
        }
        if (digest(detail.codeHash) && ((event.stage === 'validation' && event.status === 'accepted')
            || (event.stage === 'executable-baseline' && event.status === 'checkpointed'))) { accepted.add(detail.codeHash); }
        if (event.stage === 'scenarios' && event.status === 'observed' && digest(detail.codeHash)
            && ![...rows.values()].some(row => row.codeHash === detail.codeHash && row.loop === event.loop)) {
            rowFor(event, detail.codeHash, 'observed');
        }
    }
    for (const row of rows.values()) {
        row.status = row.codeHash === identity.retainedCodeHash ? 'retained'
            : rejectedHashes.has(row.codeHash) ? 'rejected' : accepted.has(row.codeHash) ? 'accepted' : 'inventoried';
    }
    const retained = digest(identity.retainedCodeHash) ? inventories.get(identity.retainedCodeHash) : undefined;
    const candidates = [...rows.values()];
    return { generated: generatedSeen ? { count: generated.size || (generatedIncomplete ? null : 0), incomplete: generatedIncomplete } : unknownCount(),
        added: addedSeen ? { count: added.size, incomplete: addedIncomplete } : unknownCount(),
        rejected: rejectedSeen ? { count: rejected.size || (rejectedIncomplete ? null : 0), incomplete: rejectedIncomplete }
            : generatedSeen ? { count: 0, incomplete: false } : unknownCount(),
        retained: retained ? { count: retained.length, incomplete: false } : unknownCount(),
        candidates: candidates.slice(0, 64), omittedCandidates: Math.max(0, candidates.length - 64) };
}

/** Read bounded host evidence only; neither test code nor provider responses are parsed here. */
export function readCandidateMethodSummary(directory: string, identity: CandidateMethodIdentity, loop?: number): CandidateMethodSummary {
    try {
        const manifestFile = path.join(directory, 'run_manifest.json'), eventFile = path.join(directory, 'role_events.jsonl');
        for (const [file, limit] of [[manifestFile, 256 * 1024], [eventFile, 16 * 1024 * 1024]] as const) {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || fs.realpathSync(file) !== path.resolve(file)) { return unknownSummary(); }
        }
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        if (manifest.runId !== identity.runId || manifest.sourceHash !== identity.sourceHash || manifest.target !== identity.target) { return unknownSummary(); }
        const lines = fs.readFileSync(eventFile, 'utf8').split('\n').filter(line => line.trim());
        if (lines.length > 4096) { return unknownSummary(); }
        return summarizeCandidateMethods(lines.map(line => JSON.parse(line)), identity, loop);
    } catch { return unknownSummary(); }
}

const cell = (value: unknown): string => String(value ?? '').replace(/[\r\n]+/g, ' ')
    .replace(/[&<>|`\[\]]/g, char => `&#${char.charCodeAt(0)};`);
const displayCount = (value: MethodCount): string => value.count === null ? localize('未知')
    : value.incomplete ? localize('≥ {0}（其餘未知）', value.count) : String(value.count);
export function renderCandidateMethodCounts(summary: CandidateMethodSummary): string {
    return localize('- **測試方法數**: 生成 {0}；新增（相對基線）{1}；拒絕 {2}；目前保留 {3}。\n',
        displayCount(summary.generated), displayCount(summary.added), displayCount(summary.rejected), displayCount(summary.retained));
}
export function renderCandidateMethodTimeline(summary: CandidateMethodSummary): string {
    const statuses = { inventoried: localize('僅盤點'), accepted: localize('曾通過執行'), rejected: localize('已拒絕'), retained: localize('目前保留') };
    return '\n' + localize('### 候選測試方法統計') + '\n\n' + renderCandidateMethodCounts(summary) + '\n'
        + localize('生成／新增／拒絕依方法名稱與 AST 指紋去重，可能重疊；合併基線不重算生成。未知不當成零或通過，保留數只綁定目前保留測資。') + '\n\n'
        + (summary.candidates.length ? [localize('| 輪次 | 候選雜湊 | 來源 | 方法數 | 新增（相對基線）| 採用情況 |'), '| --- | --- | --- | --- | --- | --- |',
            ...summary.candidates.map(row => `| ${row.loop} | ${cell(row.codeHash.slice(0, 12))} | ${row.phase} | ${row.methods ?? localize('未知')} | ${row.added ?? localize('未知')} | ${statuses[row.status]} |`), ''].join('\n')
            : localize('缺少可核對的候選 AST 方法紀錄；未推測生成或拒絕數量。\n'))
        + (summary.omittedCandidates ? localize('另有 {0} 筆候選紀錄，完整資料請見 role_events.jsonl。\n', summary.omittedCandidates) : '');
}
