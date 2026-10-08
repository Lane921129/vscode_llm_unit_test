import { createHash } from 'node:crypto';
import { currentImportFixtures, type ImportFixturePlan } from '../pipeline/importFixtures';
import { containsCredential } from '../pipeline/artifactSafety';

/** The exception is for application code, never a generated test's direct I/O. */
export const ISOLATED_RESOURCE_ROLE_RULE = 'When HOST_ISOLATED_RESOURCE_CONTEXT is supplied, the host prepares only its declared resources before application import. Call the real target through its public API; do not create files, open database connections, invent tables, or replace a declared connection with a scalar mock. The seed is controlled input, not proof of an expected output. Each process starts fresh, but methods in one unittest suite share resources: arrange and clean up through supported public application APIs so tests do not depend on order. Undeclared boundaries still need explicit use-point mocks; network, shell, direct test I/O and shared databases remain forbidden.';

/** Keep ordinary functions and qualification probes at their original prompt size. */
export function isolatedResourceSystemRule(): string {
    return currentImportFixtures()?.rules.some(rule => rule.resources?.length)
        ? '\nUse HOST_ISOLATED_RESOURCE_CONTEXT for declared resources instead of mocks; call real target APIs. Seeds are inputs, not assertion oracles. Direct test I/O stays forbidden.' : '';
}

/** Whole records only: an incomplete seed/schema must never look complete. */
export function buildIsolatedResourceContext(
    plan: ImportFixturePlan | undefined, maxChars = 6000, knownSecrets: readonly string[] = []
): string {
    const rules = plan?.rules.filter(rule => rule.resources?.length) || [];
    if (!plan || !rules.length) { return ''; }
    const header = `HOST_ISOLATED_RESOURCE_CONTEXT\nPlan identity (includes source, schema and seed): ${plan.id}\n${ISOLATED_RESOURCE_ROLE_RULE}\nResource declarations are setup facts, not execution results. Text contents are withheld. Omitted rows are unknown, never empty.\n`;
    if (maxChars < header.length + 100) { return ''; }
    const records: string[] = [];
    let omitted = 0;
    const fits = (record: string) => header.length + records.join('\n').length + record.length + 100 <= maxChars;
    for (const rule of rules) {
        for (const resource of rule.resources || []) {
            const common = { declaredBy: rule.file, sourceHash: rule.sourceHash, path: resource.path, kind: resource.kind };
            const summary = resource.kind === 'sqlite'
                ? { ...common, tables: resource.tables.map(table => ({ name: table.name, columns: table.columns,
                    rowCount: table.rows?.length || 0, rowsStatus: 'withheld' })) }
                : resource.kind === 'text'
                    ? { ...common, textBytes: Buffer.byteLength(resource.text, 'utf8'),
                        textHash: createHash('sha256').update(resource.text).digest('hex'), textStatus: 'withheld' }
                    : common;
            const complete = resource.kind === 'sqlite'
                ? { ...common, tables: resource.tables.map(table => ({ name: table.name, columns: table.columns,
                    rowCount: table.rows?.length || 0, rowsStatus: 'complete', rows: table.rows || [] })) }
                : summary;
            const full = JSON.stringify(complete), brief = JSON.stringify(summary);
            if (!containsCredential(full, knownSecrets) && fits(full)) { records.push(full); }
            else if (!containsCredential(brief, knownSecrets) && fits(brief)) { records.push(brief); }
            else { omitted++; }
        }
    }
    return header + records.join('\n') + (omitted ? `\nWhole resource declarations omitted: ${omitted}; details are unknown.` : '');
}
