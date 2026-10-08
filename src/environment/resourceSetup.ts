import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createImportFixturePlan, ImportFixturePlan, ImportFixtureRule, refreshEntryPointApprovals, selectImportFixtureRules } from '../pipeline/importFixtures';
import { resourceLogicalPath, resourceSpecKey } from '../pipeline/isolatedResources';

export interface ResourceSetupDraft {
    schemaVersion: 'isolated-resource-setup-v1'; root: string; rules: ImportFixtureRule[];
}

/** Validate the exact edited declaration and its original source approvals. */
export function readResourceSetupDraft(root: string, text: string): { draft: ResourceSetupDraft; plan: ImportFixturePlan | null } {
    if (Buffer.byteLength(text, 'utf8') > 262144) { throw new Error('Resource setup exceeds the size limit.'); }
    const value = JSON.parse(text) as ResourceSetupDraft;
    if (!value || value.schemaVersion !== 'isolated-resource-setup-v1'
        || Object.keys(value).some(key => !['schemaVersion', 'root', 'rules'].includes(key))
        || typeof value.root !== 'string' || fs.realpathSync(value.root) !== fs.realpathSync(root)
        || !Array.isArray(value.rules) || value.rules.some(rule => !rule || typeof rule !== 'object'
            || Object.keys(rule).some(key => !['file', 'resources', 'resourceSourceHash'].includes(key)))) {
        throw new Error('Resource setup belongs to a different project or has an invalid schema.');
    }
    // Clearing the resource list is an explicit withdrawal, not approval of a
    // new source version. Do not make users manually remove the obsolete hash.
    for (const rule of value.rules) {
        if (Array.isArray(rule.resources) && rule.resources.length === 0) { delete rule.resourceSourceHash; }
    }
    return { draft: value, plan: createImportFixturePlan(root, value.rules, value.root) };
}

/** A resource draft cannot overwrite newer import/entry-point approvals. */
export function mergeResourceSetupRules(root: string, saved: ImportFixtureRule[], boundRoot: string, draft: ResourceSetupDraft): ImportFixtureRule[] {
    const validated = readResourceSetupDraft(root, JSON.stringify(draft)).draft;
    const rules = structuredClone(selectImportFixtureRules(root, saved, boundRoot));
    for (const update of validated.rules) {
        const canonical = fs.realpathSync(path.join(root, update.file));
        let rule = rules.find(item => fs.realpathSync(path.join(root, item.file)) === canonical);
        if (!rule) { rule = { file: update.file }; rules.push(rule); }
        delete rule.resources; delete rule.resourceSourceHash;
        if (update.resources?.length) {
            rule.resources = structuredClone(update.resources);
            rule.resourceSourceHash = update.resourceSourceHash;
        }
    }
    // Resource source reapproval must not silently rebind stale initialization
    // line approvals. Withdraw them from this preview; the controller discloses
    // removals and a subsequent preflight can propose fresh observed locations.
    return refreshEntryPointApprovals(root, rules, root).rules;
}

export function newResourceSetupRule(root: string, file: string): ImportFixtureRule {
    root = fs.realpathSync(root); file = fs.realpathSync(file);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.py')) {
        throw new Error('Choose a Python source inside the selected project.');
    }
    return { file: relative.replace(/\\/g, '/'),
        resourceSourceHash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), resources: [] };
}

/** This only prepares a new preview; persisted approvals are never changed here. */
export function refreshResourceSetupDraft(root: string, text: string): ResourceSetupDraft {
    if (Buffer.byteLength(text, 'utf8') > 262144) { throw new Error('Resource setup exceeds the size limit.'); }
    const draft = JSON.parse(text) as ResourceSetupDraft;
    if (!draft || draft.schemaVersion !== 'isolated-resource-setup-v1' || typeof draft.root !== 'string'
        || fs.realpathSync(draft.root) !== fs.realpathSync(root) || !Array.isArray(draft.rules)) {
        throw new Error('Resource setup belongs to a different project or has an invalid schema.');
    }
    for (const rule of draft.rules) {
        if (rule?.resources?.length) {
            rule.resourceSourceHash = newResourceSetupRule(root, path.join(root, rule.file)).resourceSourceHash;
        }
    }
    return readResourceSetupDraft(root, JSON.stringify(draft)).draft;
}

export function resourceSetupCounts(rules: ImportFixtureRule[]): { directories: number; files: number; databases: number; tables: number; rows: number } {
    const resources = new Map(rules.flatMap(rule => (rule.resources || []).map(resource => [resourceSpecKey(resource), resource] as const)));
    const counts = { directories: 0, files: 0, databases: 0, tables: 0, rows: 0 };
    for (const resource of resources.values()) {
        if (resource.kind === 'directory') { counts.directories++; }
        else if (resource.kind === 'text') { counts.files++; }
        else { counts.databases++; counts.tables += resource.tables.length;
            counts.rows += resource.tables.reduce((total, table) => total + (table.rows?.length || 0), 0); }
    }
    return counts;
}

export function projectParentResourcePaths(rules: ImportFixtureRule[]): string[] {
    return [...new Set(rules.flatMap(rule => (rule.resources || []).filter(resource => resource.scope === 'project-parent')
        .map(resourceLogicalPath)))];
}
