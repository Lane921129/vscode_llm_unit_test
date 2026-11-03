import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TestSkillCard {
    id: string;
    version: number;
    title: string;
    trigger_hint: string;
    rules: string[];
}

/** Installed application assets only. No workspace discovery or Python execution. */
export function loadTestSkills(root = path.join(path.basename(__dirname) === 'skills'
    ? path.resolve(__dirname, '../..') : path.resolve(__dirname, '..'), 'skills')): TestSkillCard[] {
    const read = (name: string, limit: number) => {
        const file = path.join(root, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) { throw new Error('Invalid test skill asset.'); }
        return fs.readFileSync(file, 'utf8');
    };
    const catalog = JSON.parse(read('catalog.json', 32768));
    if (catalog?.schemaVersion !== 'test-skill-catalog-v1' || !Array.isArray(catalog.skills)
        || !catalog.skills.length || catalog.skills.length > 32) { throw new Error('Invalid test skill catalog.'); }
    const ids = new Set<string>();
    return catalog.skills.map((item: any) => {
        if (!item || typeof item.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(item.id) || ids.has(item.id)
            || !Number.isSafeInteger(item.version) || item.version < 1
            || typeof item.file !== 'string' || !/^[a-z][a-z0-9_]{0,63}\.txt$/.test(item.file)
            || !['title', 'trigger_hint'].every(key => typeof item[key] === 'string'
                && item[key].trim() && item[key].length <= 300)) { throw new Error('Invalid test skill record.'); }
        const rules = read(item.file, 16384).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!rules.length || rules.length > 32 || rules.some(line => line.length > 2000)) {
            throw new Error('Invalid test skill guidance.');
        }
        ids.add(item.id);
        return { id: item.id, version: item.version, title: item.title, trigger_hint: item.trigger_hint, rules };
    });
}
