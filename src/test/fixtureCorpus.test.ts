import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { test } from 'node:test';
import { inferSkillIdsFromCode } from '../prompts/promptSkillLibrary';

interface FixtureContext {
    calls?: string[];
    dependencies?: unknown[];
    class_name?: string;
    method_kind?: 'module' | 'instance' | 'static' | 'class' | 'property';
    file_imports?: Array<{ module?: string | null; name?: string | null; bound_name?: string | null }>;
}

interface FixtureSpec {
    id: string;
    tier: number;
    source: string;
    target: string;
    context?: FixtureContext;
    expected: {
        method_kind: string;
        is_async: boolean;
        skills: string[];
        trace: string;
    };
    acceptance: {
        min_line_coverage: number;
        min_mutation_score: number;
        forbidden: string[];
    };
}

const fixtureRoot = resolve(__dirname, '../../test/fixtures/python');
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8')) as {
    schema_version: number;
    fixtures: FixtureSpec[];
};

test('public fixture corpus has three neutral acceptance inputs for every Tier', () => {
    assert.strictEqual(manifest.schema_version, 1);
    assert.strictEqual(manifest.fixtures.length, 12);

    for (const tier of [1, 2, 3, 4]) {
        const fixtures = manifest.fixtures.filter(fixture => fixture.tier === tier);
        assert.strictEqual(fixtures.length, 3, `Tier ${tier} must have three fixtures`);
        for (const fixture of fixtures) {
            assert.ok(fixture.target);
            assert.ok(fixture.acceptance.min_line_coverage > 0);
            assert.ok(fixture.acceptance.min_mutation_score > 0);
            assert.ok(fixture.acceptance.forbidden.length > 0);
        }
    }
});

test('fixture corpus skill expectations stay tied to syntax and AST binding evidence', () => {
    for (const fixture of manifest.fixtures) {
        const source = readFileSync(join(fixtureRoot, fixture.source), 'utf8');
        const skills = inferSkillIdsFromCode(source, fixture.context);

        for (const expectedSkill of fixture.expected.skills) {
            assert.ok(
                skills.includes(expectedSkill),
                `${fixture.id} should select ${expectedSkill}; actual: ${skills.join(', ')}`
            );
        }
    }
});
