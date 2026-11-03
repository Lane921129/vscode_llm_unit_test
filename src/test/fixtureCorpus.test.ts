import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { test } from 'node:test';
import { inferTestRuleIdsFromCode } from '../prompts/testRuleLibrary';

interface FixtureContext {
    calls?: string[];
    dependencies?: unknown[];
    class_name?: string;
    method_kind?: 'module' | 'instance' | 'static' | 'class' | 'property';
    is_generator?: boolean;
    file_imports?: Array<{ module?: string | null; name?: string | null; bound_name?: string | null }>;
    condition_facts?: Array<{ kind?: string; parameter?: string; subject?: string; polarity?: string }>;
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
        rules: string[];
        trace: string;
        inherited_constructor_required?: string[];
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
    assert.strictEqual(manifest.schema_version, 2);
    assert.ok(manifest.fixtures.length >= 12);

    for (const tier of [1, 2, 3, 4]) {
        const fixtures = manifest.fixtures.filter(fixture => fixture.tier === tier);
        assert.ok(fixtures.length >= 3, `Tier ${tier} must have at least three fixtures`);
        for (const fixture of fixtures) {
            assert.ok(fixture.target);
            assert.ok(fixture.acceptance.min_line_coverage > 0);
            assert.ok(fixture.acceptance.min_mutation_score > 0);
            assert.ok(fixture.acceptance.forbidden.length > 0);
        }
    }
});

test('fixture corpus rule expectations stay tied to syntax and AST binding evidence', () => {
    for (const fixture of manifest.fixtures) {
        const source = readFileSync(join(fixtureRoot, fixture.source), 'utf8');
        const rules = inferTestRuleIdsFromCode(source, fixture.context);

        for (const expectedRule of fixture.expected.rules) {
            assert.ok(
                rules.includes(expectedRule),
                `${fixture.id} should select ${expectedRule}; actual: ${rules.join(', ')}`
            );
        }
    }
});
