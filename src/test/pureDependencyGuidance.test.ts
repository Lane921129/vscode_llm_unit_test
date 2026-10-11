import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSystemPrompt } from '../roles/unittestWriter';
import { getTestRuleCards, inferTestRuleIdsFromCode } from '../prompts/testRuleLibrary';

for (const strategy of ['small', 'large'] as const) {
    test(`full ${strategy} Writer prefers real pure-library inputs without weakening evidence or boundary isolation`, () => {
        const prompt = getSystemPrompt(1, strategy);
        if (strategy === 'small') {
            assert.match(prompt, /Pure stdlib parsing\/formatting\/calculation: real target, source-supported literals/);
            assert.match(prompt, /helper imports need no mocks/);
            assert.match(prompt, /Patch external\/ambient source use points only when needed/);
            assert.match(prompt, /Never patch immutable built-in class members; replace owning module binding/);
            assert.match(prompt, /Inputs\/source expressions prove no expected values/);
            assert.match(prompt, /exact Verified Real Execution Results, proven source path or same-test controls/);
        } else {
            assert.match(prompt, /pure standard-library parsing, formatting or calculation, prefer real target calls/);
            assert.match(prompt, /Imported helpers alone do not require mocks/);
            assert.match(prompt, /Mock only source-shown external or ambient boundaries when control is needed/);
            assert.match(prompt, /Never patch immutable built-in class members; replace the owning module binding if necessary/);
            assert.match(prompt, /Inputs and source expressions do not prove expected values/);
            assert.match(prompt, /verified-observation or explicit same-test evidence requirements/);
        }
        assert.match(prompt, /Verified Real Execution Results/);
        assert.match(prompt, strategy === 'small' ? /No direct test network\/file\/shell\/dynamic execution/ : /Use unittest\.mock.*external dependencies/);
    });
}

test('pure parser catch guidance uses evidenced literal inputs and does not require a mock or clock rule', () => {
    const source = 'def parse_units(text):\n    try:\n        return str(int(text))\n'
        + '    except ValueError:\n        return "invalid"\n';
    const ids = inferTestRuleIdsFromCode(source, { calls: ['str', 'int'], file_imports: [] });
    assert.ok(ids.includes('try_except_returns_string'));
    assert.ok(!ids.includes('datetime_freezing'));
    const rules = getTestRuleCards(ids).find(card => card.id === 'try_except_returns_string')!.rules.join('\n');
    assert.match(rules, /prefer source-supported literal inputs, including invalid inputs for an evidenced caught path/);
    assert.match(rules, /Only if the caught path requires controlling a source-shown dependency, configure side_effect/);
    assert.doesNotMatch(rules, /For the caught path, configure the dependency side_effect/);
    assert.match(rules, /Source return text alone is not an output oracle/);
});

test('external dependency catch guidance still requires a real raised exception and evidence for the result', () => {
    const source = 'def fetch_label(client):\n    try:\n        return client.fetch()\n'
        + '    except LookupError:\n        return "missing"\n';
    const ids = inferTestRuleIdsFromCode(source, { calls: ['client.fetch'], file_imports: [] });
    const rules = getTestRuleCards(ids).find(card => card.id === 'try_except_returns_string')!.rules.join('\n');
    assert.match(rules, /Only the exception types named by the matching except clause are caught/);
    assert.match(rules, /configure side_effect with a caught exception; return_value cannot raise it/);
    assert.match(rules, /verified observations or explicit same-test controlled behavior/);
});
