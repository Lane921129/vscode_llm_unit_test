/**
 * Requirements file for the v2 pipeline (llmUnitTest.requirementsFile).
 *
 * Markdown text where each requirement is one line `R1: description`
 * (a full-width colon is also accepted; list markers are ignored). Other lines
 * are notes and are skipped. Requirement text is a spec source in PR #8.
 */
export interface RequirementEntry {
    id: string;
    text: string;
}

const REQUIREMENT_LINE = /^(?:[-*+]\s+)?\**(R[1-9]\d*)\**\s*[:：]\s*(.+)$/;

export function parseRequirements(text: string): RequirementEntry[] {
    const entries: RequirementEntry[] = [];
    const seen = new Set<string>();
    for (const raw of text.split(/\r?\n/)) {
        const match = REQUIREMENT_LINE.exec(raw.trim());
        if (!match) { continue; }
        const [, id, description] = match;
        if (seen.has(id)) { throw new Error(`requirements-duplicate-id: ${id}`); }
        seen.add(id);
        entries.push({ id, text: description.trim() });
    }
    return entries;
}
