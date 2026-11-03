import { createHash } from 'node:crypto';

/** Source location is navigation, never an execution fact or an expected value.
 * The host AST supplies this metadata alongside the complete target snippet. */
export function formatSourceLineContext(source: string, location: unknown, gap = ''): string {
    if (!location || typeof location !== 'object' || Array.isArray(location)) { return ''; }
    const value = location as Record<string, unknown>;
    const normalized = source.replace(/\r\n/g, '\n');
    const rows = normalized.split('\n');
    if (value.version !== 'python-source-location-v1' || !Number.isSafeInteger(value.startLine)
        || !Number.isSafeInteger(value.endLine) || Number(value.startLine) < 1
        || Number(value.endLine) - Number(value.startLine) + 1 !== rows.length
        || value.sourceHash !== createHash('sha256').update(normalized).digest('hex')) { return ''; }
    const start = Number(value.startLine), end = Number(value.endLine);
    const line = /^line:(\d+)$/.exec(gap);
    const branch = /^branch:(-?\d+)->(-?\d+)$/.exec(gap);
    const centers = line ? [Number(line[1])] : branch ? [Number(branch[1]), Number(branch[2])] : [];
    const selected = new Set<number>();
    for (const center of centers) {
        if (!Number.isSafeInteger(center) || center < start || center > end) { continue; }
        for (let n = Math.max(start, center - 2); n <= Math.min(end, center + 2); n++) { selected.add(n); }
    }
    return 'SOURCE_FILE_LINES_V1 (source navigation only, not execution or assertion evidence)\n'
        + `Snippet row 1 is file line ${start}; last file line ${end}. Measured line/branch IDs use file lines.\n`
        + [...selected].sort((a, b) => a - b).slice(0, 10)
            .map(fileLine => {
                const text = rows[fileLine - start];
                // Navigation is optional duplication. Reference a whole long row
                // in the unchanged full source instead of copying or clipping it.
                return JSON.stringify(text.length <= 240 ? { fileLine, text }
                    : { fileLine, sourceRow: fileLine - start + 1, textInCompleteSource: true });
            }).join('\n');
}
